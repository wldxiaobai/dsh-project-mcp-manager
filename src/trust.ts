/**
 * dsh-project-mcp-manager —— 项目层 MCP 配置的 workspace 信任存储。
 *
 * 项目层的三个文件（`.dsh/mcp.yml`、`.dsh/mcp.json`、`.mcp.json`）都是**可执行代码
 * 载体**：`stdio` 行会在宿主进程里 spawn `command`。`projectTrust: "allowlist"`
 * 时，只有记录在本存储里的 workspace 才会被读取和装载；未记录的 workspace 连文件
 * 都不读（这样即使配置文件本身带解析期副作用也不会触发）。
 *
 * 存储落在 `$DSH_HOME/mcp-trust.json`（与诊断同目录，不进用户工作区），键是
 * `projectKeyOf()`——Windows 上大小写无关。模式本身不在这里：它是插件 Config /
 * `DSH_MCP_PROJECT_TRUST`，本文件只管「谁被信任」。
 *
 * 纯函数（parse/set/isTrusted）与 I/O 分开，便于 CLI、registry 与测试共用；
 * 写入走 `mcp-file.ts` 的锁 + 原子写，和受管 yml 同一套并发约定。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { projectTrustFile } from "./dsh-paths.js";
import { writeFileAtomic, withPatchLock } from "./mcp-file.js";
import { byCodeUnit, projectKeyOf } from "./model.js";

/** 强制/覆盖信任模式的环境变量；优先于插件 Config（headless、CI 用）。 */
export const PROJECT_TRUST_ENV = "DSH_MCP_PROJECT_TRUST";

/** `inherit` = 旧行为（总是读项目文件）；`allowlist` = 只读已信任的 workspace。 */
export type ProjectTrustMode = "inherit" | "allowlist";

export const PROJECT_TRUST_MODES: readonly ProjectTrustMode[] = ["inherit", "allowlist"];

export interface TrustRecord {
  /** 记录时的 workspace 根（展示与人工核对用；身份判定一律用键）。 */
  root: string;
  /** ISO 时间戳。 */
  trustedAt: string;
}

export interface TrustDocument {
  version: 1;
  /** projectKeyOf(root) → 记录。 */
  projects: Record<string, TrustRecord>;
}

export const TRUST_DOCUMENT_VERSION = 1;

export function emptyTrustDocument(): TrustDocument {
  return { version: TRUST_DOCUMENT_VERSION, projects: {} };
}

/** 单个模式串的解析（env 与 Config 共用）；非法值返回 undefined，由调用方决定回退。 */
export function parseProjectTrustMode(value: unknown): ProjectTrustMode | undefined {
  return value === "inherit" || value === "allowlist" ? value : undefined;
}

/**
 * 生效模式：`DSH_MCP_PROJECT_TRUST` 优先于插件 Config，两者都缺省时 `inherit`。
 * 非法 env 值不静默降级成 `allowlist`（那样会让写错变量的部署突然停止装载），
 * 而是忽略并落到 Config——模式只接受两个显式字面量。
 */
export function resolveProjectTrustMode(configured: unknown, env: NodeJS.ProcessEnv = process.env): ProjectTrustMode {
  return parseProjectTrustMode(env[PROJECT_TRUST_ENV]) ?? parseProjectTrustMode(configured) ?? "inherit";
}

/** 宽松解析：坏条目丢弃、键按 root 重新推导，绝不因为一条脏数据丢掉整份信任表。 */
export function parseTrustDocument(raw: unknown): TrustDocument {
  const doc = emptyTrustDocument();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return doc;
  const source = (raw as { projects?: unknown }).projects;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return doc;
  for (const value of Object.values(source as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const root = (value as { root?: unknown }).root;
    if (typeof root !== "string" || root.trim() === "") continue;
    const trustedAt = (value as { trustedAt?: unknown }).trustedAt;
    const absolute = resolve(root);
    doc.projects[projectKeyOf(absolute)] = {
      root: absolute,
      trustedAt: typeof trustedAt === "string" ? trustedAt : ""
    };
  }
  return doc;
}

/** 读信任文件；缺失视为空表（未启用或尚未信任任何项目），其它读取错误由调用方告警。 */
export async function readTrustFile(path: string): Promise<TrustDocument> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return emptyTrustDocument();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("信任文件不是合法 JSON：" + path);
  }
  return parseTrustDocument(parsed);
}

/** 锁内原子写；键排序让文件在 diff 里稳定。 */
export async function writeTrustFile(path: string, doc: TrustDocument): Promise<void> {
  const projects: Record<string, TrustRecord> = {};
  for (const key of Object.keys(doc.projects).sort(byCodeUnit)) projects[key] = doc.projects[key];
  const payload: TrustDocument = { version: TRUST_DOCUMENT_VERSION, projects };
  await withPatchLock(path, async () => {
    await writeFileAtomic(path, JSON.stringify(payload, null, 2) + "\n");
  });
}

/** 该 workspace 是否被信任（`inherit` 模式由调用方短路，不查表）。 */
export function isTrustedIn(doc: TrustDocument, projectRoot: string): boolean {
  if (projectRoot.trim() === "") return false;
  return doc.projects[projectKeyOf(resolve(projectRoot))] !== undefined;
}

/** 纯函数增删；`at` 供测试注入固定时间。返回新文档，不改入参。 */
export function setTrustedIn(doc: TrustDocument, projectRoot: string, trusted: boolean, at: string = new Date().toISOString()): TrustDocument {
  const projects: Record<string, TrustRecord> = { ...doc.projects };
  const absolute = resolve(projectRoot);
  const key = projectKeyOf(absolute);
  if (trusted) projects[key] = { root: absolute, trustedAt: at };
  else delete projects[key];
  return { version: TRUST_DOCUMENT_VERSION, projects };
}

/** 已信任的 workspace 根（按码元序）；CLI `trusted` 与诊断共用。 */
export function trustedRoots(doc: TrustDocument): string[] {
  return Object.values(doc.projects).map((record) => record.root).sort(byCodeUnit);
}

/**
 * 信任集签名（排序后的键）：registry 用它判定「文件被 CLI 改动」与「本轮与上轮
 * 是否相同」。只含键，不含时间戳——重新信任同一目录不应作废配置指纹。
 */
export function trustSignature(doc: TrustDocument): string {
  return Object.keys(doc.projects).sort(byCodeUnit).join("\u0000");
}

/** `$DSH_HOME/mcp-trust.json`；registry 与 CLI 走同一个解析。 */
export function trustFileFor(dshHome: string): string {
  return projectTrustFile(dshHome);
}
