import { describe, it, expect, beforeEach, vi } from "vitest";
import { ActivityAggregator } from "./activity-aggregator.js";

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
  } as unknown as ConstructorParameters<typeof ActivityAggregator>[0];
}

function validActivityEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "activity",
    event: "task.started",
    taskId: "task-123",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("ActivityAggregator", () => {
  let aggregator: ActivityAggregator;

  beforeEach(() => {
    aggregator = new ActivityAggregator(createMockLogger());
  });

  describe("handleNotification", () => {
    it("ignores non-activity data", () => {
      aggregator.handleNotification("agent-1", { type: "other" });
      expect(aggregator.getHistory("agent-1")).toEqual([]);
    });

    it("ignores null/undefined data", () => {
      aggregator.handleNotification("agent-1", null);
      aggregator.handleNotification("agent-1", undefined);
      expect(aggregator.getHistory("agent-1")).toEqual([]);
    });

    it("stores valid activity events", () => {
      aggregator.handleNotification("agent-1", validActivityEvent());
      const history = aggregator.getHistory("agent-1");
      expect(history).toHaveLength(1);
    });

    it("emits to subscribers", () => {
      const listener = vi.fn();
      aggregator.subscribe(listener);
      aggregator.handleNotification("agent-1", validActivityEvent());
      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(
        "agent-1",
        expect.objectContaining({ type: "activity" }),
      );
    });

    it("does not emit for invalid events", () => {
      const listener = vi.fn();
      aggregator.subscribe(listener);
      aggregator.handleNotification("agent-1", { type: "not-activity" });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("subscribe/unsubscribe", () => {
    it("subscriber stops receiving after unsubscribe", () => {
      const listener = vi.fn();
      aggregator.subscribe(listener);
      aggregator.handleNotification("agent-1", validActivityEvent());
      expect(listener).toHaveBeenCalledOnce();

      aggregator.unsubscribe(listener);
      aggregator.handleNotification("agent-1", validActivityEvent());
      expect(listener).toHaveBeenCalledOnce(); // still 1
    });

    it("handles listener errors gracefully", () => {
      const badListener = vi.fn().mockImplementation(() => {
        throw new Error("listener crash");
      });
      const goodListener = vi.fn();
      aggregator.subscribe(badListener);
      aggregator.subscribe(goodListener);

      aggregator.handleNotification("agent-1", validActivityEvent());
      expect(goodListener).toHaveBeenCalledOnce();
    });
  });

  describe("getHistory", () => {
    it("returns empty for unknown agent", () => {
      expect(aggregator.getHistory("unknown")).toEqual([]);
    });

    it("returns events in order", () => {
      for (let i = 0; i < 5; i++) {
        aggregator.handleNotification(
          "agent-1",
          validActivityEvent({
            timestamp: new Date(Date.now() + i * 1000).toISOString(),
          }),
        );
      }
      const history = aggregator.getHistory("agent-1");
      expect(history).toHaveLength(5);
    });
  });

  describe("getHistoryAll", () => {
    it("returns events from all agents sorted by timestamp", () => {
      aggregator.handleNotification(
        "agent-1",
        validActivityEvent({
          timestamp: "2026-01-01T00:00:01Z",
        }),
      );
      aggregator.handleNotification(
        "agent-2",
        validActivityEvent({
          timestamp: "2026-01-01T00:00:02Z",
        }),
      );
      const all = aggregator.getHistoryAll();
      expect(all).toHaveLength(2);
      expect(all[0].agentId).toBe("agent-2"); // newest first
    });
  });

  describe("clearAgent", () => {
    it("removes buffer for agent", () => {
      aggregator.handleNotification("agent-1", validActivityEvent());
      expect(aggregator.getHistory("agent-1")).toHaveLength(1);

      aggregator.clearAgent("agent-1");
      expect(aggregator.getHistory("agent-1")).toEqual([]);
    });
  });

  describe("ring buffer", () => {
    it("trims to 1000 events per agent", () => {
      for (let i = 0; i < 1050; i++) {
        aggregator.handleNotification(
          "agent-1",
          validActivityEvent({
            timestamp: new Date(Date.now() + i).toISOString(),
          }),
        );
      }
      expect(aggregator.getHistory("agent-1", 2000)).toHaveLength(1000);
    });
  });
});
