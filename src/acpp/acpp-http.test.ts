import { createServer, type Server } from "node:http";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { handleAcppHttpRequest, type AcppHttpContext } from "./acpp-http.js";
import { AgentStore } from "./agent-store.js";

// Minimal logger mock
function createMockLogger() {
  return {
    subsystem: "acpp-test",
    isEnabled: () => false,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => createMockLogger(),
  } as unknown as AcppHttpContext["log"];
}

function createTestContext(overrides: Partial<AcppHttpContext> = {}): AcppHttpContext {
  return {
    store: new AgentStore({ heartbeatIntervalMs: 30_000 }),
    apiKey: "test-api-key",
    log: createMockLogger(),
    ...overrides,
  };
}

function validRegistration(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "test-agent",
    name: "Test Agent",
    description: "A test agent",
    mcpEndpoint: "http://localhost:3000/mcp",
    healthEndpoint: "http://localhost:3000/healthz",
    protocolVersion: "1.0",
    capabilities: ["test_tool"],
    ...overrides,
  };
}

// HTTP test helpers
function makeRequest(
  server: Server,
  opts: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      reject(new Error("Server not listening"));
      return;
    }
    const url = `http://127.0.0.1:${addr.port}${opts.path}`;
    const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = {
      ...opts.headers,
    };
    if (bodyStr) {
      headers["content-type"] = "application/json";
    }

    void fetch(url, {
      method: opts.method,
      headers,
      body: bodyStr,
    })
      .then(async (res) => {
        const text = await res.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        resolve({ status: res.status, body, headers: responseHeaders });
      })
      .catch(reject);
  });
}

describe("ACPP HTTP Routes", () => {
  let server: Server;
  let ctx: AcppHttpContext;

  beforeEach(async () => {
    ctx = createTestContext();

    server = createServer((req, res) => {
      void handleAcppHttpRequest(req, res, ctx).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end("Not Found");
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  // ── Auth ───────────────────────────────────────────────────────

  describe("authentication", () => {
    it("rejects request without X-API-Key", async () => {
      const res = await makeRequest(server, {
        method: "GET",
        path: "/api/v1/agents",
      });
      expect(res.status).toBe(401);
    });

    it("rejects request with wrong X-API-Key", async () => {
      const res = await makeRequest(server, {
        method: "GET",
        path: "/api/v1/agents",
        headers: { "x-api-key": "wrong-key" },
      });
      expect(res.status).toBe(401);
    });

    it("accepts request with correct X-API-Key", async () => {
      const res = await makeRequest(server, {
        method: "GET",
        path: "/api/v1/agents",
        headers: { "x-api-key": "test-api-key" },
      });
      expect(res.status).toBe(200);
    });

    it("returns 500 if ACPP_API_KEY is not configured", async () => {
      ctx.apiKey = undefined;
      const res = await makeRequest(server, {
        method: "GET",
        path: "/api/v1/agents",
        headers: { "x-api-key": "anything" },
      });
      expect(res.status).toBe(500);
    });
  });

  // ── Registration ──────────────────────────────────────────────

  describe("POST /api/v1/agents/register", () => {
    it("registers a new agent with 201", async () => {
      const res = await makeRequest(server, {
        method: "POST",
        path: "/api/v1/agents/register",
        headers: { "x-api-key": "test-api-key" },
        body: validRegistration(),
      });
      expect(res.status).toBe(201);
      expect((res.body as Record<string, unknown>).registered).toBe(true);
      expect((res.body as Record<string, unknown>).agentId).toBe("test-agent");
    });

    it("re-registers with 200 and updated=true", async () => {
      await makeRequest(server, {
        method: "POST",
        path: "/api/v1/agents/register",
        headers: { "x-api-key": "test-api-key" },
        body: validRegistration(),
      });
      const res = await makeRequest(server, {
        method: "POST",
        path: "/api/v1/agents/register",
        headers: { "x-api-key": "test-api-key" },
        body: validRegistration({ name: "Updated" }),
      });
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).updated).toBe(true);
    });

    it("rejects invalid payload with 422", async () => {
      const res = await makeRequest(server, {
        method: "POST",
        path: "/api/v1/agents/register",
        headers: { "x-api-key": "test-api-key" },
        body: { agentId: "BAD AGENT" },
      });
      expect(res.status).toBe(422);
    });
  });

  // ── List Agents ───────────────────────────────────────────────

  describe("GET /api/v1/agents", () => {
    it("returns empty list when no agents", async () => {
      const res = await makeRequest(server, {
        method: "GET",
        path: "/api/v1/agents",
        headers: { "x-api-key": "test-api-key" },
      });
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).agents).toEqual([]);
    });

    it("lists registered agents", async () => {
      ctx.store.register(validRegistration());
      const res = await makeRequest(server, {
        method: "GET",
        path: "/api/v1/agents",
        headers: { "x-api-key": "test-api-key" },
      });
      expect(res.status).toBe(200);
      const body = res.body as { agents: Array<{ agentId: string }> };
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].agentId).toBe("test-agent");
    });
  });

  // ── Get Single Agent ──────────────────────────────────────────

  describe("GET /api/v1/agents/:agentId", () => {
    it("returns agent details", async () => {
      ctx.store.register(validRegistration());
      const res = await makeRequest(server, {
        method: "GET",
        path: "/api/v1/agents/test-agent",
        headers: { "x-api-key": "test-api-key" },
      });
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).agentId).toBe("test-agent");
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await makeRequest(server, {
        method: "GET",
        path: "/api/v1/agents/nonexistent",
        headers: { "x-api-key": "test-api-key" },
      });
      expect(res.status).toBe(404);
    });
  });

  // ── Update Agent ──────────────────────────────────────────────

  describe("PUT /api/v1/agents/:agentId", () => {
    it("updates an existing agent", async () => {
      ctx.store.register(validRegistration());
      const res = await makeRequest(server, {
        method: "PUT",
        path: "/api/v1/agents/test-agent",
        headers: { "x-api-key": "test-api-key" },
        body: validRegistration({ description: "Updated" }),
      });
      expect(res.status).toBe(200);
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await makeRequest(server, {
        method: "PUT",
        path: "/api/v1/agents/nonexistent",
        headers: { "x-api-key": "test-api-key" },
        body: validRegistration({ agentId: "nonexistent" }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ── Deregister ────────────────────────────────────────────────

  describe("DELETE /api/v1/agents/:agentId", () => {
    it("deregisters an agent", async () => {
      ctx.store.register(validRegistration());
      const res = await makeRequest(server, {
        method: "DELETE",
        path: "/api/v1/agents/test-agent",
        headers: {
          "x-api-key": "test-api-key",
          "x-deregister-reason": "shutdown",
        },
      });
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).deregistered).toBe(true);
      expect(ctx.store.get("test-agent")?.status).toBe("DEREGISTERED");
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await makeRequest(server, {
        method: "DELETE",
        path: "/api/v1/agents/nonexistent",
        headers: { "x-api-key": "test-api-key" },
      });
      expect(res.status).toBe(404);
    });
  });

  // ── Heartbeat ─────────────────────────────────────────────────

  describe("POST /api/v1/agents/heartbeat", () => {
    it("processes a valid heartbeat", async () => {
      ctx.store.register(validRegistration());
      const res = await makeRequest(server, {
        method: "POST",
        path: "/api/v1/agents/heartbeat",
        headers: { "x-api-key": "test-api-key" },
        body: {
          agentId: "test-agent",
          timestamp: new Date().toISOString(),
          state: "idle",
        },
      });
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).ack).toBe(true);
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await makeRequest(server, {
        method: "POST",
        path: "/api/v1/agents/heartbeat",
        headers: { "x-api-key": "test-api-key" },
        body: {
          agentId: "nonexistent",
          timestamp: new Date().toISOString(),
          state: "idle",
        },
      });
      expect(res.status).toBe(404);
    });

    it("returns 422 for invalid payload", async () => {
      const res = await makeRequest(server, {
        method: "POST",
        path: "/api/v1/agents/heartbeat",
        headers: { "x-api-key": "test-api-key" },
        body: { agentId: "test-agent" },
      });
      expect(res.status).toBe(422);
    });
  });

  // ── 404 for unknown ACPP paths ────────────────────────────────

  describe("unknown paths", () => {
    it("returns 404 for unknown ACPP path", async () => {
      const res = await makeRequest(server, {
        method: "GET",
        path: "/api/v1/agents/test-agent/unknown",
        headers: { "x-api-key": "test-api-key" },
      });
      expect(res.status).toBe(404);
    });

    it("does not handle non-ACPP paths", async () => {
      const res = await makeRequest(server, {
        method: "GET",
        path: "/api/v1/other",
        headers: { "x-api-key": "test-api-key" },
      });
      expect(res.status).toBe(404);
      expect(res.body).toBe("Not Found");
    });
  });
});
