import { describe, it, expect, beforeEach } from "vitest";
import { AgentStore } from "./agent-store.js";

function validRegistration(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    agentId: "test-agent",
    name: "Test Agent",
    description: "A test agent for unit tests",
    mcpEndpoint: "http://localhost:3000/mcp",
    healthEndpoint: "http://localhost:3000/healthz",
    protocolVersion: "1.0",
    capabilities: ["test_tool"],
    tags: ["test"],
    version: "0.1.0",
    ...overrides,
  };
}

function validHeartbeat(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    agentId: "test-agent",
    timestamp: new Date().toISOString(),
    state: "idle",
    ...overrides,
  };
}

describe("AgentStore", () => {
  let store: AgentStore;

  beforeEach(() => {
    store = new AgentStore({ heartbeatIntervalMs: 30_000 });
  });

  // ── Registration ──────────────────────────────────────────────

  describe("register", () => {
    it("registers a new agent with 201", () => {
      const result = store.register(validRegistration());
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.statusCode).toBe(201);
      expect(result.response.registered).toBe(true);
      expect(result.response.agentId).toBe("test-agent");
      expect(result.response.updated).toBeUndefined();
      expect(result.response.heartbeat.intervalMs).toBe(30_000);
      expect(result.response.heartbeat.endpoint).toBe("/api/v1/agents/heartbeat");
    });

    it("re-registers an existing agent with 200 and updated=true", () => {
      store.register(validRegistration());
      const result = store.register(validRegistration({ name: "Test Agent Updated" }));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.statusCode).toBe(200);
      expect(result.response.updated).toBe(true);

      const record = store.get("test-agent");
      expect(record?.name).toBe("Test Agent Updated");
      expect(record?.status).toBe("ONLINE");
      expect(record?.missedHeartbeats).toBe(0);
    });

    it("re-registration resets OFFLINE to ONLINE", () => {
      store.register(validRegistration());
      // Simulate going offline
      for (let i = 0; i < 10; i++) {
        store.checkMissedHeartbeats();
      }
      expect(store.get("test-agent")?.status).toBe("OFFLINE");

      const result = store.register(validRegistration());
      expect(result.ok).toBe(true);
      expect(store.get("test-agent")?.status).toBe("ONLINE");
    });

    it("rejects invalid payload", () => {
      const result = store.register({ agentId: "BAD AGENT" });
      expect(result.ok).toBe(false);
    });

    it("rejects missing required fields", () => {
      const result = store.register({});
      expect(result.ok).toBe(false);
    });

    it("stores all registration fields", () => {
      store.register(validRegistration());
      const record = store.get("test-agent");
      expect(record).toBeDefined();
      expect(record?.agentId).toBe("test-agent");
      expect(record?.name).toBe("Test Agent");
      expect(record?.description).toBe("A test agent for unit tests");
      expect(record?.mcpEndpoint).toBe("http://localhost:3000/mcp");
      expect(record?.healthEndpoint).toBe("http://localhost:3000/healthz");
      expect(record?.protocolVersion).toBe("1.0");
      expect(record?.capabilities).toEqual(["test_tool"]);
      expect(record?.tags).toEqual(["test"]);
      expect(record?.version).toBe("0.1.0");
      expect(record?.status).toBe("ONLINE");
      expect(record?.missedHeartbeats).toBe(0);
      expect(record?.registeredAt).toBeDefined();
    });
  });

  // ── Update ────────────────────────────────────────────────────

  describe("update", () => {
    it("updates an existing agent", () => {
      store.register(validRegistration());
      const result = store.update(
        "test-agent",
        validRegistration({ description: "Updated description" }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.record.description).toBe("Updated description");
    });

    it("rejects update for non-existent agent", () => {
      const result = store.update("nonexistent", validRegistration({ agentId: "nonexistent" }));
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.notFound).toBe(true);
    });

    it("rejects agentId mismatch between URL and body", () => {
      store.register(validRegistration());
      const result = store.update("test-agent", validRegistration({ agentId: "different-agent" }));
      expect(result.ok).toBe(false);
    });
  });

  // ── Deregistration ────────────────────────────────────────────

  describe("deregister", () => {
    it("marks agent as DEREGISTERED", () => {
      store.register(validRegistration());
      const result = store.deregister("test-agent", "shutdown");
      expect(result.ok).toBe(true);
      expect(store.get("test-agent")?.status).toBe("DEREGISTERED");
    });

    it("rejects deregistration of non-existent agent", () => {
      const result = store.deregister("nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.notFound).toBe(true);
    });
  });

  // ── Heartbeat ─────────────────────────────────────────────────

  describe("heartbeat", () => {
    it("processes a valid heartbeat", () => {
      store.register(validRegistration());
      const result = store.heartbeat(validHeartbeat());
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.response.ack).toBe(true);
      expect(result.response.nextExpectedBefore).toBeDefined();

      const record = store.get("test-agent");
      expect(record?.lastHeartbeat).toBeDefined();
      expect(record?.lastHeartbeatState).toBe("idle");
      expect(record?.missedHeartbeats).toBe(0);
    });

    it("recovers UNRESPONSIVE agent to ONLINE on heartbeat", () => {
      store.register(validRegistration());
      for (let i = 0; i < 3; i++) {
        store.checkMissedHeartbeats();
      }
      expect(store.get("test-agent")?.status).toBe("UNRESPONSIVE");

      store.heartbeat(validHeartbeat());
      expect(store.get("test-agent")?.status).toBe("ONLINE");
    });

    it("rejects heartbeat from non-existent agent", () => {
      const result = store.heartbeat(validHeartbeat({ agentId: "nonexistent" }));
      expect(result.ok).toBe(false);
    });

    it("rejects heartbeat from DEREGISTERED agent", () => {
      store.register(validRegistration());
      store.deregister("test-agent");
      const result = store.heartbeat(validHeartbeat());
      expect(result.ok).toBe(false);
    });

    it("rejects invalid heartbeat payload", () => {
      const result = store.heartbeat({ agentId: "test-agent" });
      expect(result.ok).toBe(false);
    });

    it("updates heartbeat state", () => {
      store.register(validRegistration());
      store.heartbeat(validHeartbeat({ state: "busy" }));
      expect(store.get("test-agent")?.lastHeartbeatState).toBe("busy");

      store.heartbeat(validHeartbeat({ state: "draining" }));
      expect(store.get("test-agent")?.lastHeartbeatState).toBe("draining");
    });
  });

  // ── Missed Heartbeats ─────────────────────────────────────────

  describe("checkMissedHeartbeats", () => {
    it("increments missedHeartbeats for ONLINE agents", () => {
      store.register(validRegistration());
      store.checkMissedHeartbeats();
      expect(store.get("test-agent")?.missedHeartbeats).toBe(1);
    });

    it("transitions to UNRESPONSIVE after 3 missed heartbeats", () => {
      store.register(validRegistration());
      for (let i = 0; i < 2; i++) {
        store.checkMissedHeartbeats();
      }
      expect(store.get("test-agent")?.status).toBe("ONLINE");

      const transitions = store.checkMissedHeartbeats(); // 3rd miss
      expect(store.get("test-agent")?.status).toBe("UNRESPONSIVE");
      expect(transitions).toEqual([{ agentId: "test-agent", from: "ONLINE", to: "UNRESPONSIVE" }]);
    });

    it("transitions to OFFLINE after 10 missed heartbeats", () => {
      store.register(validRegistration());
      for (let i = 0; i < 9; i++) {
        store.checkMissedHeartbeats();
      }
      expect(store.get("test-agent")?.status).toBe("UNRESPONSIVE");

      const transitions = store.checkMissedHeartbeats(); // 10th miss
      expect(store.get("test-agent")?.status).toBe("OFFLINE");
      expect(transitions).toEqual([{ agentId: "test-agent", from: "UNRESPONSIVE", to: "OFFLINE" }]);
    });

    it("does not affect DEREGISTERED agents", () => {
      store.register(validRegistration());
      store.deregister("test-agent");
      store.checkMissedHeartbeats();
      expect(store.get("test-agent")?.missedHeartbeats).toBe(0);
      expect(store.get("test-agent")?.status).toBe("DEREGISTERED");
    });

    it("does not affect OFFLINE agents", () => {
      store.register(validRegistration());
      for (let i = 0; i < 10; i++) {
        store.checkMissedHeartbeats();
      }
      expect(store.get("test-agent")?.status).toBe("OFFLINE");
      const beforeMissed = store.get("test-agent")?.missedHeartbeats;

      store.checkMissedHeartbeats(); // 11th miss — should not process
      expect(store.get("test-agent")?.missedHeartbeats).toBe(beforeMissed);
    });

    it("returns empty array when no transitions happen", () => {
      store.register(validRegistration());
      const transitions = store.checkMissedHeartbeats(); // 1st miss (no transition)
      expect(transitions).toEqual([]);
    });

    it("heartbeat resets missedHeartbeats counter", () => {
      store.register(validRegistration());
      store.checkMissedHeartbeats();
      store.checkMissedHeartbeats();
      expect(store.get("test-agent")?.missedHeartbeats).toBe(2);

      store.heartbeat(validHeartbeat());
      expect(store.get("test-agent")?.missedHeartbeats).toBe(0);
    });
  });

  // ── Queries ───────────────────────────────────────────────────

  describe("getAll / get / getOnlineAgents", () => {
    it("getAll returns all agents", () => {
      store.register(validRegistration({ agentId: "agent-1" }));
      store.register(validRegistration({ agentId: "agent-2" }));
      expect(store.getAll()).toHaveLength(2);
    });

    it("get returns undefined for non-existent agent", () => {
      expect(store.get("nonexistent")).toBeUndefined();
    });

    it("getOnlineAgents filters by ONLINE and UNRESPONSIVE", () => {
      store.register(validRegistration({ agentId: "agent-online" }));
      store.register(validRegistration({ agentId: "agent-deregistered" }));
      store.deregister("agent-deregistered");
      store.register(validRegistration({ agentId: "agent-unresponsive" }));
      for (let i = 0; i < 3; i++) {
        store.checkMissedHeartbeats();
      }
      // agent-online is now UNRESPONSIVE too (3 missed), so we need to heartbeat it
      store.heartbeat(validHeartbeat({ agentId: "agent-online" }));

      const online = store.getOnlineAgents();
      const onlineIds = online.map((a) => a.agentId).toSorted();
      expect(onlineIds).toEqual(["agent-online", "agent-unresponsive"]);
    });

    it("size returns total count", () => {
      expect(store.size).toBe(0);
      store.register(validRegistration());
      expect(store.size).toBe(1);
    });
  });

  // ── updateCapabilities ────────────────────────────────────────

  describe("updateCapabilities", () => {
    it("updates capabilities for existing agent", () => {
      store.register(validRegistration());
      const result = store.updateCapabilities("test-agent", ["new_tool_a", "new_tool_b"]);
      expect(result).toBe(true);
      expect(store.get("test-agent")?.capabilities).toEqual(["new_tool_a", "new_tool_b"]);
    });

    it("returns false for non-existent agent", () => {
      const result = store.updateCapabilities("nonexistent", ["tool"]);
      expect(result).toBe(false);
    });
  });
});
