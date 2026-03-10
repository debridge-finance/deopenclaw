import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildAcppRoster,
  buildAcppOrchestratorRoster,
  hasAcppConnectedAgents,
} from "./acpp-roster.js";
import type { McpClientManager } from "./mcp-client-manager.js";

// Mock mcp-client-singleton
vi.mock("./mcp-client-singleton.js", () => ({
  getGlobalMcpClientManager: vi.fn(),
}));

import { getGlobalMcpClientManager } from "./mcp-client-singleton.js";
const mockGetManager = vi.mocked(getGlobalMcpClientManager);

describe("hasAcppConnectedAgents", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns false when no manager", () => {
    mockGetManager.mockReturnValue(null);
    expect(hasAcppConnectedAgents()).toBe(false);
  });

  it("returns false when no connected agents", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => [],
    } as unknown as McpClientManager);
    expect(hasAcppConnectedAgents()).toBe(false);
  });

  it("returns true when agents are connected", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => ["scout-agent"],
    } as unknown as McpClientManager);
    expect(hasAcppConnectedAgents()).toBe(true);
  });
});

describe("buildAcppRoster", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty string when no manager", () => {
    mockGetManager.mockReturnValue(null);
    expect(buildAcppRoster()).toBe("");
  });

  it("returns empty string when no connected agents", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => [],
      getAgentTools: () => [],
    } as unknown as McpClientManager);
    expect(buildAcppRoster()).toBe("");
  });

  it("returns roster with agent and tools", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => ["scout-agent"],
      getAgentTools: (_agentId: string) => [
        { name: "acpp_test_call", description: "Test" },
        { name: "acpp_assign_task", description: "Assign" },
      ],
    } as unknown as McpClientManager);

    const roster = buildAcppRoster();
    expect(roster).toContain("ACPP Orchestrator");
    expect(roster).toContain("scout-agent");
    expect(roster).toContain("scout_agent__acpp_test_call");
    expect(roster).toContain("scout_agent__acpp_assign_task");
    expect(roster).toContain("Routing Rules");
    expect(roster).toContain("agent_name.tool_name");
  });

  it("lists multiple agents", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => ["scout-agent", "dev-agent"],
      getAgentTools: (_agentId: string) =>
        _agentId === "scout-agent" ? [{ name: "acpp_test_call" }] : [{ name: "code_review" }],
    } as unknown as McpClientManager);

    const roster = buildAcppRoster();
    expect(roster).toContain("scout-agent");
    expect(roster).toContain("dev-agent");
    expect(roster).toContain("scout_agent__acpp_test_call");
    expect(roster).toContain("dev_agent__code_review");
  });
});

describe("buildAcppOrchestratorRoster", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty string when no manager", () => {
    mockGetManager.mockReturnValue(null);
    expect(buildAcppOrchestratorRoster()).toBe("");
  });

  it("returns empty string when no connected agents", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => [],
      getAgentTools: () => [],
      getAgentInfo: () => null,
    } as unknown as McpClientManager);
    expect(buildAcppOrchestratorRoster()).toBe("");
  });

  it("contains mandatory delegation language", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => ["scout-agent"],
      getAgentTools: () => [{ name: "acpp_assign_task", description: "Assign" }],
      getAgentInfo: () => ({
        name: "Scout Agent",
        description: "Research & analysis agent",
        capabilities: ["research", "analysis"],
        status: "ONLINE",
      }),
    } as unknown as McpClientManager);

    const roster = buildAcppOrchestratorRoster();
    expect(roster).toContain("MANDATORY DELEGATION");
    expect(roster).toContain("MUST NOT");
    expect(roster).toContain("pure orchestrator");
  });

  it("includes enriched agent metadata", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => ["scout-agent"],
      getAgentTools: () => [{ name: "acpp_assign_task" }],
      getAgentInfo: () => ({
        name: "Scout Agent",
        description: "Research & context gathering agent",
        capabilities: ["research", "analysis", "code-search"],
        status: "ONLINE",
      }),
    } as unknown as McpClientManager);

    const roster = buildAcppOrchestratorRoster();
    expect(roster).toContain("Scout Agent (ONLINE)");
    expect(roster).toContain("Research & context gathering agent");
    expect(roster).toContain("research, analysis, code-search");
    expect(roster).toContain("scout_agent__acpp_assign_task");
  });

  it("contains threadContent documentation", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => ["scout-agent"],
      getAgentTools: () => [{ name: "acpp_assign_task" }],
      getAgentInfo: () => null,
    } as unknown as McpClientManager);

    const roster = buildAcppOrchestratorRoster();
    expect(roster).toContain("threadContent");
    expect(roster).toContain("acpp_assign_task");
    expect(roster).toContain("REQUIRED");
  });

  it("contains routing guidelines", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => ["scout-agent"],
      getAgentTools: () => [{ name: "acpp_assign_task" }],
      getAgentInfo: () => null,
    } as unknown as McpClientManager);

    const roster = buildAcppOrchestratorRoster();
    expect(roster).toContain("Routing Guidelines");
    expect(roster).toContain("What you CAN do without delegation");
  });

  it("falls back gracefully when no agent info available", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => ["scout-agent"],
      getAgentTools: () => [{ name: "acpp_assign_task" }],
      getAgentInfo: () => null,
    } as unknown as McpClientManager);

    const roster = buildAcppOrchestratorRoster();
    expect(roster).toContain("scout-agent");
    expect(roster).toContain("scout_agent__acpp_assign_task");
    // Should not crash, just show agentId as fallback
    expect(roster).not.toContain("undefined");
  });

  it("lists multiple agents with different capabilities", () => {
    const agentInfoMap: Record<
      string,
      { name: string; description: string; capabilities: string[]; status: string }
    > = {
      "scout-agent": {
        name: "Scout Agent",
        description: "Research agent",
        capabilities: ["research", "analysis"],
        status: "ONLINE",
      },
      "developer-agent": {
        name: "Developer Agent",
        description: "Code implementation agent",
        capabilities: ["code-generation", "bug-fixing"],
        status: "ONLINE",
      },
    };

    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => ["scout-agent", "developer-agent"],
      getAgentTools: (agentId: string) =>
        agentId === "scout-agent"
          ? [{ name: "acpp_assign_task" }]
          : [{ name: "acpp_assign_task" }, { name: "code_review" }],
      getAgentInfo: (agentId: string) => agentInfoMap[agentId] ?? null,
    } as unknown as McpClientManager);

    const roster = buildAcppOrchestratorRoster();
    expect(roster).toContain("Scout Agent (ONLINE)");
    expect(roster).toContain("Developer Agent (ONLINE)");
    expect(roster).toContain("research, analysis");
    expect(roster).toContain("code-generation, bug-fixing");
    expect(roster).toContain("scout_agent__acpp_assign_task");
    expect(roster).toContain("developer_agent__acpp_assign_task");
    expect(roster).toContain("developer_agent__code_review");
  });
});
