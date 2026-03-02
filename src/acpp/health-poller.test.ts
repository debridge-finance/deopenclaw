import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { AgentHealthPoller } from "./health-poller.js";

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
  } as unknown as Parameters<(typeof AgentHealthPoller)["prototype"]["start"]> extends never[]
    ? never
    : ConstructorParameters<typeof AgentHealthPoller>[0];
}

describe("AgentHealthPoller", () => {
  let poller: AgentHealthPoller;

  beforeEach(() => {
    poller = new AgentHealthPoller(createMockLogger());
  });

  afterEach(() => {
    poller.stop();
  });

  it("returns null for unknown agent", () => {
    expect(poller.getLastHealth("unknown")).toBeNull();
  });

  it("can be constructed and stopped without errors", () => {
    expect(() => poller.stop()).not.toThrow();
  });

  it("stop is idempotent", () => {
    poller.stop();
    poller.stop();
    expect(true).toBe(true);
  });
});
