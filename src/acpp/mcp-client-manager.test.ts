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

  it("connect marks agent as connected", async () => {
    await manager.connect("test-agent", "http://localhost:3000/mcp");
    expect(manager.isConnected("test-agent")).toBe(true);
    expect(manager.getConnectedAgentIds()).toEqual(["test-agent"]);
  });

  it("disconnect removes agent", async () => {
    await manager.connect("test-agent", "http://localhost:3000/mcp");
    manager.disconnect("test-agent");
    expect(manager.isConnected("test-agent")).toBe(false);
    expect(manager.getConnectedAgentIds()).toEqual([]);
  });

  it("disconnect is safe for unknown agent", () => {
    expect(() => manager.disconnect("unknown")).not.toThrow();
  });

  it("reconnect replaces existing connection", async () => {
    await manager.connect("test-agent", "http://localhost:3000/mcp");
    await manager.connect("test-agent", "http://localhost:4000/mcp");
    expect(manager.isConnected("test-agent")).toBe(true);
  });

  it("disconnectAll cleans up all connections", async () => {
    await manager.connect("agent-1", "http://localhost:3001/mcp");
    await manager.connect("agent-2", "http://localhost:3002/mcp");
    manager.disconnectAll();
    expect(manager.getConnectedAgentIds()).toEqual([]);
  });
});
