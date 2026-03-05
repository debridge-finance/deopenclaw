import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { ActivityAggregator } from "./activity-aggregator.js";
import type { AgentStore } from "./agent-store.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

/**
 * MCP tool definition as returned by tools/list.
 */
export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type ManagedClient = {
  agentId: string;
  mcpEndpoint: string;
  connected: boolean;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  abortController: AbortController;
  sseAbortController: AbortController | null;
};

const MAX_RECONNECT_DELAY_MS = 60_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

/**
 * Manages MCP client connections to registered agents.
 * Handles connection lifecycle, reconnection with exponential backoff,
 * and activity event forwarding via SSE.
 *
 * Uses native HTTP + SSE parsing (no extern SDK dependency).
 * Connects to each agent's MCP endpoint, sends an `initialize` request,
 * and subscribes to SSE notifications. Logging messages with activity
 * payloads are forwarded to the {@link ActivityAggregator}.
 */
export class McpClientManager {
  private readonly clients = new Map<string, ManagedClient>();
  private readonly agentTools = new Map<string, McpToolDefinition[]>();
  private readonly log: SubsystemLogger;
  private store: AgentStore | null = null;
  private activityAggregator: ActivityAggregator | null = null;

  constructor(log: SubsystemLogger) {
    this.log = log;
  }

  /**
   * Set references to store and aggregator. Called during ACPP init.
   */
  init(store: AgentStore, activityAggregator: ActivityAggregator): void {
    this.store = store;
    this.activityAggregator = activityAggregator;
  }

  /**
   * Connect to an agent's MCP endpoint.
   * Called after successful registration.
   */
  async connect(agentId: string, mcpEndpoint: string): Promise<void> {
    // Disconnect existing if re-registering
    this.disconnect(agentId);

    const ac = new AbortController();
    const managed: ManagedClient = {
      agentId,
      mcpEndpoint,
      connected: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      abortController: ac,
      sseAbortController: null,
    };
    this.clients.set(agentId, managed);

    try {
      // Send MCP initialize request
      await this.initializeMcpSession(managed);
      managed.connected = true;
      managed.reconnectAttempts = 0;
      this.log.info(`MCP client connected to ${agentId} at ${mcpEndpoint}`);

      // Discover agent's MCP tools
      await this.discoverTools(managed);

      // Start SSE listener for notifications
      this.startSseListener(managed);
    } catch (err) {
      managed.connected = false;
      this.log.warn(
        `MCP client failed to connect to ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleReconnect(agentId);
    }
  }

  /**
   * Disconnect from an agent's MCP endpoint.
   */
  disconnect(agentId: string): void {
    const managed = this.clients.get(agentId);
    if (!managed) {
      return;
    }

    if (managed.reconnectTimer) {
      clearTimeout(managed.reconnectTimer);
      managed.reconnectTimer = null;
    }
    if (managed.sseAbortController) {
      managed.sseAbortController.abort();
      managed.sseAbortController = null;
    }
    managed.abortController.abort();
    managed.connected = false;
    this.clients.delete(agentId);
    this.agentTools.delete(agentId);
    this.log.info(`MCP client disconnected from ${agentId}`);
  }

  /**
   * Get connection status for an agent.
   */
  isConnected(agentId: string): boolean {
    return this.clients.get(agentId)?.connected ?? false;
  }

  /**
   * Get all connected agent IDs.
   */
  getConnectedAgentIds(): string[] {
    return Array.from(this.clients.entries())
      .filter(([, c]) => c.connected)
      .map(([id]) => id);
  }

  /**
   * Get discovered MCP tool definitions for an agent.
   */
  getAgentTools(agentId: string): McpToolDefinition[] {
    return this.agentTools.get(agentId) ?? [];
  }

  /**
   * Proxy a tool call to the agent's MCP endpoint.
   * Sends a `tools/call` JSON-RPC request and returns the result.
   */
  async callAgentTool(
    agentId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const managed = this.clients.get(agentId);
    if (!managed?.connected) {
      return {
        content: [{ type: "text", text: `Agent ${agentId} is not connected` }],
        isError: true,
      };
    }

    const payload = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    };

    try {
      const response = await fetch(managed.mcpEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000), // 2 min timeout for tool calls
      });

      if (!response.ok) {
        return {
          content: [{ type: "text", text: `MCP tools/call failed: HTTP ${response.status}` }],
          isError: true,
        };
      }

      const contentType = response.headers.get("content-type") ?? "";

      // Handle SSE response (Streamable HTTP transport)
      if (contentType.includes("text/event-stream")) {
        return await this.parseSseToolResponse(response);
      }

      // Handle plain JSON response
      const result = (await response.json()) as {
        jsonrpc: string;
        id: number;
        result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
        error?: { code: number; message: string };
      };

      if (result.error) {
        return {
          content: [{ type: "text", text: `MCP error: ${result.error.message}` }],
          isError: true,
        };
      }

      return result.result ?? { content: [{ type: "text", text: "No result" }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `MCP tools/call error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * Disconnect all clients. Called during shutdown.
   */
  disconnectAll(): void {
    for (const agentId of Array.from(this.clients.keys())) {
      this.disconnect(agentId);
    }
  }

  /**
   * Send MCP `initialize` JSON-RPC request to set up the session.
   */
  private async initializeMcpSession(managed: ManagedClient): Promise<void> {
    const initPayload = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "deopenclaw-gateway",
          version: "1.0.0",
        },
      },
    };

    const response = await fetch(managed.mcpEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initPayload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`MCP initialize failed: HTTP ${response.status}`);
    }

    // Parse session ID from response headers (Mcp-Session-Id)
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      this.log.debug(`MCP session established for ${managed.agentId}: ${sessionId}`);
    }

    // Read and discard the response body
    await response.text();
  }

  /**
   * Discover agent's available MCP tools via `tools/list`.
   */
  private async discoverTools(managed: ManagedClient): Promise<void> {
    const payload = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    };

    try {
      const response = await fetch(managed.mcpEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        this.log.warn(`tools/list failed for ${managed.agentId}: HTTP ${response.status}`);
        return;
      }

      const result = (await response.json()) as {
        result?: { tools?: McpToolDefinition[] };
      };

      const tools = result?.result?.tools ?? [];
      this.agentTools.set(managed.agentId, tools);
      this.log.info(
        `discovered ${tools.length} MCP tools for ${managed.agentId}: ${tools.map((t) => t.name).join(", ")}`,
      );
    } catch (err) {
      this.log.warn(
        `tools/list error for ${managed.agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Parse SSE response from tools/call (Streamable HTTP transport).
   */
  private async parseSseToolResponse(
    response: Response,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const body = response.body;
    if (!body) {
      return { content: [{ type: "text", text: "Empty SSE response" }], isError: true };
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastResult: { content: Array<{ type: string; text: string }>; isError?: boolean } | null =
      null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const eventBlock of events) {
          let data = "";
          for (const line of eventBlock.split("\n")) {
            if (line.startsWith("data:")) {
              data += line.slice(5).trim();
            }
          }
          if (!data) {
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed?.result) {
              lastResult = parsed.result;
            }
          } catch {
            // skip
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return lastResult ?? { content: [{ type: "text", text: "No result in SSE stream" }] };
  }

  /**
   * Start listening for SSE notifications from the agent.
   * The Streamable HTTP transport sends notifications as SSE events
   * on a GET request to the MCP endpoint.
   */
  private startSseListener(managed: ManagedClient): void {
    const sseAc = new AbortController();
    managed.sseAbortController = sseAc;

    // Fire-and-forget — the SSE stream runs in background
    void this.listenSse(managed, sseAc.signal).catch((err) => {
      if (sseAc.signal.aborted) {
        return; // Expected on disconnect
      }
      this.log.warn(
        `SSE listener for ${managed.agentId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      managed.connected = false;
      this.scheduleReconnect(managed.agentId);
    });
  }

  /**
   * Open an SSE connection to the agent's MCP endpoint via GET.
   * Parse incoming events and forward activity logging messages
   * to the ActivityAggregator.
   */
  private async listenSse(managed: ManagedClient, signal: AbortSignal): Promise<void> {
    const response = await fetch(managed.mcpEndpoint, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
      },
      signal,
    });

    if (!response.ok) {
      // SSE may not be supported by all agents — that's OK
      this.log.debug(
        `SSE not available for ${managed.agentId} (HTTP ${response.status}), activity streaming disabled`,
      );
      return;
    }

    const body = response.body;
    if (!body) {
      return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (separated by double newline)
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const eventBlock of events) {
          this.processSseEvent(managed.agentId, eventBlock);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse a single SSE event block and forward activity data.
   */
  private processSseEvent(agentId: string, eventBlock: string): void {
    let eventType = "message";
    let data = "";

    for (const line of eventBlock.split("\n")) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }

    if (eventType !== "message" || !data) {
      return;
    }

    try {
      const parsed = JSON.parse(data);

      // MCP JSON-RPC notification: {"jsonrpc":"2.0","method":"notifications/message","params":{...}}
      if (
        parsed?.jsonrpc === "2.0" &&
        parsed?.method === "notifications/message" &&
        parsed?.params?.data
      ) {
        const logData = parsed.params.data;
        if (this.activityAggregator) {
          this.activityAggregator.handleNotification(agentId, logData);
        }
      }
    } catch {
      // Ignore non-JSON SSE data
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(agentId: string): void {
    const managed = this.clients.get(agentId);
    if (!managed) {
      return;
    }

    // Check if agent is still registered
    if (this.store) {
      const record = this.store.get(agentId);
      if (!record || record.status === "DEREGISTERED") {
        this.log.debug(`skipping reconnect for deregistered agent ${agentId}`);
        this.clients.delete(agentId);
        return;
      }
    }

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, managed.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );
    managed.reconnectAttempts++;

    this.log.info(
      `scheduling MCP reconnect for ${agentId} in ${delay}ms (attempt ${managed.reconnectAttempts})`,
    );
    managed.reconnectTimer = setTimeout(() => {
      void this.connect(agentId, managed.mcpEndpoint);
    }, delay);
  }
}
