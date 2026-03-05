import { html, nothing } from "lit";
import type { AcppAgentSummary, AcppActivityEvent, AcppHealthResult } from "../types/acpp-types.ts";
import { renderAcppRegistryDetail } from "./acpp-registry-detail.ts";

// ── Types ──────────────────────────────────────────────

export type AcppRegistryProps = {
  loading: boolean;
  error: string | null;
  agents: AcppAgentSummary[];
  selectedAgentId: string | null;
  detail: import("../types/acpp-types.ts").AcppAgentDetail | null;
  detailLoading: boolean;
  health: AcppHealthResult | null;
  healthLoading: boolean;
  activity: AcppActivityEvent[];
  activityLoading: boolean;
  onRefresh: () => void;
  onSelectAgent: (agentId: string) => void;
  onRefreshHealth: (agentId: string) => void;
  onRefreshActivity: (agentId: string) => void;
};

// ── Status Helpers ─────────────────────────────────────

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

// ── Status Count Summary ───────────────────────────────

function statusSummary(agents: AcppAgentSummary[]): string {
  const counts: Record<string, number> = {};
  for (const a of agents) {
    counts[a.status] = (counts[a.status] ?? 0) + 1;
  }
  const parts: string[] = [];
  if (counts["ONLINE"]) {
    parts.push(`${counts["ONLINE"]} online`);
  }
  if (counts["UNRESPONSIVE"]) {
    parts.push(`${counts["UNRESPONSIVE"]} unresponsive`);
  }
  if (counts["OFFLINE"]) {
    parts.push(`${counts["OFFLINE"]} offline`);
  }
  if (counts["DEREGISTERED"]) {
    parts.push(`${counts["DEREGISTERED"]} deregistered`);
  }
  return parts.join(" · ") || "No agents";
}

// ── Main Render ────────────────────────────────────────

export function renderAcppRegistry(props: AcppRegistryProps) {
  const agents = props.agents;
  const selectedId = props.selectedAgentId;
  const selectedAgent = selectedId ? (agents.find((a) => a.agentId === selectedId) ?? null) : null;

  return html`
    <div class="agents-layout">
      <section class="card agents-sidebar">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">Agent Discovery</div>
            <div class="card-sub">${statusSummary(agents)}</div>
          </div>
          <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        ${
          props.error
            ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
            : nothing
        }
        <div class="agent-list" style="margin-top: 12px;">
          ${
            agents.length === 0
              ? html`
                  <div class="muted" style="padding: 16px 0">
                    No agents registered. Agents will appear here when they register via ACPP.
                  </div>
                `
              : agents.map(
                  (agent) => html`
                    <button
                      type="button"
                      class="agent-row ${selectedId === agent.agentId ? "active" : ""}"
                      @click=${() => props.onSelectAgent(agent.agentId)}
                    >
                      <div class="agent-avatar">
                        <span
                          class="statusDot ${statusColor(agent.status)}"
                          style="width: 10px; height: 10px;"
                        ></span>
                      </div>
                      <div class="agent-info">
                        <div class="agent-title">${agent.name || agent.agentId}</div>
                        <div class="agent-sub mono">${agent.agentId}</div>
                      </div>
                      <div style="text-align: right; font-size: 0.75rem;">
                        <span class="agent-pill" style="background: var(--${statusColor(agent.status)}); color: #fff; font-size: 0.65rem; padding: 2px 6px; border-radius: 4px;">
                          ${agent.status}
                        </span>
                        ${agent.version ? html`<div class="muted" style="margin-top: 2px;">${agent.version}</div>` : nothing}
                        <div class="muted" style="margin-top: 2px;">${relativeTime(agent.lastHeartbeat)}</div>
                      </div>
                    </button>
                  `,
                )
          }
        </div>
      </section>
      <section class="agents-main">
        ${
          !selectedAgent
            ? html`
                <div class="card">
                  <div class="card-title">Select an agent</div>
                  <div class="card-sub">Pick a registered agent to inspect details, health, and activity.</div>
                </div>
              `
            : renderAcppRegistryDetail({
                agent: selectedAgent,
                detail: props.detail,
                detailLoading: props.detailLoading,
                health: props.health,
                healthLoading: props.healthLoading,
                activity: props.activity,
                activityLoading: props.activityLoading,
                onRefreshHealth: () => props.onRefreshHealth(selectedAgent.agentId),
                onRefreshActivity: () => props.onRefreshActivity(selectedAgent.agentId),
              })
        }
      </section>
    </div>
  `;
}
