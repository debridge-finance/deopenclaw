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
    state.acppRegistryAgents = Array.isArray(data.agents)
      ? data.agents
      : Array.isArray(data)
        ? data
        : [];
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
    if (!res.ok && res.status !== 503) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    // Normalize checks: backend may send object {name: {status, ...}} or array [{name, status}]
    const rawChecks = data.checks;
    let checks: AcppHealthResult["checks"] | undefined;
    if (rawChecks && typeof rawChecks === "object" && !Array.isArray(rawChecks)) {
      // Convert {memory: {status: "warning", heapUsedMb: 30, ...}} to [{name, status, message}]
      checks = Object.entries(rawChecks as Record<string, Record<string, unknown>>).map(
        ([name, check]) => {
          const rawStatus = typeof check.status === "string" ? check.status : "unknown";
          const status =
            rawStatus === "pass" ||
            rawStatus === "healthy" ||
            rawStatus === "up" ||
            rawStatus === "ok"
              ? ("pass" as const)
              : rawStatus === "warn" || rawStatus === "warning"
                ? ("warn" as const)
                : ("fail" as const);
          // Build a message from numeric metrics
          const details = Object.entries(check)
            .filter(([k]) => k !== "status")
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join(", ");
          return { name, status, message: details || undefined };
        },
      );
    } else if (Array.isArray(rawChecks)) {
      checks = rawChecks;
    }
    state.acppRegistryHealth = {
      status: data.status,
      checks,
      activeTaskCount: data.activeTaskCount,
      queueDepth: data.queueDepth,
      uptime: data.uptime,
      cachedAt: data.cachedAt ?? data.fetchedAt,
    };
  } catch {
    state.acppRegistryHealth = null;
  } finally {
    state.acppRegistryHealthLoading = false;
  }
}

// ── Load Agent Activity ────────────────────────────────

export async function loadAcppAgentActivity(state: AcppRegistryState, agentId: string, limit = 50) {
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
      : Array.isArray(data)
        ? data
        : [];
  } catch {
    state.acppRegistryActivity = [];
  } finally {
    state.acppRegistryActivityLoading = false;
  }
}
