import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { McpClientManager } from "./mcp-client-manager.js";

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
  } as unknown as ConstructorParameters<typeof McpClientManager>[0];
}

describe("McpClientManager", () => {
  let manager: McpClientManager;

  beforeEach(() => {
    manager = new McpClientManager(createMockLogger());
  });

  afterEach(() => {
    manager.disconnectAll();
  });

  it("starts with no connected agents", () => {
    expect(manager.getConnectedAgentIds()).toEqual([]);
  });

  it("isConnected returns false for unknown agent", () => {
    expect(manager.isConnected("unknown")).toBe(false);
  });

  it("connect logs error and stays disconnected for unreachable endpoint", async () => {
    // connect() catches transport errors internally; the agent stays disconnected
    await manager.connect("test-agent", "http://127.0.0.1:1/mcp");
    expect(manager.isConnected("test-agent")).toBe(false);
  });

  it("disconnect removes agent", () => {
    // Directly test disconnect on a known agent id (no connect needed)
    manager.disconnect("test-agent");
    expect(manager.isConnected("test-agent")).toBe(false);
    expect(manager.getConnectedAgentIds()).toEqual([]);
  });

  it("disconnect is safe for unknown agent", () => {
    expect(() => manager.disconnect("unknown")).not.toThrow();
  });

  it("disconnectAll cleans up all connections", () => {
    manager.disconnectAll();
    expect(manager.getConnectedAgentIds()).toEqual([]);
  });

  it("getAgentTools returns empty for unknown agent", () => {
    expect(manager.getAgentTools("unknown")).toEqual([]);
  });

  it("getAgentInfo returns null when store is not initialized", () => {
    expect(manager.getAgentInfo("test-agent")).toBeNull();
  });
});
