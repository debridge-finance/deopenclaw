import type { McpClientManager } from "./mcp-client-manager.js";
import { getGlobalMcpClientManager } from "./mcp-client-singleton.js";

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
  lines.push("- Use `{prefix}__acpp_test_call` to verify connectivity with any agent.");
  lines.push("- Use `{prefix}__acpp_assign_task` to delegate complex, multi-step work.");

  return lines.join("\n");
}

/**
 * Build an **agentic-mode** roster prompt that forces the LLM to delegate ALL
 * user requests to connected ACPP agents. Used when the UI is in "Agentic Mode".
 *
 * Returns empty string when no agents are connected.
 */
export function buildAcppAgenticRoster(): string {
  const manager = getGlobalMcpClientManager();
  if (!manager) {
    return "";
  }

  const { lines: tableLines, connectedIds } = buildAgentTable(manager);
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
  lines.push("## ⚡ AGENTIC MODE — MANDATORY DELEGATION");
  lines.push("");
  lines.push(
    "**CRITICAL SYSTEM INSTRUCTION**: You are an **ACPP Orchestrator** operating in " +
      "**strict agentic mode**. In this mode you are a **pure router** — your ONLY job is to " +
      "forward user requests to connected agents and relay their responses.",
  );
  lines.push("");

  // -- Explicit tool prohibition --
  lines.push("### 🚫 PROHIBITED ACTIONS");
  lines.push("");
  lines.push(
    "You **MUST NOT** use any of the following tools: `Read`, `Execute`, `Search`, `Write`, " +
      "`Grep`, `List`, `Glob`, `Cat`, `Bash`, `WebSearch`, `WebFetch`, or ANY other " +
      "built-in/workspace tool. The **ONLY** tools you are allowed to call are ACPP proxy tools:",
  );
  lines.push("");
  for (const toolName of acppToolNames) {
    lines.push(`- \`${toolName}\``);
  }
  lines.push("");
  lines.push("**If you use ANY tool not in the list above, you are violating agentic mode.**");
  lines.push("");

  // -- Mandatory rules --
  lines.push("### Rules (non-negotiable)");
  lines.push("");
  lines.push(
    "1. Every user request **MUST** result in a call to `{prefix}__acpp_assign_task` " +
      "or another ACPP proxy tool.",
  );
  lines.push(
    "2. **NEVER** answer from your own knowledge, read files yourself, execute code yourself, " +
      "or do research yourself. You are a dispatcher, not an executor.",
  );
  lines.push("3. Choose the most appropriate agent based on the task description.");
  lines.push(
    "4. For complex/multi-step tasks: use `{prefix}__acpp_assign_task` with a clear " +
      "`description` and `params.threadContent` containing the full user request.",
  );
  lines.push("5. For simple tool calls (test, ping): call `{prefix}__acpp_test_call` directly.");
  lines.push("6. After delegating, relay the agent's response to the user.");
  lines.push("");

  // -- Agent table --
  lines.push("### Connected Agents");
  lines.push("");
  lines.push(...tableLines);
  lines.push("");

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

  // -- Routing --
  lines.push("### Routing Rules");
  lines.push(
    "- Match user intent to the best agent. When uncertain, prefer `scout-agent` for " +
      "research/investigation tasks.",
  );
  lines.push(
    "- Call proxy tools **immediately without confirmation** — do not ask the user " +
      "which agent to use.",
  );
  lines.push(
    "- If the task result is not yet ready (`status: running`), wait briefly and poll " +
      "again with `acpp_get_task_result`.",
  );
  lines.push("- Relay the agent's response to the user verbatim or with minimal formatting.");
  lines.push("");
  lines.push(
    "**REMINDER: DO NOT use Read, Execute, Search, or any other built-in tool. " +
      "ONLY use the ACPP proxy tools listed above.**",
  );

  return lines.join("\n");
}
