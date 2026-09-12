/**
 * dsh-project-mcp-manager —— JSON 方言 MCP 配置读取器（严格只读）。
 *
 * 方言与生态一致：`{"mcpServers": { name: entry }}`（Cursor / Claude Code 通用写法）。
 * 读取位置与来源枚举：
 *   1. `<projectRoot>/.dsh/mcp.json`      —— DSH 项目层（`dsh-project-json`）
 *   2. `~/.dsh/profiles/<name>/mcp.json`  —— DSH profile 用户层（`dsh-profile-user`）
 *   3. `~/.dsh/mcp.json`                  —— DSH 通用用户层（`dsh-user`）
 *   4. `<projectRoot>/.mcp.json`          —— Claude Code project 层（遗留只读，`cc-project`）
 *
 * 本模块**只读**：写路径在 `json-write.ts`（仅 `dsh-mcp` CLI 使用，CLI 独占整个文件）。
 * 本插件永不读取任何 Claude 用户态状态文件（凭据/历史混杂的单体文件），也永不写入上述任一文件。
 *
 * 条目映射：stdio（`command`/`args`/`env`/`cwd`）与 http（`url`/`headers`）之外，
 * 容忍 `type` 与原生 `transport`（官方 `SUPPORTED_MCP_TRANSPORTS` + 别名 `http`；
 * 未知值与 `sse` 走 `resolveMcpTransport` 逐条拒绝）、Gemini 的 `httpUrl`，
 * 以及 DSH 透传键（`toolCallTimeoutMs`/`failOnStartupError`/`reconnect`）。
 * 未知键忽略。
 * `enabled:false` 静默跳过且不占名；`disabled:true` 占名但不装载（与原生 yml 一致）。
 * `${VAR}` 占位保持字面值进行，由 model.expandEnvRefs 在 mount 时运行时展开。
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { type PatchRow } from "./mcp-file.js";
import { MAX_TIMER_DELAY_MS, SERVER_NAME_RE, mcpServerInputSchema, resolveMcpTransport, toPatchRow, type McpServerInput, type SupportedMcpTransport } from "./model.js";

/** DSH 自有 JSON 配置文件名（位于 `<root>/.dsh/`、`$DSH_HOME/`、`$DSH_HOME/profiles/<name>/`）。 */
export const JSON_MCP_FILE = "mcp.json";
/** 对方插件（`@wingsky-1/dsh-mcp-manager`）的全局存储文件名（位于 `$DSH_HOME/`）。 */
export const FOREIGN_MCP_JSON_FILE = "dsh-mcp.json";

/** 对方 `{version, servers}` 存储格式的可执行诊断（本插件不读取该方言）。 */
export const FOREIGN_MCP_FORMAT_HINT =
  "该文件疑似 @wingsky-1/dsh-mcp-manager 的存储格式（{version, servers}），本插件不读取。建议改用 mcpServers 方言，或改用 .dsh/mcp.yml";

/**
 * 检测对方插件的存储格式。`mcpServers` 一旦存在（即便同时有 `servers`）就不告警——
 * 那是本插件方言。缺 `mcpServers` 且顶层是 `servers` 数组，或同时有 `version` 与
 * `servers`，才认定为对方格式。
 */
export function detectForeignMcpFormat(value: Record<string, unknown>): string | undefined {
  if ("mcpServers" in value) return undefined;
  const servers = value.servers;
  if (Array.isArray(servers) || ("version" in value && servers !== undefined)) return FOREIGN_MCP_FORMAT_HINT;
  return undefined;
}

/** 遗留 Claude Code project 层文件名（位于项目根，与 `.dsh/` 并列，只读）。 */
export const CC_PROJECT_FILE = ".mcp.json";
/** 置为 "1" 时跳过遗留 `<projectRoot>/.mcp.json` 的读取与监听；DSH 自有 JSON 层不受影响。 */
export const IGNORE_MCP_JSON_ENV = "DSH_MCP_IGNORE_MCP_JSON";

/** 遗留 CC 项目层是否启用：默认开，`DSH_MCP_IGNORE_MCP_JSON=1` 关。 */
export function mcpJsonLayerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[IGNORE_MCP_JSON_ENV] !== "1";
}

/**
 * 配置行来源。数组顺序即影子优先序（先到先得）：
 * `dsh-project` > `dsh-project-json` > `cc-project` > `dsh-profile-user` > `dsh-user-yml` > `dsh-user`。
 * 前三者是项目层（按项目装载、按会话隔离），后三者是用户层（宿主级全局装载）。
 */
export type McpRowSource = "dsh-project" | "dsh-project-json" | "cc-project" | "dsh-profile-user" | "dsh-user-yml" | "dsh-user";

/** 带来源标记的配置行：主管线合并与快照展示用。disabled=true 的行参与占名
 *  （遮蔽下层同名）但不进入装载集合。 */
export interface SourcedRow {
  rawName: string;
  row: PatchRow;
  source: McpRowSource;
  disabled?: boolean;
}

export interface JsonReadResult {
  rows: SourcedRow[];
  /** 单条坏条目（sse/缺字段/坏名字）的报错，逐条收集，不影响其余条目。 */
  entryErrors: string[];
  /** 整文件级错误（不存在=正常空结果；解析失败等）。消息不含文件内容。 */
  fileError?: string;
  /**
   * 文件存在、缺 `mcpServers`、且顶层像 `{version, servers}`（对方插件存储格式）时的
   * 诊断。缺 `mcpServers` 仍是合法空层；此字段只为「配了但不生效」提供可执行说明。
   */
  formatHint?: string;
}

/** stdio 空 cwd 的解析策略：项目层=项目根；用户层=继承宿主工作目录。 */
export type JsonCwdPolicy = "project" | "host";

export interface JsonReadOptions {
  source: McpRowSource;
  cwdPolicy: JsonCwdPolicy;
  /** 项目根（cwdPolicy="project" 时空 cwd 的落点；用户层传空串）。 */
  projectRoot: string;
  /** true：缺 `mcpServers` 报文件级错误（遗留 CC 文件语义）；false：视为空层。 */
  requireMcpServers?: boolean;
}

const jsonReconnectSchema = z
  .object({
    enabled: z.boolean().optional(),
    initialDelayMs: z.number().int().min(1).max(MAX_TIMER_DELAY_MS).optional(),
    maxDelayMs: z.number().int().min(1).max(MAX_TIMER_DELAY_MS).optional(),
    maxAttempts: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()
  })
  .optional();

/**
 * 单条目宽松 schema：未知字段（timeout/scope 等生态附加键）容忍并忽略。
 * `type` 缺省视为 stdio（有 url/httpUrl 无 command 时按 http 推断）。
 * `transport` 与 `httpUrl` 为原生/Gemini 方言别名，由 jsonEntryToInput 归一。
 */
export const jsonServerEntrySchema = z.looseObject({
  type: z.string().optional(),
  transport: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  httpUrl: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  disabled: z.boolean().optional(),
  toolCallTimeoutMs: z.number().int().min(1).optional(),
  failOnStartupError: z.boolean().optional(),
  reconnect: jsonReconnectSchema,
  tools: z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional()
  }).optional(),
  includeTools: z.array(z.string()).optional(),
  excludeTools: z.array(z.string()).optional()
});

export type JsonServerEntry = z.infer<typeof jsonServerEntrySchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** DSH 透传键：只在条目显式给出时并入输入（缺省由 mcpServerInputSchema 的 default 补）。 */
function passthroughKeys(entry: JsonServerEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (entry.toolCallTimeoutMs !== undefined) out.toolCallTimeoutMs = entry.toolCallTimeoutMs;
  if (entry.failOnStartupError !== undefined) out.failOnStartupError = entry.failOnStartupError;
  if (entry.reconnect !== undefined) out.reconnect = entry.reconnect;
  return out;
}

function resolveJsonToolFilter(entry: JsonServerEntry): { tools?: { allow?: string[]; deny?: string[] } } {
  const allow = entry.tools?.allow !== undefined ? entry.tools.allow : entry.includeTools;
  const deny = entry.tools?.deny !== undefined ? entry.tools.deny : entry.excludeTools;
  if (allow === undefined && deny === undefined) return {};
  return { tools: { ...(allow === undefined ? {} : { allow }), ...(deny === undefined ? {} : { deny }) } };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 条目上显式给出的 transport/type → 官方传输。两者都给且映射结果不同则报错；
 * `transport` 优先（原生方言优先），但冲突仍报错而不是静默覆盖。
 * `sse` 等不受支持值走 resolveMcpTransport 的可执行文案。
 */
function resolveDeclaredTransport(entry: JsonServerEntry): { transport?: SupportedMcpTransport } | { error: string } {
  const fromTransport = entry.transport === undefined || entry.transport === "" ? undefined : resolveMcpTransport(entry.transport);
  const fromType = entry.type === undefined || entry.type === "" ? undefined : resolveMcpTransport(entry.type);
  if (fromTransport !== undefined && "error" in fromTransport) return fromTransport;
  if (fromType !== undefined && "error" in fromType) return fromType;
  if (fromTransport !== undefined && fromType !== undefined && fromTransport.transport !== fromType.transport) {
    return { error: `transport (${entry.transport}) 与 type (${entry.type}) 冲突` };
  }
  return { transport: fromTransport?.transport ?? fromType?.transport };
}

/** 单条 JSON 条目 → 官方输入。坏条目返回 `{ error }` 由调用方逐条收集。 */
export function jsonEntryToInput(name: string, entry: JsonServerEntry, options: JsonReadOptions): { input: McpServerInput } | { error: string } {
  const url = nonEmptyString(entry.url);
  const httpUrl = nonEmptyString(entry.httpUrl);
  if (url !== undefined && httpUrl !== undefined && url !== httpUrl) {
    return { error: "url 与 httpUrl 同时出现且值不同；请只保留其一" };
  }
  const remoteUrl = httpUrl ?? url;
  const declared = resolveDeclaredTransport(entry);
  if ("error" in declared) return declared;
  if (httpUrl !== undefined && declared.transport === "stdio") {
    return { error: "httpUrl 表示 streamable-http，与 transport/type 声明的 stdio 冲突" };
  }
  try {
    const inferredHttp = declared.transport === undefined && remoteUrl !== undefined && entry.command === undefined;
    const wantHttp = declared.transport === "streamable-http" || httpUrl !== undefined || inferredHttp;
    if (wantHttp) {
      if (remoteUrl === undefined) return { error: 'type:"http" 条目缺少 url' };
      const input = mcpServerInputSchema.parse({
        serverName: name,
        transport: "streamable-http",
        url: remoteUrl,
        headers: entry.headers,
        ...passthroughKeys(entry),
        ...resolveJsonToolFilter(entry)
      });
      return { input };
    }
    if (typeof entry.command !== "string" || entry.command === "") {
      return { error: declared.transport === "stdio" || entry.type === "stdio" ? 'type:"stdio" 条目缺少 command' : '条目缺少 command（且无 type:"http"/url）' };
    }
    // cwd 缺省语义：显式写的非空 cwd 原样保留；项目层缺省落到项目根；全局层留空串（继承宿主工作目录）。
    let cwd = "";
    if (typeof entry.cwd === "string" && entry.cwd !== "") {
      cwd = entry.cwd;
    } else if (options.cwdPolicy === "project") {
      cwd = options.projectRoot;
    }
    const input = mcpServerInputSchema.parse({
      serverName: name,
      transport: "stdio",
      command: entry.command,
      args: entry.args ?? [],
      env: entry.env,
      cwd,
      ...passthroughKeys(entry),
      ...resolveJsonToolFilter(entry)
    });
    return { input };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** `mcpServers` 值 → SourcedRow 列表；坏条目逐条报错跳过。 */
export function parseJsonServersValue(mcpServers: unknown, options: JsonReadOptions): { rows: SourcedRow[]; entryErrors: string[] } {
  const rows: SourcedRow[] = [];
  const entryErrors: string[] = [];
  if (mcpServers === undefined || mcpServers === null) return { rows, entryErrors };
  if (!isPlainObject(mcpServers)) {
    entryErrors.push("mcpServers 必须是对象（serverName → 配置）");
    return { rows, entryErrors };
  }
  for (const [name, raw] of Object.entries(mcpServers)) {
    // enabled:false = 静默不装载、不报错、不占名（生态通行写法）。
    if (isPlainObject(raw) && raw.enabled === false) continue;
    if (!SERVER_NAME_RE.test(name)) {
      entryErrors.push(`"${name}": serverName 非法（允许 1-32 位字母、数字、下划线或连字符）`);
      continue;
    }
    const parsed = jsonServerEntrySchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；");
      entryErrors.push(`"${name}": 条目字段无效：${detail}`);
      continue;
    }
    const mapped = jsonEntryToInput(name, parsed.data, options);
    if ("error" in mapped) {
      entryErrors.push(`"${name}": ${mapped.error}`);
      continue;
    }
    // disabled:true = 占名但不装载（与原生 yml 的 disabled 占位行同义）。
    const disabled = parsed.data.disabled === true;
    rows.push({ rawName: name, row: toPatchRow(mapped.input, !disabled), source: options.source, ...(disabled ? { disabled: true } : {}) });
  }
  return { rows, entryErrors };
}

/** 读取 JSON 文件并 parse；缺失返回 missing:true；parse 错误消息不含内容片段。 */
async function readJsonFile(path: string): Promise<{ missing?: true; value?: unknown; error?: string }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { missing: true };
    // errno code 不含文件内容，可安全附带——EACCES 与 EISDIR 的处置完全不同，
    // 只报「读取失败」会让用户无从下手。
    return { error: typeof code === "string" && code !== "" ? `读取失败（${code}）` : "读取失败" };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch {
    // V8 的 JSON.parse 错误消息会引用文件内容片段；这里必须只报类别。
    return { error: "JSON 解析失败" };
  }
}

/** 通用 JSON 方言读取：文件缺失 → 空结果；坏条目逐条报错。 */
export async function readJsonRows(path: string, options: JsonReadOptions): Promise<JsonReadResult> {
  const label = basename(path);
  const result = await readJsonFile(path);
  if (result.missing === true) return { rows: [], entryErrors: [] };
  if (result.error !== undefined) return { rows: [], entryErrors: [], fileError: `${label} ${result.error}` };
  if (!isPlainObject(result.value)) return { rows: [], entryErrors: [], fileError: `${label} 顶层必须是 JSON 对象` };
  if (!("mcpServers" in result.value)) {
    const formatHint = detectForeignMcpFormat(result.value);
    if (options.requireMcpServers === true) {
      return {
        rows: [],
        entryErrors: [],
        fileError: `${label} 缺少 mcpServers 字段`,
        ...(formatHint === undefined ? {} : { formatHint })
      };
    }
    if (formatHint !== undefined) return { rows: [], entryErrors: [], formatHint };
    return { rows: [], entryErrors: [] };
  }
  const { rows, entryErrors } = parseJsonServersValue(result.value.mcpServers, options);
  return { rows, entryErrors };
}

/** 读 DSH 自有 JSON 层（缺 `mcpServers` 视为空层）。 */
export function readDshJsonFile(path: string, options: JsonReadOptions): Promise<JsonReadResult> {
  return readJsonRows(path, { ...options, requireMcpServers: false });
}

/** 读遗留 `<projectRoot>/.mcp.json`（CC project scope；缺 `mcpServers` 报文件级错误）。 */
export function readMcpJsonFile(path: string, projectRoot: string): Promise<JsonReadResult> {
  return readJsonRows(path, { source: "cc-project", cwdPolicy: "project", projectRoot, requireMcpServers: true });
}
