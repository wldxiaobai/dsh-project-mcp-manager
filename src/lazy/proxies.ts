import { createMcpToolDefinition, type McpToolDefinitionOptions } from "@deepseek-ai/dsh-mcp-client";
import type { Context } from "@deepseek-ai/cordis";
import { createHash } from "node:crypto";
import { z } from "zod";
import { matchToolGlob, toolFilterFromConfig } from "../model.js";
import type { ProjectServerState } from "../registry.js";
import type { LazyConnections, LazyServer, LazyTool } from "./connection.js";

import { LAZY_TOOL_NAMES } from "./tool-names.js";
export { LAZY_TOOL_NAMES, isLazyToolName } from "./tool-names.js";

export type LazyMount = ProjectServerState & { lazy: LazyConnections };
type VisibleMounts = () => LazyMount[];
type LazySession = { id: string; visible: VisibleMounts };
type ToolCall = McpToolDefinitionOptions["call"];

const server = z.string().min(1).max(32);
const tool = z.string().min(1);
const target = z.object({ server, tool });
const call = target.extend({ arguments: z.record(z.string(), z.unknown()).optional() });
const search = z.object({
  query: z.string().max(500).optional(),
  server: server.optional(),
  limit: z.number().int().min(1).max(50).optional()
});

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

/**
 * Internal test seam: apply one row's `tools.allow` / `deny` to a Lazy catalog.
 * Not re-exported from the package entry.
 */
export function allowedTools(state: LazyMount, tools: LazyTool[]): LazyTool[] {
  const filter = toolFilterFromConfig(state.row.config);
  if (filter === undefined) return tools;
  const prefix = `mcp__${state.effectiveName}__`;
  return tools.filter(({ name }) => {
    const raw = prefix + name;
    const registered = eagerToolName(state.effectiveName, name, raw);
    const matches = (pattern: string) => pattern.includes("mcp__")
      ? matchToolGlob(pattern, registered)
      : matchToolGlob(pattern, name) || matchToolGlob(pattern, registered.slice(prefix.length));
    return filter.deny?.some(matches) !== true && (filter.allow === undefined || filter.allow.some(matches));
  });
}

/**
 * Mirror the official Eager bridge's public name for existing full-name filters.
 * The official package does not export its naming helper; the parity test drives
 * the public `apply` entry against a local MCP server instead of importing internals.
 * Exported for lib-internal tests only; the package entry does not re-export it.
 */
export function eagerToolName(server: string, tool: string, raw: string): string {
  const normalized = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  if (normalized === raw && normalized.length <= 64) return raw;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 12);
  return `${normalized.slice(0, 51)}_${hash}`;
}

async function searchTools(args: z.infer<typeof search>, { id, visible }: LazySession, signal: AbortSignal) {
  const terms = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const states = visible().filter((state) => args.server === undefined || state.effectiveName === args.server);
  const results = await Promise.all(states.map(async (state) => {
    try {
      signal.throwIfAborted();
      const server = state.lazy.forSession(id, true);
      return await server?.withClient(signal, (connection) => server.listTools(connection));
    } catch {
      return undefined;
    }
  }));
  signal.throwIfAborted();
  const current = new Set(visible());
  const matches: { server: string; tool: string; description: string }[] = [];
  const unavailable: string[] = [];
  for (const [index, state] of states.entries()) {
    if (!current.has(state)) continue;
    const tools = results[index];
    if (tools === undefined) {
      unavailable.push(state.effectiveName);
      continue;
    }
    for (const tool of allowedTools(state, tools)) {
      const description = tool.description ?? "";
      const haystack = `${state.rawName} ${tool.name} ${description}`.toLowerCase();
      if (terms.every((term) => haystack.includes(term))) {
        matches.push({ server: state.effectiveName, tool: tool.name, description: description.slice(0, 300) });
      }
    }
  }
  return textResult({ tools: matches.slice(0, args.limit ?? 10), total: matches.length, unavailable });
}

async function withTool<T>(args: z.infer<typeof target>, { id, visible }: LazySession, signal: AbortSignal,
  use: (tool: LazyTool, invoke: (args: Record<string, unknown>) => ReturnType<LazyServer["callTool"]>) => T) {
  const state = visible().find((item) => item.effectiveName === args.server);
  if (state === undefined) throw new Error("MCP server is unavailable in this session");
  const server = state.lazy.forSession(id, false);
  if (server === undefined) throw new Error("Run mcp_search for this MCP server in the current session first");
  return server.withClient(signal, async (connection) => {
    const tools = await server.listTools(connection);
    signal.throwIfAborted();
    if (!visible().includes(state)) throw new Error("MCP server is unavailable in this session");
    const tool = allowedTools(state, tools).find((item) => item.name === args.tool);
    if (tool === undefined) throw new Error("MCP tool is unavailable in this session");
    return use(tool, (args) => server.callTool(connection, tool, args, signal));
  });
}

export function registerLazyTools(ctx: Context, resolve: (agent: unknown) => Promise<LazySession>): () => void {
  const disposers: (() => void)[] = [];
  const dispose = () => {
    for (const release of disposers.splice(0).reverse()) release();
  };
  const definitions = [
    {
      name: LAZY_TOOL_NAMES[0],
      description: "Find Lazy MCP tools available in this session. Optionally filter by server or search terms. Use mcp_describe before calling a tool.",
      schema: search,
      call: (async (args, exec) => searchTools(search.parse(args), await resolve(exec.agent), exec.signal)) satisfies ToolCall
    },
    {
      name: LAZY_TOOL_NAMES[1],
      description: "Read the full input and output schemas of a Lazy MCP tool identified by mcp_search.",
      schema: target,
      call: (async (args, exec) => withTool(target.parse(args), await resolve(exec.agent), exec.signal,
        ({ name, description, inputSchema, outputSchema, annotations, execution }) =>
          textResult({ name, description, inputSchema, outputSchema, annotations, execution }))) satisfies ToolCall
    },
    {
      name: LAZY_TOOL_NAMES[2],
      description: "Call a Lazy MCP tool using the server and tool names returned by mcp_search and the arguments from mcp_describe.",
      schema: call,
      call: (async (raw, exec) => {
        const args = call.parse(raw);
        return withTool(args, await resolve(exec.agent), exec.signal, (_, invoke) => invoke(args.arguments ?? {}));
      }) satisfies ToolCall
    }
  ];
  try {
    for (const definition of definitions) {
      const { $schema, ...inputSchema } = z.toJSONSchema(definition.schema, {
        target: "draft-7",
        override: ({ jsonSchema }) => { delete jsonSchema.propertyNames; }
      });
      disposers.push(ctx.tools.register(createMcpToolDefinition(ctx, {
        name: definition.name,
        rawName: definition.name,
        description: definition.description,
        inputSchema,
        call: definition.call
      })));
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
