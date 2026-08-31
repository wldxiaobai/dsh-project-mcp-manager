/**
 * dsh-project-mcp-manager —— Claude Code MCP 兼容层（严格只读）。
 *
 * 两个来源：
 *   1. `<projectRoot>/.mcp.json` —— CC 的 project scope（约定 commit 进 git）；
 *   2. `~/.claude.json` 顶层 `mcpServers` —— CC 的 user scope。
 *
 * 职责边界：`~/.claude.json` 是 CC 的单体状态文件（混杂登录凭证、onboarding
 * 状态、每项目会话历史等，见 anthropics/claude-code#83143），本模块按严格
 * allowlist **只摘取顶层 `mcpServers` 键**，其余内容解析后即弃，永不进入
 * 行、诊断或日志；JSON parse 失败时诊断不带原始错误文本（V8 的消息会引用
 * 文件内容片段）。兼容层永不写入，两个文件都只读。
 *
 * 明确不支持：
 *   - local scope（`~/.claude.json` 的 `projects[<cwd>].mcpServers`）：其键按
 *     会话 cwd 匹配，会把 cwd 粒度可见性引入项目粒度管线；`claude mcp add`
 *     不带 `--scope` 默认写这里，文档指引用户改用 `--scope user` 或 `dsh-mcp`。
 *   - `type:"sse"` 条目：dsh-mcp-client 仅支持 stdio | streamable-http，
 *     entry-level 报错跳过。
 *
 * 行归一后与 `.dsh/mcp.yml` 受管行同构（PatchRow），复用主管线；`${VAR}`
 * 占位保持字面值进配置，由 model.expandEnvRefs 在 mount 时运行时展开。
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { type PatchRow } from "./mcp-file.js";
import { SERVER_NAME_RE, ccServerEntrySchema, mcpServerInputSchema, toPatchRow, type CcServerEntry } from "./model.js";

/** CC project scope 文件名（位于项目根，与 .dsh 并列）。 */
export const CC_PROJECT_FILE = ".mcp.json";
/** CC user scope 单体状态文件名（位于家目录，allowlist 只读其顶层 mcpServers）。 */
export const CLAUDE_USER_FILE = ".claude.json";
/** 置为 "1" 时整体跳过对 ~/.claude.json 的读取与监听。 */
export const IGNORE_CLAUDE_JSON_ENV = "DSH_MCP_IGNORE_CLAUDE_JSON";

/** 配置行来源（冲突遮蔽优先序见 registry：yml > cc-project > user-yml > cc-user）。 */
export type McpRowSource = "yml" | "cc-project" | "user-yml" | "cc-user";

/** 带来源标记的配置行：主管线合并与快照展示用。disabled=true 的行参与占名
 * （遮蔽下层同名）但不进入装载集合。 */
export interface SourcedRow {
  rawName: string;
  row: PatchRow;
  source: McpRowSource;
  disabled?: boolean;
}

export interface CcReadResult {
  rows: SourcedRow[];
  /** 单条坏条目（sse/缺字段/坏名字）的报错，逐条收集，不影响其余条目。 */
  entryErrors: string[];
  /** 整文件级错误（不存在=正常空结果；解析失败等）。消息不含文件内容。 */
  fileError?: string;
  /** readClaudeUserFile 专用：mcpServers 子树的规范化哈希，watcher 门控用。 */
  serversHash?: string;
}

/** 键排序的规范化 JSON 序列化（哈希与内容等价性判定共用）。 */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.keys(item as object).sort().reduce((acc: Record<string, unknown>, k) => {
        acc[k] = (item as Record<string, unknown>)[k];
        return acc;
      }, {});
    }
    return item;
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 单条 CC 条目 → 官方输入。stdio 的 cwd：project 层条目固定为项目根（CC spawn
 * 于配置文件所在项目）；user 层条目留空（继承宿主进程 cwd，文档披露的偏差——
 * 同一用户行会被挂到多个项目，无法逐项目定 cwd）。
 */
function ccEntryToInput(name: string, entry: CcServerEntry, projectRoot: string) {
  if (entry.type === "sse") {
    return { error: 'sse transport not supported（dsh-mcp-client 仅支持 stdio | streamable-http）' };
  }
  try {
    // url 而无 type/command：按 http 处理（手写文件常见，CC 官方要求 type 但容忍度向实用倾斜）
    const inferredHttp = entry.type === undefined && typeof entry.url === "string" && entry.command === undefined;
    if (entry.type === "http" || entry.type === "streamable-http" || inferredHttp) {
      if (typeof entry.url !== "string" || entry.url === "") return { error: 'type:"http" 条目缺少 url' };
      const input = mcpServerInputSchema.parse({
        serverName: name,
        transport: "streamable-http",
        url: entry.url,
        headers: entry.headers
      });
      return { input };
    }
    if (typeof entry.command !== "string" || entry.command === "") {
      return { error: entry.type === "stdio" ? 'type:"stdio" 条目缺少 command' : "条目缺少 command（且无 type:\"http\"/url）" };
    }
    const input = mcpServerInputSchema.parse({
      serverName: name,
      transport: "stdio",
      command: entry.command,
      args: entry.args ?? [],
      env: entry.env,
      cwd: projectRoot
    });
    return { input };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** CC 条目对象（mcpServers 的值）→ SourcedRow 列表；坏条目逐条报错跳过。 */
function parseMcpServersValue(mcpServers: unknown, source: McpRowSource, projectRoot: string): { rows: SourcedRow[]; entryErrors: string[] } {
  const rows: SourcedRow[] = [];
  const entryErrors: string[] = [];
  if (mcpServers === undefined || mcpServers === null) return { rows, entryErrors };
  if (!isPlainObject(mcpServers)) {
    entryErrors.push("mcpServers 必须是对象（serverName → 配置）");
    return { rows, entryErrors };
  }
  for (const [name, raw] of Object.entries(mcpServers)) {
    // enabled:false（README 承诺的跳过语义）：静默不装载、不报错、不占名。
    if (isPlainObject(raw) && raw.enabled === false) continue;
    if (!SERVER_NAME_RE.test(name)) {
      entryErrors.push(`"${name}": serverName 非法（允许 1-32 位字母、数字、下划线或连字符）`);
      continue;
    }
    const parsed = ccServerEntrySchema.safeParse(raw);
    if (!parsed.success) {
      entryErrors.push(`"${name}": 条目字段无效：${parsed.error.issues.map((issue) => `${String(issue.path.join("."))}: ${issue.message}`).join("；")}`);
      continue;
    }
    const mapped = ccEntryToInput(name, parsed.data, projectRoot);
    if ("error" in mapped) {
      entryErrors.push(`"${name}": ${mapped.error}`);
      continue;
    }
    rows.push({ rawName: name, row: toPatchRow(mapped.input), source });
  }
  return { rows, entryErrors };
}

/** 读取 JSON 文件并 parse；缺失返回 missing:true；parse 错误消息不含内容片段。 */
async function readJsonFile(path: string): Promise<{ missing?: true; value?: unknown; error?: string }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { missing: true };
    return { error: "读取失败" };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch {
    // V8 的 JSON.parse 错误消息会引用文件内容片段；这里必须只报类别。
    return { error: "JSON 解析失败" };
  }
}

/** 读项目根 `.mcp.json`（CC project scope）。文件缺失 → 空结果不算错误。 */
export async function readMcpJsonFile(path: string, projectRoot: string): Promise<CcReadResult> {
  const result = await readJsonFile(path);
  if (result.missing === true) return { rows: [], entryErrors: [] };
  if (result.error !== undefined) return { rows: [], entryErrors: [], fileError: `${CC_PROJECT_FILE} ${result.error}` };
  if (!isPlainObject(result.value)) return { rows: [], entryErrors: [], fileError: `${CC_PROJECT_FILE} 顶层必须是 JSON 对象` };
  if (!("mcpServers" in result.value)) return { rows: [], entryErrors: [], fileError: `${CC_PROJECT_FILE} 缺少 mcpServers 字段` };
  const { rows, entryErrors } = parseMcpServersValue(result.value.mcpServers, "cc-project", projectRoot);
  return { rows, entryErrors };
}

/**
 * 读 `~/.claude.json` 的顶层 `mcpServers`（CC user scope，allowlist 摘取）。
 * 文件缺失或未设 mcpServers → 空结果；同时输出 serversHash 供 watcher 门控
 * （CC 每次会话都重写该文件，与 MCP 无关的状态变化不应触发 reconcile）。
 */
export async function readClaudeUserFile(path: string): Promise<CcReadResult> {
  const result = await readJsonFile(path);
  const emptyHash = createHash("sha256").update(canonicalJsonString({})).digest("hex");
  if (result.missing === true) return { rows: [], entryErrors: [], fileError: undefined, serversHash: emptyHash };
  if (result.error !== undefined) return { rows: [], entryErrors: [], fileError: `${CLAUDE_USER_FILE} ${result.error}` };
  const servers = isPlainObject(result.value) ? result.value.mcpServers : undefined;
  const serversHash = createHash("sha256").update(canonicalJsonString(servers ?? {})).digest("hex");
  const { rows, entryErrors } = parseMcpServersValue(servers, "cc-user", "");
  return { rows, entryErrors, serversHash };
}
