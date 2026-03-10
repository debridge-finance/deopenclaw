import type { McpClientManager } from "./mcp-client-manager.js";
import { getGlobalMcpClientManager } from "./mcp-client-singleton.js";

/**
 * Returns true when at least one ACPP agent is connected to the gateway.
 * Used by callers to determine whether orchestrator mode should be active.
 */
export function hasAcppConnectedAgents(): boolean {
  const manager = getGlobalMcpClientManager();
  if (!manager) {
    return false;
  }
  return manager.getConnectedAgentIds().length > 0;
}

/**
 * Build the markdown agent table shared between both roster modes.
 * Returns the table lines (including header) and the connected agent IDs.
 */
function buildAgentTable(manager: McpClientManager): {
  lines: string[];
  connectedIds: string[];
} {
  const connectedIds = manager.getConnectedAgentIds();
  if (connectedIds.length === 0) {
    return { lines: [], connectedIds: [] };
  }

  const lines: string[] = [];
  lines.push("| Agent ID | Proxy tool prefix | Available tools |");
  lines.push("|---|---|---|");

  for (const agentId of connectedIds) {
    const mcpTools = manager.getAgentTools(agentId);
    const prefix = agentId.replace(/-/g, "_");
    const toolNames = mcpTools.map((t) => `${prefix}__${t.name}`).join(", ") || "(none)";
    lines.push(`| ${agentId} | \`${prefix}__\` | ${toolNames} |`);
  }

  return { lines, connectedIds };
}

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

  const { lines: tableLines, connectedIds } = buildAgentTable(manager);
  if (connectedIds.length === 0) {
    return "";
  }

  const lines: string[] = [];
  lines.push(
    "You are an **ACPP Orchestrator**. You have proxy tools that delegate work to external agents.",
  );
  lines.push("");
  lines.push(...tableLines);

  lines.push("");
  lines.push("### Routing Rules");
  lines.push(
    "- When user mentions `agent_name.tool_name` or `agent_id.tool_name`, call the matching proxy tool **immediately without confirmation**.",
  );
  lines.push("- Proxy tools forward via MCP to the agent. The result is the agent's response.");
  lines.push("- Use `<agent_prefix>__acpp_test_call` to verify connectivity with any agent.");
  lines.push("- Use `<agent_prefix>__acpp_assign_task` to delegate complex, multi-step work.");

  return lines.join("\n");
}

/**
 * Build an **orchestrator-mode** roster prompt that forces the LLM to delegate ALL
 * user requests to connected ACPP agents. The orchestrator never performs work itself.
 *
 * Unlike the basic roster, this includes rich agent metadata (description, capabilities)
 * so the LLM can make informed routing decisions.
 *
 * Returns empty string when no agents are connected.
 */
export function buildAcppOrchestratorRoster(): string {
  const manager = getGlobalMcpClientManager();
  if (!manager) {
    return "";
  }

  const connectedIds = manager.getConnectedAgentIds();
  if (connectedIds.length === 0) {
    return "";
  }

  // Build the list of all ACPP proxy tool names so we can whitelist them
  const acppToolNames: string[] = [];
  for (const agentId of connectedIds) {
    const mcpTools = manager.getAgentTools(agentId);
    const prefix = agentId.replace(/-/g, "_");
    for (const t of mcpTools) {
      acppToolNames.push(`${prefix}__${t.name}`);
    }
  }

  const lines: string[] = [];

  // -- CRITICAL preamble --
  lines.push("## ⚡ ORCHESTRATOR MODE — MANDATORY DELEGATION");
  lines.push("");
  lines.push(
    "**CRITICAL SYSTEM INSTRUCTION**: You are a **pure orchestrator**. You do NOT perform any work yourself. " +
      "Your ONLY purpose is to route user requests to the appropriate ACPP agent.",
  );
  lines.push("");

  // -- Decision Flow --
  lines.push("### Decision Flow");
  lines.push("1. Analyze the user's request to understand intent");
  lines.push("2. Review the connected agents and their capabilities below");
  lines.push("3. Select the best agent for the task");
  lines.push("4. Call `<agent_prefix>__acpp_assign_task` with:");
  lines.push("   - `taskId`: generate a unique UUID");
  lines.push("   - `description`: human-readable summary of what the agent should do");
  lines.push("   - `params.threadContent`: the FULL user request text (verbatim)");
  lines.push('   - `priority`: "normal" (or "high" for urgent tasks)');
  lines.push("5. Wait for the result (auto-polling is handled by the system)");
  lines.push("6. Return the agent's response to the user");
  lines.push("");

  // -- Explicit tool prohibition --
  lines.push("### 🚫 PROHIBITED ACTIONS");
  lines.push("");
  lines.push(
    "You **MUST NOT** use any built-in/workspace tools. " +
      "The **ONLY** tools you are allowed to call are ACPP proxy tools:",
  );
  lines.push("");
  for (const toolName of acppToolNames) {
    lines.push(`- \`${toolName}\``);
  }
  lines.push("");
  lines.push("**If you use ANY tool not in the list above, you are violating orchestrator mode.**");
  lines.push("");

  // -- Connected Agents with enriched metadata --
  lines.push("### Connected Agents");
  lines.push("");

  for (const agentId of connectedIds) {
    const prefix = agentId.replace(/-/g, "_");
    const info = manager.getAgentInfo(agentId);

    if (info) {
      const statusBadge = info.status === "ONLINE" ? "ONLINE" : info.status;
      lines.push(`#### ${info.name} (${statusBadge})`);
      lines.push(`- **Agent ID**: ${agentId}`);
      lines.push(`- **Description**: ${info.description}`);
      lines.push(`- **Capabilities**: ${info.capabilities.join(", ")}`);
      lines.push(`- **Delegate via**: \`${prefix}__acpp_assign_task\``);
    } else {
      // Fallback: no metadata available from AgentStore
      lines.push(`#### ${agentId}`);
      lines.push(`- **Delegate via**: \`${prefix}__acpp_assign_task\``);
    }
    lines.push("");
  }

  // -- assign_task usage guide --
  lines.push("### How to use `acpp_assign_task`");
  lines.push("");
  lines.push("```json");
  lines.push("{");
  lines.push('  "taskId": "<generate-a-unique-uuid>",');
  lines.push('  "description": "<human-readable summary of what the agent should do>",');
  lines.push('  "params": {');
  lines.push('    "threadContent": "<the full user request or conversation context>"');
  lines.push("  },");
  lines.push('  "priority": "normal"');
  lines.push("}");
  lines.push("```");
  lines.push("");
  lines.push(
    "**Important**: The `threadContent` field inside `params` is REQUIRED — it provides " +
      "the agent with the full context needed to execute the task.",
  );
  lines.push("");

  // -- Routing Guidelines --
  lines.push("### Routing Guidelines");
  lines.push("- Match user intent to the best agent based on the capabilities listed above.");
  lines.push(
    "- When uncertain, prefer agents with research/analysis capabilities for investigation tasks.",
  );
  lines.push(
    "- Call proxy tools **immediately without confirmation** — do not ask the user which agent to use.",
  );
  lines.push("- Relay the agent's response to the user verbatim or with minimal formatting.");
  lines.push("");

  // -- What the orchestrator CAN do --
  lines.push("### What you CAN do without delegation");
  lines.push("- Answer meta-questions about yourself (status, connected agents)");
  lines.push("- Explain what agents are available and their capabilities");
  lines.push("- Ask clarifying questions to better route the request");
  lines.push("");

  lines.push(
    "**REMINDER: ONLY use the ACPP proxy tools listed above. Do NOT use any other tools.**",
  );

  return lines.join("\n");
}
