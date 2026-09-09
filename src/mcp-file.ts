/**
 * dsh-project-mcp-manager —— 项目 MCP 配置文件（<projectRoot>/.dsh/mcp.yml）编辑器。
 *
 * 项目文件使用与 profile cordis.patch.yml 相同的受管块格式：begin/end 标记
 * 之间的 YAML insert 列表（与 @deepseek-ai/dsh-mcp-client 插件行同构）。
 * 本插件只读写 begin/end 标记之间的行，标记之外的内容逐字节保留。
 * 写入使用同目录临时文件 + rename，并通过锁文件避免并发写。
 *
 * 标记名与 dsh-skill-mcp-panel 不同（dsh-project-mcp-manager vs dsh-skill-mcp-panel），
 * 但行 id 前缀兼容 panel 的 `panel-mcp-`，v2.1 面板写出的项目文件可直接读取。
 */
import { open, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDocument, stringify } from "yaml";

export const MCP_BLOCK_BEGIN = "# >>> dsh-project-mcp-manager:mcp:begin";
export const MCP_BLOCK_END = "# <<< dsh-project-mcp-manager:mcp:end";
export const MCP_PLUGIN_NAME = "@deepseek-ai/dsh-mcp-client";
/** 兼容 dsh-skill-mcp-panel 的受管行 id 前缀（其项目文件行可直接装载）。 */
export const MANAGED_ROW_ID_PREFIX = "panel-mcp-";

/** Loader patch 行（宽松形状；受管块只包含 insert 列表）。 */
export interface PatchRow {
  id?: string;
  name?: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

const delay = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

/** 读取 patch 文件；缺失/读失败统一带路径报错。 */
export async function readPatchFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error("无法读取 patch 文件（" + path + "）：" + (error instanceof Error ? error.message : String(error)));
  }
}

/** 校验整份 patch 文本：可解析且顶层是数组。不解出/写回任何值。 */
export async function validatePatchText(raw: string): Promise<void> {
  const doc = parseDocument(raw, { logLevel: "silent" });
  if (doc.errors.length > 0) {
    throw new Error("cordis.patch.yml 解析失败：" + String(doc.errors[0]?.message ?? doc.errors[0]));
  }
  const parsed = doc.toJS();
  if (!Array.isArray(parsed)) throw new Error("cordis.patch.yml 顶层必须是 YAML 数组");
}

/** 把 YAML 解析出的顶层条目拍平成 patch 行。 */
function flattenPatchRows(entries: unknown): PatchRow[] {
  const rows: PatchRow[] = [];
  if (!Array.isArray(entries)) return rows;
  const pushRow = (value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const row = value as Record<string, unknown>;
    if (typeof row.id === "string" || typeof row.name === "string") {
      const normalized: PatchRow = { ...row };
      if (typeof row.id !== "string") delete normalized.id;
      if (typeof row.name !== "string") delete normalized.name;
      if (typeof row.disabled !== "boolean") delete normalized.disabled;
      if (row.config === null || typeof row.config !== "object" || Array.isArray(row.config)) delete normalized.config;
      rows.push(normalized);
    }
  };
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (Array.isArray(record.insert)) {
      for (const row of record.insert) pushRow(row);
    } else {
      pushRow(record);
    }
  }
  return rows;
}

/** 提取 begin/end 标记之间的受管行；无标记返回空数组。 */
export function extractManagedRows(raw: string): PatchRow[] {
  const begin = raw.indexOf(MCP_BLOCK_BEGIN);
  const end = raw.indexOf(MCP_BLOCK_END);
  if (begin < 0 && end < 0) return [];
  if (begin < 0 || end < 0 || end < begin) throw new Error("项目 MCP 文件中 dsh-project-mcp-manager 受管块标记不完整（begin/end 必须成对）");
  const blockStart = raw.indexOf("\n", begin);
  if (blockStart < 0) throw new Error("项目 MCP 文件受管块格式损坏");
  const blockText = raw.slice(blockStart + 1, end);
  const doc = parseDocument(blockText, { logLevel: "silent" });
  if (doc.errors.length > 0) throw new Error("受管块解析失败：" + String(doc.errors[0]?.message ?? doc.errors[0]));
  // 原生 cordis 方言的 `!!js` 标签（cordis-plugin-include 的
  // js-yaml JSON_SCHEMA.extend(JsExpr)，由 Loader 求值）在 yaml 包中无法
  // 解析：只产生 Unresolved tag 警告，值会静默降级为 "process.env.X" 字面
  // 量字符串（env/headers 拿到假值，disabled 表达式因 !== true 被当启用装载）。
  // 受管块内出现任何未解析标签都必须显式报错，不能带病装载。
  const unresolved = doc.warnings.find((warning) => /Unresolved tag/.test(String(warning?.message ?? warning)));
  if (unresolved !== undefined) {
    throw new Error("受管块包含不支持的 YAML 标签：原生 cordis 方言 `!!js` 不能用于项目 mcp.yml，env/headers/disabled 请写字面值。位置：" + String(unresolved.message ?? unresolved));
  }
  const parsed = doc.toJS();
  if (!Array.isArray(parsed)) throw new Error("受管块内容必须是 YAML 数组");
  return flattenPatchRows(parsed);
}

/** 生成受管块文本（无行时为空字符串）。 */
export function generateManagedBlock(rows: PatchRow[]): string {
  if (rows.length === 0) return "";
  const body = stringify([{ insert: rows }], { indent: 2, lineWidth: 0 });
  return MCP_BLOCK_BEGIN + "\n" + body + MCP_BLOCK_END + "\n";
}

/**
 * 替换受管块；无标记且要写入行时追加到文件末尾。标记之外的所有字节原样保留。
 */
export function replaceManagedBlock(raw: string, rows: PatchRow[]): string {
  const begin = raw.indexOf(MCP_BLOCK_BEGIN);
  const end = raw.indexOf(MCP_BLOCK_END);
  const block = generateManagedBlock(rows);

  if (begin >= 0 || end >= 0) {
    if (begin < 0 || end < 0 || end < begin) throw new Error("项目 MCP 文件中 dsh-project-mcp-manager 受管块标记不完整（begin/end 必须成对）");
    const lineStart = raw.lastIndexOf("\n", begin - 1) + 1;
    const afterEnd = raw.indexOf("\n", end);
    const lineEnd = afterEnd < 0 ? raw.length : afterEnd + 1;
    const next = raw.slice(0, lineStart) + block + raw.slice(lineEnd);
    if (block !== "") return next;
    // 删除最后一批受管行后，原文件可能只剩注释；此时必须补回流式空数组，
    // 否则文件不再是合法顶层数组。
    const meaningful = next.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
    if (meaningful.length === 0) return next.replace(/\s*$/, "") + "\n[]\n";
    return next;
  }

  if (block === "") return raw;
  // 空模板是流式空数组 `[]`：直接追加块序列会变成 `[] - insert`，
  // 必须在追加前把 `[]` 替换为受管块序列。
  const lines = raw.split(/\r?\n/);
  const meaningful = lines.map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  if (meaningful.length === 1 && meaningful[0] === "[]") {
    const index = raw.lastIndexOf("[]");
    return raw.slice(0, index) + block + raw.slice(index + 2);
  }
  const prefix = raw.length === 0 ? "" : raw.endsWith("\n") ? "\n" : "\n\n";
  return raw + prefix + block;
}

/** 同目录临时文件 + rename 原子写；Windows 上 rename 覆盖失败时退化为 rm+rename。 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), ".dsh-project-mcp-manager-tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8));
  try {
    await writeFile(temp, content, "utf8");
    try {
      await rename(temp, path);
    } catch (error) {
      if (error === null || typeof error !== "object" || !["EPERM", "EEXIST", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await rm(path, { force: true });
      await rename(temp, path);
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * 以 `<path>.mcp-project.lock` 为锁执行 fn。锁文件记录 pid + 时间；超过 30 秒
 * 视为陈旧锁自动清理。获取超时 5 秒。
 */
export async function withPatchLock<T>(path: string, fn: () => Promise<T> | T): Promise<T> {
  const lockPath = path + ".mcp-project.lock";
  // 项目文件首次写入时父目录可能不存在：锁文件也需要父目录。
  await mkdir(dirname(lockPath), { recursive: true });
  const started = Date.now();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (handle === undefined) {
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (error === null || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > 30000) await rm(lockPath, { force: true }).catch(() => {});
      } catch {
        // 锁在检查间隙被释放：继续重试。
      }
      if (Date.now() - started > 5000) throw new Error("等待项目 MCP 文件写锁超时（可能有其他进程正在写入）");
      await delay(50);
    }
  }
  try {
    await handle.writeFile(process.pid + "\n" + Date.now() + "\n", "utf8");
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

/**
 * 锁内读-改-写受管行：mutate 收到锁内读出的最新受管行，返回值即写回的行集合。
 * 并发写入的唯一安全形态——锁外先读、锁内整体替换会让两个并发 add 互相丢行。
 * mutate 抛出的错误原样上抛（判重冲突走这里），文件不被改动。
 *
 * createIfMissing 只吃「文件/父目录不存在」（ENOENT）：EACCES、受管块损坏等
 * 一律上抛，绝不当成空文件覆盖用户内容。
 * 返回写回后的完整文本。
 */
async function writeManagedBlockLocked(
  path: string,
  rowsFrom: (raw: string) => PatchRow[],
  options: { createIfMissing?: boolean }
): Promise<string> {
  return withPatchLock(path, async () => {
    let raw: string;
    try {
      raw = await readPatchFile(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 只有「文件/父目录不存在」才按空文件处理：EACCES 等一律上抛，
      // 否则读不到的文件会被当空文件整体覆盖（吞掉用户内容）。
      if (options.createIfMissing !== true || !message.includes("ENOENT")) throw error;
      await mkdir(dirname(path), { recursive: true });
      raw = "";
    }
    const next = replaceManagedBlock(raw, rowsFrom(raw));
    await validatePatchText(next);
    await writeFileAtomic(path, next);
    return next;
  });
}

export async function updateManagedRows(
  path: string,
  mutate: (rows: PatchRow[]) => PatchRow[],
  options: { createIfMissing?: boolean } = {}
): Promise<string> {
  // extractManagedRows 的解析错误在此穿透：受管块损坏时改写等于丢用户内容。
  return writeManagedBlockLocked(path, (raw) => mutate(extractManagedRows(raw)), options);
}

/**
 * 整体替换受管行（读取、替换受管块、校验、加锁原子写回）。
 * 调用方已持有完整目标行集合时用它；需要「基于现有行改一改」请用
 * updateManagedRows（锁内读-改-写，并发安全）。
 * createIfMissing 时文件缺失（或父目录缺失）按空文件处理：用于项目级
 * <projectRoot>/.dsh/mcp.yml 的首次写入。
 * 返回写回后的完整文本。
 */
export async function writeManagedRows(path: string, rows: PatchRow[], options: { createIfMissing?: boolean } = {}): Promise<string> {
  return writeManagedBlockLocked(path, () => rows, options);
}
