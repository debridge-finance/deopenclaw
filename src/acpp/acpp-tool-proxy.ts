import { Type } from "@sinclair/typebox";
import type { McpClientManager, McpToolDefinition } from "./mcp-client-manager.js";

/**
 * Creates proxy tools for an ACPP agent's MCP tools.
 * Each proxy tool wraps a `tools/call` RPC through the {@link McpClientManager}.
 *
 * Tool names are prefixed with the agent ID to avoid collisions:
 *   e.g. `scout__search_repositories` → calls `search_repositories` on scout-agent
 *
 * @param agentId — the registered ACPP agent ID
 * @param tools — MCP tool definitions from `tools/list`
 * @param clientManager — the McpClientManager instance for proxying calls
 */
export function createAcppProxyTools(
  agentId: string,
  tools: McpToolDefinition[],
  clientManager: McpClientManager,
) {
  const prefix = agentId.replace(/-/g, "_");

  return tools.map((mcpTool) => {
    // Convert MCP inputSchema to TypeBox-compatible schema
    const parameters = mcpTool.inputSchema
      ? convertJsonSchemaToTypebox(mcpTool.inputSchema)
      : Type.Object({});

    return {
      name: `${prefix}__${mcpTool.name}`,
      description: `[${agentId}] ${mcpTool.description || mcpTool.name}`,
      parameters,
      execute: async (
        _toolCallId: string,
        rawParams: Record<string, unknown>,
        _signal?: AbortSignal,
        _onUpdate?: unknown,
      ) => {
        // Normalize params: LLMs sometimes send nested objects as JSON strings.
        // Parse them back so the agent receives real objects as the schema expects.
        const params = normalizeParams(rawParams, mcpTool.inputSchema);
        const result = await clientManager.callAgentTool(agentId, mcpTool.name, params);

        // Convert MCP result to AgentToolResult format
        const textParts = result.content.filter((c) => c.type === "text").map((c) => c.text);
        let text = textParts.join("\n") || "No output";

        // For acpp_assign_task: auto-poll for task result instead of returning "accepted"
        if (mcpTool.name === "acpp_assign_task" && !result.isError) {
          const taskId = params.taskId as string | undefined;
          if (taskId) {
            const POLL_INTERVAL_MS = 5_000;
            const MAX_POLL_MS = 5 * 60 * 1000; // 5 minutes
            const start = Date.now();

            while (Date.now() - start < MAX_POLL_MS) {
              await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

              try {
                const poll = await clientManager.callAgentTool(agentId, "acpp_get_task_result", {
                  taskId,
                });
                const pollText = poll.content
                  .filter((c) => c.type === "text")
                  .map((c) => c.text)
                  .join("\n");

                // Parse the result to check status
                try {
                  const parsed = JSON.parse(pollText);
                  if (parsed.status === "completed" || parsed.status === "failed") {
                    text = pollText;
                    break;
                  }
                } catch {
                  // Non-JSON response — keep polling
                }
              } catch {
                // Poll failed — keep trying
              }
            }
          }
        }

        return {
          content: [{ type: "text" as const, text }],
          details: { agentId, tool: mcpTool.name, isError: result.isError },
        };
      },
    };
  });
}

/**
 * Convert a JSON Schema to a TypeBox schema object.
 * Since MCP tools provide standard JSON Schema, we need to pass it through
 * to the LLM in a compatible format.
 */
function convertJsonSchemaToTypebox(schema: Record<string, unknown>) {
  // TypeBox schemas are compatible with JSON Schema — pass through directly
  // The LLM tool definition adapter will serialize this correctly
  if (schema.type === "object" && schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const typeboxProps: Record<string, unknown> = {};

    for (const [key, prop] of Object.entries(props)) {
      const isRequired = required.has(key);
      const description = (prop.description as string) || undefined;

      if (prop.type === "string") {
        typeboxProps[key] = isRequired
          ? Type.String({ description })
          : Type.Optional(Type.String({ description }));
      } else if (prop.type === "number" || prop.type === "integer") {
        typeboxProps[key] = isRequired
          ? Type.Number({ description })
          : Type.Optional(Type.Number({ description }));
      } else if (prop.type === "boolean") {
        typeboxProps[key] = isRequired
          ? Type.Boolean({ description })
          : Type.Optional(Type.Boolean({ description }));
      } else if (prop.type === "array") {
        typeboxProps[key] = isRequired
          ? Type.Array(Type.Unknown(), { description })
          : Type.Optional(Type.Array(Type.Unknown(), { description }));
      } else if (prop.type === "object") {
        // Nested object / record — tell the LLM this is a JSON object, not a string
        typeboxProps[key] = isRequired
          ? Type.Record(Type.String(), Type.Unknown(), { description })
          : Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description }));
      } else {
        // Fallback: accept any value
        typeboxProps[key] = isRequired
          ? Type.Unknown({ description })
          : Type.Optional(Type.Unknown({ description }));
      }
    }

    // oxlint-disable-next-line typescript/no-explicit-any
    return Type.Object(typeboxProps as any);
  }

  // Non-object schema → wraps in a single "input" param
  return Type.Object({
    input: Type.Optional(Type.Unknown({ description: "Tool input" })),
  });
}

/**
 * Normalize tool call params from the LLM.
 * LLMs sometimes serialize nested objects as JSON strings instead of real objects.
 * For each property that the schema expects as "object" but we received a "string",
 * attempt to JSON.parse it back.
 */
function normalizeParams(
  params: Record<string, unknown>,
  inputSchema?: Record<string, unknown>,
): Record<string, unknown> {
  if (!inputSchema || inputSchema.type !== "object" || !inputSchema.properties) {
    return params;
  }

  const props = inputSchema.properties as Record<string, Record<string, unknown>>;
  const result = { ...params };

  for (const [key, prop] of Object.entries(props)) {
    const value = result[key];
    // If schema expects object/array but received a string, try to parse it
    if (typeof value === "string" && (prop.type === "object" || prop.type === "array")) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        // Keep original string if it's not valid JSON
      }
    }
  }

  return result;
}
