import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import type { McpClientManager, McpToolDefinition } from "../acpp/mcp-client-manager.js";
import { setGlobalMcpClientManager } from "../acpp/mcp-client-singleton.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

/**
 * Create a minimal McpClientManager stub for testing.
 * The real class requires a SubsystemLogger; we only stub methods used by
 * resolveAcppProxyTools (getConnectedAgentIds, getAgentTools, callAgentTool).
 */
function makeFakeManager(agents: Record<string, McpToolDefinition[]>): McpClientManager {
  return {
    getConnectedAgentIds: () => Object.keys(agents),
    getAgentTools: (id: string) => agents[id] ?? [],
    callAgentTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    }),
    // Unused stubs to satisfy the type
    connect: vi.fn(),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
    isConnected: vi.fn(),
    init: vi.fn(),
  } as unknown as McpClientManager;
}

describe("resolveAcppProxyTools (via createOpenClawCodingTools)", () => {
  beforeEach(() => {
    // Clear singleton before each test
    setGlobalMcpClientManager(null as unknown as McpClientManager);
  });

  afterEach(() => {
    setGlobalMcpClientManager(null as unknown as McpClientManager);
  });

  function buildTools(sessionKey: string) {
    return createOpenClawCodingTools({
      sessionKey,
      workspaceDir: "/tmp/test-acpp-proxy",
      agentDir: "/tmp/agent-acpp-proxy",
      senderIsOwner: true,
    });
  }

  it("injects proxy tools for main session when ACPP agents are connected", () => {
    const fakeManager = makeFakeManager({
      "scout-agent": [
        { name: "search_repositories", description: "Search repos" },
        { name: "get_issue", description: "Get Jira issue" },
      ],
    });
    setGlobalMcpClientManager(fakeManager);

    const tools = buildTools("agent:main:main");
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("scout_agent__search_repositories");
    expect(toolNames).toContain("scout_agent__get_issue");
  });

  it("does NOT inject proxy tools for ACP sessions (avoids duplication)", () => {
    const fakeManager = makeFakeManager({
      "scout-agent": [{ name: "search_repositories" }],
    });
    setGlobalMcpClientManager(fakeManager);

    const tools = buildTools("agent:scout-agent:acp:550e8400-e29b-41d4-a716-446655440000");
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).not.toContain("scout_agent__search_repositories");
  });

  it("injects proxy tools for subagent sessions", () => {
    const fakeManager = makeFakeManager({
      "scout-agent": [{ name: "search_repositories" }],
    });
    setGlobalMcpClientManager(fakeManager);

    const tools = buildTools("agent:main:subagent:test-sub-1");
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("scout_agent__search_repositories");
  });

  it("returns no proxy tools when McpClientManager is not set", () => {
    // Manager left as null from beforeEach
    const tools = buildTools("agent:main:main");
    const toolNames = tools.map((t) => t.name);

    const proxyTools = toolNames.filter((n) => n.includes("__"));
    expect(proxyTools).toHaveLength(0);
  });

  it("returns no proxy tools when no agents are connected", () => {
    const fakeManager = makeFakeManager({});
    setGlobalMcpClientManager(fakeManager);

    const tools = buildTools("agent:main:main");
    const toolNames = tools.map((t) => t.name);

    const proxyTools = toolNames.filter((n) => n.includes("__"));
    expect(proxyTools).toHaveLength(0);
  });

  it("injects proxy tools from multiple ACPP agents", () => {
    const fakeManager = makeFakeManager({
      "scout-agent": [{ name: "search_repositories" }],
      "sla-agent": [{ name: "check_compliance" }],
    });
    setGlobalMcpClientManager(fakeManager);

    const tools = buildTools("agent:main:main");
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("scout_agent__search_repositories");
    expect(toolNames).toContain("sla_agent__check_compliance");
  });

  it("injects proxy tools for channel/group sessions", () => {
    const fakeManager = makeFakeManager({
      "scout-agent": [{ name: "search_repositories" }],
    });
    setGlobalMcpClientManager(fakeManager);

    const tools = buildTools("agent:main:whatsapp:group:123");
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("scout_agent__search_repositories");
  });
});
