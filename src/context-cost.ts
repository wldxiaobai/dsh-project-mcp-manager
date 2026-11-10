/**
 * 会话级 MCP 工具定义的上下文占用估算（纯函数）。
 *
 * 输入是某个会话可见的工具 schema（`agent.ctx` 视角的 `tools.schemas()`，已经过
 * 本插件的 deny 与条目 allow/deny）。只统计 MCP 工具：`mcp__<生效名>__<工具>`。
 * token 按 DSH token-meter 的同一口径估算：`ceil(JSON.stringify(tools).length / 4) + 4`，
 * 不是 provider 精确计数，也不含服务器 instructions。
 */

export const MCP_TOOL_PREFIX = "mcp__";
/** 提醒阈值：达到后抬头标签变为提醒色。 */
export const CONTEXT_COST_WARN_TOKENS = 5_000;
/** 警告阈值：达到后标签变为警告色并加警告图标。 */
export const CONTEXT_COST_ALERT_TOKENS = 10_000;

const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;

export type ContextCostLevel = "ok" | "warn" | "alert";

export interface McpServerContextCost {
  /** 生效名（工具名里 `mcp__` 与下一个 `__` 之间的部分）。 */
  name: string;
  tools: number;
  chars: number;
  estTokens: number;
}

export interface McpContextCost {
  /** 被统计的会话 id；找不到当前会话时为 null，其余字段为零。 */
  sessionId: string | null;
  tools: number;
  chars: number;
  estTokens: number;
  level: ContextCostLevel;
  /** 模型上下文窗口（来自会话最近一次请求的路由信息）；未知时省略。 */
  contextWindow?: number;
  /** 按估算 token 从大到小排序。 */
  servers: McpServerContextCost[];
  warnTokens: number;
  alertTokens: number;
}

/** DSH token-meter 的工具 schema 估算口径。空列表为 0。 */
export function estimateSchemaTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
}

export function contextCostLevel(estTokens: number, warn = CONTEXT_COST_WARN_TOKENS, alert = CONTEXT_COST_ALERT_TOKENS): ContextCostLevel {
  if (estTokens >= alert) return "alert";
  if (estTokens >= warn) return "warn";
  return "ok";
}

function toolNameOf(schema: any): string {
  if (typeof schema?.name === "string") return schema.name;
  if (typeof schema?.id === "string") return schema.id;
  return "";
}

/**
 * 工具名归属的服务器生效名。优先匹配已知生效名里最长的前缀（生效名本身可含 `__`），
 * 否则取 `mcp__` 之后到下一个 `__` 为止。不是 MCP 工具时返回 undefined。
 */
export function mcpServerOfTool(toolName: string, knownServers: readonly string[] = []): string | undefined {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return undefined;
  let best: string | undefined;
  for (const server of knownServers) {
    if (server === "" || !toolName.startsWith(`${MCP_TOOL_PREFIX}${server}__`)) continue;
    if (best === undefined || server.length > best.length) best = server;
  }
  if (best !== undefined) return best;
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const end = rest.indexOf("__");
  return end > 0 ? rest.slice(0, end) : undefined;
}

/** 与 DSH `projectToolSchema` 相同的模型可见字段，避免把回调或宿主私有字段算进去。 */
function modelFacing(schema: any): unknown {
  return {
    name: toolNameOf(schema),
    description: typeof schema?.description === "string" ? schema.description : "",
    parameters: schema?.parameters ?? schema?.inputSchema ?? {}
  };
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export interface ContextCostInput {
  sessionId: string | null;
  /** 该会话可见的工具 schema；会话缺失时传空数组。 */
  schemas: readonly unknown[];
  knownServers?: readonly string[];
  contextWindow?: number;
  warnTokens?: number;
  alertTokens?: number;
}

/**
 * 汇总一份会话工具视图里的 MCP 定义占用。`deferLoading` 的工具不进本次请求，不计。
 * 总数按整组 schema 一次估算（与 DSH 对 `header.tools` 的口径一致），
 * 各服务器分别按自己那组估算，所以分项之和与总数可能差几个 token。
 */
export function mcpContextCost(input: ContextCostInput): McpContextCost {
  const warnTokens = input.warnTokens ?? CONTEXT_COST_WARN_TOKENS;
  const alertTokens = input.alertTokens ?? CONTEXT_COST_ALERT_TOKENS;
  const groups = new Map<string, unknown[]>();
  const all: unknown[] = [];
  for (const schema of input.schemas) {
    if ((schema as any)?.deferLoading === true) continue;
    const server = mcpServerOfTool(toolNameOf(schema), input.knownServers);
    if (server === undefined) continue;
    const facing = modelFacing(schema);
    all.push(facing);
    const group = groups.get(server) ?? [];
    group.push(facing);
    groups.set(server, group);
  }
  const servers: McpServerContextCost[] = [...groups].map(([name, tools]) => {
    const chars = serializedLength(tools);
    return { name, tools: tools.length, chars, estTokens: estimateSchemaTokens(chars) };
  });
  servers.sort((a, b) => b.estTokens - a.estTokens || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chars = all.length === 0 ? 0 : serializedLength(all);
  const estTokens = estimateSchemaTokens(chars);
  return {
    sessionId: input.sessionId,
    tools: all.length,
    chars,
    estTokens,
    level: contextCostLevel(estTokens, warnTokens, alertTokens),
    ...(input.contextWindow !== undefined && input.contextWindow > 0 ? { contextWindow: input.contextWindow } : {}),
    servers,
    warnTokens,
    alertTokens
  };
}

/** 推送去重用的签名：只含会改变显示的字段。 */
export function contextCostSignature(cost: McpContextCost): string {
  return JSON.stringify([cost.sessionId, cost.estTokens, cost.contextWindow ?? null, cost.servers.map((s) => [s.name, s.tools, s.estTokens])]);
}
