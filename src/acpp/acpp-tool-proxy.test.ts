import { describe, it, expect, vi } from "vitest";
import { createAcppProxyTools, streamTaskResult, fetchFinalResult } from "./acpp-tool-proxy.js";
import type { McpClientManager } from "./mcp-client-manager.js";

/** Minimal mock of McpClientManager with the methods used by acpp-tool-proxy. */
function createMockClientManager(overrides?: Partial<McpClientManager>): McpClientManager {
  return {
    callAgentTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"status":"accepted"}' }],
      isError: false,
    }),
    streamAgentTask: vi.fn(),
    ...overrides,
  } as unknown as McpClientManager;
}

/** Create an async generator from an array of events. */
async function* fakeStream(events: Array<{ type: string; [k: string]: unknown }>) {
  for (const e of events) {
    yield e;
  }
}

describe("streamTaskResult", () => {
  it("streams text-delta events and calls onUpdate with accumulated text", async () => {
    const onUpdate = vi.fn();
    const cm = createMockClientManager({
      streamAgentTask: vi
        .fn()
        .mockReturnValue(
          fakeStream([
            { type: "text-delta", text: "Hello " },
            { type: "text-delta", text: "world" },
            { type: "finish" },
          ]),
        ),
      callAgentTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"status":"completed","result":{"summary":"done"}}' }],
        isError: false,
      }),
    });

    const result = await streamTaskResult(cm, "scout-agent", "task-1", onUpdate);

    // onUpdate called for each text-delta
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenNthCalledWith(1, {
      content: [{ type: "text", text: "Hello " }],
      details: { agentId: "scout-agent", taskId: "task-1", phase: "streaming" },
    });
    expect(onUpdate).toHaveBeenNthCalledWith(2, {
      content: [{ type: "text", text: "Hello world" }],
      details: { agentId: "scout-agent", taskId: "task-1", phase: "streaming" },
    });

    // Final result fetched from acpp_get_task_result
    // oxlint-disable-next-line typescript/unbound-method
    expect(vi.mocked(cm.callAgentTool)).toHaveBeenCalledWith(
      "scout-agent",
      "acpp_get_task_result",
      {
        taskId: "task-1",
      },
    );
    expect(result).toContain("completed");
  });

  it("emits tool-call onUpdate events", async () => {
    const onUpdate = vi.fn();
    const cm = createMockClientManager({
      streamAgentTask: vi
        .fn()
        .mockReturnValue(
          fakeStream([{ type: "tool-call", toolName: "search_repos" }, { type: "finish" }]),
        ),
      callAgentTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"status":"completed"}' }],
      }),
    });

    await streamTaskResult(cm, "scout-agent", "task-1", onUpdate);

    expect(onUpdate).toHaveBeenCalledWith({
      content: [{ type: "text", text: "🔧 scout-agent: search_repos..." }],
      details: {
        agentId: "scout-agent",
        taskId: "task-1",
        phase: "tool-call",
        toolName: "search_repos",
      },
    });
  });

  it("emits step-finish onUpdate events", async () => {
    const onUpdate = vi.fn();
    const cm = createMockClientManager({
      streamAgentTask: vi
        .fn()
        .mockReturnValue(
          fakeStream([{ type: "step-finish", stepIndex: 2, elapsed: "12s" }, { type: "finish" }]),
        ),
      callAgentTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"status":"completed"}' }],
      }),
    });

    await streamTaskResult(cm, "scout-agent", "task-1", onUpdate);

    expect(onUpdate).toHaveBeenCalledWith({
      content: [{ type: "text", text: "📍 Step 2 (12s)" }],
      details: { agentId: "scout-agent", taskId: "task-1", phase: "step", stepIndex: 2 },
    });
  });

  it("falls back to polling when stream throws immediately", async () => {
    const cm = createMockClientManager({
      streamAgentTask: vi.fn().mockImplementation(function () {
        // oxlint-disable-next-line require-yield
        return (async function* () {
          throw new Error("SSE not available");
        })();
      }),
      callAgentTool: vi
        .fn()
        .mockResolvedValueOnce({
          content: [{ type: "text", text: '{"status":"running"}' }],
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: '{"status":"completed","result":"ok"}' }],
        }),
    });

    // Use fake timers to avoid waiting for real poll intervals
    vi.useFakeTimers();
    const promise = streamTaskResult(cm, "scout-agent", "task-1");

    // Advance past first poll interval
    await vi.advanceTimersByTimeAsync(5_001);
    // Second poll completes the task
    await vi.advanceTimersByTimeAsync(5_001);

    const result = await promise;
    expect(result).toContain("completed");
    vi.useRealTimers();
  });

  it("works without onUpdate callback", async () => {
    const cm = createMockClientManager({
      streamAgentTask: vi
        .fn()
        .mockReturnValue(fakeStream([{ type: "text-delta", text: "hi" }, { type: "finish" }])),
      callAgentTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"status":"completed","result":"hi"}' }],
      }),
    });

    // Should not throw even without onUpdate
    const result = await streamTaskResult(cm, "agent", "t1");
    expect(result).toContain("completed");
  });
});

describe("fetchFinalResult", () => {
  it("returns poll result text when available", async () => {
    const cm = createMockClientManager({
      callAgentTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "final answer" }],
      }),
    });

    const result = await fetchFinalResult(cm, "agent", "task-1", "fallback");
    expect(result).toBe("final answer");
  });

  it("returns fallback text when poll returns empty", async () => {
    const cm = createMockClientManager({
      callAgentTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "" }],
      }),
    });

    const result = await fetchFinalResult(cm, "agent", "task-1", "fallback text");
    expect(result).toBe("fallback text");
  });

  it("returns JSON with summary when poll throws and fallback exists", async () => {
    const cm = createMockClientManager({
      callAgentTool: vi.fn().mockRejectedValue(new Error("network error")),
    });

    const result = await fetchFinalResult(cm, "agent", "task-1", "partial text");
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("completed");
    expect(parsed.result.summary).toBe("partial text");
  });

  it("returns failed JSON when poll throws and no fallback", async () => {
    const cm = createMockClientManager({
      callAgentTool: vi.fn().mockRejectedValue(new Error("network error")),
    });

    const result = await fetchFinalResult(cm, "agent", "task-1", "");
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("failed");
  });
});

describe("createAcppProxyTools", () => {
  it("passes onUpdate to streamTaskResult for acpp_assign_task", async () => {
    const onUpdate = vi.fn();
    const cm = createMockClientManager({
      callAgentTool: vi
        .fn()
        .mockResolvedValueOnce({
          // initial assign call
          content: [{ type: "text", text: '{"status":"accepted"}' }],
          isError: false,
        })
        .mockResolvedValueOnce({
          // fetchFinalResult call
          content: [{ type: "text", text: '{"status":"completed","result":"done"}' }],
          isError: false,
        }),
      streamAgentTask: vi
        .fn()
        .mockReturnValue(
          fakeStream([{ type: "text-delta", text: "streaming..." }, { type: "finish" }]),
        ),
    });

    const tools = createAcppProxyTools(
      "scout-agent",
      [
        {
          name: "acpp_assign_task",
          description: "Assign task",
          inputSchema: {
            type: "object",
            properties: {
              taskId: { type: "string" },
              description: { type: "string" },
            },
            required: ["taskId", "description"],
          },
        },
      ],
      cm,
    );

    expect(tools).toHaveLength(1);

    const result = await tools[0].execute(
      "call-1",
      { taskId: "task-123", description: "test" },
      undefined,
      onUpdate,
    );

    // onUpdate should have been called during streaming
    expect(onUpdate).toHaveBeenCalled();
    expect(result.content[0].text).toContain("completed");
  });

  it("does not use streaming for non-assign tools", async () => {
    const cm = createMockClientManager({
      callAgentTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "search results" }],
        isError: false,
      }),
    });

    const tools = createAcppProxyTools(
      "scout-agent",
      [
        {
          name: "search_repos",
          description: "Search repos",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      cm,
    );

    const result = await tools[0].execute("call-1", {}, undefined, vi.fn());

    // streamAgentTask should NOT be called for non-assign tools
    // oxlint-disable-next-line typescript/unbound-method
    expect(vi.mocked(cm.streamAgentTask)).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("search results");
  });
});
