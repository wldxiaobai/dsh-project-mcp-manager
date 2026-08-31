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
 *   1. <projectRoot>/.dsh/mcp.yml —— 原生受管块（主格式）
 *   2. <projectRoot>/.mcp.json    —— CC project scope（严格只读兼容层）
 *   3. ~/.dsh/mcp.yml             —— 用户层原生（dsh-mcp CLI --scope user 的落点）
 *   4. ~/.claude.json             —— CC user scope（allowlist 只读顶层 mcpServers）
 * 用户层行进入每个项目的合并集，即每个项目各挂一条用户服务器连接（与项目行
 * 同模型）；被同名项目行遮蔽的项目不再见到用户层副本。${VAR} 占位在 mount
 * 时经 model.expandEnvRefs 用宿主进程环境运行时展开，缺失即跳过该条目。
 */
import chokidar from "chokidar";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";
import { extractManagedRows, readPatchFile, type PatchRow } from "./mcp-file.js";
import {
  CC_PROJECT_FILE,
  CLAUDE_USER_FILE,
  IGNORE_CLAUDE_JSON_ENV,
  readClaudeUserFile,
  readMcpJsonFile,
  type CcReadResult,
  type McpRowSource,
  type SourcedRow
} from "./cc-file.js";
import { findProjectRoot } from "./project-root.js";
import {
  denySetFor,
  effectiveServerNames,
  expandEnvRefs,
  inputFromPatchRow,
  mcpServerInputSchema,
  patchRowToView,
  projectKeyOf,
  serverNameFromRowId,
  toOfficialConfig
} from "./model.js";
import { mcpToolCount } from "./status.js";

const delay = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

/** 项目 MCP 配置文件名（位于项目根下）。 */
export const PROJECT_MCP_FILE = "mcp.yml";

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

/** 一个已装载（或装载中）的项目 MCP 服务器的运行时状态。 */
export interface ProjectServerState {
  projectRoot: string;
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
  /** 用户层文件路径注入点（测试用）；缺省 <home>/.dsh/mcp.yml 与 <home>/.claude.json。 */
  userLayerPaths?: { mcpYml: string; claudeJson: string };
}

interface ProjectEntry {
  projectRoot: string;
  servers: Map<string, ProjectServerState>; // rawName → state
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
      return Object.keys(value).sort().reduce((acc: Record<string, unknown>, k) => {
        acc[k] = (value as Record<string, unknown>)[k];
        return acc;
      }, {});
    }
    return value;
  });
}

/** 行的原始 serverName（受管行 id 或 config.serverName）。 */
export function rowNameOf(row: PatchRow): string | undefined {
  const fromId = serverNameFromRowId(row.id);
  if (fromId !== undefined) return fromId;
  return typeof row.config?.serverName === "string" ? row.config.serverName : undefined;
}

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
  for (const item of desired) {
    const state = current.find((candidate) => candidate.rawName === item.rawName);
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

/** 项目根下 CC project scope 兼容文件路径（只读）。 */
export function projectMcpJsonFile(projectRoot: string): string {
  return join(projectRoot, CC_PROJECT_FILE);
}

function normalizePathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

const SOURCE_RANK: Record<McpRowSource, number> = { yml: 0, "cc-project": 1, "user-yml": 2, "cc-user": 3 };

/**
 * 多来源行按优先序合并（数组顺序=优先序，先到先得；后到同名行为被遮蔽）。
 * shadowedOwnCc：被项目 yml 遮蔽的项目 .mcp.json 行；shadowedUser：被任一项目
 * 自身行遮蔽的用户层行。纯函数，供测试。
 */
export function mergeSourcedRows(candidates: SourcedRow[][]): { rows: DesiredProjectRow[]; shadowedOwnCc: string[]; shadowedUser: string[] } {
  const byName = new Map<string, SourcedRow>();
  const shadowedOwnCc: string[] = [];
  const shadowedUser: string[] = [];
  for (const list of candidates) {
    for (const item of list) {
      const winner = byName.get(item.rawName);
      if (winner !== undefined) {
        if (item.source === "cc-project" && winner.source === "yml") {
          if (!shadowedOwnCc.includes(item.rawName)) shadowedOwnCc.push(item.rawName);
        } else if (SOURCE_RANK[item.source] >= 2 && SOURCE_RANK[winner.source] <= 1) {
          if (!shadowedUser.includes(item.rawName)) shadowedUser.push(item.rawName);
        }
        continue;
      }
      byName.set(item.rawName, item);
    }
  }
  return {
    rows: [...byName.values()]
      .filter((item) => item.disabled !== true)
      .map((item) => ({ rawName: item.rawName, row: item.row, source: item.source })),
    shadowedOwnCc,
    shadowedUser
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
  /** 最近一次读到的 ~/.claude.json mcpServers 子树规范化哈希（watcher 门控用）。 */
  private claudeServersHash: string | undefined;
  /** 装载被跳过的行（key\0rawName → 原因）；快照按独立 skipReason 字段展示，fiberPhase 保持枚举。 */
  private skipReasons = new Map<string, string>();
  /** 最近一次用户层读取结果（reconcile 与 snapshot 共享；首轮 reconcile 前为空）。 */
  private userLayer: {
    mcpYml: string;
    claudeJson: string;
    ymlRows: SourcedRow[];
    ymlError: string | null;
    cc: CcReadResult | null;
  } = { mcpYml: "", claudeJson: "", ymlRows: [], ymlError: null, cc: null };
  private reconcileCount = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

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
    const keys = roots.map((root) => projectKeyOf(root)).sort();
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
    // .mcp.json 与 .dsh/mcp.yml 平级热重载：都按「已知项目根下的精确文件」比对，
    // 项目树里其它位置的同名文件（嵌套子目录的 .dsh/mcp.yml 等）不误触发。
    const ccFiles = new Set(roots.map((root) => normalizePathKey(projectMcpJsonFile(root))));
    const ymlFiles = new Set(roots.map((root) => normalizePathKey(projectMcpFile(root))));
    const kick = (path: string) => {
      const key = normalizePathKey(path);
      if (ymlFiles.has(key) || ccFiles.has(key)) this.kick();
    };
    watcher.on("add", kick);
    watcher.on("change", kick);
    watcher.on("unlink", kick);
    watcher.on("error", () => {
      // 保持监听；下一次事件仍会触发 reconcile
    });
    this.watcher = watcher;
  }

  // ── 用户层（~/.dsh/mcp.yml + ~/.claude.json allowlist）────────────────

  private resolveUserLayerPaths(): { mcpYml: string; claudeJson: string } {
    const home = homedir();
    return this.providers.userLayerPaths ?? {
      mcpYml: join(home, ".dsh", PROJECT_MCP_FILE),
      claudeJson: join(home, CLAUDE_USER_FILE)
    };
  }

  /** 原生受管块文件通用读取（项目 yml 与用户层 yml 共用）。 */
  private async readNativeRows(path: string, source: McpRowSource, liveMounts: number): Promise<{ rows: SourcedRow[]; ok: boolean; error: string | null }> {
    let rows: SourcedRow[] = [];
    let ok = true;
    let error: string | null = null;
    try {
      const raw = await readPatchFile(path);
      for (const row of extractManagedRows(raw)) {
        const rawName = rowNameOf(row);
        // disabled 行不跳过：带着占位旗进合并——显式禁用应同时遮蔽下层同名，
        // 否则「关掉 yml 行」会意外改去装载 .mcp.json 副本。
        if (rawName !== undefined) rows.push({ rawName, row, source, disabled: row.disabled === true });
      }
    } catch (catchError) {
      const message = catchError instanceof Error ? catchError.message : String(catchError);
      // 「配置文件不存在」(ENOENT) 只有在该项目确实有活着的装载时才算异常——
      // 意味着文件在装载之后被删/移走。零配置项目缺文件是常态：不能用
      // projects.has(key) 当判据，空项目条目也会让它恒真（误报根因）。
      if (liveMounts > 0 || !message.includes("ENOENT")) {
        ok = false;
        error = message;
      }
      rows = [];
    }
    return { rows, ok, error };
  }

  /** 读用户层两来源并刷新 userLayer 缓存；坏条目只告警（无项目归属，不进逐项目 diag）。 */
  private async readUserLayer(): Promise<void> {
    const paths = this.resolveUserLayerPaths();
    const yml = await this.readNativeRows(paths.mcpYml, "user-yml", 0);
    let cc: CcReadResult | null = null;
    if (process.env[IGNORE_CLAUDE_JSON_ENV] !== "1") {
      cc = await readClaudeUserFile(paths.claudeJson);
      if (cc.serversHash !== undefined) this.claudeServersHash = cc.serversHash;
    }
    this.userLayer = { mcpYml: paths.mcpYml, claudeJson: paths.claudeJson, ymlRows: yml.rows, ymlError: yml.error, cc };
    for (const note of cc?.entryErrors ?? []) this.ctx.logger.warn(`用户层 MCP（${CLAUDE_USER_FILE}）：${note}`);
    if (cc?.fileError !== undefined) this.ctx.logger.warn(`用户层 MCP：${cc.fileError}`);
    if (yml.error !== null) this.ctx.logger.warn(`用户层 MCP（${paths.mcpYml}）：${yml.error}`);
  }

  /**
   * 监听用户层两个具体文件（与项目层的精确路径过滤同构；不监视家目录递归：
   * 探针实测 chokidar v5 盯「父目录已存在的缺失文件」能在创建时补发 add，而盯
   * 不存在的目录则永久瞎——具体文件路径是更稳的监听形态）。~/.claude.json 事件
   * 过 serversHash 门：CC 每次会话都重写整个状态文件，先解析并比对 mcpServers
   * 子树的规范哈希，未变不触发 reconcile（不做 size/mtime 快路径：那会在
   * 同刻同体积的真实改动上误杀，内容哈希才是唯一可靠门）。
   */
  private async syncUserWatcher(): Promise<void> {
    const paths = this.resolveUserLayerPaths();
    // 只监听这两个具体文件本身；被 kill switch 关掉的 ~/.claude.json 连监听都不建。
    const targets = process.env[IGNORE_CLAUDE_JSON_ENV] === "1" ? [paths.mcpYml] : [paths.mcpYml, paths.claudeJson];
    const keys = targets.map((target) => normalizePathKey(target)).sort();
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
    const onEvent = (path: string) => {
      const target = normalizePathKey(path);
      if (target === normalizePathKey(paths.claudeJson)) {
        if (process.env[IGNORE_CLAUDE_JSON_ENV] === "1") return;
        void this.claudeGateThenKick();
        return;
      }
      if (target === normalizePathKey(paths.mcpYml)) this.kick();
    };
    watcher.on("add", onEvent);
    watcher.on("change", onEvent);
    watcher.on("unlink", onEvent);
    watcher.on("error", () => {
      // 保持监听；错误不炸宿主
    });
    this.userWatcher = watcher;
  }

  private async claudeGateThenKick(): Promise<void> {
    if (this.disposed) return;
    const { claudeJson } = this.resolveUserLayerPaths();
    // 内容哈希门是唯一裁决：不缓存 size/mtime 走快路径——Windows 上两次不同
    // 内容的重写可能落在同一 mtime 粒度且体积相仿，mtime 相等不等于内容相等。
    let hash: string | undefined;
    try {
      hash = (await readClaudeUserFile(claudeJson)).serversHash;
    } catch {
      hash = undefined;
    }
    if (hash === undefined) {
      this.kick(); // 读不动也要走一次 reconcile，让正式读取路径产出诊断
      return;
    }
    if (hash === this.claudeServersHash) return; // 仅 CC 状态位变化：不惊动管线
    this.claudeServersHash = hash;
    this.kick();
  }

  // ── 核心 reconcile ───────────────────────────────────────────────────

  /**
   * 全量对账：重算项目集合 → 读全部项目文件 → 计算生效名 → 逐项目装载/
   * 卸载 → 重扫各会话 deny。文件事件、新 agent、插件热更都汇到这里。
   */
  async reconcileAll(): Promise<void> {
    if (this.disposed) return;
    this.reconcileCount++;
    await this.syncWatcher();
    await this.syncUserWatcher();
    await this.readUserLayer();

    const roots = await this.knownProjects();
    const desiredByProject = new Map<string, { projectRoot: string; rows: DesiredProjectRow[] }>();
    for (const projectRoot of roots) {
      const key = projectKeyOf(projectRoot);
      const liveServers = this.projects.get(key)?.servers.size ?? 0;
      const yml = await this.readNativeRows(projectMcpFile(projectRoot), "yml", liveServers);
      const cc = await readMcpJsonFile(projectMcpJsonFile(projectRoot), projectRoot);
      // 影子优先级：项目 mcp.yml > 项目 .mcp.json > 用户 ~/.dsh/mcp.yml > 用户 ~/.claude.json。
      const merged = mergeSourcedRows([yml.rows, cc.rows, this.userLayer.ymlRows, this.userLayer.cc?.rows ?? []]);
      const ownRows = merged.rows.filter((row) => row.source === "yml" || row.source === "cc-project");
      // 源级隔离：某个源坏了只清空该源的 rows（读取器已保证），其余源照常进
      // desired。绝不能整项目一票否决——那会把坏文件的代价转嫁给好文件的行。
      desiredByProject.set(key, { projectRoot, rows: merged.rows });
      // 诊断只记有信息量的扫描：异常，或确实解析出了项目自身配置行。干净且无配置的
      // 项目不写任何记录——用户层行落到每个项目不算该项目的事件。
      if (!yml.ok || ownRows.length > 0 || cc.fileError !== undefined || cc.entryErrors.length > 0 || merged.shadowedOwnCc.length > 0 || merged.shadowedUser.length > 0) {
        await this.writeDiag(projectRoot, {
          kind: "scan",
          ok: yml.ok && cc.fileError === undefined,
          error: [yml.error, cc.fileError].filter(Boolean).join(" ; ") || null,
          rows: ownRows.map((row) => row.rawName),
          ...(merged.shadowedOwnCc.length > 0 ? { shadowedByYml: merged.shadowedOwnCc } : {}),
          ...(merged.shadowedUser.length > 0 ? { shadowedByProject: merged.shadowedUser } : {}),
          ...(cc.entryErrors.length > 0 ? { ccEntryErrors: cc.entryErrors } : {})
        });
      }
      for (const note of cc.entryErrors) this.ctx.logger.warn(`项目 MCP（${CC_PROJECT_FILE}，${projectRoot}）：${note}`);
      if (cc.fileError !== undefined) this.ctx.logger.warn(`项目 MCP（${CC_PROJECT_FILE}，${projectRoot}）：${cc.fileError}`);
    }

    const catalogProjects = [...desiredByProject.values()].map((entry) => ({
      projectRoot: entry.projectRoot,
      names: entry.rows.map((row) => row.rawName)
    }));
    const globalNames = await this.providers.globalNames().catch(() => []);
    this.effective = effectiveServerNames(catalogProjects, globalNames);

    for (const [key, entry] of desiredByProject) {
      await this.reconcileProject(key, entry);
    }
    await this.sweepRestrictions();
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
    const current = [...project.servers.values()].map((state) => ({ rawName: state.rawName, effectiveName: state.effectiveName, row: state.row }));
    const plan = planProjectChanges(current, entry.rows, this.effective, key);
    // 清理死键：从未挂上（被跳过）的行若从文件里删掉，既不在 toMount 也不在
    // toUnmount，其 skipReasons 标记没人再触碰——按当前 desired 集合剪掉。
    const desiredNames = new Set(entry.rows.map((item) => item.rawName));
    const markPrefix = key + "\u0000";
    for (const markKey of this.skipReasons.keys()) {
      if (markKey.startsWith(markPrefix) && !desiredNames.has(markKey.slice(markPrefix.length))) this.skipReasons.delete(markKey);
    }
    // 先卸载（同名重装载必须先释放 serverName 预留），再装载。
    for (const rawName of plan.toUnmount) {
      await this.unmountServer(project, rawName);
      this.skipReasons.delete(key + "\u0000" + rawName);
    }
    for (const item of plan.toMount) {
      const skip = await this.mountServer(project, item);
      const markKey = key + "\u0000" + item.rawName;
      if (skip === undefined) this.skipReasons.delete(markKey);
      else this.skipReasons.set(markKey, skip);
    }
  }

  // ── 装载诊断（写 <projectRoot>/.dsh/.mcp-diag.json，宿主日志不可见时定位失败）──
  // 调用方只在有异常或有配置行时写入：无配置的干净项目不创建该文件。

  private async writeDiag(projectRoot: string, event: Record<string, unknown>): Promise<void> {
    const path = join(projectRoot, ".dsh", ".mcp-diag.json");
    const tmp = path + `.tmp-${process.pid}`;
    try {
      let lines: Record<string, unknown>[] = [];
      try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        if (Array.isArray(parsed)) lines = parsed;
      } catch {
        lines = [];
      }
      lines.push({ ts: new Date().toISOString(), ...event });
      if (lines.length > 30) lines = lines.slice(-30);
      // .dsh 可能已被用户删掉（而项目仍有活装载）：补建目录，避免诊断静默丢失。
      await mkdir(dirname(path), { recursive: true });
      // 原子落盘（临时文件 + rename）：裸 writeFile 会让并发读取方看到半截
      // JSON（快照/测试轮询都算），与 mcp-file 的写路径同一标准。
      await writeFile(tmp, JSON.stringify(lines, null, 2), "utf8");
      await rename(tmp, path);
    } catch {
      // 诊断失败不影响主流程；清掉半截临时文件
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  /** 装载一个期望行；返回跳过原因（有则不建装载实例），undefined = 已发起装载。 */
  private async mountServer(project: ProjectEntry, item: DesiredProjectRow): Promise<string | undefined> {
    if (this.disposed) return undefined;
    const key = projectKeyOf(project.projectRoot);
    const effectiveName = this.effective.get(key + "\u0000" + item.rawName);
    if (effectiveName === undefined) return undefined;
    await this.writeDiag(project.projectRoot, { kind: "attempt", rawName: item.rawName, effectiveName });
    let config: Record<string, unknown>;
    try {
      let input = inputFromPatchRow(item.row);
      // ${VAR} 串内插值展开对所有来源统一（CLI 按 CC 习惯写进原生 yml 的
      // Bearer ${TOKEN} 也要生效）；值不含 ${NAME} 引用的行行为不变。
      const expanded = expandEnvRefs(input, process.env);
      if (!expanded.ok) {
        await this.writeDiag(project.projectRoot, { kind: "env-missing", rawName: item.rawName, effectiveName, missingVar: expanded.missingVar });
        this.ctx.logger.warn(`项目 MCP "${item.rawName}"（${project.projectRoot}）未装载：环境变量 \${${expanded.missingVar}} 未设置`);
        return "env-missing";
      }
      input = expanded.input;
      // 展开后的值可能不再合法（占位 `${URL}` 骗过了装载前 schema），补跑一次校验，
      // 让错误在这里以诊断形式落地，而不是留给 ctx.plugin 炸 plugin-throw。
      const revalidated = mcpServerInputSchema.safeParse(input);
      if (!revalidated.success) {
        const note = revalidated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        await this.writeDiag(project.projectRoot, { kind: "env-invalid", rawName: item.rawName, effectiveName, error: note });
        this.ctx.logger.warn(`项目 MCP "${item.rawName}"（${project.projectRoot}）配置无效：\${VAR} 展开后校验失败（${note}）`);
        return "env-invalid";
      }
      input = revalidated.data;
      const configInput: any = { ...input, serverName: effectiveName };
      if (input.transport === "stdio") {
        if (typeof input.cwd === "string" && input.cwd !== "") {
          configInput.cwd = resolve(project.projectRoot, input.cwd);
        } else if (item.source === undefined || item.source === "yml" || item.source === "cc-project") {
          // 文档语义：项目层空 cwd = 项目根（手写 yml 行可整个省略 cwd）；
          // 用户层（user-yml / cc-user）空 cwd 保持继承宿主工作目录，不改写。
          configInput.cwd = project.projectRoot;
        }
      }
      config = toOfficialConfig(configInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeDiag(project.projectRoot, { kind: "config-invalid", rawName: item.rawName, error: message });
      this.ctx.logger.warn(`项目 MCP "${item.rawName}"（${project.projectRoot}）配置无效：${message}`);
      return "config-invalid";
    }
    let fiber: any;
    try {
      fiber = this.ctx.plugin(mcpClient as any, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeDiag(project.projectRoot, { kind: "plugin-throw", effectiveName, error: message });
      this.ctx.logger.error(`项目 MCP "${effectiveName}"（${project.projectRoot}）装载失败：${message}`);
      return "plugin-throw";
    }
    const state: ProjectServerState = {
      projectRoot: project.projectRoot,
      rawName: item.rawName,
      effectiveName,
      row: item.row,
      source: item.source,
      fiber,
      phase: "mounting"
    };
    project.servers.set(item.rawName, state);
    fiber.then(
      () => {
        if (this.projects.get(key) !== project || project.servers.get(item.rawName) !== state) return;
        state.phase = "active";
        state.error = undefined;
        // 诊断写必须排进 reconcile 链：异步回调里裸写会与之交叉丢行（read-modify-write 竞态）。
        this.enqueue(async () => {
          await this.writeDiag(project.projectRoot, { kind: "active", effectiveName });
        }).catch(() => {});
        this.kickSweep();
      },
      (error: unknown) => {
        if (this.projects.get(key) !== project || project.servers.get(item.rawName) !== state) return;
        state.phase = "failed";
        state.error = error instanceof Error ? error.message : String(error);
        this.enqueue(async () => {
          await this.writeDiag(project.projectRoot, { kind: "failed", effectiveName, error: state.error });
        }).catch(() => {});
        this.ctx.logger.error(`项目 MCP "${effectiveName}"（${project.projectRoot}）装载失败：${state.error}`);
        this.kickSweep();
      }
    );
    return undefined;
  }

  private async unmountServer(project: ProjectEntry, rawName: string) {
    const state = project.servers.get(rawName);
    if (state === undefined) return;
    project.servers.delete(rawName);
    state.phase = "unloading";
    try {
      await state.fiber?.dispose();
    } catch {
      // fiber 已随上下文销毁
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
    const groups: { projectRoot: string; effectiveNames: string[] }[] = [];
    for (const entry of this.projects.values()) {
      const names: string[] = [];
      for (const state of entry.servers.values()) {
        if (state.phase !== "active") continue;
        names.push(state.effectiveName);
      }
      if (names.length > 0) groups.push({ projectRoot: entry.projectRoot, effectiveNames: names });
    }
    // tools.restrict 的 deny 是精确工具名（"unknown names fail"），不是 serverName；
    // 把各服务器的 serverName 展开为它当前注册的全部工具名（mcp__<server>__*）。
    let schemas: any[] = [];
    try {
      schemas = this.ctx.tools?.schemas?.() ?? [];
    } catch {
      schemas = [];
    }
    const toolNamesOf = (serverName: string): string[] => {
      const prefix = "mcp__" + serverName + "__";
      return schemas
        .map((s) => String(s?.id ?? s?.name ?? ""))
        .filter((name) => name.startsWith(prefix));
    };
    for (const agent of this.liveAgents()) {
      const project = this.agentProjects.get(agent.id) ?? await this.resolveProject(agent);
      if (project !== undefined) this.agentProjects.set(agent.id, project);
      const toolDeny: string[] = [];
      for (const serverName of denySetFor(project, groups)) {
        toolDeny.push(...toolNamesOf(serverName));
      }
      this.applyRestriction(agent, toolDeny);
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

  /** 已执行的 reconcile 次数（测试用：验证 .claude.json 哈希门是否惊动管线）。 */
  get debugReconcileCount(): number {
    return this.reconcileCount;
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

  /** 行级 view；未装载时 phase 按行状态推导。行查找按影子优先序逐层进行。 */
  async serverView(projectRoot: string, rawName: string): Promise<any | undefined> {
    const key = projectKeyOf(projectRoot);
    const entry = this.projects.get(key);
    const state = entry?.servers.get(rawName);
    let row: PatchRow | undefined;
    let source: McpRowSource | undefined;
    try {
      const raw = await readPatchFile(projectMcpFile(projectRoot));
      row = extractManagedRows(raw).find((candidate) => rowNameOf(candidate) === rawName);
      if (row !== undefined) source = "yml";
    } catch {
      // 落到后续层
    }
    if (row === undefined) {
      const cc = await readMcpJsonFile(projectMcpJsonFile(projectRoot), projectRoot);
      const found = cc.rows.find((candidate) => candidate.rawName === rawName);
      if (found !== undefined) {
        row = found.row;
        source = "cc-project";
      }
    }
    if (row === undefined) {
      const uy = this.userLayer.ymlRows.find((candidate) => candidate.rawName === rawName);
      const uc = this.userLayer.cc?.rows.find((candidate) => candidate.rawName === rawName);
      if (uy !== undefined) {
        row = uy.row;
        source = "user-yml";
      } else if (uc !== undefined) {
        row = uc.row;
        source = "cc-user";
      }
    }
    if (row === undefined) {
      row = state?.row;
      source = state?.source;
    }
    if (row === undefined) return undefined;
    const view = patchRowToView(row, { kind: "workspace", path: projectRoot });
    if (view === undefined) return undefined;
    const effectiveName = this.effective.get(key + "\u0000" + rawName);
    const skipReason = state === undefined && row.disabled !== true ? this.skipReasons.get(key + "\u0000" + rawName) : undefined;
    return {
      ...view,
      ...(source === undefined ? {} : { source }),
      ...(effectiveName === undefined ? {} : { effectiveServerName: effectiveName }),
      fiberPhase: state === undefined ? (row.disabled === true ? null : "pending") : phaseToFiberPhase(state.phase),
      skipReason: skipReason ?? null,
      toolCount: state !== undefined && state.phase === "active" ? mcpToolCount(this.ctx, state.effectiveName) : 0
    };
  }

  /** 全量快照：每个已知项目一个 yml 分区 + 一个 .mcp.json 分区（有内容才出），外加两个用户层分区。 */
  async snapshot(): Promise<ProjectFileState[]> {
    await this.enqueue(async () => {
      await this.reconcileAll();
    });
    const out: ProjectFileState[] = [];
    for (const [key, entry] of this.projects) {
      const path = projectMcpFile(entry.projectRoot);
      const file: ProjectFileState = { project: entry.projectRoot, path, ok: true, error: null, source: "yml", servers: [] };
      let rows: PatchRow[] = [];
      let usable = true;
      let skipYmlPartition = false;
      try {
        rows = extractManagedRows(await readPatchFile(path));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // yml 缺失且没有 yml 来源的装载：文件本就不存在，不出 yml 分区——
        // 用户层行也能让项目有装载实例，servers.size>0 不再等价「装载后文件被删」。
        const ymlLive = [...entry.servers.values()].some((state) => state.source === "yml" || state.source === undefined);
        if (message.includes("ENOENT") && !ymlLive) {
          skipYmlPartition = true;
        } else {
          usable = false;
          file.ok = false;
          file.error = message;
        }
      }
      if (!skipYmlPartition) {
        if (usable) file.servers = this.partitionServers(entry, key, rows, "yml");
        out.push(file);
      }
      // ── 项目 .mcp.json 分区 ──
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
    // ── 用户层两个分区（无 fiberPhase：装载实例按项目分布，见各项目的 servers.state.source）──
    if (this.userLayer.mcpYml !== "" && (this.userLayer.ymlRows.length > 0 || this.userLayer.ymlError !== null)) {
      out.push({
        project: dirname(dirname(this.userLayer.mcpYml)),
        path: this.userLayer.mcpYml,
        kind: "global",
        source: "user-yml",
        ok: this.userLayer.ymlError === null,
        error: this.userLayer.ymlError,
        servers: this.userLayer.ymlRows
          .map((r) => patchRowToView(r.row, { kind: "global", path: this.userLayer.mcpYml, label: "user" }))
          .filter((v): v is NonNullable<typeof v> => v !== undefined)
          .map((v) => ({ ...v, source: "user-yml" as const }))
      });
    }
    const ccUser = this.userLayer.cc;
    if (ccUser !== null && ccUser !== undefined && (ccUser.rows.length > 0 || ccUser.fileError !== undefined || ccUser.entryErrors.length > 0)) {
      const file: ProjectFileState = {
        project: dirname(this.userLayer.claudeJson),
        path: this.userLayer.claudeJson,
        kind: "global",
        source: "cc-user",
        ok: ccUser.fileError === undefined,
        error: ccUser.fileError ?? null,
        servers: ccUser.rows
          .map((r) => patchRowToView(r.row, { kind: "global", path: this.userLayer.claudeJson, label: "user" }))
          .filter((v): v is NonNullable<typeof v> => v !== undefined)
          .map((v) => ({ ...v, source: "cc-user" as const }))
      };
      if (ccUser.entryErrors.length > 0) (file as any).entryErrors = ccUser.entryErrors;
      out.push(file);
    }
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
      const owned = state !== undefined && state.source === source;
      const effectiveName = this.effective.get(key + "\u0000" + rawName);
      const skipReason = state === undefined && row.disabled !== true ? this.skipReasons.get(key + "\u0000" + rawName) : undefined;
      out.push({
        ...view,
        source,
        ...(effectiveName === undefined ? {} : { effectiveServerName: effectiveName }),
        fiberPhase: state === undefined
          ? (row.disabled === true ? null : "pending")
          : owned
            ? phaseToFiberPhase(state.phase)
            : null, // 该名字由更高优先层装载：本分区行只作展示
        skipReason: skipReason ?? null, // env-missing / env-invalid / config-invalid / plugin-throw；fiberPhase 保持生命周期枚举
        toolCount: owned && state !== undefined && state.phase === "active" ? mcpToolCount(this.ctx, state.effectiveName) : 0
      });
    }
    return out;
  }
}
