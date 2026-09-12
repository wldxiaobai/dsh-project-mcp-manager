/**
 * dsh-project-mcp-manager —— 项目级 MCP 装载与按会话可见性。
 *
 * 项目级 MCP 服务器配置存放在 <projectRoot>/.dsh/mcp.yml（与技能侧的
 * <projectRoot>/.dsh/skills/ 并列），文件格式与 profile cordis.patch.yml
 * 受管块一致（begin/end 标记之间的 YAML insert 列表）。
 *
 * 装载模型：
 *   - 每个 (项目, serverName) 在宿主 ctx 上装载一个 @deepseek-ai/dsh-mcp-client
 *     实例（ctx.plugin），注册进全局工具层——同一项目内多会话共享同一连接；
 *   - 生效名：原始 serverName 在整个目录（全局行 + 全部项目行）中唯一时保持
 *     原名；否则按 model.effectiveServerNames 规则改名（确定性、与装载顺序
 *     无关），避免 dsh-mcp-client 按进程根的 serverName 预留冲突；
 *   - 会话可见性：agent 创建时按其会话 cwd 解析项目，对该 agent 层应用
 *     tools.restrict({ deny })，deny 掉「除本会话项目外的全部项目服务器」；
 *     目录变化（项目文件增删改、新 agent、装载 settle）都会重扫。
 *
 * 子代理（subagent）不继承父 agent 层的 restrict，但本注册表对每个 live
 * agent（含子代理）都按各自会话 cwd 应用同样的 deny 规则，因此行为一致。
 * 会话无 cwd 且无 owner 时回退 dsh 进程 cwd 所在项目（“在该项目开启 dsh
 * 会话”场景）。
 *
 * 配置来源（同一项目内合并=遮蔽优先序，先到先得；跨项目撞名仍走生效名改名）：
 *   1. <projectRoot>/.dsh/mcp.yml —— 原生受管块（主格式，source dsh-project）
 *   2. <projectRoot>/.dsh/mcp.json —— DSH 自有 JSON 方言（dsh-project-json）
 *   3. <projectRoot>/.mcp.json    —— Claude Code project 层（遗留只读，cc-project）
 *   4. ~/.dsh/profiles/<p>/mcp.json —— profile 用户层（dsh-profile-user）
 *   5. ~/.dsh/mcp.yml             —— 用户层原生（dsh-user-yml）
 *   6. ~/.dsh/mcp.json            —— 通用用户层（dsh-user）
 * 用户层行进入每个项目的合并集，即每个项目各挂一条用户服务器连接（与项目行
 * 同模型）；被同名项目行遮蔽的项目不再见到用户层副本。${VAR} 占位在 mount
 * 时经 model.expandEnvRefs 用宿主进程环境运行时展开，缺失即跳过该条目。
 */
import chokidar from "chokidar";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";
import { extractManagedRows, readPatchFile, type PatchRow } from "./mcp-file.js";
import {
  DIAG_FILE,
  DSH_DIR,
  MCP_YML_FILE,
  PROFILE_ENV,
  dshHomeDir,
  foreignUserMcpJsonFile,
  isValidProfileName,
  profileMcpJsonFile,
  userLayerPathsIn,
  type UserLayerPaths
} from "./dsh-paths.js";
import {
  CC_PROJECT_FILE,
  JSON_MCP_FILE,
  mcpJsonLayerEnabled,
  readDshJsonFile,
  readMcpJsonFile,
  type JsonReadResult,
  type McpRowSource,
  type SourcedRow
} from "./json-file.js";
import { findProjectRoot } from "./project-root.js";
import {
  byCodeUnit,
  deniedToolsForFilter,
  denySetFor,
  effectiveServerNames,
  expandEnvRefs,
  inputFromPatchRow,
  mcpServerInputSchema,
  configFromPatchRow,
  patchRowToView,
  projectKeyOf,
  rowNameOf,
  toOfficialConfig,
  toolFilterFromConfig,
  type McpScopeInfo
} from "./model.js";
import { mcpToolCount } from "./status.js";

const delay = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

/** 项目 MCP 配置文件名（位于项目根 `.dsh/` 下）。 */
export const PROJECT_MCP_FILE = MCP_YML_FILE;

/**
 * 从 loader 根 include 的配置路径（或 `ctx.baseUrl`）解析当前 profile 名。
 * profile 的根配置固定为 `<dshHome>/profiles/<name>/cordis.yml`（replay 模式为
 * `cordis.snapshot.yml`）；解析不出返回 undefined（调用方降级为不读 profile 层）。
 */
export function profileNameFromConfigPath(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  let path = raw;
  if (raw.startsWith("file:")) {
    try {
      path = fileURLToPath(new URL(raw));
    } catch {
      // Windows 上无盘符的 file URL（如 posix 形态）会让 fileURLToPath 抛错：
      // 退回 URL pathname 解析，保证目录形态仍能识别。
      try {
        path = decodeURIComponent(new URL(raw).pathname);
      } catch {
        return undefined;
      }
    }
  }
  const normalized = path.replaceAll("\\", "/");
  const fileMatch = /\/profiles\/([^/]+)\/cordis(?:\.snapshot)?\.ya?ml$/.exec(normalized);
  if (fileMatch !== null) return fileMatch[1];
  // baseUrl 形态：`file:///…/profiles/<name>/`
  const dirMatch = /\/profiles\/([^/]+)\/?$/.exec(normalized);
  return dirMatch === null ? undefined : dirMatch[1];
}

export type ProjectServerPhase = "mounting" | "active" | "failed" | "unloading";

/** 面板状态 → wire fiberPhase 词汇（wire 无 "mounting"）。 */
export function phaseToFiberPhase(phase: ProjectServerPhase): "loading" | "active" | "failed" | "unloading" {
  switch (phase) {
    case "mounting": return "loading";
    case "active": return "active";
    case "failed": return "failed";
    case "unloading": return "unloading";
  }
}

/**
 * serverName 集合 → 这批服务器当前注册的精确工具名（`mcp__<server>__*`）。
 * tools.restrict 的 deny 只认已注册的具体工具名（传 unknown names 会报错），不能直接给 serverName；
 * 装载尚未 settle 时会漏几个工具，靠下一次 sweep 补上。
 */
function expandToToolNames(serverNames: Iterable<string>, toolIds: string[]): string[] {
  const out: string[] = [];
  for (const serverName of serverNames) {
    const prefix = `mcp__${serverName}__`;
    out.push(...toolIds.filter((id) => id.startsWith(prefix)));
  }
  return out;
}

/** 一个已装载（或装载中）的 MCP 服务器的运行时状态。 */
export interface ProjectServerState {
  /** 项目根；全局层行为空串（scope="global"）。 */
  projectRoot: string;
  /** 作用域：项目层按项目装载 + 会话隔离；全局层宿主级只挂一条、对所有会话可见。 */
  scope?: "project" | "global";
  rawName: string;
  effectiveName: string;
  row: PatchRow;
  /** 行来源（遮蔽优先序见模块注释）；旧调用方可缺省。 */
  source?: McpRowSource;
  fiber?: any;
  phase: ProjectServerPhase;
  error?: string;
}

/** 一个项目的文件级状态（snapshot() 用）。 */
export interface ProjectFileState {
  project: string;
  path: string;
  ok: boolean;
  error: string | null;
  servers: any[];
  /** 分区作用域：workspace=项目层文件，global=用户层文件。缺省 workspace。 */
  kind?: "workspace" | "global";
  /** 该分区的配置来源方言。 */
  source?: McpRowSource;
}

export interface ProjectMcpRegistryOptions {
  /** 全局（profile patch）已装载 mcp-client 行的 serverName，用于生效名冲突判定。 */
  globalNames: () => Promise<string[]>;
  /** 当前运行的 profile 名（决定读哪个 `profiles/<name>/mcp.json`）；解析不出返回 undefined。 */
  activeProfile?: () => Promise<string | undefined>;
  /** 用户层路径注入点（测试用）；缺省 `<dshHome>/mcp.yml`、`<dshHome>/mcp.json`、`<dshHome>/profiles`
   *  （dshHome = `$DSH_HOME` 或 `<home>/.dsh`，见 dsh-paths.dshHomeDir）。 */
  userLayerPaths?: Partial<UserLayerPaths>;
  /** 时钟（测试注入）；缺省 `Date.now`。 */
  now?: () => number;
  /** 健康重挂退避毫秒；缺省 `HEALTH_REMOUNT_BACKOFF_MS`。 */
  healthRemountBackoffMs?: number;
  /** 健康重挂次数上限；缺省 `HEALTH_REMOUNT_LIMIT`。 */
  healthRemountLimit?: number;
  /** 配置文件指纹（测试注入）；缺省 `fs.stat`。返回 `null` 视为缺失。 */
  statFile?: (path: string) => Promise<{ mtimeMs: number; size: number } | null>;
}

interface ProjectEntry {
  projectRoot: string;
  servers: Map<string, ProjectServerState>; // rawName → state
}

/** 装载容器：项目层（按项目）与全局层（宿主级一条）共用同一套对账/装载逻辑。 */
interface MountContainer {
  scope: "project" | "global";
  /** 作用域键（projectKey 或 GLOBAL_SCOPE_KEY），用于 skipReasons 与生效名映射。 */
  key: string;
  /** 项目根；全局层为空串。 */
  projectRoot: string;
  servers: Map<string, ProjectServerState>;
  /** 该 state 是否仍是当前容器的装载（异步回调里防止旧 fiber 回写）。 */
  isCurrent: (state: ProjectServerState) => boolean;
  /** 生效名解析：项目层查生效名表；全局层保持原名。 */
  effectiveNameOf: (rawName: string) => string | undefined;
  /** 该容器的诊断落点。 */
  diag: (event: Record<string, unknown>) => Promise<void>;
  /** 日志前缀（含作用域描述）。 */
  label: string;
}

/** 变更计划（纯函数，供测试）。 */
export interface DesiredProjectRow {
  rawName: string;
  row: PatchRow;
  source?: McpRowSource;
}

export interface ProjectChangePlan {
  toUnmount: string[];
  toMount: DesiredProjectRow[];
}

/** 行配置的规范化序列化（键排序），用于判断行是否实质变化。 */
function canonicalConfig(config: Record<string, unknown> | undefined): string {
  return JSON.stringify(config ?? null, (key, value) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const keys = Object.keys(value);
      keys.sort(byCodeUnit);
      return keys.reduce((acc: Record<string, unknown>, k) => {
        acc[k] = (value as Record<string, unknown>)[k];
        return acc;
      }, {});
    }
    return value;
  });
}

/** 行的原始 serverName（受管行 id 或 config.serverName）；实现在 model.ts，CLI 与装载同口径。 */
export { rowNameOf } from "./model.js";

/**
 * 计算一个项目应当执行的装载变更（纯函数）：
 *   toUnmount —— 已装载但已不存在 / 生效名变化 / 配置变化的 rawName；
 *   toMount   —— 尚未装载或需要按新行/新生效名重新装载的条目。
 */
export function planProjectChanges(
  current: { rawName: string; effectiveName: string; row: PatchRow }[],
  desired: DesiredProjectRow[],
  effective: Map<string, string>,
  projectKey: string
): ProjectChangePlan {
  const toUnmount: string[] = [];
  const toMount: DesiredProjectRow[] = [];
  const desiredByName = new Map(desired.map((item) => [item.rawName, item]));
  for (const state of current) {
    const want = desiredByName.get(state.rawName);
    if (want === undefined) {
      toUnmount.push(state.rawName);
      continue;
    }
    const eff = effective.get(projectKey + "\u0000" + state.rawName);
    if (eff !== state.effectiveName || canonicalConfig(state.row.config) !== canonicalConfig(want.row.config)) {
      toUnmount.push(state.rawName);
    }
  }
  const currentByName = new Map(current.map((state) => [state.rawName, state]));
  for (const item of desired) {
    const state = currentByName.get(item.rawName);
    if (state === undefined) {
      toMount.push(item);
      continue;
    }
    const eff = effective.get(projectKey + "\u0000" + item.rawName);
    if (eff !== state.effectiveName || canonicalConfig(state.row.config) !== canonicalConfig(item.row.config)) {
      toMount.push(item);
    }
  }
  return { toUnmount, toMount };
}

/** 项目根下原生受管块文件路径。 */
export function projectMcpFile(projectRoot: string): string {
  return join(projectRoot, ".dsh", PROJECT_MCP_FILE);
}

/** 项目根下 DSH 自有 JSON 配置文件路径（`<root>/.dsh/mcp.json`）。 */
export function projectDshJsonFile(projectRoot: string): string {
  return join(projectRoot, ".dsh", JSON_MCP_FILE);
}

/** 项目根下 CC project scope 兼容文件路径（只读）。 */
export function projectMcpJsonFile(projectRoot: string): string {
  return join(projectRoot, CC_PROJECT_FILE);
}

function normalizePathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 两个文件路径是否指向同一文件（Windows 大小写不敏感）。 */
function isSameFilePath(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right);
}

const SOURCE_RANK: Record<McpRowSource, number> = {
  "dsh-project": 0,
  "dsh-project-json": 1,
  "cc-project": 2,
  "dsh-profile-user": 3,
  "dsh-user-yml": 4,
  "dsh-user": 5
};
/** 项目层来源（按项目装载、按会话隔离）与用户层来源（宿主级全局装载）的分界。 */
const PROJECT_LAYER_MAX_RANK = 2;

/** 该来源是否属于项目层；source 缺省（旧调用方）按项目层处理。 */
function isProjectLayerSource(source: McpRowSource | undefined): boolean {
  return source === undefined || SOURCE_RANK[source] <= PROJECT_LAYER_MAX_RANK;
}

/** 全局（用户层）装载的作用域键：参与 skipReasons 与日志归因。 */
export const GLOBAL_SCOPE_KEY = "\u0000global";
/** 连接死后连续重挂次数上限；达到后写 `give-up` 诊断并停止。 */
export const HEALTH_REMOUNT_LIMIT = 3;
/** 两次健康重挂之间的缺省退避（毫秒）。测试可经 options 注入 0。 */
export const HEALTH_REMOUNT_BACKOFF_MS = 5_000;

/** 服务身份键：stdio 看「可执行文件 + 参数」，http 看 url。command/url 缺失或为空的行
 * 不注册身份键（disabled 占名行常无 config，只占名字不冒充服务）。Windows 下路径大小写
 * 不敏感，command 统一小写；args 逐项字符串化后以 \0 连接（顺序与内容都要求一致）。 */
function serviceIdentityKey(item: SourcedRow): string | undefined {
  const config = configFromPatchRow(item.row);
  if (config === undefined) return undefined;
  if (config.transport === "streamable-http") {
    return typeof config.url === "string" && config.url !== "" ? "h\0" + config.url : undefined;
  }
  if (config.transport === "stdio") {
    if (typeof config.command !== "string" || config.command === "") return undefined;
    const command = process.platform === "win32" ? config.command.toLowerCase() : config.command;
    const args = Array.isArray(config.args) ? config.args.map(String).join("\0") : "";
    return "s\0" + command + "\0" + args;
  }
  return undefined;
}

/** 归一名键：小写并去掉非字母数字后同名视为同一服务（unityMCP 与 unity-mcp 是一个
 * 服务器的两种写法，真实事故对）；归一后为空串的原始名不注册该键。 */
function normalizedNameKey(rawName: string): string | undefined {
  const norm = rawName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return norm === "" ? undefined : norm;
}

/** 被身份/归一名去重剔除的行：loser 原名、winner 原名、命中维度、两侧来源。
 *  来源字段用于归因过滤：纯用户层之间的冲突不该记到每个项目的诊断里。 */
export interface IdentityShadow {
  name: string;
  winner: string;
  reason: "identity" | "normname";
  /** 被剔除方（loser）的来源层。 */
  source: McpRowSource;
  /** 胜出方（winner）的来源层。 */
  winnerSource: McpRowSource;
}

/** 用户层之间被同名/同服务遮蔽的行（全局层内部冲突，按全局归因）。 */
export interface GlobalShadow {
  name: string;
  winner: string;
  source: McpRowSource;
  winnerSource: McpRowSource;
}

/** 影子键的条件 get：键为 undefined 直接不查，免调用点三元。 */
function getIfDefined<V>(map: Map<string, V>, key: string | undefined): V | undefined {
  return key === undefined ? undefined : map.get(key);
}

function pushUnique(list: string[], name: string): void {
  if (!list.includes(name)) list.push(name);
}

/** 跨层遮蔽诊断的四个收集桶。 */
interface ShadowBuckets {
  shadowedOwnCc: string[];
  shadowedUser: string[];
  shadowedGlobal: GlobalShadow[];
  shadowedIdentity: IdentityShadow[];
}

/**
 * 被遮蔽行归因：
 *  - 项目 cc 行被任一 DSH 项目行遮蔽 → shadowedOwnCc；
 *  - 用户层行被项目层行遮蔽 → shadowedUser（项目侧压制的候选）；
 *  - 用户层行被另一条用户层行遮蔽 → shadowedGlobal（全局层内部冲突，此前零可见性）。
 */
function classifyShadow(item: SourcedRow, winner: SourcedRow, buckets: ShadowBuckets): void {
  if (item.source === "cc-project" && SOURCE_RANK[winner.source] < SOURCE_RANK["cc-project"]) {
    pushUnique(buckets.shadowedOwnCc, item.rawName);
    return;
  }
  if (SOURCE_RANK[item.source] <= PROJECT_LAYER_MAX_RANK) return;
  if (SOURCE_RANK[winner.source] <= PROJECT_LAYER_MAX_RANK) {
    pushUnique(buckets.shadowedUser, item.rawName);
    return;
  }
  if (!buckets.shadowedGlobal.some((shadow) => shadow.name === item.rawName)) {
    buckets.shadowedGlobal.push({ name: item.rawName, winner: winner.rawName, source: item.source, winnerSource: winner.source });
  }
}

/** 剔除集签名：排序后逐条 name\0winner\0reason\0source\0winnerSource 拼接，供「集合变了才告警」比较。 */
function identityShadowSignature(shadows: IdentityShadow[]): string {
  const entries = shadows.map((shadow) => [shadow.name, shadow.winner, shadow.reason, shadow.source, shadow.winnerSource].join("\u0000"));
  entries.sort(byCodeUnit);
  return entries.join("\u0001");
}

/** 全局层内部遮蔽集签名（同上，供全局告警门控）。 */
function globalShadowSignature(shadows: GlobalShadow[]): string {
  const entries = shadows.map((shadow) => [shadow.name, shadow.winner, shadow.source, shadow.winnerSource].join("\u0000"));
  entries.sort(byCodeUnit);
  return entries.join("\u0001");
}

/**
 * scan 诊断载荷（纯函数，自 scanProject 抽出以降认知复杂度）：「干净且无配置」
 * 返回 null——零配置项目不留痕。判定与载荷字段与原内联大 || 条件、条件展开逐一
 * 等价：异常、或有项目自身行、或有遮蔽/坏条目事件才写。
 */
function buildScanDiag(input: {
  yml: { ok: boolean; error: string | null };
  projectJson: JsonReadResult;
  cc: JsonReadResult;
  ownRows: Array<{ rawName: string }>;
  shadowedOwnCc: string[];
  suppressed: Set<string>;
  identityShadows: IdentityShadow[];
  shadowChanged: boolean
}): Record<string, unknown> | null {
  const { yml, projectJson, cc, ownRows, shadowedOwnCc, suppressed, identityShadows, shadowChanged } = input;
  const worthRecording = !yml.ok
    || ownRows.length > 0
    || projectJson.fileError !== undefined
    || projectJson.entryErrors.length > 0
    || projectJson.formatHint !== undefined
    || cc.fileError !== undefined
    || cc.entryErrors.length > 0
    || shadowedOwnCc.length > 0
    || suppressed.size > 0
    || (identityShadows.length > 0 && shadowChanged);
  if (!worthRecording) return null;
  const payload: Record<string, unknown> = {
    kind: "scan",
    ok: yml.ok && projectJson.fileError === undefined && cc.fileError === undefined,
    error: [yml.error, projectJson.fileError, cc.fileError].filter(Boolean).join(" ; ") || null,
    rows: ownRows.map((row) => row.rawName)
  };
  if (shadowedOwnCc.length > 0) payload.shadowedByYml = shadowedOwnCc;
  if (suppressed.size > 0) payload.shadowedByProject = [...suppressed];
  if (identityShadows.length > 0) payload.shadowedIdentity = identityShadows;
  if (projectJson.entryErrors.length > 0) payload.dshJsonEntryErrors = projectJson.entryErrors;
  if (projectJson.formatHint !== undefined) payload.foreignFormat = projectJson.formatHint;
  if (cc.entryErrors.length > 0) payload.ccEntryErrors = cc.entryErrors;
  return payload;
}

function jsonIssueNotes(result: JsonReadResult): string[] {
  return [...result.entryErrors, ...(result.formatHint === undefined ? [] : [result.formatHint])];
}

/** 单行三键先到先得：命中已有影子键则归因剔除，否则注册进影子表（disabled 占名行也注册）。 */
function mergeOneRow(item: SourcedRow, byName: Map<string, SourcedRow>, byNorm: Map<string, SourcedRow>, byIdentity: Map<string, SourcedRow>, buckets: ShadowBuckets): void {
  const winner = byName.get(item.rawName);
  if (winner !== undefined) {
    classifyShadow(item, winner, buckets);
    return;
  }
  const normKey = normalizedNameKey(item.rawName);
  const idKey = serviceIdentityKey(item);
  const normWinner = getIfDefined(byNorm, normKey);
  const idWinner = getIfDefined(byIdentity, idKey);
  const dupWinner = normWinner ?? idWinner;
  if (dupWinner !== undefined) {
    const reason: IdentityShadow["reason"] = normWinner !== undefined ? "normname" : "identity";
    buckets.shadowedIdentity.push({ name: item.rawName, winner: dupWinner.rawName, reason, source: item.source, winnerSource: dupWinner.source });
    classifyShadow(item, dupWinner, buckets);
    return;
  }
  byName.set(item.rawName, item);
  if (normKey !== undefined) byNorm.set(normKey, item);
  if (idKey !== undefined) byIdentity.set(idKey, item);
}

/** fiberPhase 展示推导：未装载时 disabled 占名→null、否则 pending；已装载且本分区拥有该实例才给生命周期枚举。 */
function fiberPhaseFor(state: ProjectServerState | undefined, row: PatchRow, owned: boolean): unknown {
  if (state === undefined) return row.disabled === true ? null : "pending";
  return owned ? phaseToFiberPhase(state.phase) : null;
}

/** 跳过原因只在「无装载实例且该行不是 disabled 占名行」时有值。 */
function skipReasonFor(skipReasons: Map<string, string>, key: string, rawName: string, state: ProjectServerState | undefined, row: PatchRow): string | undefined {
  if (state !== undefined || row.disabled === true) return undefined;
  return skipReasons.get(key + "\u0000" + rawName);
}

/**
 * 多来源行按优先序合并（数组顺序=优先序，先到先得；后到重复行为被遮蔽）。
 * 三把遮蔽键同时先到先得：精确原名、归一名（normalizedNameKey）、服务身份
 * （serviceIdentityKey）。disabled 占名行照样注册三键——给低层行提供
 * 「占名退出」手段，但本身不进 rows。
 * shadowedOwnCc：被项目 yml 遮蔽的项目 .mcp.json 行；shadowedUser：被任一项目
 * 自身行遮蔽的用户层行（含身份/归一名命中）；shadowedGlobal：被另一条用户层行
 * 遮蔽的用户层行；shadowedIdentity：被归一名或身份键去重剔除的行明细（带两侧
 * 来源，供归因过滤）。纯函数，供测试。
 */
export function mergeSourcedRows(candidates: SourcedRow[][]): {
  rows: DesiredProjectRow[];
  shadowedOwnCc: string[];
  shadowedUser: string[];
  shadowedGlobal: GlobalShadow[];
  shadowedIdentity: IdentityShadow[];
} {
  const byName = new Map<string, SourcedRow>();
  const byNorm = new Map<string, SourcedRow>();
  const byIdentity = new Map<string, SourcedRow>();
  const buckets: ShadowBuckets = { shadowedOwnCc: [], shadowedUser: [], shadowedGlobal: [], shadowedIdentity: [] };
  for (const list of candidates) {
    for (const item of list) mergeOneRow(item, byName, byNorm, byIdentity, buckets);
  }
  return {
    rows: [...byName.values()]
      .filter((item) => item.disabled !== true)
      .map((item) => ({ rawName: item.rawName, row: item.row, source: item.source })),
    shadowedOwnCc: buckets.shadowedOwnCc,
    shadowedUser: buckets.shadowedUser,
    shadowedGlobal: buckets.shadowedGlobal,
    shadowedIdentity: buckets.shadowedIdentity
  };
}

export interface DiagUnhealthy {
  name: string;
  reason: string;
}

/** 对账结束后写入诊断文件的摘要段（`.mcp-diag.json` 的 `summary`）。 */
export interface DiagSummary {
  at: string;
  projects?: number;
  rows: number;
  mounted: number;
  skippedByReason: Record<string, number>;
  unhealthy: DiagUnhealthy[];
}

export interface DiagDocument {
  summary?: DiagSummary;
  events: Record<string, unknown>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 兼容旧版纯数组诊断文件：数组 → `{ events }`；对象取 `summary` + `events`。 */
export function parseDiagDocument(raw: unknown): DiagDocument {
  if (Array.isArray(raw)) return { events: raw.filter(isRecord) };
  if (!isRecord(raw)) return { events: [] };
  const events = Array.isArray(raw.events) ? raw.events.filter(isRecord) : [];
  const summary = parseDiagSummary(raw.summary);
  return summary === undefined ? { events } : { summary, events };
}

function parseDiagSummary(raw: unknown): DiagSummary | undefined {
  if (!isRecord(raw) || typeof raw.at !== "string" || typeof raw.rows !== "number" || typeof raw.mounted !== "number") return undefined;
  const skippedByReason: Record<string, number> = {};
  if (isRecord(raw.skippedByReason)) {
    for (const [key, value] of Object.entries(raw.skippedByReason)) {
      if (typeof value === "number") skippedByReason[key] = value;
    }
  }
  const unhealthy: DiagUnhealthy[] = [];
  if (Array.isArray(raw.unhealthy)) {
    for (const item of raw.unhealthy) {
      if (isRecord(item) && typeof item.name === "string" && typeof item.reason === "string") {
        unhealthy.push({ name: item.name, reason: item.reason });
      }
    }
  }
  return {
    at: raw.at,
    ...(typeof raw.projects === "number" ? { projects: raw.projects } : {}),
    rows: raw.rows,
    mounted: raw.mounted,
    skippedByReason,
    unhealthy
  };
}

/**
 * 项目级 MCP 注册表：文件监听、装载/卸载、按会话 deny 重扫、状态快照。
 */
export class ProjectMcpRegistry {
  private readonly ctx: any;
  private readonly providers: ProjectMcpRegistryOptions;

  /** projectKey → 项目条目（含已装载服务器）。 */
  private readonly projects = new Map<string, ProjectEntry>();
  /** 全局（用户层）已装载服务器：rawName → state，宿主级只挂一条。 */
  private readonly globalServers = new Map<string, ProjectServerState>();
  /** projectKey → 被该项目自身行遮蔽的全局行原名（按会话 deny 用）。 */
  private readonly suppressedGlobals = new Map<string, Set<string>>();
  /** projectKey → 最近一次生效名目录（key = projectKey + "\0" + rawName）。 */
  private effective = new Map<string, string>();
  /** agent id → 其会话项目 key（undefined 表示无项目）。 */
  private readonly agentProjects = new Map<string, string | undefined>();
  /** agent id → 当前 restrict 的 disposer。 */
  private readonly restrictions = new Map<string, () => void>();

  private watcher?: ReturnType<typeof chokidar.watch>;
  private watchedFiles: string[] = [];
  /** 用户层 watcher 当前盯的精确文件路径集合。 */
  private userWatcher?: ReturnType<typeof chokidar.watch>;
  private userWatchedPaths: string[] = [];
  /** 装载被跳过的行（key\0rawName → 原因）；快照按独立 skipReason 字段展示，fiberPhase 保持枚举。 */
  private readonly skipReasons = new Map<string, string>();
  /** 最近一次用户层读取结果（reconcile 与 snapshot 共享；首轮 reconcile 前为空）。 */
  private userLayer: {
    mcpYml: string;
    mcpJson: string;
    profileJson: string | null;
    ymlRows: SourcedRow[];
    ymlError: string | null;
    jsonRows: SourcedRow[];
    jsonError: string | null;
    profileRows: SourcedRow[];
    profileError: string | null;
  } = {
    mcpYml: "",
    mcpJson: "",
    profileJson: null,
    ymlRows: [],
    ymlError: null,
    jsonRows: [],
    jsonError: null,
    profileRows: [],
    profileError: null
  };
  /** 当前 profile 名（activeProfile provider 的最近一次解析结果）。 */
  private activeProfileName: string | undefined;
  private reconcileCount = 0;
  /** identity 去重告警/诊断的变更门控：projectKey → 上次对账的剔除集签名。 */
  private readonly identityShadowSigs = new Map<string, string>();
  /**
   * 告警变更门控：门控键 → 上次告警的签名。签名不变就沉默——否则任何文件事件
   * 都会让每类告警重刷一遍（规模 = 对账次数 × 项目数 × 坏条目数）。
   * 键前缀区分关注点：`entries\0<path|projectKey>`、`blocked\0global`、`gshadow\0global`。
   */
  private readonly warnGates = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  /** 配置文件读取次数（scan / 用户层；测试用指纹跳过断言）。 */
  private configReadCount = 0;
  /** 上一轮对账入口的配置文件指纹；全同则跳过重读。 */
  private lastFingerprintSig = "";
  /** watcher 文件事件代数：agent/巡检触发的对账可跳过重读，文件事件必须重读。 */
  private configEpoch = 0;
  private lastFingerprintEpoch = -1;
  /** 上一轮 scanProject 的期望行（指纹未变时复用）。 */
  private lastScanDesired = new Map<string, { projectRoot: string; rows: DesiredProjectRow[] }>();
  /** 装载行的健康巡检内存（unmount 会删掉 ProjectServerState，不能只挂在 state 上）。 */
  private readonly healthByMount = new Map<string, { everHadTools: boolean; remountCount: number; nextRemountAt: number; givenUp: boolean }>();

  constructor(ctx: any, providers: ProjectMcpRegistryOptions) {
    this.ctx = ctx;
    this.providers = providers;

    ctx.on("agent/created", ({ agent }: any) => {
      if (agent === undefined) return;
      this.enqueue(async () => {
        this.agentProjects.set(agent.id, await this.resolveProject(agent));
        await this.reconcileAll();
      });
    });
    ctx.on("agent/disposed", ({ agent }: any) => {
      if (agent === undefined) return;
      this.releaseAgent(agent);
    });
    // 会话生命周期开始（含恢复/重挂的会话）也补扫一次，覆盖启动时序缺口。
    ctx.on("agent/session-start", ({ agent }: any) => {
      if (agent === undefined) return;
      this.enqueue(async () => {
        this.agentProjects.set(agent.id, await this.resolveProject(agent));
        await this.reconcileAll();
      });
    });

    // 插件热更重载时已存在的会话也要覆盖。
    this.enqueue(async () => {
      for (const agent of this.liveAgents()) {
        this.agentProjects.set(agent.id, await this.resolveProject(agent));
      }
      await this.reconcileAll();
    });

    ctx.effect(() => () => {
      this.disposed = true;
      if (this.timer !== undefined) clearTimeout(this.timer);
      if (this.watcher !== undefined) void this.watcher.close().catch(() => {});
      if (this.userWatcher !== undefined) void this.userWatcher.close().catch(() => {});
      for (const disposer of this.restrictions.values()) {
        try {
          disposer();
        } catch {
          // agent 已销毁时 disposer 可能已失效
        }
      }
      this.restrictions.clear();
      for (const entry of this.projects.values()) {
        for (const state of entry.servers.values()) {
          try {
            state.fiber?.dispose();
          } catch {
            // fiber 随插件 ctx 一并销毁
          }
        }
      }
      this.projects.clear();
      for (const state of this.globalServers.values()) {
        try {
          state.fiber?.dispose();
        } catch {
          // fiber 随插件 ctx 一并销毁
        }
      }
      this.globalServers.clear();
      this.suppressedGlobals.clear();
    }, "dsh-project-mcp-manager: project mcp registry");
  }

  // ── 串行化与调度 ─────────────────────────────────────────────────────

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private kick() {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.enqueue(async () => {
        await this.reconcileAll();
      }).catch(() => {});
    }, 150);
  }

  /**
   * 变更门控告警：签名与上次相同则不 emit；空签名表示「该 scope 无异常」，清掉门控
   * （下次再出现同样的问题仍会告警一次）。
   */
  private warnGated(key: string, signature: string, emit: () => void): void {
    const previous = this.warnGates.get(key);
    if (signature === "") this.warnGates.delete(key);
    else this.warnGates.set(key, signature);
    if (signature !== previous) emit();
  }

  private liveAgents(): any[] {
    try {
      const list = this.ctx.agents?.list?.();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  // ── 项目发现与文件监听 ──────────────────────────────────────────────

  private async knownProjects(): Promise<string[]> {
    const map = new Map<string, string>();
    const add = async (raw: string) => {
      if (typeof raw !== "string" || raw === "") return;
      try {
        const project = await findProjectRoot(raw);
        map.set(projectKeyOf(project), project);
      } catch {
        // 目录不可解析：忽略
      }
    };
    // 项目发现：在线会话 cwd + 进程 cwd（dsh 启动目录）+ 已装载项目。
    for (const agent of this.liveAgents()) {
      const cwd = agent?.session?.header?.cwd;
      if (typeof cwd === "string" && cwd !== "") await add(cwd);
    }
    try {
      await add(process.cwd());
    } catch {
      // 启动目录不可解析：忽略
    }
    for (const [key, entry] of this.projects) map.set(key, entry.projectRoot);
    return [...map.values()];
  }

  private async syncWatcher() {
    const roots = await this.knownProjects();
    const keys = roots.map((root) => projectKeyOf(root));
    keys.sort(byCodeUnit);
    const same = this.watchedFiles.length === keys.length && keys.every((key, index) => key === this.watchedFiles[index]);
    if (same) return;
    const old = this.watcher;
    this.watcher = undefined;
    if (old !== undefined) await old.close().catch(() => {});
    this.watchedFiles = keys;
    if (keys.length === 0) return;
    // chokidar 不会监听尚不存在的嵌套文件：改为监听项目根（depth 2 覆盖
    // .dsh/mcp.yml），事件回调里按精确路径过滤。
    const watcher = chokidar.watch(roots, {
      ignoreInitial: true,
      depth: 2,
      ignored: (candidate: string) => {
        const parts = candidate.split(/[/\\]/);
        return parts.some((part) => part === "node_modules" || part === ".git" || part === ".hg" || part === ".svn");
      }
    });
    // .mcp.json 与 .dsh/mcp.yml、.dsh/mcp.json 平级热重载：都按「已知项目根下的
    // 精确文件」比对，项目树里其它位置的同名文件（嵌套子目录的 .dsh/mcp.yml 等）不误触发。
    const ccFiles = new Set(roots.map((root) => normalizePathKey(projectMcpJsonFile(root))));
    const ymlFiles = new Set(roots.map((root) => normalizePathKey(projectMcpFile(root))));
    const jsonFiles = new Set(roots.map((root) => normalizePathKey(projectDshJsonFile(root))));
    const kick = (path: string) => {
      const key = normalizePathKey(path);
      if (ymlFiles.has(key) || jsonFiles.has(key) || (ccFiles.has(key) && mcpJsonLayerEnabled())) {
        this.configEpoch += 1;
        this.kick();
      }
    };
    watcher.on("add", kick);
    watcher.on("change", kick);
    watcher.on("unlink", kick);
    watcher.on("error", () => {
      // 保持监听；下一次事件仍会触发 reconcile
    });
    this.watcher = watcher;
  }

  // ── 用户层（~/.dsh/mcp.yml、~/.dsh/mcp.json、~/.dsh/profiles/<p>/mcp.json）──

  /** 用户层三个来源文件路径：缺省跟随 dshHome（`$DSH_HOME` 优先），注入项逐键覆盖。 */
  private resolveUserLayerPaths(): UserLayerPaths {
    const defaults = userLayerPathsIn(dshHomeDir());
    const provided = this.providers.userLayerPaths;
    return provided === undefined ? defaults : { ...defaults, ...provided };
  }

  /** 原生受管块文件通用读取（项目 yml 与用户层 yml 共用）。 */
  private async readNativeRows(path: string, source: McpRowSource, hasYmlMounts: boolean): Promise<{ rows: SourcedRow[]; ok: boolean; error: string | null }> {
    let rows: SourcedRow[] = [];
    let ok = true;
    let error: string | null = null;
    try {
      this.noteConfigRead();
      const raw = await readPatchFile(path);
      for (const row of extractManagedRows(raw)) {
        const rawName = rowNameOf(row);
        // disabled 行不跳过：带着占位旗进合并——显式禁用应同时遮蔽下层同名，
        // 否则「关掉 yml 行」会意外改去装载 .mcp.json 副本。
        if (rawName !== undefined) rows.push({ rawName, row, source, disabled: row.disabled === true });
      }
    } catch (catchError) {
      const message = catchError instanceof Error ? catchError.message : String(catchError);
      // 「配置文件不存在」(ENOENT) 只有在该项目确实有活着的 yml 来源装载时才算异常——
      // 意味着文件在装载之后被删/移走。零配置项目缺文件是常态：不能用
      // projects.has(key) 当判据，空项目条目也会让它恒真（误报根因）。
      // hasYmlMounts 同样不能拿 servers.size 充数——用户层行也占装载实例，
      // 纯用户层挂载的项目缺 yml 依旧常态（与 snapshot 的 ymlLive 同一判据）。
      if (hasYmlMounts || !message.includes("ENOENT")) {
        ok = false;
        error = message;
      }
      rows = [];
    }
    return { rows, ok, error };
  }

  /**
   * 读用户层三个来源并刷新缓存：profile JSON（profile 名可解析时）、用户 yml、用户 JSON。
   * 坏条目/文件级错误只告警（无项目归属，不进逐项目 diag）。
   */
  /**
   * 当前 profile 名，并挡下不能安全拼进 profiles 目录的值：`DSH_MCP_PROFILE`
   * 是外部输入，`../../somewhere` 会让 join 读到 profiles 目录之外。
   * 不合法按「解析不出」降级（不读 profile 层），并按门控告警一次。
   */
  private async resolveActiveProfileName(): Promise<string | undefined> {
    if (this.providers.activeProfile === undefined) return undefined;
    // Promise.resolve 包一层：注入的 activeProfile 若同步抛错，裸 .catch 会先 TypeError。
    const resolved = await Promise.resolve(this.providers.activeProfile()).catch(() => undefined);
    if (resolved === undefined) return undefined;
    if (isValidProfileName(resolved)) {
      this.warnGated("profile\u0000name", "", () => {});
      return resolved;
    }
    this.warnGated("profile\u0000name", resolved, () => {
      this.ctx.logger.warn(`profile 名 ${JSON.stringify(resolved)} 不合法（只允许字母数字开头，其后字母数字与 . _ -），已跳过 profile 用户层；请检查 ${PROFILE_ENV} 或宿主 profile 路径`);
    });
    return undefined;
  }

  private async readUserLayer(): Promise<void> {
    const paths = this.resolveUserLayerPaths();
    this.activeProfileName = await this.resolveActiveProfileName();
    const yml = await this.readNativeRows(paths.mcpYml, "dsh-user-yml", false);
    this.noteConfigRead();
    const json = await readDshJsonFile(paths.mcpJson, { source: "dsh-user", cwdPolicy: "host", projectRoot: "" });
    const profileJson = this.activeProfileName === undefined ? null : profileMcpJsonFile(paths.profilesDir, this.activeProfileName);
    const profile: JsonReadResult = profileJson === null
      ? { rows: [], entryErrors: [] }
      : (this.noteConfigRead(), await readDshJsonFile(profileJson, { source: "dsh-profile-user", cwdPolicy: "host", projectRoot: "" }));
    this.userLayer = {
      mcpYml: paths.mcpYml,
      mcpJson: paths.mcpJson,
      profileJson,
      ymlRows: yml.rows,
      ymlError: yml.error,
      jsonRows: json.rows,
      jsonError: json.fileError ?? null,
      profileRows: profile.rows,
      profileError: profile.fileError ?? null
    };
    // 告警按「文件 + 问题集合」门控：同一个坏条目不随每次文件事件重刷。
    this.warnFileIssues(paths.mcpYml, `用户层 MCP（${paths.mcpYml}）`, yml.error ?? undefined, []);
    this.warnFileIssues(paths.mcpJson, `用户层 MCP（${paths.mcpJson}）`, json.fileError, jsonIssueNotes(json));
    if (profileJson !== null) this.warnFileIssues(profileJson, `用户层 MCP（${profileJson}）`, profile.fileError, jsonIssueNotes(profile));
    if (json.formatHint !== undefined) {
      await this.writeGlobalDiag({ kind: "foreign-format", path: paths.mcpJson, message: json.formatHint });
    }
    const foreignPath = foreignUserMcpJsonFile(dirname(paths.mcpJson));
    if (!isSameFilePath(foreignPath, paths.mcpJson)) {
      this.noteConfigRead();
      const foreign = await readDshJsonFile(foreignPath, { source: "dsh-user", cwdPolicy: "host", projectRoot: "" });
      this.warnFileIssues(foreignPath, `用户层 MCP（${foreignPath}）`, foreign.fileError, jsonIssueNotes(foreign));
      if (foreign.formatHint !== undefined) {
        await this.writeGlobalDiag({ kind: "foreign-format", path: foreignPath, message: foreign.formatHint });
      }
    }
  }

  /**
   * 一个配置文件的文件级错误 + 坏条目告警（门控：集合不变则沉默）。
   * gateKey 只用于门控归属（不出现在文案里），label 是完整的告警前缀。
   */
  private warnFileIssues(gateKey: string, label: string, fileError: string | undefined, entryErrors: string[]): void {
    const notes = [...(fileError === undefined ? [] : [fileError]), ...entryErrors];
    this.warnGated("entries\u0000" + gateKey, notes.join("\u0001"), () => {
      for (const note of notes) this.ctx.logger.warn(`${label}：${note}`);
    });
  }

  /**
   * 监听用户层具体文件（与项目层的精确路径过滤同构；不监视家目录递归：
   * 探针实测 chokidar v5 盯「父目录已存在的缺失文件」能在创建时补发 add，而盯
   * 不存在的目录则永久瞎——具体文件路径是更稳的监听形态）。
   */
  private async syncUserWatcher(): Promise<void> {
    const paths = this.resolveUserLayerPaths();
    const targets = [paths.mcpYml, paths.mcpJson, ...(this.userLayer.profileJson === null ? [] : [this.userLayer.profileJson])];
    // 排序只用于跨轮次相等性比较，须与 locale 无关保持稳定：统一走 byCodeUnit
    // （UTF-16 码元序，与 Array#sort 默认逐字节等价，不经 locale collator），
    // 比较器显式化是静态分析要求，也是本仓的排序口径声明。
    const keys = targets.map((target) => normalizePathKey(target));
    keys.sort(byCodeUnit);
    const same = this.userWatchedPaths.length === keys.length && keys.every((key, index) => key === this.userWatchedPaths[index]);
    if (same) return;
    const old = this.userWatcher;
    this.userWatcher = undefined;
    if (old !== undefined) await old.close().catch(() => {});
    this.userWatchedPaths = keys;
    if (keys.length === 0 || this.disposed) return;
    const watcher = chokidar.watch(targets, {
      ignoreInitial: true,
      depth: 0
    });
    const watched = new Set(keys);
    const onEvent = (path: string) => {
      if (watched.has(normalizePathKey(path))) {
        this.configEpoch += 1;
        this.kick();
      }
    };
    watcher.on("add", onEvent);
    watcher.on("change", onEvent);
    watcher.on("unlink", onEvent);
    watcher.on("error", () => {
      // 保持监听；错误不炸宿主
    });
    this.userWatcher = watcher;
  }

  private noteConfigRead(): void {
    this.configReadCount += 1;
  }

  private nowMs(): number {
    return this.providers.now?.() ?? Date.now();
  }

  private remountBackoffMs(): number {
    return this.providers.healthRemountBackoffMs ?? HEALTH_REMOUNT_BACKOFF_MS;
  }

  private remountLimit(): number {
    return this.providers.healthRemountLimit ?? HEALTH_REMOUNT_LIMIT;
  }

  private async statConfigFile(path: string): Promise<{ mtimeMs: number; size: number } | "missing"> {
    try {
      if (this.providers.statFile !== undefined) {
        const injected = await this.providers.statFile(path);
        if (injected === null) return "missing";
        return injected;
      }
      const info = await stat(path);
      return { mtimeMs: info.mtimeMs, size: info.size };
    } catch {
      return "missing";
    }
  }

  /** 已知项目的 3 个配置路径 + 用户层 3 路径（及对方全局文件）的 mtimeMs+size 指纹。 */
  private async configFingerprintSignature(roots: string[]): Promise<string> {
    const paths = new Set<string>();
    for (const root of roots) {
      paths.add(normalizePathKey(projectMcpFile(root)));
      paths.add(normalizePathKey(projectDshJsonFile(root)));
      paths.add(normalizePathKey(projectMcpJsonFile(root)));
    }
    const user = this.resolveUserLayerPaths();
    paths.add(normalizePathKey(user.mcpYml));
    paths.add(normalizePathKey(user.mcpJson));
    const profileName = this.activeProfileName ?? await this.resolveActiveProfileName();
    if (profileName !== undefined) paths.add(normalizePathKey(profileMcpJsonFile(user.profilesDir, profileName)));
    paths.add(normalizePathKey(foreignUserMcpJsonFile(dirname(user.mcpJson))));
    const files = [...paths];
    files.sort(byCodeUnit);
    const parts: string[] = [
      `cc=${mcpJsonLayerEnabled() ? "1" : "0"}`,
      `profile=${profileName ?? ""}`
    ];
    for (const file of files) {
      const fp = await this.statConfigFile(file);
      parts.push(fp === "missing" ? `${file}:missing` : `${file}:${Math.round(fp.mtimeMs)}:${fp.size}`);
    }
    return parts.join("\n");
  }

  private async shouldSkipConfigReread(roots: string[]): Promise<boolean> {
    if (this.lastFingerprintSig === "") return false;
    if (this.configEpoch !== this.lastFingerprintEpoch) return false;
    for (const entry of this.projects.values()) {
      const hasYmlMounts = [...entry.servers.values()].some((state) => state.source === "dsh-project" || state.source === undefined);
      if (!hasYmlMounts) continue;
      if (await this.statConfigFile(projectMcpFile(entry.projectRoot)) === "missing") return false;
    }
    return await this.configFingerprintSignature(roots) === this.lastFingerprintSig;
  }

  // ── 核心 reconcile ───────────────────────────────────────────────────

  /**
   * 全量对账：重算项目集合 → 读全部项目文件 → 计算生效名 → 逐项目装载/
   * 卸载 → 重扫各会话 deny。文件事件、新 agent、插件热更都汇到这里。
   */
  async reconcileAll(): Promise<void> {
    if (this.disposed) return;
    this.reconcileCount++;
    const roots = await this.knownProjects();
    const skipReread = await this.shouldSkipConfigReread(roots);
    if (!skipReread) {
      await this.readUserLayer();
    }
    await this.syncWatcher();
    await this.syncUserWatcher();

    const globalMerged = mergeSourcedRows([this.userLayer.profileRows, this.userLayer.ymlRows, this.userLayer.jsonRows]);
    const hostGlobalNames = await this.providers.globalNames().catch(() => []);
    const hostTaken = new Set(hostGlobalNames);
    const globalMountable = new Set(globalMerged.rows.map((row) => row.rawName).filter((rawName) => !hostTaken.has(rawName)));

    const desiredByProject = new Map<string, { projectRoot: string; rows: DesiredProjectRow[] }>();
    if (skipReread) {
      for (const projectRoot of roots) {
        const key = projectKeyOf(projectRoot);
        const cached = this.lastScanDesired.get(key);
        if (cached !== undefined) desiredByProject.set(key, cached);
        else desiredByProject.set(key, await this.scanProject(projectRoot, globalMountable));
      }
    } else {
      for (const projectRoot of roots) {
        desiredByProject.set(projectKeyOf(projectRoot), await this.scanProject(projectRoot, globalMountable));
      }
      this.lastScanDesired = new Map(desiredByProject);
      this.lastFingerprintSig = await this.configFingerprintSignature(roots);
      this.lastFingerprintEpoch = this.configEpoch;
    }
    await this.reportGlobalShadows(globalMerged.shadowedGlobal, globalMerged.shadowedIdentity);

    const catalogProjects = [...desiredByProject.values()].map((entry) => ({
      projectRoot: entry.projectRoot,
      names: entry.rows.map((row) => row.rawName)
    }));
    const globalNames = [...hostGlobalNames, ...globalMerged.rows.map((row) => row.rawName)];
    this.effective = effectiveServerNames(catalogProjects, globalNames);

    for (const [key, entry] of desiredByProject) {
      await this.reconcileProject(key, entry);
    }
    await this.reconcileGlobals(globalMerged.rows, hostGlobalNames);
    this.prunePerProjectState(new Set(desiredByProject.keys()));
    await this.remountUnhealthy();
    await this.sweepRestrictions();
    await this.writeSummaries();
  }

  /**
   * 单个项目的扫描：读三个项目层来源 → 与用户层行合并 → 记诊断/告警 → 返回该项目
   * 的期望行。项目侧压制集合（suppressedGlobals）在这里落库，只收「本轮真会全局
   * 装载的名字」。
   */
  private async scanProject(projectRoot: string, globalMountable: Set<string>): Promise<{ projectRoot: string; rows: DesiredProjectRow[] }> {
    const key = projectKeyOf(projectRoot);
    const userPaths = this.resolveUserLayerPaths();
    // 只数 yml 来源的装载实例：用户层行同样落在 entry.servers 里，拿总数
    // 会把「纯用户层挂载」误判成「yml 装载后文件被删」，产生假 ENOENT 诊断。
    const hasYmlMounts = [...(this.projects.get(key)?.servers.values() ?? [])].some((state) => state.source === "dsh-project" || state.source === undefined);
    // 家目录（或 DSH_HOME 所在目录）本身就是已知项目时，<home>/.dsh/mcp.yml|json
    // 与用户层文件是同一份文件：项目层必须跳过，否则同一行会被挂两次
    // （全局一条 + 该项目一条 p<hash>_…）。
    const ymlPath = projectMcpFile(projectRoot);
    const jsonPath = projectDshJsonFile(projectRoot);
    const yml = isSameFilePath(ymlPath, userPaths.mcpYml)
      ? { rows: [], ok: true, error: null }
      : await this.readNativeRows(ymlPath, "dsh-project", hasYmlMounts);
    const projectJson: JsonReadResult = isSameFilePath(jsonPath, userPaths.mcpJson)
      ? { rows: [], entryErrors: [] }
      : (this.noteConfigRead(), await readDshJsonFile(jsonPath, { source: "dsh-project-json", cwdPolicy: "project", projectRoot }));
    const cc: JsonReadResult = mcpJsonLayerEnabled()
      ? (this.noteConfigRead(), await readMcpJsonFile(projectMcpJsonFile(projectRoot), projectRoot))
      : { rows: [], entryErrors: [] };
    // 影子优先级：.dsh/mcp.yml > .dsh/mcp.json > .mcp.json > profile json > 用户 yml > 用户 json。
    const merged = mergeSourcedRows([yml.rows, projectJson.rows, cc.rows, this.userLayer.profileRows, this.userLayer.ymlRows, this.userLayer.jsonRows]);
    // 归因过滤：纯用户层之间的重复定义与本项目无关（否则零配置项目也会被写
    // .dsh/.mcp-diag.json、各刷一遍同样的告警），只保留至少一侧是项目层行的条目。
    const identityShadows = merged.shadowedIdentity.filter((shadow) => isProjectLayerSource(shadow.source) || isProjectLayerSource(shadow.winnerSource));
    // 跨来源同服务去重告警：unityMCP 与 unity-mcp 这类「一个服务器两个名字」的
    // 冗余定义，只装载高优先级层一条，被剔除的必须可见，不能静默消失。
    const shadowChanged = this.warnIdentityShadows(key, projectRoot, identityShadows);
    const ownRows = merged.rows.filter((row) => isProjectLayerSource(row.source));
    // 项目侧压制：被本项目自身行遮蔽的全局行，在本会话 deny 掉（全局实例仍只挂一条）。
    // 只收本轮真会全局装载的名字：disabled 占名行与被宿主 patch 拒掉的名字都不会
    // 产生全局实例，deny 它们只会命中项目自己（或宿主 patch）的同名工具。
    const suppressed = new Set(merged.shadowedUser.filter((rawName) => globalMountable.has(rawName)));
    this.suppressedGlobals.set(key, suppressed);
    // 诊断只记有信息量的扫描：异常，或确实解析出了项目自身配置行。干净且无配置的
    // 项目不写任何记录——用户层行落到每个项目不算该项目的事件。
    const diag = buildScanDiag({ yml, projectJson, cc, ownRows, shadowedOwnCc: merged.shadowedOwnCc, suppressed, identityShadows, shadowChanged });
    if (diag !== null) await this.writeDiag(projectRoot, diag);
    this.warnFileIssues(key + "\u0000json", `项目 MCP（.dsh/${JSON_MCP_FILE}，${projectRoot}）`, projectJson.fileError, jsonIssueNotes(projectJson));
    this.warnFileIssues(key + "\u0000cc", `项目 MCP（${CC_PROJECT_FILE}，${projectRoot}）`, cc.fileError, jsonIssueNotes(cc));
    // 源级隔离：某个源坏了只清空该源的 rows（读取器已保证），其余源照常进
    // desired。绝不能整项目一票否决——那会把坏文件的代价转嫁给好文件的行。
    // 项目容器只装项目层行；用户层行由全局容器装载（见 reconcileGlobals）。
    return { projectRoot, rows: ownRows };
  }

  /**
   * 项目层同服务剔除的告警 + 变更门控：剔除集与上次一致就沉默——否则任何文件
   * 事件都会让每个已知项目各刷一遍同样的告警（规模 = 对账次数 × 项目数 × 重复
   * 行数）。返回 shadowChanged 供 scan 诊断写入条件（buildScanDiag）使用。
   */
  private warnIdentityShadows(key: string, projectRoot: string, identityShadows: IdentityShadow[]): boolean {
    const shadowSig = identityShadowSignature(identityShadows);
    const prevShadowSig = this.identityShadowSigs.get(key);
    const shadowChanged = shadowSig !== prevShadowSig;
    if (shadowSig === "") this.identityShadowSigs.delete(key);
    else this.identityShadowSigs.set(key, shadowSig);
    if (shadowChanged) {
      for (const shadow of identityShadows) {
        this.ctx.logger.warn(`项目 MCP（${projectRoot}）：跳过重复服务定义 "${shadow.name}"（与 "${shadow.winner}" 为同一服务，${shadow.reason === "normname" ? "归一化名称相同" : "命令与参数相同"}，按层优先级保留高优先级定义）；确属不同服务器请改名或调整命令与参数`);
      }
    }
    return shadowChanged;
  }

  /**
   * 用户层内部遮蔽的全局归因：同名（shadowedGlobal）与同服务/归一名
   * （shadowedIdentity 的两侧都是用户层）都只告警一次并写全局诊断。
   * 此前同名遮蔽零可见性、同服务遮蔽按项目重复归因。
   */
  private async reportGlobalShadows(shadowedGlobal: GlobalShadow[], shadowedIdentity: IdentityShadow[]): Promise<void> {
    const identityGlobal = shadowedIdentity.filter((shadow) => !isProjectLayerSource(shadow.source) && !isProjectLayerSource(shadow.winnerSource));
    const signature = globalShadowSignature(shadowedGlobal) + "\u0002" + identityShadowSignature(identityGlobal);
    let changed = false;
    this.warnGated("gshadow\u0000global", shadowedGlobal.length === 0 && identityGlobal.length === 0 ? "" : signature, () => {
      changed = true;
      for (const shadow of shadowedGlobal) {
        this.ctx.logger.warn(`全局用户层 MCP "${shadow.name}"（${shadow.source}）未装载：同名服务器已由更高优先层 ${shadow.winnerSource} 的 "${shadow.winner}" 占用`);
      }
      for (const shadow of identityGlobal) {
        this.ctx.logger.warn(`全局用户层 MCP：跳过重复服务定义 "${shadow.name}"（${shadow.source}，与 ${shadow.winnerSource} 的 "${shadow.winner}" 为同一服务，${shadow.reason === "normname" ? "归一化名称相同" : "命令与参数相同"}）；确属不同服务器请改名或调整命令与参数`);
      }
    });
    if (changed && (shadowedGlobal.length > 0 || identityGlobal.length > 0)) {
      await this.writeGlobalDiag({
        kind: "shadow",
        ...(shadowedGlobal.length > 0 ? { shadowedByHigherLayer: shadowedGlobal } : {}),
        ...(identityGlobal.length > 0 ? { shadowedIdentity: identityGlobal } : {})
      });
    }
  }

  /** 逐项目状态表按本轮已知项目剪枝（projects 的保留是有意为之，见 reconcileProject）。 */
  private prunePerProjectState(knownKeys: Set<string>): void {
    for (const key of this.suppressedGlobals.keys()) {
      if (!knownKeys.has(key)) this.suppressedGlobals.delete(key);
    }
    for (const key of this.identityShadowSigs.keys()) {
      if (!knownKeys.has(key)) this.identityShadowSigs.delete(key);
    }
  }

  private async reconcileProject(key: string, entry: { projectRoot: string; rows: DesiredProjectRow[] }) {
    let project = this.projects.get(key);
    if (project === undefined) {
      // 只为「确实有行要装载」的项目建条目：否则会话/进程访问过的每个目录都会
      // 永久留在 projects 里（knownProjects 会一直把它带上），零配置项目也就
      // 不该算作已知项目。已有条目保留，用于卸载后仍能在快照里看到该文件。
      if (entry.rows.length === 0) return;
      project = { projectRoot: entry.projectRoot, servers: new Map() };
      this.projects.set(key, project);
    }
    await this.reconcileContainer(this.projectContainer(key, project), entry.rows);
  }

  /** 全局（用户层）对账：与项目数量无关，宿主级只挂一条连接。 */
  private async reconcileGlobals(rows: DesiredProjectRow[], hostGlobalNames: string[]): Promise<void> {
    const taken = new Set(hostGlobalNames);
    const desired: DesiredProjectRow[] = [];
    const blocked = new Set<string>();
    for (const row of rows) {
      if (taken.has(row.rawName)) {
        // 宿主 patch 行已占用同名 serverName：跳过而不是改名，避免与全局 patch 行冲突。
        blocked.add(row.rawName);
        continue;
      }
      desired.push(row);
    }
    // 告警门控：blocked 集合不变就沉默（skipReasons 照写，快照始终能看到原因）。
    const blockedNames = [...blocked];
    blockedNames.sort(byCodeUnit);
    for (const rawName of blockedNames) {
      this.skipReasons.set(GLOBAL_SCOPE_KEY + "\u0000" + rawName, "name-taken");
    }
    this.warnGated("blocked\u0000global", blockedNames.join("\u0000"), () => {
      for (const rawName of blockedNames) {
        this.ctx.logger.warn(`全局用户层 MCP "${rawName}" 未装载：同名服务器已由宿主全局 patch 行（bundle 层或 profile patch 层）占用；请改名或从用户层移除`);
      }
    });
    await this.reconcileContainer(this.globalMountContainer(), desired, blocked);
  }

  private globalMountContainer(): MountContainer {
    return {
      scope: "global",
      key: GLOBAL_SCOPE_KEY,
      projectRoot: "",
      servers: this.globalServers,
      isCurrent: (state) => this.globalServers.get(state.rawName) === state,
      effectiveNameOf: (rawName) => rawName,
      diag: (event) => this.writeGlobalDiag(event),
      label: "全局用户层 MCP"
    };
  }

  private projectContainer(key: string, project: ProjectEntry): MountContainer {
    return {
      scope: "project",
      key,
      projectRoot: project.projectRoot,
      servers: project.servers,
      isCurrent: (state) => this.projects.get(key) === project && project.servers.get(state.rawName) === state,
      effectiveNameOf: (rawName) => this.effective.get(key + "\u0000" + rawName),
      diag: (event) => this.writeDiag(project.projectRoot, event),
      label: `项目 MCP（${project.projectRoot}）`
    };
  }

  /** 装载容器的通用对账（项目层与全局层共用）：算变更计划 → 卸载 → 装载。 */
  private async reconcileContainer(container: MountContainer, desired: DesiredProjectRow[], blocked: Set<string> = new Set()): Promise<void> {
    const current = [...container.servers.values()].map((state) => ({ rawName: state.rawName, effectiveName: state.effectiveName, row: state.row }));
    // 全局行保持原名：生效名映射就地合成，避免污染项目生效名表。
    const effectiveMap = container.scope === "global"
      ? new Map(desired.map((item) => [GLOBAL_SCOPE_KEY + "\u0000" + item.rawName, item.rawName]))
      : this.effective;
    const plan = planProjectChanges(current, desired, effectiveMap, container.key);
    // 清理死键：从未挂上（被跳过）的行若从文件里删掉，既不在 toMount 也不在
    // toUnmount，其 skipReasons 标记没人再触碰——按当前 desired 集合剪掉。
    // blocked（撞名被拒）的行保留其标记，供快照展示 skipReason。
    const desiredNames = new Set([...desired.map((item) => item.rawName), ...blocked]);
    const markPrefix = container.key + "\u0000";
    for (const markKey of this.skipReasons.keys()) {
      if (markKey.startsWith(markPrefix) && !desiredNames.has(markKey.slice(markPrefix.length))) this.skipReasons.delete(markKey);
    }
    // 先卸载（同名重装载必须先释放 serverName 预留），再装载。
    for (const rawName of plan.toUnmount) {
      await this.unmountServer(container, rawName);
      this.skipReasons.delete(container.key + "\u0000" + rawName);
    }
    for (const item of plan.toMount) {
      const skip = await this.mountServer(container, item);
      const markKey = container.key + "\u0000" + item.rawName;
      if (skip === undefined) this.skipReasons.delete(markKey);
      else this.skipReasons.set(markKey, skip);
    }
  }

  // ── 装载诊断（项目：<root>/.dsh/.mcp-diag.json；全局：<dshHome>/.mcp-diag.json）──
  // 调用方只在有异常或有配置行时写入：无配置的干净项目不创建该文件。
  // 文件形态：`{ summary?, events: [...] }`（旧版纯数组读入后当作 events）。

  private async writeDiag(projectRoot: string, event: Record<string, unknown>): Promise<void> {
    await this.writeDiagAt(join(projectRoot, DSH_DIR, DIAG_FILE), event);
  }

  /** 全局诊断落 dshHome 根（与用户层 mcp.yml 同目录：注入 userLayerPaths 时同样跟随注入值）。 */
  private async writeGlobalDiag(event: Record<string, unknown>): Promise<void> {
    const { mcpYml } = this.resolveUserLayerPaths();
    await this.writeDiagAt(join(dirname(mcpYml), DIAG_FILE), event);
  }

  private async writeDiagAt(path: string, event?: Record<string, unknown>, summary?: DiagSummary): Promise<void> {
    const tmp = path + `.tmp-${process.pid}`;
    try {
      let doc: DiagDocument = { events: [] };
      try {
        doc = parseDiagDocument(JSON.parse(await readFile(path, "utf8")));
      } catch {
        doc = { events: [] };
      }
      if (event !== undefined) {
        doc.events.push({ ts: new Date().toISOString(), ...event });
        if (doc.events.length > 30) doc.events = doc.events.slice(-30);
      }
      if (summary !== undefined) doc.summary = summary;
      const payload = doc.summary === undefined ? { events: doc.events } : { summary: doc.summary, events: doc.events };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
      await rename(tmp, path);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  private summarizeScope(key: string, servers: Map<string, ProjectServerState>, at: string, projects?: number): DiagSummary {
    const skippedByReason: Record<string, number> = {};
    const unhealthy: DiagUnhealthy[] = [];
    const prefix = key + "\u0000";
    let skippedCount = 0;
    for (const [mark, reason] of this.skipReasons) {
      if (!mark.startsWith(prefix)) continue;
      skippedCount += 1;
      skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
      unhealthy.push({ name: mark.slice(prefix.length), reason });
    }
    let mounted = 0;
    for (const state of servers.values()) {
      if (state.phase === "active" || state.phase === "mounting") mounted += 1;
      if (state.phase === "failed") {
        skippedByReason.failed = (skippedByReason.failed ?? 0) + 1;
        unhealthy.push({ name: state.rawName, reason: state.error ?? "failed" });
      }
    }
    return {
      at,
      ...(projects === undefined ? {} : { projects }),
      rows: servers.size + skippedCount,
      mounted,
      skippedByReason,
      unhealthy
    };
  }

  private async writeSummaries(): Promise<void> {
    const at = new Date().toISOString();
    for (const [key, entry] of this.projects) {
      const summary = this.summarizeScope(key, entry.servers, at);
      const path = join(entry.projectRoot, DSH_DIR, DIAG_FILE);
      if (summary.rows === 0 && summary.unhealthy.length === 0) {
        try {
          await readFile(path);
        } catch {
          continue;
        }
      }
      await this.writeDiagAt(path, undefined, summary);
    }
    const globalSummary = this.summarizeScope(GLOBAL_SCOPE_KEY, this.globalServers, at, this.projects.size);
    const userHasContent = this.userLayer.ymlRows.length + this.userLayer.jsonRows.length + this.userLayer.profileRows.length > 0
      || this.userLayer.ymlError !== null
      || this.userLayer.jsonError !== null
      || this.userLayer.profileError !== null;
    const globalPath = join(dirname(this.resolveUserLayerPaths().mcpYml), DIAG_FILE);
    if (globalSummary.rows === 0 && globalSummary.unhealthy.length === 0 && !userHasContent) {
      try {
        await readFile(globalPath);
      } catch {
        return;
      }
    }
    await this.writeDiagAt(globalPath, undefined, globalSummary);
  }

  /** 装载一个期望行；返回跳过原因（有则不建装载实例），undefined = 已发起装载。 */
  private async mountServer(container: MountContainer, item: DesiredProjectRow): Promise<string | undefined> {
    if (this.disposed) return undefined;
    const effectiveName = container.effectiveNameOf(item.rawName);
    if (effectiveName === undefined) return undefined;
    await container.diag({ kind: "attempt", rawName: item.rawName, effectiveName });
    let built: { config: Record<string, unknown> } | { skip: string };
    try {
      built = await this.buildServerConfig(container, item, effectiveName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await container.diag({ kind: "config-invalid", rawName: item.rawName, error: message });
      this.ctx.logger.warn(`${container.label} "${item.rawName}" 配置无效：${message}`);
      return "config-invalid";
    }
    if ("skip" in built) return built.skip;
    let fiber: any;
    try {
      fiber = this.ctx.plugin(mcpClient as any, built.config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await container.diag({ kind: "plugin-throw", effectiveName, error: message });
      this.ctx.logger.error(`${container.label} "${effectiveName}" 装载失败：${message}`);
      return "plugin-throw";
    }
    this.trackMount(container, item, effectiveName, fiber);
    return undefined;
  }

  /**
   * 期望行 → dsh-mcp-client 配置。返回 `{ skip }` 表示已记诊断、不发起装载；
   * 行本身读不出或展开后仍不合法则抛出，由 mountServer 落 config-invalid。
   */
  private async buildServerConfig(container: MountContainer, item: DesiredProjectRow, effectiveName: string): Promise<{ config: Record<string, unknown> } | { skip: string }> {
    let input = inputFromPatchRow(item.row);
    // ${VAR} 串内插值展开对所有来源统一（CLI 按生态习惯写进原生文件的
    // Bearer ${TOKEN} 也要生效）；值不含 ${NAME} 引用的行行为不变。
    const expanded = expandEnvRefs(input, process.env);
    if (!expanded.ok) {
      await container.diag({ kind: "env-missing", rawName: item.rawName, effectiveName, missingVar: expanded.missingVar });
      this.ctx.logger.warn(`${container.label} "${item.rawName}" 未装载：环境变量 \${${expanded.missingVar}} 未设置`);
      return { skip: "env-missing" };
    }
    input = expanded.input;
    // 展开后的值可能不再合法（占位 `${URL}` 骗过了装载前 schema），补跑一次校验，
    // 让错误在这里以诊断形式落地，而不是留给 ctx.plugin 炸 plugin-throw。
    const revalidated = mcpServerInputSchema.safeParse(input);
    if (!revalidated.success) {
      const note = revalidated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      await container.diag({ kind: "env-invalid", rawName: item.rawName, effectiveName, error: note });
      this.ctx.logger.warn(`${container.label} "${item.rawName}" 配置无效：\${VAR} 展开后校验失败（${note}）`);
      return { skip: "env-invalid" };
    }
    input = revalidated.data;
    const configInput: any = { ...input, serverName: effectiveName };
    if (input.transport === "stdio") {
      if (typeof input.cwd === "string" && input.cwd !== "") {
        // 项目层相对 cwd 以项目根为基准；全局层以宿主工作目录为基准。
        configInput.cwd = resolve(container.projectRoot === "" ? process.cwd() : container.projectRoot, input.cwd);
      } else if (container.scope === "project") {
        // 文档语义：项目层空 cwd = 项目根（手写 yml/json 行可整个省略 cwd）；
        // 全局层空 cwd 保持继承宿主工作目录，不改写。
        configInput.cwd = container.projectRoot;
      }
    }
    return { config: toOfficialConfig(configInput) };
  }

  /** 登记装载中状态，并把 fiber 的 settle 结果回写到状态、诊断与会话过滤。 */
  private trackMount(container: MountContainer, item: DesiredProjectRow, effectiveName: string, fiber: any) {
    const state: ProjectServerState = {
      projectRoot: container.projectRoot,
      scope: container.scope,
      rawName: item.rawName,
      effectiveName,
      row: item.row,
      source: item.source,
      fiber,
      phase: "mounting"
    };
    container.servers.set(item.rawName, state);
    fiber.then(
      () => {
        if (!container.isCurrent(state)) return;
        state.phase = "active";
        state.error = undefined;
        // 诊断写必须排进 reconcile 链：异步回调里裸写会与之交叉丢行（read-modify-write 竞态）。
        this.enqueue(async () => {
          await container.diag({ kind: "active", effectiveName });
        }).catch(() => {});
        this.kickSweep();
      },
      (error: unknown) => {
        if (!container.isCurrent(state)) return;
        state.phase = "failed";
        state.error = error instanceof Error ? error.message : String(error);
        this.enqueue(async () => {
          await container.diag({ kind: "failed", effectiveName, error: state.error });
        }).catch(() => {});
        this.ctx.logger.error(`${container.label} "${effectiveName}" 装载失败：${state.error}`);
        this.kickSweep();
      }
    );
  }

  private async unmountServer(container: MountContainer, rawName: string) {
    const state = container.servers.get(rawName);
    if (state === undefined) return;
    container.servers.delete(rawName);
    state.phase = "unloading";
    try {
      await state.fiber?.dispose();
    } catch {
      // fiber 已随上下文销毁
    }
  }

  private healthKey(containerKey: string, rawName: string): string {
    return containerKey + "\u0000" + rawName;
  }

  private healthOf(containerKey: string, rawName: string): { everHadTools: boolean; remountCount: number; nextRemountAt: number; givenUp: boolean } {
    const key = this.healthKey(containerKey, rawName);
    const existing = this.healthByMount.get(key);
    if (existing !== undefined) return existing;
    const created = { everHadTools: false, remountCount: 0, nextRemountAt: 0, givenUp: false };
    this.healthByMount.set(key, created);
    return created;
  }

  /**
   * 连接死亡自愈：曾经有过工具、当前 0 工具、未 disabled、退避已过 → unmount 再 mount。
   * 连续 HEALTH_REMOUNT_LIMIT 次仍为 0 工具则 give-up。JSON enabled:false 本就不在装载集。
   */
  private async remountUnhealthy(): Promise<void> {
    for (const [key, entry] of this.projects) {
      await this.remountUnhealthyIn(this.projectContainer(key, entry));
    }
    await this.remountUnhealthyIn(this.globalMountContainer());
    for (const mark of [...this.healthByMount.keys()]) {
      const sep = mark.lastIndexOf("\u0000");
      const scopeKey = mark.slice(0, sep);
      const rawName = mark.slice(sep + 1);
      const servers = scopeKey === GLOBAL_SCOPE_KEY ? this.globalServers : this.projects.get(scopeKey)?.servers;
      if (servers === undefined || !servers.has(rawName)) this.healthByMount.delete(mark);
    }
  }

  private async remountUnhealthyIn(container: MountContainer): Promise<void> {
    const snapshot = [...container.servers.values()];
    for (const state of snapshot) {
      if (this.disposed || !container.isCurrent(state)) continue;
      if (state.row.disabled === true) continue;
      const health = this.healthOf(container.key, state.rawName);
      const tools = mcpToolCount(this.ctx, state.effectiveName);
      if (tools > 0) {
        health.everHadTools = true;
        health.remountCount = 0;
        health.nextRemountAt = 0;
        health.givenUp = false;
        continue;
      }
      if (!health.everHadTools || state.phase !== "active" || health.givenUp) continue;
      if (health.remountCount >= this.remountLimit()) {
        health.givenUp = true;
        await container.diag({ kind: "give-up", rawName: state.rawName, effectiveName: state.effectiveName, remountCount: health.remountCount });
        this.ctx.logger.warn(`${container.label} "${state.effectiveName}" 连续重挂 ${health.remountCount} 次后仍无工具，停止自愈`);
        continue;
      }
      if (this.nowMs() < health.nextRemountAt) continue;
      health.remountCount += 1;
      health.nextRemountAt = this.nowMs() + this.remountBackoffMs();
      await container.diag({ kind: "remount", rawName: state.rawName, effectiveName: state.effectiveName, attempt: health.remountCount });
      this.ctx.logger.warn(`${container.label} "${state.effectiveName}" 连接巡检：工具数为 0，第 ${health.remountCount} 次重挂`);
      const item: DesiredProjectRow = { rawName: state.rawName, row: state.row, source: state.source };
      await this.unmountServer(container, state.rawName);
      await this.mountServer(container, item);
    }
  }

  // ── 会话可见性（deny 重扫）────────────────────────────────────────────

  private kickSweep() {
    if (this.disposed) return;
    this.enqueue(async () => {
      await this.sweepRestrictions();
    }).catch(() => {});
  }

  private async sweepRestrictions() {
    if (this.disposed) return;
    const groups = this.activeMountGroups();
    const toolIds = this.registeredToolIds();
    for (const agent of this.liveAgents()) {
      const project = this.agentProjects.get(agent.id) ?? await this.resolveProject(agent);
      if (project !== undefined) this.agentProjects.set(agent.id, project);
      const hidden = [...denySetFor(project, groups)];
      // 项目侧压制：本项目自身行遮蔽过的全局服务器，在本会话 deny 其工具
      // （全局实例仍只挂一条，只有该项目的会话看不见）。
      // 守卫 globalServers.has：没有全局实例的名字一律不 deny——`mcp__<name>__*`
      // 前缀会命中项目自己（生效名未改名时）或宿主 patch 行的工具，等于自杀式 deny。
      if (project !== undefined) {
        for (const rawName of this.suppressedGlobals.get(project) ?? []) {
          if (this.globalServers.has(rawName)) hidden.push(rawName);
        }
      }
      const deny = expandToToolNames(hidden, toolIds);
      deny.push(...this.toolFilterDeniesForSession(project, toolIds));
      this.applyRestriction(agent, deny);
    }
  }

  /** 本会话可见的服务器上，条目 tools.allow/deny 展开成已注册工具名。 */
  private toolFilterDeniesForSession(sessionProject: string | undefined, toolIds: string[]): string[] {
    const deny: string[] = [];
    if (sessionProject !== undefined) {
      const entry = this.projects.get(sessionProject);
      if (entry !== undefined) {
        for (const state of entry.servers.values()) {
          if (state.phase !== "active") continue;
          deny.push(...deniedToolsForFilter(state.effectiveName, toolFilterFromConfig(state.row.config), toolIds));
        }
      }
    }
    const suppressed = sessionProject === undefined ? undefined : this.suppressedGlobals.get(sessionProject);
    for (const state of this.globalServers.values()) {
      if (state.phase !== "active") continue;
      if (suppressed?.has(state.rawName) === true) continue;
      deny.push(...deniedToolsForFilter(state.effectiveName, toolFilterFromConfig(state.row.config), toolIds));
    }
    return deny;
  }

  /** 各装载容器里已 active 的生效名，按项目根分组（deny 计算的输入）。 */
  private activeMountGroups(): { projectRoot: string; effectiveNames: string[] }[] {
    const groups: { projectRoot: string; effectiveNames: string[] }[] = [];
    for (const entry of this.projects.values()) {
      const names: string[] = [];
      for (const state of entry.servers.values()) {
        if (state.phase === "active") names.push(state.effectiveName);
      }
      if (names.length > 0) groups.push({ projectRoot: entry.projectRoot, effectiveNames: names });
    }
    return groups;
  }

  /** 宿主工具层当前注册的全部工具 id；取不到时按空集（本轮不新增限制，下次 sweep 补）。 */
  private registeredToolIds(): string[] {
    try {
      return (this.ctx.tools?.schemas?.() ?? []).map((schema: any) => String(schema?.id ?? schema?.name ?? ""));
    } catch {
      return [];
    }
  }

  private applyRestriction(agent: any, deny: string[]) {
    const previous = this.restrictions.get(agent.id);
    if (previous !== undefined) {
      this.restrictions.delete(agent.id);
      try {
        previous();
      } catch {
        // agent 层已销毁
      }
    }
    if (deny.length === 0) return;
    try {
      const disposer = agent.ctx.tools.restrict({ deny });
      this.restrictions.set(agent.id, disposer);
    } catch (error) {
      // 未知名（装载未 settle）竞态：下一次 sweep 会补上。
      this.ctx.logger.warn(`会话 ${agent.id} 的项目 MCP 过滤暂未应用：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private releaseAgent(agent: any) {
    this.agentProjects.delete(agent.id);
    const previous = this.restrictions.get(agent.id);
    if (previous !== undefined) {
      this.restrictions.delete(agent.id);
      try {
        previous();
      } catch {
        // 已随 agent 销毁
      }
    }
  }

  /**
   * 会话项目 key：会话 cwd 的项目根；子代理无 cwd 时回退 owner 的项目；
   * 均无时回退 dsh 进程 cwd 所在项目。
   */
  private async resolveProject(agent: any): Promise<string | undefined> {
    try {
      const cwd = agent?.session?.header?.cwd;
      if (typeof cwd === "string" && cwd !== "") {
        return projectKeyOf(await findProjectRoot(cwd));
      }
    } catch {
      // 回退 owner
    }
    try {
      for (const candidate of this.liveAgents()) {
        if (candidate === agent) continue;
        if (this.ctx.agents?.isOwnedBy?.(agent.id, candidate)) {
          const own = this.agentProjects.get(candidate.id);
          if (own !== undefined) return own;
          const resolved = await this.resolveProject(candidate);
          if (resolved !== undefined) return resolved;
        }
      }
    } catch {
      // 视为无项目
    }
    try {
      return projectKeyOf(await findProjectRoot(process.cwd()));
    } catch {
      // 视为无项目
    }
    return undefined;
  }

  // ── 对外查询 ─────────────────────────────────────────────────────────

  /** 立即执行一次全量对账（供外部在写入文件后调用，不等 watcher）。 */
  reconcileNow(): Promise<void> {
    return this.enqueue(async () => {
      await this.reconcileAll();
    });
  }

  /** 已执行的 reconcile 次数（测试用：验证文件事件是否惊动管线）。 */
  get debugReconcileCount(): number {
    return this.reconcileCount;
  }

  /** 配置文件读取次数（测试用：指纹未变时不应再增长）。 */
  get debugConfigReadCount(): number {
    return this.configReadCount;
  }

  /** 等待某项目某行的装载状态满足 predicate（写入后 reconciliation 用）。 */
  async waitForState(projectRoot: string, rawName: string, predicate: (state: ProjectServerState | undefined) => boolean, timeoutMs = 3000): Promise<boolean> {
    const key = projectKeyOf(projectRoot);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const state = this.projects.get(key)?.servers.get(rawName);
      if (predicate(state)) return true;
      await delay(200);
    }
    return false;
  }

  /** 全局（用户层）某行的装载状态；未装载返回 undefined。 */
  globalState(rawName: string): ProjectServerState | undefined {
    return this.globalServers.get(rawName);
  }

  /** 等待全局层某行的装载状态满足 predicate。 */
  async waitForGlobalState(rawName: string, predicate: (state: ProjectServerState | undefined) => boolean, timeoutMs = 3000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate(this.globalServers.get(rawName))) return true;
      await delay(200);
    }
    return false;
  }

  /** 行级 view 的逐层影子优先查找：项目 yml > 项目 .dsh/mcp.json > .mcp.json > profile json > 用户 yml > 用户 json > 装载残留态。 */
  private async locateRow(projectRoot: string, rawName: string, state?: ProjectServerState): Promise<{ row?: PatchRow; source?: McpRowSource; path?: string }> {
    const userPaths = this.resolveUserLayerPaths();
    const ymlPath = projectMcpFile(projectRoot);
    if (!isSameFilePath(ymlPath, userPaths.mcpYml)) {
      try {
        const raw = await readPatchFile(ymlPath);
        const ymlRow = extractManagedRows(raw).find((candidate) => rowNameOf(candidate) === rawName);
        if (ymlRow !== undefined) return { row: ymlRow, source: "dsh-project", path: ymlPath };
      } catch {
        // 落到后续层
      }
    }
    const jsonPath = projectDshJsonFile(projectRoot);
    if (!isSameFilePath(jsonPath, userPaths.mcpJson)) {
      const projectJson = await readDshJsonFile(jsonPath, { source: "dsh-project-json", cwdPolicy: "project", projectRoot });
      const projectJsonRow = projectJson.rows.find((candidate) => candidate.rawName === rawName);
      if (projectJsonRow !== undefined) return { row: projectJsonRow.row, source: "dsh-project-json", path: jsonPath };
    }
    if (mcpJsonLayerEnabled()) {
      const ccPath = projectMcpJsonFile(projectRoot);
      const cc = await readMcpJsonFile(ccPath, projectRoot);
      const found = cc.rows.find((candidate) => candidate.rawName === rawName);
      if (found !== undefined) return { row: found.row, source: "cc-project", path: ccPath };
    }
    const profileRow = this.userLayer.profileRows.find((candidate) => candidate.rawName === rawName);
    if (profileRow !== undefined) return { row: profileRow.row, source: "dsh-profile-user", path: this.userLayer.profileJson ?? undefined };
    const uy = this.userLayer.ymlRows.find((candidate) => candidate.rawName === rawName);
    if (uy !== undefined) return { row: uy.row, source: "dsh-user-yml", path: userPaths.mcpYml };
    const uj = this.userLayer.jsonRows.find((candidate) => candidate.rawName === rawName);
    if (uj !== undefined) return { row: uj.row, source: "dsh-user", path: userPaths.mcpJson };
    if (state?.row !== undefined) return { row: state.row, source: state.source };
    return {};
  }

  /** 行级 view；未装载时 phase 按行状态推导。行查找按影子优先序逐层进行。 */
  async serverView(projectRoot: string, rawName: string): Promise<any | undefined> {
    const key = projectKeyOf(projectRoot);
    const state = this.projects.get(key)?.servers.get(rawName) ?? this.globalServers.get(rawName);
    const located = await this.locateRow(projectRoot, rawName, state);
    if (located.row === undefined) return undefined;
    // 用户层行报全局作用域 + 层文件路径（与快照的 pushGlobal 同口径）：报
    // workspace/项目根会让消费方以为这是项目行、误导「改哪个文件」。
    const isUserLayerRow = located.source !== undefined && !isProjectLayerSource(located.source);
    const scope: McpScopeInfo = isUserLayerRow
      ? { kind: "global", path: located.path ?? "", label: "user" }
      : { kind: "workspace", path: projectRoot };
    const view = patchRowToView(located.row, scope);
    if (view === undefined) return undefined;
    const globalState = this.globalServers.get(rawName);
    const effectiveName = isUserLayerRow
      ? globalState?.effectiveName ?? rawName
      : this.effective.get(key + "\u0000" + rawName);
    // owned：装载实例确实来自这条行所在的那个源（与分区视图 partitionServers 的
    // state?.source === source 同一口径）。异来源实例挂在同一个 rawName 上时，
    // 本行是被遮蔽方——phase 走 null，toolCount 不借用别源的装载数据。
    const owned = state?.source === located.source;
    // 跳过原因按「行所在层」的作用域查（被跳过的全局行没有 state，不能靠 state.scope 判）。
    const scopeKey = isUserLayerRow ? GLOBAL_SCOPE_KEY : key;
    return {
      ...view,
      ...(located.source === undefined ? {} : { source: located.source }),
      ...(effectiveName === undefined ? {} : { effectiveServerName: effectiveName }),
      fiberPhase: fiberPhaseFor(state, located.row, owned),
      skipReason: skipReasonFor(this.skipReasons, scopeKey, rawName, state, located.row) ?? null,
      toolCount: owned && state?.phase === "active" ? mcpToolCount(this.ctx, state.effectiveName) : 0
    };
  }

  /** 全量快照：每个已知项目一个 yml 分区 + 一个 .mcp.json 分区（有内容才出），外加用户层分区。 */
  async snapshot(): Promise<ProjectFileState[]> {
    await this.enqueue(async () => {
      await this.reconcileAll();
    });
    const out: ProjectFileState[] = [];
    const userPaths = this.resolveUserLayerPaths();
    for (const [key, entry] of this.projects) {
      const path = projectMcpFile(entry.projectRoot);
      const file: ProjectFileState = { project: entry.projectRoot, path, ok: true, error: null, source: "dsh-project", servers: [] };
      let rows: PatchRow[] = [];
      let usable = true;
      let skipYmlPartition = false;
      if (isSameFilePath(path, userPaths.mcpYml)) {
        // 家目录即项目根：该文件就是用户层文件，不作为项目分区展示。
        skipYmlPartition = true;
      } else {
        try {
          rows = extractManagedRows(await readPatchFile(path));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // yml 缺失且没有 yml 来源的装载：文件本就不存在，不出 yml 分区——
          // 用户层行也能让项目有装载实例，servers.size>0 不再等价「装载后文件被删」。
          const ymlLive = [...entry.servers.values()].some((state) => state.source === "dsh-project" || state.source === undefined);
          if (message.includes("ENOENT") && !ymlLive) {
            skipYmlPartition = true;
          } else {
            usable = false;
            file.ok = false;
            file.error = message;
          }
        }
      }
      if (!skipYmlPartition) {
        if (usable) file.servers = this.partitionServers(entry, key, rows, "dsh-project");
        out.push(file);
      }
      // ── 项目 .dsh/mcp.json 分区（DSH 自有 JSON 方言；家目录即项目根时跳过）──
      {
        const jsonPath = projectDshJsonFile(entry.projectRoot);
        if (!isSameFilePath(jsonPath, userPaths.mcpJson)) {
          const pj = await readDshJsonFile(jsonPath, { source: "dsh-project-json", cwdPolicy: "project", projectRoot: entry.projectRoot });
          const pjLive = [...entry.servers.values()].some((state) => state.source === "dsh-project-json");
          if (pj.rows.length > 0 || pj.fileError !== undefined || pj.entryErrors.length > 0 || pjLive) {
            const pjFile: ProjectFileState = {
              project: entry.projectRoot,
              path: jsonPath,
              ok: pj.fileError === undefined,
              error: pj.fileError ?? null,
              source: "dsh-project-json",
              servers: this.partitionServers(entry, key, pj.rows.map((r) => r.row), "dsh-project-json")
            };
            if (pj.entryErrors.length > 0) (pjFile as any).entryErrors = pj.entryErrors;
            out.push(pjFile);
          }
        }
      }
      // ── 项目 .mcp.json 分区（被开关关闭时整分区不出，含残留装载的情形）──
      if (mcpJsonLayerEnabled()) {
        const ccPath = projectMcpJsonFile(entry.projectRoot);
        const cc = await readMcpJsonFile(ccPath, entry.projectRoot);
        const ccLive = [...entry.servers.values()].some((state) => state.source === "cc-project");
        if (cc.rows.length > 0 || cc.fileError !== undefined || cc.entryErrors.length > 0 || ccLive) {
          const ccFile: ProjectFileState = {
            project: entry.projectRoot,
            path: ccPath,
            ok: cc.fileError === undefined,
            error: cc.fileError ?? null,
            source: "cc-project",
            servers: this.partitionServers(entry, key, cc.rows.map((r) => r.row), "cc-project")
          };
          if (cc.entryErrors.length > 0) (ccFile as any).entryErrors = cc.entryErrors;
          out.push(ccFile);
        }
      }
    }
    // ── 用户层分区（全局装载：fiberPhase/toolCount 取自 globalServers 中同源实例）──
    const pushGlobal = (path: string, source: McpRowSource, rows: SourcedRow[], error: string | null): void => {
      if (path === "" || (rows.length === 0 && error === null)) return;
      out.push({
        project: dirname(path),
        path,
        kind: "global",
        source,
        ok: error === null,
        error,
        servers: rows
          .map((r) => {
            const view = patchRowToView(r.row, { kind: "global", path, label: "user" });
            if (view === undefined) return undefined;
            const state = this.globalServers.get(r.rawName);
            const owned = state?.source === source;
            return {
              ...view,
              source,
              effectiveServerName: state?.effectiveName ?? r.rawName,
              fiberPhase: fiberPhaseFor(state, r.row, owned),
              skipReason: skipReasonFor(this.skipReasons, GLOBAL_SCOPE_KEY, r.rawName, state, r.row) ?? null,
              toolCount: owned && state?.phase === "active" ? mcpToolCount(this.ctx, state.effectiveName) : 0
            };
          })
          .filter((v): v is NonNullable<typeof v> => v !== undefined)
      });
    };
    pushGlobal(this.userLayer.profileJson ?? "", "dsh-profile-user", this.userLayer.profileRows, this.userLayer.profileError);
    pushGlobal(this.userLayer.mcpYml, "dsh-user-yml", this.userLayer.ymlRows, this.userLayer.ymlError);
    pushGlobal(this.userLayer.mcpJson, "dsh-user", this.userLayer.jsonRows, this.userLayer.jsonError);
    return out;
  }

  /** 一个来源分区的服务器 view 列表；state 只认同来源装载实例（异来源=被遮蔽）。 */
  private partitionServers(entry: ProjectEntry, key: string, rows: PatchRow[], source: McpRowSource): any[] {
    const out: any[] = [];
    for (const row of rows) {
      const rawName = rowNameOf(row);
      if (rawName === undefined) continue;
      const view = patchRowToView(row, { kind: "workspace", path: entry.projectRoot });
      if (view === undefined) continue;
      const state = entry.servers.get(rawName);
      const owned = state?.source === source;
      const effectiveName = this.effective.get(key + "\u0000" + rawName);
      out.push({
        ...view,
        source,
        ...(effectiveName === undefined ? {} : { effectiveServerName: effectiveName }),
        fiberPhase: fiberPhaseFor(state, row, owned),
        skipReason: skipReasonFor(this.skipReasons, key, rawName, state, row) ?? null, // env-missing / env-invalid / config-invalid / plugin-throw；fiberPhase 保持生命周期枚举
        toolCount: owned && state?.phase === "active" ? mcpToolCount(this.ctx, state.effectiveName) : 0
      });
    }
    return out;
  }
}
