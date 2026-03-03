import { html, nothing } from "lit";
import type {
    AcppAgentSummary,
    AcppAgentDetail,
    AcppHealthResult,
    AcppActivityEvent,
} from "../types/acpp-types.ts";

// ── Types ──────────────────────────────────────────────

export type AcppDetailProps = {
    agent: AcppAgentSummary;
    detail: AcppAgentDetail | null;
    detailLoading: boolean;
    health: AcppHealthResult | null;
    healthLoading: boolean;
    activity: AcppActivityEvent[];
    activityLoading: boolean;
    onRefreshHealth: () => void;
    onRefreshActivity: () => void;
};

// ── Helpers ────────────────────────────────────────────

function relativeTime(iso: string | null | undefined): string {
    if (!iso) {
        return "never";
    }
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) {
        return "just now";
    }
    if (ms < 60_000) {
        return `${Math.floor(ms / 1000)}s ago`;
    }
    if (ms < 3_600_000) {
        return `${Math.floor(ms / 60_000)}m ago`;
    }
    if (ms < 86_400_000) {
        return `${Math.floor(ms / 3_600_000)}h ago`;
    }
    return `${Math.floor(ms / 86_400_000)}d ago`;
}

type StatusColor = "ok" | "warn" | "danger" | "muted";

function statusColor(status: string): StatusColor {
    switch (status) {
        case "ONLINE":
            return "ok";
        case "UNRESPONSIVE":
            return "warn";
        case "OFFLINE":
            return "danger";
        case "DEREGISTERED":
            return "muted";
        default:
            return "muted";
    }
}

function healthStatusColor(status: string | undefined): StatusColor {
    switch (status) {
        case "healthy":
            return "ok";
        case "degraded":
            return "warn";
        case "unhealthy":
            return "danger";
        default:
            return "muted";
    }
}

function eventDotColor(event: string): string {
    if (event === "task.started") return "var(--accent, #6366f1)";
    if (event === "task.completed") return "var(--ok, #22c55e)";
    if (event === "task.failed" || event === "agent.error") return "var(--danger, #ef4444)";
    if (event === "task.cancelled") return "var(--warn, #f59e0b)";
    if (event === "task.step_completed") return "var(--text-muted, #888)";
    if (event === "agent.state_changed") return "var(--accent, #6366f1)";
    return "var(--text-muted, #888)";
}

function eventLabel(event: string, payload?: Record<string, unknown>): string {
    const desc = payload?.description ?? payload?.error ?? payload?.outcome ?? payload?.reason ?? "";
    const suffix = desc ? `: ${String(desc)}` : "";
    switch (event) {
        case "task.started":
            return `Task started${suffix}`;
        case "task.step_completed":
            return `Step completed${suffix}`;
        case "task.completed":
            return `Task completed${suffix}`;
        case "task.failed":
            return `Task failed${suffix}`;
        case "task.cancelled":
            return `Task cancelled${suffix}`;
        case "agent.state_changed":
            return `State changed${suffix}`;
        case "agent.error":
            return `Agent error${suffix}`;
        default:
            return `${event}${suffix}`;
    }
}

// ── Main Render ────────────────────────────────────────

export function renderAcppRegistryDetail(props: AcppDetailProps) {
    const { agent, health, activity } = props;

    return html`
    ${renderInfoSection(agent)}
    ${renderHealthSection(health, props.healthLoading, props.onRefreshHealth)}
    ${renderActivitySection(activity, props.activityLoading, props.onRefreshActivity)}
  `;
}

// ── Info Section ───────────────────────────────────────

function renderInfoSection(agent: AcppAgentSummary) {
    return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="card-title">${agent.name || agent.agentId}</div>
          <div class="card-sub mono">${agent.agentId}</div>
          ${agent.description ? html`<div class="card-sub" style="margin-top: 4px;">${agent.description}</div>` : nothing}
        </div>
        <span
          style="
            display: inline-block;
            padding: 4px 12px;
            border-radius: 6px;
            font-size: 0.75rem;
            font-weight: 600;
            color: #fff;
            background: var(--${statusColor(agent.status)});
          "
        >
          ${agent.status}
        </span>
      </div>
      <div class="agents-overview-grid" style="margin-top: 16px;">
        <div class="agent-kv">
          <div class="label">Version</div>
          <div class="mono">${agent.version || "—"}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Protocol</div>
          <div class="mono">${agent.protocolVersion || "—"}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Registered</div>
          <div>${relativeTime(agent.registeredAt)}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Last Heartbeat</div>
          <div>${relativeTime(agent.lastHeartbeat)}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Missed Heartbeats</div>
          <div>
            ${agent.missedHeartbeats > 0
            ? html`<span style="color: var(--warn, #f59e0b); font-weight: 600;">${agent.missedHeartbeats}</span>`
            : "0"}
          </div>
        </div>
        <div class="agent-kv">
          <div class="label">MCP Endpoint</div>
          <div class="mono" style="font-size: 0.75rem;">${agent.mcpEndpoint || "—"}</div>
        </div>
      </div>
      ${agent.tags && agent.tags.length > 0
            ? html`
              <div style="margin-top: 12px;">
                <div class="label" style="margin-bottom: 4px;">Tags</div>
                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                  ${agent.tags.map(
                (tag) =>
                    html`<span class="agent-pill" style="font-size: 0.65rem;">${tag}</span>`,
            )}
                </div>
              </div>
            `
            : nothing
        }
      ${agent.capabilities && agent.capabilities.length > 0
            ? html`
              <div style="margin-top: 12px;">
                <div class="label" style="margin-bottom: 4px;">Capabilities</div>
                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                  ${agent.capabilities.map(
                (cap) =>
                    html`<span class="agent-pill" style="font-size: 0.65rem; background: var(--accent, #6366f1); color: #fff;">${cap}</span>`,
            )}
                </div>
              </div>
            `
            : nothing
        }
    </section>
  `;
}

// ── Health Section ─────────────────────────────────────

function renderHealthSection(
    health: AcppHealthResult | null,
    loading: boolean,
    onRefresh: () => void,
) {
    return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Health</div>
          <div class="card-sub">
            ${health
            ? html`Status: <span style="color: var(--${healthStatusColor(health.status)});">${health.status}</span>`
            : "No health data yet."}
          </div>
        </div>
        <button class="btn btn--sm" ?disabled=${loading} @click=${onRefresh}>
          ${loading ? "Checking…" : "Check"}
        </button>
      </div>
      ${health
            ? html`
              <div class="agents-overview-grid" style="margin-top: 12px;">
                ${health.activeTaskCount != null
                    ? html`
                      <div class="agent-kv">
                        <div class="label">Active Tasks</div>
                        <div>${health.activeTaskCount}</div>
                      </div>
                    `
                    : nothing}
                ${health.queueDepth != null
                    ? html`
                      <div class="agent-kv">
                        <div class="label">Queue Depth</div>
                        <div>${health.queueDepth}</div>
                      </div>
                    `
                    : nothing}
                ${health.cachedAt
                    ? html`
                      <div class="agent-kv">
                        <div class="label">Last Checked</div>
                        <div>${relativeTime(health.cachedAt)}</div>
                      </div>
                    `
                    : nothing}
              </div>
              ${health.checks && health.checks.length > 0
                    ? html`
                      <div style="margin-top: 12px;">
                        <div class="label" style="margin-bottom: 6px;">Checks</div>
                        ${health.checks.map(
                        (check) => html`
                            <div
                              style="
                                display: flex;
                                align-items: center;
                                gap: 8px;
                                padding: 4px 0;
                                font-size: 0.8rem;
                              "
                            >
                              <span
                                class="statusDot ${check.status === "pass"
                                ? "ok"
                                : check.status === "warn"
                                    ? "warn"
                                    : "danger"}"
                                style="width: 8px; height: 8px;"
                              ></span>
                              <span style="font-weight: 500;">${check.name}</span>
                              ${check.message
                                ? html`<span class="muted">— ${check.message}</span>`
                                : nothing}
                            </div>
                          `,
                    )}
                      </div>
                    `
                    : nothing
                }
            `
            : nothing
        }
    </section>
  `;
}

// ── Activity Section ───────────────────────────────────

function renderActivitySection(
    activity: AcppActivityEvent[],
    loading: boolean,
    onRefresh: () => void,
) {
    // Show most recent first, limit to 100
    const events = activity.slice(0, 100);

    return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Activity</div>
          <div class="card-sub">${events.length} events</div>
        </div>
        <button class="btn btn--sm" ?disabled=${loading} @click=${onRefresh}>
          ${loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      ${events.length === 0
            ? html`<div class="muted" style="padding: 16px 0;">No activity events yet.</div>`
            : html`
              <div
                style="
                  margin-top: 12px;
                  max-height: 400px;
                  overflow-y: auto;
                  display: flex;
                  flex-direction: column;
                  gap: 2px;
                "
              >
                ${events.map(
                (ev) => html`
                    <div
                      style="
                        display: flex;
                        align-items: flex-start;
                        gap: 8px;
                        padding: 6px 4px;
                        font-size: 0.8rem;
                        border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
                      "
                    >
                      <span
                        style="
                          flex-shrink: 0;
                          width: 8px;
                          height: 8px;
                          border-radius: 50%;
                          margin-top: 5px;
                          background: ${eventDotColor(ev.event)};
                        "
                      ></span>
                      <div style="flex: 1; min-width: 0;">
                        <div style="font-weight: 500;">
                          ${eventLabel(ev.event, ev.payload)}
                        </div>
                        <div class="muted" style="font-size: 0.7rem;">
                          ${relativeTime(ev.timestamp)}
                          ${ev.taskId ? html` · <span class="mono">${ev.taskId}</span>` : nothing}
                        </div>
                      </div>
                    </div>
                  `,
            )}
              </div>
            `
        }
    </section>
  `;
}
