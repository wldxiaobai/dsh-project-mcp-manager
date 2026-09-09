/**
 * dsh-project-mcp-manager —— DSH JSON 配置写入器（仅 `dsh-mcp` CLI 使用）。
 *
 * 契约（"CLI 独占整个文件"）：
 *  - 只认 `mcpServers` 键；其余顶层键原样保留（语义保真，排版归一化）；
 *  - 写入前必须先能解析现有文件：解析失败即拒绝写入，**绝不覆盖**用户内容；
 *  - JSON 无注释，`mcpServers` 内部的注释/排版不被保留（与 yml 的受管块保真承诺不同）；
 *  - 复用 `withPatchLock`（`<path>.mcp-project.lock`）+ `writeFileAtomic`（临时文件 + rename）。
 *
 * 读路径不在本模块：插件侧只读由 `json-file.ts` 承担，宿主永不写这些文件。
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { writeFileAtomic, withPatchLock } from "./mcp-file.js";
import { DEFAULT_RECONNECT, DEFAULT_TOOL_CALL_TIMEOUT_MS, type McpServerInput } from "./model.js";

/**
 * `mcpServers` 映射。值类型是 unknown 而非对象：文件里可能存在非对象条目
 * （`"legacy": "node x.js"` 这类手写错误），读-改-写必须原样带过，不能顺手删。
 * 写入方（CLI）只新增/删除自己指名的键。
 */
export type JsonServers = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 读 JSON 文档：缺失/空文件 → `{}`；解析失败或顶层非对象 → 抛错（消息不含文件内容）。
 * 调用方据此拒绝写入，避免把无法解析的文件覆盖掉。
 */
export async function readJsonDocument(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw new Error(`无法读取 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // V8 的解析错误消息会引用文件内容片段（可能含密钥）：只报类别。
    throw new Error(`${basename(path)} JSON 语法错误：CLI 独占写入，拒绝覆盖无法解析的文件`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${basename(path)} 顶层必须是 JSON 对象`);
  return parsed;
}

/**
 * 读现有 `mcpServers` 映射（缺失/null → 空映射；顶层非对象 → 抛错）。
 * 条目一律保留（含非对象的坏条目）：CLI 的判重要能看见坏条目占用的名字，
 * `remove <坏条目名>` 也才能把它清掉。装载侧的坏条目过滤在 json-file.ts。
 */
export async function readJsonServers(path: string): Promise<JsonServers> {
  const doc = await readJsonDocument(path);
  const servers = doc.mcpServers;
  if (servers === undefined || servers === null) return {};
  if (!isPlainObject(servers)) throw new Error(`${basename(path)} 的 mcpServers 必须是对象`);
  return { ...servers };
}

/**
 * 锁内读-改-写 `mcpServers`：mutate 收到锁内的最新映射，返回值（或原地修改）即写回值。
 * 加锁 + 原子写；写前自校验（序列化结果必须可解析回来）。返回写回后的映射。
 */
export async function updateJsonServers(path: string, mutate: (servers: JsonServers) => JsonServers | void): Promise<JsonServers> {
  return withPatchLock(path, async () => {
    const doc = await readJsonDocument(path);
    // 非对象条目原样带过：过滤掉的话任何 add/remove 都会顺手永久删除它们
    // （用户手写的 `"legacy": "node x.js"` 会静默消失）。
    const current: JsonServers = isPlainObject(doc.mcpServers) ? { ...doc.mcpServers } : {};
    const next = mutate(current) ?? current;
    const text = JSON.stringify({ ...doc, mcpServers: next }, null, 2) + "\n";
    const check: unknown = JSON.parse(text);
    if (!isPlainObject(check) || !isPlainObject(check.mcpServers)) {
      throw new Error("写入自校验失败：序列化结果不是合法的 mcpServers 文档");
    }
    await writeFileAtomic(path, text);
    return next;
  });
}

/** 整体替换 `mcpServers`（保留其余顶层键与键序）。 */
export function writeJsonServers(path: string, servers: JsonServers): Promise<JsonServers> {
  return updateJsonServers(path, () => servers);
}

/**
 * 官方输入 → JSON 条目（Cursor/CC 方言 + DSH 透传键）。
 * 缺省值不落盘（`args: []`、空 `env`/`headers`、空或 "." 的 `cwd`、默认
 * `toolCallTimeoutMs`/`failOnStartupError`/`reconnect`），保持文件简洁可读。
 * `${VAR}` 原样保留，装载时才展开——凭据不落盘。
 */
export function toJsonEntry(input: McpServerInput): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (input.transport === "stdio") {
    entry.command = input.command;
    if (input.args.length > 0) entry.args = [...input.args];
    const env = Object.entries(input.env ?? {}).filter((pair): pair is [string, string] => typeof pair[1] === "string");
    if (env.length > 0) entry.env = Object.fromEntries(env);
    if (input.cwd !== "" && input.cwd !== ".") entry.cwd = input.cwd;
  } else {
    entry.url = input.url;
    const headers = Object.entries(input.headers ?? {}).filter((pair): pair is [string, string] => typeof pair[1] === "string");
    if (headers.length > 0) entry.headers = Object.fromEntries(headers);
  }
  if (input.toolCallTimeoutMs !== DEFAULT_TOOL_CALL_TIMEOUT_MS) entry.toolCallTimeoutMs = input.toolCallTimeoutMs;
  if (input.failOnStartupError !== false) entry.failOnStartupError = input.failOnStartupError;
  const reconnect = input.reconnect;
  if (
    reconnect.enabled !== DEFAULT_RECONNECT.enabled ||
    reconnect.initialDelayMs !== DEFAULT_RECONNECT.initialDelayMs ||
    reconnect.maxDelayMs !== DEFAULT_RECONNECT.maxDelayMs ||
    reconnect.maxAttempts !== DEFAULT_RECONNECT.maxAttempts
  ) {
    entry.reconnect = { ...reconnect };
  }
  return entry;
}
