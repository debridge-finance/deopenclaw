import { ActivityEventSchema, type ActivityEvent } from "@debridge-finance/acpp-contracts";
import type { createSubsystemLogger } from "../logging/subsystem.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type ActivityListener = (agentId: string, event: ActivityEvent) => void;

const MAX_BUFFER_SIZE = 1000;

/**
 * Aggregates activity events from all connected MCP agents.
 * Stores events in a per-agent ring buffer and emits to subscribers.
 */
export class ActivityAggregator {
  private readonly buffers = new Map<string, ActivityEvent[]>();
  private readonly listeners = new Set<ActivityListener>();
  private readonly log: SubsystemLogger;

  constructor(log: SubsystemLogger) {
    this.log = log;
  }

  /**
   * Process an incoming notification from an MCP agent.
   * Validates, stores in ring buffer, and emits to listeners.
   */
  handleNotification(agentId: string, data: unknown): void {
    if (!isActivityData(data)) {
      return;
    }

    const parsed = ActivityEventSchema.safeParse(data);
    if (!parsed.success) {
      this.log.debug(`invalid activity event from ${agentId}: ${parsed.error.message}`);
      return;
    }

    const event = parsed.data;
    this.appendToBuffer(agentId, event);

    // Emit to all listeners
    for (const listener of this.listeners) {
      try {
        listener(agentId, event);
      } catch (err) {
        this.log.warn(
          `activity listener error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Subscribe to activity events from all agents.
   */
  subscribe(listener: ActivityListener): void {
    this.listeners.add(listener);
  }

  /**
   * Unsubscribe from activity events.
   */
  unsubscribe(listener: ActivityListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Get historical events for a specific agent.
   */
  getHistory(agentId: string, limit = 100, offset = 0): ActivityEvent[] {
    const buffer = this.buffers.get(agentId);
    if (!buffer) {
      return [];
    }
    // Events are in chronological order (oldest first)
    const start = Math.max(0, buffer.length - limit - offset);
    const end = Math.max(0, buffer.length - offset);
    return buffer.slice(start, end);
  }

  /**
   * Get historical events across all agents, sorted by timestamp (newest first).
   */
  getHistoryAll(limit = 100): Array<ActivityEvent & { agentId: string }> {
    const all: Array<ActivityEvent & { agentId: string }> = [];
    for (const [agentId, buffer] of this.buffers) {
      for (const event of buffer) {
        all.push({ ...(event as Record<string, unknown>), agentId } as ActivityEvent & {
          agentId: string;
        });
      }
    }
    all.sort((a, b) =>
      (b as unknown as { timestamp: string }).timestamp.localeCompare(
        (a as unknown as { timestamp: string }).timestamp,
      ),
    );
    return all.slice(0, limit);
  }

  /**
   * Clear buffer for a specific agent (e.g. on deregistration).
   */
  clearAgent(agentId: string): void {
    this.buffers.delete(agentId);
  }

  private appendToBuffer(agentId: string, event: ActivityEvent): void {
    let buffer = this.buffers.get(agentId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(agentId, buffer);
    }
    buffer.push(event);
    // Trim to max buffer size (ring buffer behavior)
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
    }
  }
}

function isActivityData(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as Record<string, unknown>).type === "activity"
  );
}
