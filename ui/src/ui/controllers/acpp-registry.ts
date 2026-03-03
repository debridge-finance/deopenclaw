import type {
    AcppAgentSummary,
    AcppAgentDetail,
    AcppHealthResult,
    AcppActivityEvent,
} from "../types/acpp-types.ts";

// ── State ──────────────────────────────────────────────

export type AcppRegistryState = {
    acppRegistryLoading: boolean;
    acppRegistryError: string | null;
    acppRegistryAgents: AcppAgentSummary[];
    acppRegistrySelected: string | null;
    acppRegistryDetail: AcppAgentDetail | null;
    acppRegistryDetailLoading: boolean;
    acppRegistryHealth: AcppHealthResult | null;
    acppRegistryHealthLoading: boolean;
    acppRegistryActivity: AcppActivityEvent[];
    acppRegistryActivityLoading: boolean;
    settings: { acppApiKey: string };
};

// ── Helpers ────────────────────────────────────────────

function acppHeaders(state: AcppRegistryState): HeadersInit {
    const key = state.settings.acppApiKey;
    return key ? { "X-API-Key": key, Accept: "application/json" } : { Accept: "application/json" };
}

function basePath(): string {
    const configured =
        typeof window !== "undefined" &&
        typeof window.__OPENCLAW_CONTROL_UI_BASE_PATH__ === "string" &&
        window.__OPENCLAW_CONTROL_UI_BASE_PATH__.trim();
    if (configured) {
        let base = configured.trim();
        if (!base.startsWith("/")) {
            base = `/${base}`;
        }
        if (base.endsWith("/")) {
            base = base.slice(0, -1);
        }
        return base === "/" ? "" : base;
    }
    return "";
}

function acppUrl(path: string): string {
    return `${basePath()}${path}`;
}

// ── Load Agents ────────────────────────────────────────

export async function loadAcppAgents(state: AcppRegistryState) {
    if (state.acppRegistryLoading) {
        return;
    }
    state.acppRegistryLoading = true;
    state.acppRegistryError = null;
    try {
        const res = await fetch(acppUrl("/api/v1/agents"), {
            headers: acppHeaders(state),
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        const data = await res.json();
        state.acppRegistryAgents = Array.isArray(data.agents) ? data.agents : (Array.isArray(data) ? data : []);
        // Auto-select first if nothing selected
        if (!state.acppRegistrySelected && state.acppRegistryAgents.length > 0) {
            state.acppRegistrySelected = state.acppRegistryAgents[0].agentId;
        }
    } catch (err) {
        state.acppRegistryError = `Failed to load agents: ${String(err)}`;
    } finally {
        state.acppRegistryLoading = false;
    }
}

// ── Load Agent Detail ──────────────────────────────────

export async function loadAcppAgentDetail(state: AcppRegistryState, agentId: string) {
    if (state.acppRegistryDetailLoading) {
        return;
    }
    state.acppRegistryDetailLoading = true;
    try {
        const res = await fetch(acppUrl(`/api/v1/agents/${encodeURIComponent(agentId)}`), {
            headers: acppHeaders(state),
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as AcppAgentDetail;
        state.acppRegistryDetail = data;
    } catch {
        state.acppRegistryDetail = null;
    } finally {
        state.acppRegistryDetailLoading = false;
    }
}

// ── Load Agent Health ──────────────────────────────────

export async function loadAcppAgentHealth(state: AcppRegistryState, agentId: string) {
    if (state.acppRegistryHealthLoading) {
        return;
    }
    state.acppRegistryHealthLoading = true;
    try {
        const res = await fetch(acppUrl(`/api/v1/agents/${encodeURIComponent(agentId)}/health`), {
            headers: acppHeaders(state),
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        state.acppRegistryHealth = (await res.json()) as AcppHealthResult;
    } catch {
        state.acppRegistryHealth = null;
    } finally {
        state.acppRegistryHealthLoading = false;
    }
}

// ── Load Agent Activity ────────────────────────────────

export async function loadAcppAgentActivity(
    state: AcppRegistryState,
    agentId: string,
    limit = 50,
) {
    if (state.acppRegistryActivityLoading) {
        return;
    }
    state.acppRegistryActivityLoading = true;
    try {
        const res = await fetch(
            acppUrl(`/api/v1/agents/${encodeURIComponent(agentId)}/activity?limit=${limit}`),
            { headers: acppHeaders(state) },
        );
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        state.acppRegistryActivity = Array.isArray(data.events)
            ? data.events
            : (Array.isArray(data) ? data : []);
    } catch {
        state.acppRegistryActivity = [];
    } finally {
        state.acppRegistryActivityLoading = false;
    }
}
