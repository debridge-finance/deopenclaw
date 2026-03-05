import type { McpClientManager } from "./mcp-client-manager.js";

/**
 * Module-level singleton for accessing the McpClientManager from
 * tool creation code (pi-tools.ts) without threading it through
 * the entire options chain.
 *
 * Set once during gateway init (server-runtime-state.ts).
 */
let _mcpClientManager: McpClientManager | null = null;

export function setGlobalMcpClientManager(manager: McpClientManager): void {
  _mcpClientManager = manager;
}

export function getGlobalMcpClientManager(): McpClientManager | null {
  return _mcpClientManager;
}
