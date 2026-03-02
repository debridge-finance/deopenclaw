import { HealthResponseSchema, type HealthResponse } from "@debridge/acpp-contracts";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { AgentStore } from "./agent-store.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type HealthCacheEntry = {
  response?: HealthResponse;
  error?: string;
  fetchedAt: string;
};

/**
 * Periodically polls registered agents' /healthz endpoints
 * and caches the results.
 */
export class AgentHealthPoller {
  private readonly cache = new Map<string, HealthCacheEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private store: AgentStore | null = null;
  private readonly log: SubsystemLogger;

  constructor(log: SubsystemLogger) {
    this.log = log;
  }

  start(store: AgentStore, intervalMs: number): void {
    this.store = store;
    this.stop();
    this.timer = setInterval(() => {
      void this.pollAll();
    }, intervalMs);
    // Run initial poll after a short delay
    setTimeout(() => void this.pollAll(), 5000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLastHealth(agentId: string): HealthCacheEntry | null {
    return this.cache.get(agentId) ?? null;
  }

  private async pollAll(): Promise<void> {
    if (!this.store) {
      return;
    }
    const agents = this.store.getOnlineAgents();
    const results = await Promise.allSettled(
      agents.map((agent) => this.pollAgent(agent.agentId, agent.healthEndpoint)),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        this.log.warn(`health poll batch error: ${String(result.reason)}`);
      }
    }
  }

  private async pollAgent(agentId: string, healthEndpoint: string): Promise<void> {
    const now = new Date().toISOString();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(healthEndpoint, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown");
        this.cache.set(agentId, {
          error: `HTTP ${response.status}: ${errorText}`,
          fetchedAt: now,
        });
        this.log.warn(`health poll failed for ${agentId}: HTTP ${response.status}`);
        return;
      }

      const body = await response.json();
      const parsed = HealthResponseSchema.safeParse(body);
      if (!parsed.success) {
        this.cache.set(agentId, {
          error: `Invalid response: ${parsed.error.message}`,
          fetchedAt: now,
        });
        this.log.warn(`health poll invalid response for ${agentId}: ${parsed.error.message}`);
        return;
      }

      this.cache.set(agentId, {
        response: parsed.data,
        fetchedAt: now,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cache.set(agentId, {
        error: message,
        fetchedAt: now,
      });
      this.log.warn(`health poll error for ${agentId}: ${message}`);
    }
  }
}
