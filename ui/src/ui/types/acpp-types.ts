// ── ACPP Types ─────────────────────────────────────────
// Types matching the backend AgentRecord and ACPP REST API responses.

export type AcppAgentStatus = "ONLINE" | "UNRESPONSIVE" | "OFFLINE" | "DEREGISTERED";

export type AcppAgentSummary = {
    agentId: string;
    name: string;
    description?: string;
    version?: string;
    protocolVersion?: string;
    status: AcppAgentStatus;
    capabilities?: string[];
    tags?: string[];
    mcpEndpoint?: string;
    healthEndpoint?: string;
    lastHeartbeat: string | null;
    lastHeartbeatState?: string | null;
    missedHeartbeats: number;
    registeredAt: string;
    updatedAt: string;
};

export type AcppHealthCheck = {
    name: string;
    status: "pass" | "fail" | "warn";
    message?: string;
};

export type AcppHealthResult = {
    status: "healthy" | "degraded" | "unhealthy";
    checks?: AcppHealthCheck[];
    activeTaskCount?: number;
    queueDepth?: number;
    uptime?: number;
    cachedAt?: string;
};

export type AcppActivityEvent = {
    type: "activity";
    event: string;
    taskId?: string;
    timestamp: string;
    payload?: Record<string, unknown>;
    agentId?: string;
};

export type AcppAgentDetail = AcppAgentSummary & {
    health?: AcppHealthResult | null;
};
