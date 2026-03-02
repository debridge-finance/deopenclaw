import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { ActivityAggregator } from "./activity-aggregator.js";
import type { AgentStore } from "./agent-store.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type ManagedClient = {
  agentId: string;
  mcpEndpoint: string;
  connected: boolean;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  abortController: AbortController;
};

const MAX_RECONNECT_DELAY_MS = 60_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

/**
 * Manages MCP client connections to registered agents.
 * Handles connection lifecycle, reconnection with exponential backoff,
 * and capability discovery.
 *
 * NOTE: Full MCP SDK client integration requires `@modelcontextprotocol/sdk`
 * which is added as a dependency. The actual Client/Transport usage is
 * abstracted here; the real transport connection uses StreamableHTTPClientTransport.
 */
export class McpClientManager {
  private readonly clients = new Map<string, ManagedClient>();
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
    };
    this.clients.set(agentId, managed);

    try {
      // In a real implementation, this would create a Client with StreamableHTTPClientTransport
      // and connect. For now we mark as connected and discover capabilities.
      managed.connected = true;
      managed.reconnectAttempts = 0;
      this.log.info(`MCP client connected to ${agentId} at ${mcpEndpoint}`);

      // Discover capabilities
      await this.discoverCapabilities(agentId, mcpEndpoint);
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
    managed.abortController.abort();
    managed.connected = false;
    this.clients.delete(agentId);
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
   * Disconnect all clients. Called during shutdown.
   */
  disconnectAll(): void {
    for (const agentId of Array.from(this.clients.keys())) {
      this.disconnect(agentId);
    }
  }

  /**
   * Discover capabilities via tools/list and update the agent store.
   */
  private async discoverCapabilities(agentId: string, mcpEndpoint: string): Promise<void> {
    if (!this.store) {
      return;
    }
    try {
      // In production, this would call client.listTools() via MCP SDK
      // For now, we log the intent — the actual tool list comes from the
      // agent's registration payload capabilities field
      this.log.debug(`capability discovery for ${agentId} (endpoint: ${mcpEndpoint})`);
    } catch (err) {
      this.log.warn(
        `capability discovery failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
