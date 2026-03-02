import type { AgentRegistration, AgentState } from "@debridge/acpp-contracts";

// ── Agent Status ──────────────────────────────────────────────

export type AgentStatus = "ONLINE" | "UNRESPONSIVE" | "OFFLINE" | "DEREGISTERED";

// ── Agent Record ──────────────────────────────────────────────

export type AgentRecord = AgentRegistration & {
  status: AgentStatus;
  lastHeartbeat: string | null;
  lastHeartbeatState: AgentState | null;
  missedHeartbeats: number;
  registeredAt: string;
  updatedAt: string;
};
