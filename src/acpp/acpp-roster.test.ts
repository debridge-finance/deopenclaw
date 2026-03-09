import { describe, it, expect, vi, afterEach } from "vitest";
import { buildAcppRoster, buildAcppAgenticRoster } from "./acpp-roster.js";

// Mock mcp-client-singleton
vi.mock("./mcp-client-singleton.js", () => ({
  getGlobalMcpClientManager: vi.fn(),
}));

import { getGlobalMcpClientManager } from "./mcp-client-singleton.js";
const mockGetManager = vi.mocked(getGlobalMcpClientManager);

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
    } as unknown);
    expect(buildAcppRoster()).toBe("");
  });

  it("returns roster with agent and tools", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => ["scout-agent"],
      getAgentTools: (_agentId: string) => [
        { name: "acpp_test_call", description: "Test" },
        { name: "acpp_assign_task", description: "Assign" },
      ],
    } as unknown);

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
    } as unknown);

    const roster = buildAcppRoster();
    expect(roster).toContain("scout-agent");
    expect(roster).toContain("dev-agent");
    expect(roster).toContain("scout_agent__acpp_test_call");
    expect(roster).toContain("dev_agent__code_review");
  });
});

describe("buildAcppAgenticRoster", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty string when no manager", () => {
    mockGetManager.mockReturnValue(null);
    expect(buildAcppAgenticRoster()).toBe("");
  });

  it("returns empty string when no connected agents", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => [],
      getAgentTools: () => [],
    } as unknown);
    expect(buildAcppAgenticRoster()).toBe("");
  });

  it("contains mandatory delegation language", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => ["scout-agent"],
      getAgentTools: () => [{ name: "acpp_assign_task", description: "Assign" }],
    } as unknown);

    const roster = buildAcppAgenticRoster();
    expect(roster).toContain("MANDATORY DELEGATION");
    expect(roster).toContain("MUST");
    expect(roster).toContain("DO NOT");
    expect(roster).toContain("agentic mode");
  });

  it("contains threadContent documentation", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => ["scout-agent"],
      getAgentTools: () => [{ name: "acpp_assign_task" }],
    } as unknown);

    const roster = buildAcppAgenticRoster();
    expect(roster).toContain("threadContent");
    expect(roster).toContain("acpp_assign_task");
    expect(roster).toContain("REQUIRED");
  });

  it("lists agent tools in table", () => {
    mockGetManager.mockReturnValue({
      getConnectedAgentIds: () => ["scout-agent"],
      getAgentTools: () => [{ name: "acpp_test_call" }, { name: "acpp_assign_task" }],
    } as unknown);

    const roster = buildAcppAgenticRoster();
    expect(roster).toContain("scout-agent");
    expect(roster).toContain("scout_agent__acpp_test_call");
    expect(roster).toContain("scout_agent__acpp_assign_task");
  });
});
