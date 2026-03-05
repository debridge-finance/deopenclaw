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
      execute: async (params: Record<string, unknown>) => {
        const result = await clientManager.callAgentTool(agentId, mcpTool.name, params);

        // Convert MCP result to AgentToolResult format
        const textParts = result.content.filter((c) => c.type === "text").map((c) => c.text);

        const text = textParts.join("\n") || "No output";

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
