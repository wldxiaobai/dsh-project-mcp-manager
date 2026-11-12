/**
 * 会话级 MCP 上下文占用估算（纯函数）。
 *
 * 两份口径：
 * - 工具定义：输入是某个会话可见的工具 schema（`agent.ctx` 视角的
 *   `tools.schemas()`，已经过本插件的 deny 与条目 allow/deny）。统计
 *   `mcp__<生效名>__<工具>` 及可见的三个 Lazy 代理，按
 *   `ceil(JSON.stringify(tools).length / 4) + 4` 计价。
 * - 工具调用结果：输入是会话当前模型可见的消息（`session.deriveMessages()`），
 *   只取仍留在 surface 上的 `tool/result` 消息，按 DSH token-meter 的逐条消息
 *   口径计价。被裁剪或压缩掉的结果不在当前上下文里，不计。
 *
 * 两者都是估算，不是 provider 精确计数；工具定义口径也不含服务器 instructions。
 *
 * 代码模式（PTC / run_code）下两份口径都无法成立：工具定义被渲染进系统提示词
 * 的 `tools:sdk` 文本（不是逐工具的请求 `tools` 列表），MCP 调用又嵌在 `run_code`
 * 内部、surface 上只剩外层结果。此时返回 `unsupported: "code-mode"`，由调用方
 * 明确显示「无法估算」，而不是给出误导性的零或按原生口径硬算。
 */

import { LAZY_PROXY_GROUP_NAME, isLazyToolName } from "./lazy/tool-names.js";

export const MCP_TOOL_PREFIX = "mcp__";
/**
 * 代码模式（PTC）执行器对外暴露的唯一工具名。宿主把它列为保留名（注册/限制
 * 都会拒绝），所以某次请求的 `tools` 里出现它就等价于该会话走 PTC。这里镜像
 * 宿主常量、不新增依赖；判定只读请求头，不触碰执行器私有接口。
 */
export const CODE_MODE_TOOL_NAME = "run_code";

/**
 * 某次请求的工具列表是否来自代码模式（PTC）执行器。`run_code` 是保留名，
 * 原生执行器不会注册它，因此出现即判定为代码模式。只读、不抛错。
 */
export function isCodeModeTools(tools: readonly unknown[] | undefined): boolean {
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => (tool as { name?: unknown } | null)?.name === CODE_MODE_TOOL_NAME);
}
/** 提醒阈值：达到后抬头标签变为提醒色。 */
export const CONTEXT_COST_WARN_TOKENS = 5_000;
/** 警告阈值：达到后标签变为警告色并加警告图标。 */
export const CONTEXT_COST_ALERT_TOKENS = 10_000;

const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;

export type ContextCostLevel = "ok" | "warn" | "alert";

export interface McpServerContextCost {
  /** 服务器生效名；Lazy 公共代理使用保留的合成组名 `[lazy proxies]`。 */
  name: string;
  /** 仅共享代理组设置；缺省仍为普通服务器，兼容既有调用方。 */
  kind?: "lazy-proxy";
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
  /**
   * 代码模式（PTC）下定义走系统提示词渲染，无法按工具 schema 估算；
   * 置 `"code-mode"` 时其余数值字段为零、`servers` 为空，调用方应显示「无法估算」。
   */
  unsupported?: "code-mode";
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

/** 分项排序：估算 token 从大到小，同量按名称的 UTF-16 码元序。 */
function byEstimatedSize(a: { name: string; estTokens: number }, b: { name: string; estTokens: number }): number {
  if (a.estTokens !== b.estTokens) return b.estTokens - a.estTokens;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
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
  /** 会话走代码模式（PTC）：定义无法按 schema 估算，返回 unsupported。 */
  codeMode?: boolean;
}

/**
 * 汇总一份会话工具视图里的 MCP 定义占用。`deferLoading` 的工具不进本次请求，不计。
 * 共享 Lazy 代理按会话工具列表只计一组，不按服务器数量复制，也不连接/读取远端目录。
 * 总数按整组 schema 一次估算（与 DSH 对 `header.tools` 的口径一致），
 * 各服务器分别按自己那组估算，所以分项之和与总数可能差几个 token。
 */
export function mcpContextCost(input: ContextCostInput): McpContextCost {
  const warnTokens = input.warnTokens ?? CONTEXT_COST_WARN_TOKENS;
  const alertTokens = input.alertTokens ?? CONTEXT_COST_ALERT_TOKENS;
  if (input.codeMode === true) {
    return {
      sessionId: input.sessionId,
      tools: 0,
      chars: 0,
      estTokens: 0,
      level: "ok",
      ...(input.contextWindow !== undefined && input.contextWindow > 0 ? { contextWindow: input.contextWindow } : {}),
      servers: [],
      warnTokens,
      alertTokens,
      unsupported: "code-mode"
    };
  }
  const groups = new Map<string, unknown[]>();
  const all: unknown[] = [];
  for (const schema of input.schemas) {
    if ((schema as any)?.deferLoading === true) continue;
    const name = toolNameOf(schema);
    const isLazyProxy = isLazyToolName(name);
    const server = isLazyProxy ? LAZY_PROXY_GROUP_NAME : mcpServerOfTool(name, input.knownServers);
    if (server === undefined) continue;
    const facing = modelFacing(schema);
    all.push(facing);
    const group = groups.get(server) ?? [];
    group.push(facing);
    groups.set(server, group);
  }
  const servers: McpServerContextCost[] = [...groups].map(([name, tools]) => {
    const chars = serializedLength(tools);
    return {
      name,
      ...(name === LAZY_PROXY_GROUP_NAME ? { kind: "lazy-proxy" as const } : {}),
      tools: tools.length,
      chars,
      estTokens: estimateSchemaTokens(chars)
    };
  });
  servers.sort(byEstimatedSize);
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

// ── 工具调用结果 ─────────────────────────────────────────────────────────

/** 模型可见消息的最小形状；只读计价，不复制内容。 */
export interface ContextMessageLike {
  readonly role?: string;
  readonly content?: readonly unknown[];
  readonly source?: { readonly callId?: string };
  readonly toolCallId?: string;
}

/** 一台服务器（或共享 Lazy 代理组）仍留在会话里的调用结果。 */
export interface McpResultServerCost {
  /** 服务器生效名；无法归属到单台服务器的 Lazy 结果归入 `[lazy proxies]`。 */
  name: string;
  /** `lazy`：经 Lazy 代理调用的某台服务器；`lazy-proxy`：跨服务器的共享代理结果。 */
  kind?: "lazy" | "lazy-proxy";
  /** 结果消息条数（每条对应一次已完成的调用）。 */
  calls: number;
  estTokens: number;
}

/** 会话当前仍保留的 MCP 工具调用结果占用。 */
export interface McpResultCost {
  /** 被统计的会话 id；找不到当前会话时为 null，其余字段为零。 */
  sessionId: string | null;
  /** 计入的结果消息条数；被裁剪或压缩掉的不算。 */
  calls: number;
  estTokens: number;
  /** 模型上下文窗口（来自会话最近一次请求的路由信息）；未知时省略。 */
  contextWindow?: number;
  /** 按估算 token 从大到小排序。 */
  servers: McpResultServerCost[];
  /**
   * 代码模式（PTC）下 MCP 调用嵌在 `run_code` 内部，surface 上无法归属到
   * 具体 MCP 结果；置 `"code-mode"` 时 `calls`/`estTokens` 为零、`servers` 为空。
   */
  unsupported?: "code-mode";
}

export interface ResultCostInput {
  sessionId: string | null;
  /** 会话当前的模型可见消息（`session.deriveMessages()`）；会话缺失时传空数组。 */
  messages: readonly unknown[];
  knownServers?: readonly string[];
  contextWindow?: number;
  /** 会话走代码模式（PTC）：结果无法归属，返回 unsupported。 */
  codeMode?: boolean;
}

function blockTypeOf(block: unknown): string {
  const type = (block as { type?: unknown } | null)?.type;
  return typeof type === "string" ? type : "";
}

function textOf(block: unknown): string {
  const text = (block as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
}

function stringFieldOf(block: unknown, field: string): string {
  const value = (block as Record<string, unknown> | null)?.[field];
  return typeof value === "string" ? value : "";
}

/** 图像以外未知块的保守 JSON 结构价；与 token-meter 的 `estimateStructuralBlock` 一致。 */
function estimateStructuralTokens(block: unknown): number {
  if (blockTypeOf(block) === "image") {
    const { offloaded: _offloaded, ...reference } = block as Record<string, unknown>;
    return BLOCK_OVERHEAD + Math.ceil(serializedLength(reference) / CHARS_PER_TOKEN);
  }
  return BLOCK_OVERHEAD + Math.ceil(serializedLength(block) / CHARS_PER_TOKEN);
}

/**
 * 一组模型可见 content 的估算 token。口径镜像
 * `@deepseek-ai/dsh-token-meter/estimate` 的 `estimateContent`：文本/推理按
 * `ceil(字符数 / 4) + 4`，tool-call 按名字与原始参数串，未知块按 JSON 结构。
 */
export function estimateContentTokens(blocks: readonly unknown[]): number {
  let tokens = 0;
  for (const block of blocks) {
    const type = blockTypeOf(block);
    if (type === "text" || type === "reasoning") {
      tokens += Math.ceil(textOf(block).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
    } else if (type === "tool-call") {
      tokens += Math.ceil(stringFieldOf(block, "name").length / CHARS_PER_TOKEN)
        + Math.ceil(stringFieldOf(block, "arguments").length / CHARS_PER_TOKEN)
        + BLOCK_OVERHEAD;
    } else {
      tokens += estimateStructuralTokens(block);
    }
  }
  return tokens;
}

/**
 * 一条模型可见消息的估算 token。镜像 token-meter 的 `estimateMessage`：
 * system 只按文本字符计价，其它角色是 content 价加 4 的角色开销。
 */
export function estimateMessageTokens(message: ContextMessageLike): number {
  const content = Array.isArray(message?.content) ? message.content : [];
  if (message?.role === "system") {
    if (content.length === 0) return 0;
    let characters = 0;
    for (const block of content) {
      characters += blockTypeOf(block) === "text" ? textOf(block).length : serializedLength(block);
    }
    return Math.ceil(characters / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
  }
  return estimateContentTokens(content) + BLOCK_OVERHEAD;
}

/** `mcp_call` / `mcp_describe` / 带 `server` 的 `mcp_search` 的目标服务器。 */
function lazyTargetServer(argumentsJson: string): string | undefined {
  if (argumentsJson === "") return undefined;
  try {
    const server = (JSON.parse(argumentsJson) as { server?: unknown } | null)?.server;
    return typeof server === "string" && server !== "" ? server : undefined;
  } catch {
    return undefined;
  }
}

interface ToolCallRef {
  name: string;
  arguments: string;
}

/** 会话里出现过的工具调用：callId → 工具名与原始参数。结果消息只带 callId。 */
function toolCallsOf(messages: readonly unknown[]): Map<string, ToolCallRef> {
  const calls = new Map<string, ToolCallRef>();
  for (const message of messages) {
    const candidate = message as { role?: unknown; content?: unknown };
    if (candidate?.role !== "assistant" || !Array.isArray(candidate.content)) continue;
    for (const block of candidate.content) {
      if (blockTypeOf(block) !== "tool-call") continue;
      const id = stringFieldOf(block, "id");
      const name = stringFieldOf(block, "name");
      if (id === "" || name === "") continue;
      calls.set(id, { name, arguments: stringFieldOf(block, "arguments") });
    }
  }
  return calls;
}

/** 一次调用的归属；不是 MCP 调用时返回 undefined。 */
function resultTargetOf(call: ToolCallRef, knownServers: readonly string[]): { name: string; kind?: "lazy" | "lazy-proxy" } | undefined {
  if (call.name.startsWith(MCP_TOOL_PREFIX)) {
    const server = mcpServerOfTool(call.name, knownServers);
    return server === undefined ? undefined : { name: server };
  }
  if (!isLazyToolName(call.name)) return undefined;
  const server = lazyTargetServer(call.arguments);
  return server === undefined
    ? { name: LAZY_PROXY_GROUP_NAME, kind: "lazy-proxy" }
    : { name: server, kind: "lazy" };
}

function toolCallIdOf(message: ContextMessageLike): string | undefined {
  if (typeof message.toolCallId === "string" && message.toolCallId !== "") return message.toolCallId;
  const callId = message.source?.callId;
  return typeof callId === "string" && callId !== "" ? callId : undefined;
}

/**
 * 汇总会话当前 surface 上仍保留的 MCP 工具调用结果。只统计能对应到 MCP 工具调用的
 * `tool/result` 消息：Eager 按 `mcp__<生效名>__<工具>` 归属；Lazy 按代理参数里的
 * `server` 归属，`mcp_search` 未指定服务器时归入共享代理组。被裁剪、压缩或已不在
 * surface 上的结果不进入当前上下文，因此不计。
 */
export function mcpResultCost(input: ResultCostInput): McpResultCost {
  if (input.codeMode === true) {
    return {
      sessionId: input.sessionId,
      calls: 0,
      estTokens: 0,
      ...(input.contextWindow !== undefined && input.contextWindow > 0 ? { contextWindow: input.contextWindow } : {}),
      servers: [],
      unsupported: "code-mode"
    };
  }
  const knownServers = input.knownServers ?? [];
  const calls = toolCallsOf(input.messages);
  const totals = new Map<string, McpResultServerCost>();
  let count = 0;
  let tokens = 0;
  for (const message of input.messages) {
    const candidate = message as ContextMessageLike;
    if (candidate?.role !== "tool") continue;
    const callId = toolCallIdOf(candidate);
    if (callId === undefined) continue;
    const call = calls.get(callId);
    if (call === undefined) continue;
    const target = resultTargetOf(call, knownServers);
    if (target === undefined) continue;
    const price = estimateMessageTokens(candidate);
    count += 1;
    tokens += price;
    const entry = totals.get(target.name) ?? { name: target.name, calls: 0, estTokens: 0 };
    entry.calls += 1;
    entry.estTokens += price;
    if (entry.kind === undefined && target.kind !== undefined) entry.kind = target.kind;
    totals.set(target.name, entry);
  }
  const servers = [...totals.values()].sort(byEstimatedSize);
  return {
    sessionId: input.sessionId,
    calls: count,
    estTokens: tokens,
    ...(input.contextWindow !== undefined && input.contextWindow > 0 ? { contextWindow: input.contextWindow } : {}),
    servers
  };
}

/** 推送去重用的签名：只含会改变显示的字段。 */
export function contextCostSignature(cost: McpContextCost): string {
  return JSON.stringify([cost.sessionId, cost.estTokens, cost.contextWindow ?? null, cost.unsupported ?? null, cost.servers.map((s) => [s.name, s.tools, s.estTokens, s.kind ?? null])]);
}

/** 推送去重用的签名：只含会改变显示的字段。 */
export function resultCostSignature(cost: McpResultCost): string {
  return JSON.stringify([cost.sessionId, cost.calls, cost.estTokens, cost.contextWindow ?? null, cost.unsupported ?? null, cost.servers.map((s) => [s.name, s.calls, s.estTokens, s.kind ?? null])]);
}
