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

  describe("streamAgentTask", () => {
    /**
     * Helper: create a managed client entry so streamAgentTask can look it up.
     * We poke into the private `clients` map via an unsafe cast.
     */
    function injectConnectedClient(
      mgr: McpClientManager,
      agentId: string,
      mcpEndpoint: string,
    ): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clients = (mgr as any).clients as Map<string, unknown>;
      clients.set(agentId, {
        agentId,
        mcpEndpoint,
        connected: true,
        mcpSessionId: null,
        reconnectAttempts: 0,
        reconnectTimer: null,
        abortController: new AbortController(),
        sseAbortController: null,
      });
    }

    /** Encode a string into a ReadableStream of Uint8Array chunks. */
    function sseStream(raw: string): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(raw));
          controller.close();
        },
      });
    }

    it("throws when agent is not connected", async () => {
      const gen = manager.streamAgentTask("unknown-agent", "task-1");
      await expect(gen.next()).rejects.toThrow("Agent unknown-agent is not connected");
    });

    it("yields parsed SSE events", async () => {
      injectConnectedClient(manager, "a1", "http://localhost:3001/mcp");

      const ssePayload =
        `event: message\ndata: ${JSON.stringify({ type: "text-delta", text: "hello" })}\n\n` +
        `event: message\ndata: ${JSON.stringify({ type: "finish" })}\n\n`;

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          body: sseStream(ssePayload),
        }),
      );

      const events: unknown[] = [];
      for await (const ev of manager.streamAgentTask("a1", "task-1")) {
        events.push(ev);
      }

      expect(events).toEqual([{ type: "text-delta", text: "hello" }, { type: "finish" }]);

      // Verify correct URL was called
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "http://localhost:3001/acpp/stream/task-1",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("skips heartbeat comments", async () => {
      injectConnectedClient(manager, "a1", "http://localhost:3001/mcp");

      const ssePayload =
        `: heartbeat\n\n` +
        `data: ${JSON.stringify({ type: "text-delta", text: "hi" })}\n\n` +
        `: heartbeat\n\n`;

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          body: sseStream(ssePayload),
        }),
      );

      const events: unknown[] = [];
      for await (const ev of manager.streamAgentTask("a1", "t1")) {
        events.push(ev);
      }

      expect(events).toEqual([{ type: "text-delta", text: "hi" }]);
    });

    it("throws on non-200 response", async () => {
      injectConnectedClient(manager, "a1", "http://localhost:3001/mcp");

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, body: null }));

      const gen = manager.streamAgentTask("a1", "t1");
      await expect(gen.next()).rejects.toThrow("Stream endpoint returned HTTP 500");
    });

    it("passes AbortSignal to fetch", async () => {
      injectConnectedClient(manager, "a1", "http://localhost:3001/mcp");

      const ac = new AbortController();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          body: sseStream(`data: ${JSON.stringify({ type: "finish" })}\n\n`),
        }),
      );

      const events: unknown[] = [];
      for await (const ev of manager.streamAgentTask("a1", "t1", ac.signal)) {
        events.push(ev);
      }

      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: ac.signal }),
      );
    });
  });
});
