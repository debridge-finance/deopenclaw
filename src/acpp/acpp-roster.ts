import { getGlobalMcpClientManager } from "./mcp-client-singleton.js";

/**
 * Build a text block describing all connected ACPP agents and their proxy tools.
 * Injected into the system prompt so the LLM knows which agents it can delegate to.
 *
 * Returns empty string when no agents are connected.
 */
export function buildAcppRoster(): string {
  const manager = getGlobalMcpClientManager();
  if (!manager) {
    return "";
  }

  const connectedIds = manager.getConnectedAgentIds();
  if (connectedIds.length === 0) {
    return "";
  }

  const lines: string[] = [];
  lines.push(
    "You are an **ACPP Orchestrator**. You have proxy tools that delegate work to external agents.",
  );
  lines.push("");
  lines.push("| Agent ID | Proxy tool prefix | Available tools |");
  lines.push("|---|---|---|");

  for (const agentId of connectedIds) {
    const mcpTools = manager.getAgentTools(agentId);
    const prefix = agentId.replace(/-/g, "_");
    const toolNames = mcpTools.map((t) => `${prefix}__${t.name}`).join(", ") || "(none)";
    lines.push(`| ${agentId} | \`${prefix}__\` | ${toolNames} |`);
  }

  lines.push("");
  lines.push("### Routing Rules");
  lines.push(
    "- When user mentions `agent_name.tool_name` or `agent_id.tool_name`, call the matching proxy tool **immediately without confirmation**.",
  );
  lines.push("- Proxy tools forward via MCP to the agent. The result is the agent's response.");
  lines.push("- Use `{prefix}__acpp_test_call` to verify connectivity with any agent.");
  lines.push("- Use `{prefix}__acpp_assign_task` to delegate complex, multi-step work.");

  return lines.join("\n");
}
