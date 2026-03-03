import {
  AgentRegistrationSchema,
  HeartbeatSchema,
  type RegistrationResponse,
  type HeartbeatResponse,
} from "@debridge-finance/acpp-contracts";
import type { AgentRecord, AgentStatus } from "./types.js";

export type AgentStoreOptions = {
  heartbeatIntervalMs: number;
};

const UNRESPONSIVE_THRESHOLD = 3;
const OFFLINE_THRESHOLD = 10;

/**
 * Pure in-memory agent registry store.
 * No database, no DI — just a Map.
 */
export class AgentStore {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly heartbeatIntervalMs: number;

  constructor(opts: AgentStoreOptions) {
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs;
  }

  /**
   * Upsert: register new or re-register existing agent.
   * Returns 201 for new, 200 for re-register.
   */
  register(
    payload: unknown,
  ):
    | { ok: true; statusCode: 201 | 200; response: RegistrationResponse }
    | { ok: false; error: string } {
    const parsed = AgentRegistrationSchema.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: formatZodError(parsed.error) };
    }
    const data = parsed.data;
    const existing = this.agents.get(data.agentId);
    const now = new Date().toISOString();

    if (existing) {
      // Re-register (upsert): update fields, reset state
      const updated: AgentRecord = {
        ...data,
        status: "ONLINE",
        lastHeartbeat: existing.lastHeartbeat,
        lastHeartbeatState: existing.lastHeartbeatState,
        missedHeartbeats: 0,
        registeredAt: existing.registeredAt,
        updatedAt: now,
      };
      this.agents.set(data.agentId, updated);
      return {
        ok: true,
        statusCode: 200,
        response: {
          registered: true,
          agentId: data.agentId,
          updated: true,
          heartbeat: {
            intervalMs: this.heartbeatIntervalMs,
            endpoint: "/api/v1/agents/heartbeat",
          },
        },
      };
    }

    // New registration
    const record: AgentRecord = {
      ...data,
      status: "ONLINE",
      lastHeartbeat: null,
      lastHeartbeatState: null,
      missedHeartbeats: 0,
      registeredAt: now,
      updatedAt: now,
    };
    this.agents.set(data.agentId, record);
    return {
      ok: true,
      statusCode: 201,
      response: {
        registered: true,
        agentId: data.agentId,
        heartbeat: {
          intervalMs: this.heartbeatIntervalMs,
          endpoint: "/api/v1/agents/heartbeat",
        },
      },
    };
  }

  /**
   * Update an existing agent's registration fields.
   */
  update(
    agentId: string,
    payload: unknown,
  ): { ok: true; record: AgentRecord } | { ok: false; error: string; notFound?: boolean } {
    const existing = this.agents.get(agentId);
    if (!existing) {
      return { ok: false, error: `Agent '${agentId}' not found`, notFound: true };
    }
    const parsed = AgentRegistrationSchema.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: formatZodError(parsed.error) };
    }
    const data = parsed.data;
    if (data.agentId !== agentId) {
      return { ok: false, error: "agentId in body does not match URL parameter" };
    }
    const updated: AgentRecord = {
      ...existing,
      ...data,
      updatedAt: new Date().toISOString(),
    };
    this.agents.set(agentId, updated);
    return { ok: true, record: updated };
  }

  /**
   * Mark agent as DEREGISTERED.
   */
  deregister(
    agentId: string,
    _reason?: string,
  ): { ok: true; agentId: string } | { ok: false; error: string; notFound?: boolean } {
    const existing = this.agents.get(agentId);
    if (!existing) {
      return { ok: false, error: `Agent '${agentId}' not found`, notFound: true };
    }
    const updated: AgentRecord = {
      ...existing,
      status: "DEREGISTERED",
      updatedAt: new Date().toISOString(),
    };
    this.agents.set(agentId, updated);
    return { ok: true, agentId };
  }

  /**
   * Process a heartbeat from an agent.
   */
  heartbeat(
    payload: unknown,
  ): { ok: true; response: HeartbeatResponse } | { ok: false; error: string; notFound?: boolean } {
    const parsed = HeartbeatSchema.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: formatZodError(parsed.error) };
    }
    const data = parsed.data;
    const existing = this.agents.get(data.agentId);
    if (!existing) {
      return { ok: false, error: `Agent '${data.agentId}' not found`, notFound: true };
    }
    if (existing.status === "DEREGISTERED") {
      return { ok: false, error: `Agent '${data.agentId}' is deregistered` };
    }
    const now = new Date();
    const updated: AgentRecord = {
      ...existing,
      lastHeartbeat: data.timestamp,
      lastHeartbeatState: data.state,
      missedHeartbeats: 0,
      updatedAt: now.toISOString(),
      // Recover from UNRESPONSIVE
      status: existing.status === "UNRESPONSIVE" ? "ONLINE" : existing.status,
    };
    this.agents.set(data.agentId, updated);

    const nextExpected = new Date(now.getTime() + this.heartbeatIntervalMs + 5000);
    return {
      ok: true,
      response: {
        ack: true,
        nextExpectedBefore: nextExpected.toISOString(),
      },
    };
  }

  /**
   * Check all ONLINE/UNRESPONSIVE agents for missed heartbeats.
   * Called periodically (e.g. every heartbeatIntervalMs).
   *
   * Returns list of agents whose status changed.
   */
  checkMissedHeartbeats(): Array<{ agentId: string; from: AgentStatus; to: AgentStatus }> {
    const transitions: Array<{ agentId: string; from: AgentStatus; to: AgentStatus }> = [];
    const now = new Date().toISOString();

    for (const [agentId, record] of this.agents) {
      if (record.status !== "ONLINE" && record.status !== "UNRESPONSIVE") {
        continue;
      }
      const newMissed = record.missedHeartbeats + 1;
      let newStatus: AgentStatus = record.status;

      if (newMissed >= OFFLINE_THRESHOLD) {
        newStatus = "OFFLINE";
      } else if (newMissed >= UNRESPONSIVE_THRESHOLD) {
        newStatus = "UNRESPONSIVE";
      }

      const updated: AgentRecord = {
        ...record,
        missedHeartbeats: newMissed,
        status: newStatus,
        updatedAt: now,
      };
      this.agents.set(agentId, updated);

      if (newStatus !== record.status) {
        transitions.push({ agentId, from: record.status, to: newStatus });
      }
    }

    return transitions;
  }

  /**
   * Get all agents.
   */
  getAll(): AgentRecord[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get a single agent by agentId.
   */
  get(agentId: string): AgentRecord | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get agents with ONLINE or UNRESPONSIVE status.
   */
  getOnlineAgents(): AgentRecord[] {
    return this.getAll().filter((a) => a.status === "ONLINE" || a.status === "UNRESPONSIVE");
  }

  /**
   * Update agent capabilities (used by MCP capability discovery).
   */
  updateCapabilities(agentId: string, capabilities: string[]): boolean {
    const existing = this.agents.get(agentId);
    if (!existing) {
      return false;
    }
    this.agents.set(agentId, {
      ...existing,
      capabilities,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  /**
   * Number of registered agents (any status).
   */
  get size(): number {
    return this.agents.size;
  }
}

function formatZodError(error: {
  issues: Array<{ path: (string | number)[]; message: string }>;
}): string {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}
