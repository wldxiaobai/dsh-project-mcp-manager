/**
 * dsh-project-mcp-manager —— MCP 服务器配置模型（纯函数）。
 *
 * 模型本身不含 scope：scope 是配置所在文件（profile cordis.patch.yml =
 * 全局，<projectRoot>/.dsh/mcp.yml = 项目）的属性。env/headers 的 null 是
 * 编辑语义：string = 覆盖该 key，null = 删除该 key，不出现 = 保留旧值。
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { MANAGED_ROW_ID_PREFIX, MCP_PLUGIN_NAME, type PatchRow } from "./mcp-file.js";

export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000;
export const DEFAULT_RECONNECT = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30000,
  maxAttempts: 10
} as const;

const serverNameSchema = z.string().regex(SERVER_NAME_RE, "serverName 只能包含 1-32 位字母、数字、下划线或连字符");
const secretMapSchema = z.record(z.string(), z.string().nullable()).optional();
/**
 * 与官方 dsh-mcp-client 的 reconnect 上限一致（@deepseek-ai/dsh-mcp-client
 * lib/index.js:734-735）；2147483647 = MAX_TIMER_DELAY_MS（@deepseek-ai/
 * dsh-timeout，Node 不钳制的最大 timer 延迟）。上限不镜像的话越界值会绕过
 * 本地校验、到 ctx.plugin 装载时才以 plugin-throw 爆错，归因更晚更难查。
 */
export const MAX_TIMER_DELAY_MS = 2147483647;
const reconnectSchema = z.object({
  enabled: z.boolean().default(DEFAULT_RECONNECT.enabled),
  initialDelayMs: z.number().int().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_RECONNECT.initialDelayMs),
  maxDelayMs: z.number().int().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_RECONNECT.maxDelayMs),
  maxAttempts: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_RECONNECT.maxAttempts)
}).default({ ...DEFAULT_RECONNECT });

export const stdioServerSchema = z.object({
  serverName: serverNameSchema,
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: secretMapSchema,
  cwd: z.string().default(""),
  toolCallTimeoutMs: z.number().int().min(1).default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  failOnStartupError: z.boolean().default(false),
  reconnect: reconnectSchema
});

export const httpServerSchema = z.object({
  serverName: serverNameSchema,
  transport: z.literal("streamable-http"),
  url: z.string().url(),
  headers: secretMapSchema,
  toolCallTimeoutMs: z.number().int().min(1).default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  failOnStartupError: z.boolean().default(false),
  reconnect: reconnectSchema
});

export const mcpServerInputSchema = z.discriminatedUnion("transport", [stdioServerSchema, httpServerSchema]);

export type McpServerInput = z.infer<typeof mcpServerInputSchema>;
export type McpTransport = McpServerInput["transport"];
export interface ReconnectConfig {
  enabled: boolean;
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}
export type SecretPatch = Record<string, string | null> | undefined;

/** 服务器所在作用域：全局（profile patch）或工作区（项目根路径）。 */
export interface McpScopeInfo {
  kind: "global" | "workspace";
  path?: string;
  label?: string;
}

/** 项目根的规范化键（Windows 大小写不敏感），作 Map 键用。 */
export function projectKeyOf(projectRoot: string): string {
  const normalized = resolve(projectRoot);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * 冲突时的命名空间生效名：`p<sha256(projectKeyOf(projectRoot))前6位hex>_<原始名>`，
 * 截断到 32 字符（保持 SERVER_NAME_RE 合法）。确定性，与装载顺序、路径大小写
 * 写法无关。
 */
export function namespacedServerName(projectRoot: string, name: string): string {
  const hash = createHash("sha256").update(projectKeyOf(projectRoot)).digest("hex").slice(0, 6);
  return ("p" + hash + "_" + name).slice(0, 32);
}

/** 一个项目的原始 serverName 目录（供生效名计算）。 */
export interface ProjectServerCatalogEntry {
  projectRoot: string;
  names: string[];
}

/**
 * 计算全部 (projectRoot, 原始名) → 生效名的映射：
 * 原始名在整个目录（全局行 + 所有项目行）中唯一时保持原名；否则该名的
 * 每个项目拥有者都改用 namespacedServerName（全局行参与占用判定但不改名）。
 * 键 = projectKeyOf(projectRoot) + "\0" + 原始名。
 */
export function effectiveServerNames(
  projects: ProjectServerCatalogEntry[],
  globalNames: string[] = []
): Map<string, string> {
  const counts = new Map<string, number>();
  const add = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const name of globalNames) add(name);
  for (const project of projects) {
    for (const name of project.names) add(name);
  }
  const result = new Map<string, string>();
  for (const project of projects) {
    for (const name of project.names) {
      result.set(projectKeyOf(project.projectRoot) + "\0" + name, (counts.get(name) ?? 0) > 1 ? namespacedServerName(project.projectRoot, name) : name);
    }
  }
  return result;
}

/**
 * 会话可见性：某会话项目应 deny 的生效名 = 全部已装载项目服务器 − 本会话
 * 项目的。sessionProject 为 undefined（无 cwd / 未知项目）时 deny 全部。
 */
export function denySetFor(
  sessionProject: string | undefined,
  mounted: { projectRoot: string; effectiveNames: string[] }[]
): string[] {
  const deny = new Set<string>();
  const own = sessionProject === undefined ? undefined : projectKeyOf(sessionProject);
  for (const group of mounted) {
    if (own !== undefined && projectKeyOf(group.projectRoot) === own) continue;
    for (const name of group.effectiveNames) deny.add(name);
  }
  return [...deny];
}

/** 兼容 dsh-skill-mcp-panel 的行 id ↔ serverName。 */
export function rowIdForServerName(serverName: string): string {
  return MANAGED_ROW_ID_PREFIX + serverName;
}

export function serverNameFromRowId(id: string | undefined): string | undefined {
  if (typeof id !== "string" || !id.startsWith(MANAGED_ROW_ID_PREFIX)) return undefined;
  const name = id.slice(MANAGED_ROW_ID_PREFIX.length);
  return SERVER_NAME_RE.test(name) ? name : undefined;
}

/** null = 删除，string = 覆盖；缺省 key 保留旧值。 */
export function mergeSecretPatch(previous: Record<string, string> | undefined, patch: SecretPatch): Record<string, string> {
  const merged: Record<string, string> = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

function normalizeReconnect(input: McpServerInput): ReconnectConfig {
  return {
    enabled: input.reconnect.enabled,
    initialDelayMs: input.reconnect.initialDelayMs,
    maxDelayMs: input.reconnect.maxDelayMs,
    maxAttempts: input.reconnect.maxAttempts
  };
}

/** 面板输入 → 官方 @deepseek-ai/dsh-mcp-client 配置。 */
export function toOfficialConfig(input: McpServerInput): Record<string, unknown> {
  const common = {
    serverName: input.serverName,
    toolCallTimeoutMs: input.toolCallTimeoutMs,
    failOnStartupError: input.failOnStartupError,
    reconnect: normalizeReconnect(input)
  };
  if (input.transport === "stdio") {
    return {
      ...common,
      transport: "stdio",
      command: input.command,
      args: input.args,
      env: mergeSecretPatch({}, input.env),
      cwd: input.cwd
    };
  }
  return {
    ...common,
    transport: "streamable-http",
    url: input.url,
    headers: mergeSecretPatch({}, input.headers)
  };
}

/** 输入 → cordis.patch.yml / 项目 mcp.yml 行。 */
export function toPatchRow(input: McpServerInput, enabled = true): PatchRow {
  return {
    id: rowIdForServerName(input.serverName),
    name: MCP_PLUGIN_NAME,
    ...(enabled ? {} : { disabled: true }),
    config: toOfficialConfig(input)
  };
}

/** 读取 patch 行中的 config（宽松，坏行返回 undefined）。 */
export function configFromPatchRow(row: PatchRow | undefined): Record<string, unknown> | undefined {
  if (row === undefined || row.name !== MCP_PLUGIN_NAME) return undefined;
  if (row.config === null || typeof row.config !== "object" || Array.isArray(row.config)) return undefined;
  return row.config as Record<string, unknown>;
}

export interface McpServerView {
  serverName: string;
  transport: McpTransport | "unknown";
  enabled: boolean;
  entryId: string | undefined;
  /** 行所属作用域与装载时生效名（与 serverName 不同仅当发生命名冲突）。 */
  scope?: McpScopeInfo;
  effectiveServerName?: string;
  // stdio
  command?: string;
  args?: string[];
  envKeys: string[];
  cwd?: string;
  // http
  url?: string;
  headerKeys: string[];
  toolCallTimeoutMs: number;
  failOnStartupError: boolean;
  reconnect: ReconnectConfig;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function secretKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).filter((key) => typeof (value as Record<string, unknown>)[key] === "string");
}

/** patch 行 → 脱敏 view。密钥值不返回。scope/effectiveServerName 由调用方给出。 */
export function patchRowToView(row: PatchRow, scope?: McpScopeInfo, effectiveServerName?: string): McpServerView | undefined {
  const config = configFromPatchRow(row);
  if (config === undefined) return undefined;
  const serverName = asString(config.serverName);
  if (!SERVER_NAME_RE.test(serverName)) return undefined;
  const transport = config.transport === "streamable-http" ? "streamable-http" : config.transport === "stdio" ? "stdio" : "unknown";
  const reconnectRaw = config.reconnect !== null && typeof config.reconnect === "object" && !Array.isArray(config.reconnect) ? config.reconnect as Record<string, unknown> : {};
  return {
    serverName,
    transport,
    enabled: row.disabled !== true,
    entryId: row.id,
    ...(scope === undefined ? {} : { scope }),
    ...(effectiveServerName === undefined ? {} : { effectiveServerName }),
    command: transport === "stdio" ? asString(config.command) : undefined,
    args: transport === "stdio" ? asStringArray(config.args) : undefined,
    envKeys: transport === "stdio" ? secretKeys(config.env) : [],
    cwd: transport === "stdio" ? asString(config.cwd) : undefined,
    url: transport === "streamable-http" ? asString(config.url) : undefined,
    headerKeys: transport === "streamable-http" ? secretKeys(config.headers) : [],
    toolCallTimeoutMs: asNumber(config.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: asBoolean(config.failOnStartupError, false),
    reconnect: {
      enabled: asBoolean(reconnectRaw.enabled, DEFAULT_RECONNECT.enabled),
      initialDelayMs: asNumber(reconnectRaw.initialDelayMs, DEFAULT_RECONNECT.initialDelayMs),
      maxDelayMs: asNumber(reconnectRaw.maxDelayMs, DEFAULT_RECONNECT.maxDelayMs),
      maxAttempts: asNumber(reconnectRaw.maxAttempts, DEFAULT_RECONNECT.maxAttempts)
    }
  };
}

/** 从 patch 行读取完整输入（含 secret 值，仅供本机装载/测试使用，不跨 RPC）。 */
export function inputFromPatchRow(row: PatchRow): McpServerInput {
  const config = configFromPatchRow(row) ?? {};
  // 显式拒绝未知 transport：此前非 "streamable-http" 一律落 stdio 分支，
  // `transport: http` 之类的笔误报的是「command 必填」而非「未知 transport」。
  const transportRaw = config.transport;
  if (transportRaw !== undefined && transportRaw !== "stdio" && transportRaw !== "streamable-http") {
    throw new Error('transport 必须为 "stdio" 或 "streamable-http"，当前为 ' + JSON.stringify(transportRaw));
  }
  const serverName = asString(config.serverName, serverNameFromRowId(row.id) ?? "");
  const common = {
    serverName,
    toolCallTimeoutMs: asNumber(config.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: asBoolean(config.failOnStartupError, false),
    reconnect: {
      enabled: asBoolean((config.reconnect as any)?.enabled, DEFAULT_RECONNECT.enabled),
      initialDelayMs: asNumber((config.reconnect as any)?.initialDelayMs, DEFAULT_RECONNECT.initialDelayMs),
      maxDelayMs: asNumber((config.reconnect as any)?.maxDelayMs, DEFAULT_RECONNECT.maxDelayMs),
      maxAttempts: asNumber((config.reconnect as any)?.maxAttempts, DEFAULT_RECONNECT.maxAttempts)
    }
  };
  if (config.transport === "streamable-http") {
    return mcpServerInputSchema.parse({
      ...common,
      transport: "streamable-http",
      url: asString(config.url),
      headers: config.headers as Record<string, string> | undefined
    });
  }
  return mcpServerInputSchema.parse({
    ...common,
    transport: "stdio",
    command: asString(config.command),
    args: asStringArray(config.args),
    env: config.env as Record<string, string> | undefined,
    cwd: asString(config.cwd)
  });
}
