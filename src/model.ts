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
/**
 * 串内 `${VAR}` 引用扫描/替换（展开与 url 占位判定共用）：`$VAR` 裸形、
 * `${9bad}` 非法名一律按字面量处理。只在 mount 时运行时展开，展开结果
 * 绝不回写文件、不进诊断明文。
 */
const EMBEDDED_ENV_REF_RE = /\$\{([A-Za-z_]\w*)\}/g;

/** url 字段允许合法 URL 或含 `${VAR}` 占位的串（整值与串内插值同待）：装载前
 * 一律放行占位串，展开后的真实合法性由 mount 复验兜底（env-invalid 诊断）。 */
export function isUrlOrEnvRef(value: string): boolean {
  EMBEDDED_ENV_REF_RE.lastIndex = 0;
  if (EMBEDDED_ENV_REF_RE.test(value)) return true;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
/**
 * 字符串数组比较器：UTF-16 码元序，与 `Array#sort` 默认行为逐字节等价。
 * 全仓凡排序结果 wire 可见（诊断/快照键集、告警门控签名、list 输出序）都必须
 * 用显式比较器写死这个口径——默认序不经 locale collator，不随宿主区域设置漂移。
 */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function escapeRegexChar(char: string): string {
  return /[\\^$*+?.()|{}\[\]]/.test(char) ? "\\" + char : char;
}

/**
 * glob → 正则：`*` 不跨 `/`，`**` 跨段，`?` 单字符，`[abc]` / `[!abc]` 字符类。
 * 工具名通常不含 `/`，`*` 与 `**` 对裸名等价，完整 `mcp__…__…` 路径才用得上 `**`。
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let index = 0; index < pattern.length; ) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        out += ".*";
        index += 2;
      } else {
        out += "[^/]*";
        index += 1;
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      index += 1;
      continue;
    }
    if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1 || close === index + 1) {
        out += "\\[";
        index += 1;
        continue;
      }
      let body = pattern.slice(index + 1, close);
      let negated = false;
      if (body.startsWith("!") || body.startsWith("^")) {
        negated = true;
        body = body.slice(1);
      }
      let cls = "";
      for (const item of body) cls += item === "\\" ? "\\\\" : item === "]" ? "\\]" : item;
      out += "[" + (negated ? "^" : "") + cls + "]";
      index = close + 1;
      continue;
    }
    out += escapeRegexChar(char);
    index += 1;
  }
  return new RegExp("^" + out + "$");
}

export function matchToolGlob(pattern: string, name: string): boolean {
  try {
    return globToRegExp(pattern).test(name);
  } catch {
    return false;
  }
}

export interface ToolFilter {
  allow?: string[];
  deny?: string[];
}

const toolFilterSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional()
}).optional();

function patternHitsTool(pattern: string, shortName: string, fullName: string): boolean {
  return matchToolGlob(pattern, pattern.includes("mcp__") ? fullName : shortName);
}

/**
 * 条目级工具过滤：`allow` 缺省全开；`deny` 优先。只返回当前已注册的完整工具名
 * （`mcp__<effective>__<tool>`），供 `tools.restrict` 使用。
 */
export function deniedToolsForFilter(effectiveName: string, filter: ToolFilter | undefined, registeredToolIds: string[]): string[] {
  if (filter === undefined) return [];
  const allow = filter.allow;
  const deny = filter.deny;
  if (allow === undefined && (deny === undefined || deny.length === 0)) return [];
  const prefix = `mcp__${effectiveName}__`;
  const denied: string[] = [];
  for (const id of registeredToolIds) {
    if (!id.startsWith(prefix) || id.length <= prefix.length) continue;
    const shortName = id.slice(prefix.length);
    const denyHit = deny !== undefined && deny.some((pattern) => patternHitsTool(pattern, shortName, id));
    if (denyHit) {
      denied.push(id);
      continue;
    }
    if (allow === undefined) continue;
    if (!allow.some((pattern) => patternHitsTool(pattern, shortName, id))) denied.push(id);
  }
  return denied;
}

export function toolFilterFromConfig(config: Record<string, unknown> | undefined): ToolFilter | undefined {
  const raw = config?.tools;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const allow = Array.isArray(record.allow) ? record.allow.filter((item): item is string => typeof item === "string") : undefined;
  const deny = Array.isArray(record.deny) ? record.deny.filter((item): item is string => typeof item === "string") : undefined;
  if (allow === undefined && deny === undefined) return undefined;
  return {
    ...(allow === undefined ? {} : { allow }),
    ...(deny === undefined ? {} : { deny })
  };
}

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

/**
 * 官方 `@deepseek-ai/dsh-mcp-client` 0.1.5-rc.1 支持的 MCP 传输集合
 * （config.transport 判别联合：`stdio` | `streamable-http`）。本插件不实现
 * 传输，只负责表达；schema / CLI / JSON 读取器 / 报错文案全部从这里派生。
 * 官方新增传输时：常量加值 + 一条 CLI/JSON 别名映射 + 文档 + 测试，不要再
 * 加判定分支。性质与 `MAX_TIMER_DELAY_MS` 相同。
 */
export const SUPPORTED_MCP_TRANSPORTS = ["stdio", "streamable-http"] as const;
export type SupportedMcpTransport = (typeof SUPPORTED_MCP_TRANSPORTS)[number];

/** JSON/CLI 用户面写法 → 官方 transport。`http` 是 Cursor/CC 通行别名。 */
export const MCP_TRANSPORT_ALIASES: Record<string, SupportedMcpTransport> = {
  stdio: "stdio",
  http: "streamable-http",
  "streamable-http": "streamable-http"
};

/**
 * 已知但不被装载后端支持的传输。走统一报错路径，不隐式回退、不静默跳过。
 * 官方若日后支持其中某一项：从本表删掉、加入 `SUPPORTED_MCP_TRANSPORTS` 与别名即可。
 */
export const UNSUPPORTED_MCP_TRANSPORTS = ["sse"] as const;

/** 官方 transport → JSON 方言 `type`（Cursor/CC 写 `http` 而非 `streamable-http`）。 */
export function jsonTypeOfTransport(transport: SupportedMcpTransport): "stdio" | "http" {
  return transport === "stdio" ? "stdio" : "http";
}

export function isSupportedMcpTransport(value: string): value is SupportedMcpTransport {
  return (SUPPORTED_MCP_TRANSPORTS as readonly string[]).includes(value);
}

export function isUnsupportedMcpTransport(value: string): boolean {
  return (UNSUPPORTED_MCP_TRANSPORTS as readonly string[]).includes(value);
}

export function supportedTransportsLabel(separator = " | "): string {
  return SUPPORTED_MCP_TRANSPORTS.join(separator);
}

/** 未知/不受支持传输的报错（CLI 与 JSON 读取器共用）。 */
export function unsupportedTransportMessage(value: string): string {
  const backend = `装载后端（dsh-mcp-client）只支持 ${supportedTransportsLabel(" | ")}`;
  if (value === "sse") {
    return (
      "不支持 MCP SSE 端点传输：" + backend +
      "。出路：①服务端已支持 Streamable HTTP 时把 type 改为 \"http\"；" +
      "②删除 type 只留 url（本插件按 streamable-http 推断）"
    );
  }
  return `不支持 ${value} 传输：${backend}`;
}

/**
 * 用户面传输值（CLI `--transport`、JSON `type`/`transport`）→ 官方 transport。
 * 别名命中则映射；其余一律报错（含 `UNSUPPORTED_MCP_TRANSPORTS` 与完全陌生的值）。
 */
export function resolveMcpTransport(raw: string): { transport: SupportedMcpTransport } | { error: string } {
  const mapped = MCP_TRANSPORT_ALIASES[raw];
  if (mapped !== undefined) return { transport: mapped };
  return { error: unsupportedTransportMessage(raw) };
}

/**
 * CLI `--transport`：官方名与 `http` 别名；内部仍用 `stdio` | `http`
 * （`add` 的用户面口径，与 `jsonTypeOfTransport` 一致）。
 * 已知不支持值走 `unsupportedTransportMessage`；完全陌生的值提示合法集合。
 */
export function parseCliTransport(value: string): { transport: "stdio" | "http" } | { error: string } {
  const mapped = MCP_TRANSPORT_ALIASES[value];
  if (mapped !== undefined) return { transport: jsonTypeOfTransport(mapped) };
  if (isUnsupportedMcpTransport(value)) return { error: unsupportedTransportMessage(value) };
  return { error: `--transport 只支持 stdio|http（别名 streamable-http），收到：${value}` };
}

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
  reconnect: reconnectSchema,
  tools: toolFilterSchema
});

export const httpServerSchema = z.object({
  serverName: serverNameSchema,
  transport: z.literal("streamable-http"),
  url: z.string().refine(isUrlOrEnvRef, "url 必须是合法 URL 或含 ${VAR} 占位的串"),
  headers: secretMapSchema,
  toolCallTimeoutMs: z.number().int().min(1).default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  failOnStartupError: z.boolean().default(false),
  reconnect: reconnectSchema,
  tools: toolFilterSchema
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

/**
 * 行的原始 serverName：**受管行 id 优先**，其次 `config.serverName`。
 * 装载（registry）与 CLI 判重/删除必须同口径——反向优先（config 优先）会在
 * `id: panel-mcp-a` + `config.serverName: b` 这类不一致行上认成另一个名字，
 * 于是 CLI 删不掉装载器实际装载的那条。
 */
export function rowNameOf(row: PatchRow): string | undefined {
  const fromId = serverNameFromRowId(row.id);
  if (fromId !== undefined) return fromId;
  return typeof row.config?.serverName === "string" ? row.config.serverName : undefined;
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

/** 值中引用的全部环境变量名（含串内插值形态），按出现顺序去重。 */
function envRefNames(value: string): string[] {
  const names: string[] = [];
  EMBEDDED_ENV_REF_RE.lastIndex = 0;
  for (let match = EMBEDDED_ENV_REF_RE.exec(value); match !== null; match = EMBEDDED_ENV_REF_RE.exec(value)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

export type ExpandEnvRefsResult =
  | { ok: true; input: McpServerInput }
  | { ok: false; missingVar: string };

function expandSecretMap(
  map: Record<string, string | null> | undefined,
  expand: (value: string) => string
): Record<string, string | null> | undefined {
  if (map === undefined) return undefined;
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(map)) out[key] = typeof value === "string" ? expand(value) : value;
  return out;
}

/**
 * 运行时展开 command、args[*]、env/headers 值、url、cwd 中的 `${VAR}` 引用，
 * 支持串内插值（`Bearer ${TOKEN}` 与整值 `${TOKEN}` 都会展开），对齐 CC 的
 * 写法习惯。纯函数：环境经参数注入（宿主传 process.env），便于测试。
 * 任一被引用的变量缺失或为空串即整体失败（ok:false + 变量名，调用方据此
 * 跳过该条目装载）——空 token 与缺失同样危险，宁可 spawn 前拒绝。诊断
 * 消息只含变量名不含值。`$VAR` 裸形与 `${9bad}` 非法名保持字面量。
 */
export function expandEnvRefs(input: McpServerInput, env: NodeJS.ProcessEnv): ExpandEnvRefsResult {
  const strings: string[] = [];
  const secretValues = (map: Record<string, string | null> | undefined): string[] =>
    Object.values(map ?? {}).filter((value): value is string => typeof value === "string");
  if (input.transport === "stdio") {
    strings.push(input.command, ...input.args, input.cwd, ...secretValues(input.env));
  } else {
    strings.push(input.url, ...secretValues(input.headers));
  }
  for (const value of strings) {
    for (const name of envRefNames(value)) {
      const resolved = env[name];
      if (resolved === undefined || resolved === "") return { ok: false, missingVar: name };
    }
  }
  const expand = (value: string): string => {
    if (envRefNames(value).length === 0) return value;
    EMBEDDED_ENV_REF_RE.lastIndex = 0;
    return value.replace(EMBEDDED_ENV_REF_RE, (whole, name: string) => env[name]!);
  };
  if (input.transport === "stdio") {
    return {
      ok: true,
      input: {
        ...input,
        command: expand(input.command),
        args: input.args.map(expand),
        env: expandSecretMap(input.env, expand),
        cwd: expand(input.cwd)
      }
    };
  }
  return {
    ok: true,
    input: {
      ...input,
      url: expand(input.url),
      headers: expandSecretMap(input.headers, expand)
    }
  };
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
  const config = toOfficialConfig(input);
  if (input.tools !== undefined) config.tools = input.tools;
  return {
    id: rowIdForServerName(input.serverName),
    name: MCP_PLUGIN_NAME,
    ...(enabled ? {} : { disabled: true }),
    config
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
  if (transportRaw !== undefined && (typeof transportRaw !== "string" || !isSupportedMcpTransport(transportRaw))) {
    throw new Error("transport 必须为 " + SUPPORTED_MCP_TRANSPORTS.map((item) => JSON.stringify(item)).join(" 或 ") + "，当前为 " + JSON.stringify(transportRaw));
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
    },
    ...(config.tools === undefined ? {} : { tools: config.tools })
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
