import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import type { AcppHttpContext } from "../acpp/acpp-http.js";
import { ActivityAggregator } from "../acpp/activity-aggregator.js";
import { AgentStore } from "../acpp/agent-store.js";
import { AgentHealthPoller } from "../acpp/health-poller.js";
import { McpClientManager } from "../acpp/mcp-client-manager.js";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import { type CanvasHostHandler, createCanvasHostHandler } from "../canvas-host/server.js";
import type { CliDeps } from "../cli/deps.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { RuntimeEnv } from "../runtime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { ControlUiRootState } from "./control-ui.js";
import type { HooksConfigResolved } from "./hooks.js";
import { isLoopbackHost, resolveGatewayListenHosts } from "./net.js";
import {
  createGatewayBroadcaster,
  type GatewayBroadcastFn,
  type GatewayBroadcastToConnIdsFn,
} from "./server-broadcast.js";
import {
  type ChatRunEntry,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat.js";
import { MAX_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import type { DedupeEntry } from "./server-shared.js";
import { createGatewayHooksRequestHandler } from "./server/hooks.js";
import { listenGatewayHttpServer } from "./server/http-listen.js";
import {
  createGatewayPluginRequestHandler,
  shouldEnforceGatewayAuthForPluginPath,
  type PluginRoutePathContext,
} from "./server/plugins-http.js";
import type { GatewayTlsRuntime } from "./server/tls.js";
import type { GatewayWsClient } from "./server/ws-types.js";

export async function createGatewayRuntimeState(params: {
  cfg: import("../config/config.js").OpenClawConfig;
  bindHost: string;
  port: number;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  strictTransportSecurityHeader?: string;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  gatewayTls?: GatewayTlsRuntime;
  hooksConfig: () => HooksConfigResolved | null;
  pluginRegistry: PluginRegistry;
  deps: CliDeps;
  canvasRuntime: RuntimeEnv;
  canvasHostEnabled: boolean;
  allowCanvasHostInTests?: boolean;
  logCanvas: { info: (msg: string) => void; warn: (msg: string) => void };
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  logHooks: ReturnType<typeof createSubsystemLogger>;
  logPlugins: ReturnType<typeof createSubsystemLogger>;
}): Promise<{
  canvasHost: CanvasHostHandler | null;
  httpServer: HttpServer;
  httpServers: HttpServer[];
  httpBindHosts: string[];
  wss: WebSocketServer;
  clients: Set<GatewayWsClient>;
  broadcast: GatewayBroadcastFn;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  agentRunSeq: Map<string, number>;
  dedupe: Map<string, DedupeEntry>;
  chatRunState: ReturnType<typeof createChatRunState>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  addChatRun: (sessionId: string, entry: ChatRunEntry) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  toolEventRecipients: ReturnType<typeof createToolEventRecipientRegistry>;
  acppAgentStore?: AgentStore;
}> {
  let canvasHost: CanvasHostHandler | null = null;
  if (params.canvasHostEnabled) {
    try {
      const handler = await createCanvasHostHandler({
        runtime: params.canvasRuntime,
        rootDir: params.cfg.canvasHost?.root,
        basePath: CANVAS_HOST_PATH,
        allowInTests: params.allowCanvasHostInTests,
        liveReload: params.cfg.canvasHost?.liveReload,
      });
      if (handler.rootDir) {
        canvasHost = handler;
        params.logCanvas.info(
          `canvas host mounted at http://${params.bindHost}:${params.port}${CANVAS_HOST_PATH}/ (root ${handler.rootDir})`,
        );
      }
    } catch (err) {
      params.logCanvas.warn(`canvas host failed to start: ${String(err)}`);
    }
  }

  const clients = new Set<GatewayWsClient>();
  const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

  const handleHooksRequest = createGatewayHooksRequestHandler({
    deps: params.deps,
    getHooksConfig: params.hooksConfig,
    bindHost: params.bindHost,
    port: params.port,
    logHooks: params.logHooks,
  });

  const handlePluginRequest = createGatewayPluginRequestHandler({
    registry: params.pluginRegistry,
    log: params.logPlugins,
  });
  const shouldEnforcePluginGatewayAuth = (pathContext: PluginRoutePathContext): boolean => {
    return shouldEnforceGatewayAuthForPluginPath(params.pluginRegistry, pathContext);
  };

  const bindHosts = await resolveGatewayListenHosts(params.bindHost);
  if (!isLoopbackHost(params.bindHost)) {
    params.log.warn(
      "⚠️  Gateway is binding to a non-loopback address. " +
        "Ensure authentication is configured before exposing to public networks.",
    );
  }
  if (params.cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true) {
    params.log.warn(
      "⚠️  gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true is enabled. " +
        "Host-header origin fallback weakens origin checks and should only be used as break-glass.",
    );
  }
  const acppApiKey = params.cfg.acpp?.apiKey ?? process.env.ACPP_API_KEY;
  const acppHeartbeatIntervalMs =
    params.cfg.acpp?.heartbeatIntervalMs ??
    (parseInt(process.env.ACPP_HEARTBEAT_INTERVAL_MS ?? "30000", 10) || 30_000);
  const acppHealthPollIntervalMs =
    params.cfg.acpp?.healthPollIntervalMs ??
    (parseInt(process.env.ACPP_HEALTH_POLL_INTERVAL_MS ?? "60000", 10) || 60_000);

  let acppContext: AcppHttpContext | undefined;
  let acppAgentStore: AgentStore | undefined;
  let _acppHeartbeatTimer: ReturnType<typeof setInterval> | undefined;

  if (acppApiKey) {
    const logAcpp = createSubsystemLogger("acpp");
    acppAgentStore = new AgentStore({ heartbeatIntervalMs: acppHeartbeatIntervalMs });
    const healthPoller = new AgentHealthPoller(logAcpp);
    const activityAggregator = new ActivityAggregator(logAcpp);

    healthPoller.start(acppAgentStore, acppHealthPollIntervalMs);
    _acppHeartbeatTimer = setInterval(() => {
      const transitions = acppAgentStore!.checkMissedHeartbeats();
      for (const t of transitions) {
        logAcpp.info(`agent ${t.agentId}: ${t.from} → ${t.to}`);
      }
    }, acppHeartbeatIntervalMs);

    const mcpClientManager = new McpClientManager(logAcpp);
    mcpClientManager.init(acppAgentStore, activityAggregator);
    // Register singleton so tool-creation code (pi-tools) can access MCP proxy tools
    const { setGlobalMcpClientManager } = await import("../acpp/mcp-client-singleton.js");
    setGlobalMcpClientManager(mcpClientManager);

    acppContext = {
      store: acppAgentStore,
      apiKey: acppApiKey,
      log: logAcpp,
      healthPoller,
      activityAggregator,
      mcpClientManager,
    };
    logAcpp.info(
      `ACPP module enabled (heartbeat: ${acppHeartbeatIntervalMs}ms, health poll: ${acppHealthPollIntervalMs}ms)`,
    );
  }

  const httpServers: HttpServer[] = [];
  const httpBindHosts: string[] = [];
  for (const host of bindHosts) {
    const httpServer = createGatewayHttpServer({
      canvasHost,
      clients,
      controlUiEnabled: params.controlUiEnabled,
      controlUiBasePath: params.controlUiBasePath,
      controlUiRoot: params.controlUiRoot,
      openAiChatCompletionsEnabled: params.openAiChatCompletionsEnabled,
      openResponsesEnabled: params.openResponsesEnabled,
      openResponsesConfig: params.openResponsesConfig,
      strictTransportSecurityHeader: params.strictTransportSecurityHeader,
      handleHooksRequest,
      handlePluginRequest,
      shouldEnforcePluginGatewayAuth,
      resolvedAuth: params.resolvedAuth,
      rateLimiter: params.rateLimiter,
      tlsOptions: params.gatewayTls?.enabled ? params.gatewayTls.tlsOptions : undefined,
      acppContext,
    });
    try {
      await listenGatewayHttpServer({
        httpServer,
        bindHost: host,
        port: params.port,
      });
      httpServers.push(httpServer);
      httpBindHosts.push(host);
    } catch (err) {
      if (host === bindHosts[0]) {
        throw err;
      }
      params.log.warn(
        `gateway: failed to bind loopback alias ${host}:${params.port} (${String(err)})`,
      );
    }
  }
  const httpServer = httpServers[0];
  if (!httpServer) {
    throw new Error("Gateway HTTP server failed to start");
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  for (const server of httpServers) {
    attachGatewayUpgradeHandler({
      httpServer: server,
      wss,
      canvasHost,
      clients,
      resolvedAuth: params.resolvedAuth,
      rateLimiter: params.rateLimiter,
    });
  }

  const agentRunSeq = new Map<string, number>();
  const dedupe = new Map<string, DedupeEntry>();
  const chatRunState = createChatRunState();
  const chatRunRegistry = chatRunState.registry;
  const chatRunBuffers = chatRunState.buffers;
  const chatDeltaSentAt = chatRunState.deltaSentAt;
  const addChatRun = chatRunRegistry.add;
  const removeChatRun = chatRunRegistry.remove;
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const toolEventRecipients = createToolEventRecipientRegistry();

  return {
    canvasHost,
    httpServer,
    httpServers,
    httpBindHosts,
    wss,
    clients,
    broadcast,
    broadcastToConnIds,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    toolEventRecipients,
    acppAgentStore,
  };
}
