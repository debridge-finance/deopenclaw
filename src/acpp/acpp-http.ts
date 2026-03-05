import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../gateway/hooks.js";
import { sendJson, setSseHeaders } from "../gateway/http-common.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import type { ActivityAggregator } from "./activity-aggregator.js";
import type { AgentStore } from "./agent-store.js";
import type { AgentHealthPoller } from "./health-poller.js";
import type { McpClientManager } from "./mcp-client-manager.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const ACPP_PATH_PREFIX = "/api/v1/agents";
const MAX_BODY_BYTES = 256 * 1024;

export type AcppHttpContext = {
  store: AgentStore;
  apiKey: string | undefined;
  log: SubsystemLogger;
  healthPoller?: AgentHealthPoller;
  activityAggregator?: ActivityAggregator;
  mcpClientManager?: McpClientManager;
};

/**
 * Handle ACPP HTTP requests.
 * Returns true if the request was handled, false otherwise.
 */
export async function handleAcppHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AcppHttpContext,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (!pathname.startsWith(ACPP_PATH_PREFIX)) {
    return false;
  }

  // Auth check — all ACPP endpoints require X-API-Key
  if (!ctx.apiKey) {
    sendJson(res, 500, { error: "ACPP_API_KEY not configured" });
    return true;
  }

  const providedKey =
    typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined;
  if (!safeEqualSecret(providedKey, ctx.apiKey)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  const method = (req.method ?? "GET").toUpperCase();
  const subPath = pathname.slice(ACPP_PATH_PREFIX.length);

  // POST /api/v1/agents/register
  if (subPath === "/register" && method === "POST") {
    return handleRegister(req, res, ctx);
  }

  // POST /api/v1/agents/heartbeat
  if (subPath === "/heartbeat" && method === "POST") {
    return handleHeartbeat(req, res, ctx);
  }

  // GET /api/v1/agents/activity/stream — SSE all agents
  if (subPath === "/activity/stream" && method === "GET") {
    return handleActivityStreamAll(req, res, ctx);
  }

  // GET /api/v1/agents — list all
  if ((subPath === "" || subPath === "/") && method === "GET") {
    return handleListAgents(res, ctx);
  }

  // Routes with :agentId parameter
  const agentIdMatch = subPath.match(/^\/([a-z0-9-]+)(\/.*)?$/);
  if (agentIdMatch) {
    const agentId = agentIdMatch[1];
    const rest = agentIdMatch[2] ?? "";

    // PUT /api/v1/agents/:agentId
    if (rest === "" && method === "PUT") {
      return handleUpdateAgent(req, res, ctx, agentId);
    }

    // DELETE /api/v1/agents/:agentId
    if (rest === "" && method === "DELETE") {
      return handleDeregister(req, res, ctx, agentId);
    }

    // GET /api/v1/agents/:agentId
    if (rest === "" && method === "GET") {
      return handleGetAgent(res, ctx, agentId);
    }

    // GET /api/v1/agents/:agentId/health
    if (rest === "/health" && method === "GET") {
      return handleGetAgentHealth(res, ctx, agentId);
    }

    // GET /api/v1/agents/:agentId/activity/stream — SSE single agent
    if (rest === "/activity/stream" && method === "GET") {
      return handleActivityStreamAgent(req, res, ctx, agentId);
    }

    // GET /api/v1/agents/:agentId/activity — REST paginated history
    if (rest === "/activity" && method === "GET") {
      return handleActivityHistory(req, res, ctx, agentId);
    }
  }

  sendJson(res, 404, { error: "Not Found" });
  return true;
}

// ── Route Handlers ──────────────────────────────────────────────

async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AcppHttpContext,
): Promise<true> {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) {
    sendJson(res, 400, { error: body.error });
    return true;
  }
  const result = ctx.store.register(body.value);
  if (!result.ok) {
    sendJson(res, 422, { error: result.error });
    return true;
  }
  ctx.log.info(
    `agent registered: ${result.response.agentId} (${result.statusCode === 201 ? "new" : "re-registered"})`,
  );

  // Connect to agent's MCP endpoint for tool discovery
  const registered = ctx.store.get(result.response.agentId);
  if (ctx.mcpClientManager && registered?.mcpEndpoint) {
    void ctx.mcpClientManager.connect(result.response.agentId, registered.mcpEndpoint);
  }

  sendJson(res, result.statusCode, result.response);
  return true;
}

async function handleHeartbeat(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AcppHttpContext,
): Promise<true> {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) {
    sendJson(res, 400, { error: body.error });
    return true;
  }
  const result = ctx.store.heartbeat(body.value);
  if (!result.ok) {
    if (result.notFound) {
      sendJson(res, 404, { error: result.error });
    } else {
      sendJson(res, 422, { error: result.error });
    }
    return true;
  }
  sendJson(res, 200, result.response);
  return true;
}

async function handleUpdateAgent(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AcppHttpContext,
  agentId: string,
): Promise<true> {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) {
    sendJson(res, 400, { error: body.error });
    return true;
  }
  const result = ctx.store.update(agentId, body.value);
  if (!result.ok) {
    if (result.notFound) {
      sendJson(res, 404, { error: result.error });
    } else {
      sendJson(res, 422, { error: result.error });
    }
    return true;
  }
  ctx.log.info(`agent updated: ${agentId}`);
  sendJson(res, 200, result.record);
  return true;
}

function handleDeregister(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AcppHttpContext,
  agentId: string,
): true {
  const reason =
    typeof req.headers["x-deregister-reason"] === "string"
      ? req.headers["x-deregister-reason"]
      : undefined;
  const result = ctx.store.deregister(agentId, reason);
  if (!result.ok) {
    if (result.notFound) {
      sendJson(res, 404, { error: result.error });
    } else {
      sendJson(res, 422, { error: result.error });
    }
    return true;
  }
  ctx.log.info(`agent deregistered: ${agentId} (reason: ${reason ?? "none"})`);

  // Disconnect MCP client
  ctx.mcpClientManager?.disconnect(agentId);

  sendJson(res, 200, { deregistered: true, agentId });
  return true;
}

function handleListAgents(res: ServerResponse, ctx: AcppHttpContext): true {
  const agents = ctx.store.getAll();
  sendJson(res, 200, { agents });
  return true;
}

function handleGetAgent(res: ServerResponse, ctx: AcppHttpContext, agentId: string): true {
  const agent = ctx.store.get(agentId);
  if (!agent) {
    sendJson(res, 404, { error: `Agent '${agentId}' not found` });
    return true;
  }
  sendJson(res, 200, agent);
  return true;
}

function handleGetAgentHealth(res: ServerResponse, ctx: AcppHttpContext, agentId: string): true {
  const agent = ctx.store.get(agentId);
  if (!agent) {
    sendJson(res, 404, { error: `Agent '${agentId}' not found` });
    return true;
  }
  if (!ctx.healthPoller) {
    sendJson(res, 503, { error: "Health poller not configured" });
    return true;
  }
  const health = ctx.healthPoller.getLastHealth(agentId);
  if (!health) {
    sendJson(res, 200, { agentId, health: null, message: "No health data available yet" });
    return true;
  }
  sendJson(res, 200, { agentId, ...health });
  return true;
}

// ── SSE Handlers ────────────────────────────────────────────────

function handleActivityStreamAll(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AcppHttpContext,
): true {
  if (!ctx.activityAggregator) {
    sendJson(res, 503, { error: "Activity aggregator not configured" });
    return true;
  }
  setSseHeaders(res);
  const aggregator = ctx.activityAggregator;
  const listener = (agentId: string, event: unknown) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ agentId, ...(event as Record<string, unknown>) })}\n\n`);
    }
  };
  aggregator.subscribe(listener);

  // Keepalive every 30s
  const keepalive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(":keepalive\n\n");
    }
  }, 30_000);

  req.on("close", () => {
    aggregator.unsubscribe(listener);
    clearInterval(keepalive);
  });

  return true;
}

function handleActivityStreamAgent(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AcppHttpContext,
  agentId: string,
): true {
  if (!ctx.activityAggregator) {
    sendJson(res, 503, { error: "Activity aggregator not configured" });
    return true;
  }
  const agent = ctx.store.get(agentId);
  if (!agent) {
    sendJson(res, 404, { error: `Agent '${agentId}' not found` });
    return true;
  }
  setSseHeaders(res);
  const aggregator = ctx.activityAggregator;
  const listener = (eventAgentId: string, event: unknown) => {
    if (eventAgentId === agentId && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ agentId, ...(event as Record<string, unknown>) })}\n\n`);
    }
  };
  aggregator.subscribe(listener);

  const keepalive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(":keepalive\n\n");
    }
  }, 30_000);

  req.on("close", () => {
    aggregator.unsubscribe(listener);
    clearInterval(keepalive);
  });

  return true;
}

function handleActivityHistory(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AcppHttpContext,
  agentId: string,
): true {
  if (!ctx.activityAggregator) {
    sendJson(res, 503, { error: "Activity aggregator not configured" });
    return true;
  }
  const agent = ctx.store.get(agentId);
  if (!agent) {
    sendJson(res, 404, { error: `Agent '${agentId}' not found` });
    return true;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1000);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10) || 0;

  const events = ctx.activityAggregator.getHistory(agentId, limit, offset);
  sendJson(res, 200, { agentId, events, limit, offset });
  return true;
}
