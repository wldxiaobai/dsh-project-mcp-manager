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
 */
import chokidar from "chokidar";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";
import { extractManagedRows, readPatchFile, type PatchRow } from "./mcp-file.js";
import { findProjectRoot } from "./project-root.js";
import {
  denySetFor,
  effectiveServerNames,
  inputFromPatchRow,
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
}

export interface ProjectMcpRegistryOptions {
  /** 全局（profile patch / bundle 层）已装载 mcp-client 行的 serverName，用于生效名冲突判定。 */
  globalNames: () => Promise<string[]>;
}

interface ProjectEntry {
  projectRoot: string;
  servers: Map<string, ProjectServerState>; // rawName → state
}

/** 变更计划（纯函数，供测试）。 */
export interface DesiredProjectRow {
  rawName: string;
  row: PatchRow;
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

/** 项目文件绝对路径。 */
export function projectMcpFile(projectRoot: string): string {
  return join(projectRoot, ".dsh", PROJECT_MCP_FILE);
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
    const kick = (path: string) => {
      const parts = String(path ?? "").split(/[/\\]/).filter(Boolean);
      if (parts.length < 2 || parts[parts.length - 1] !== PROJECT_MCP_FILE || parts[parts.length - 2] !== ".dsh") return;
      this.kick();
    };
    watcher.on("add", kick);
    watcher.on("change", kick);
    watcher.on("unlink", kick);
    watcher.on("error", () => {
      // 保持监听；下一次事件仍会触发 reconcile
    });
    this.watcher = watcher;
  }

  // ── 核心 reconcile ───────────────────────────────────────────────────

  /**
   * 全量对账：重算项目集合 → 读全部项目文件 → 计算生效名 → 逐项目装载/
   * 卸载 → 重扫各会话 deny。文件事件、新 agent、插件热更都汇到这里。
   */
  async reconcileAll(): Promise<void> {
    if (this.disposed) return;
    await this.syncWatcher();

    const roots = await this.knownProjects();
    const desiredByProject = new Map<string, { projectRoot: string; rows: DesiredProjectRow[]; ok: boolean; error: string | null }>();
    for (const projectRoot of roots) {
      const key = projectKeyOf(projectRoot);
      const path = projectMcpFile(projectRoot);
      let rows: DesiredProjectRow[] = [];
      let ok = true;
      let error: string | null = null;
      try {
        const raw = await readPatchFile(path);
        for (const row of extractManagedRows(raw)) {
          const rawName = rowNameOf(row);
          if (rawName === undefined) continue;
          if (row.disabled === true) continue;
          rows.push({ rawName, row });
        }
      } catch (catchError) {
        const message = catchError instanceof Error ? catchError.message : String(catchError);
        // 「配置文件不存在」(ENOENT) 只有在该项目确实有活着的装载时才算异常——
        // 意味着文件在装载之后被删/移走。零配置项目缺文件是常态：不能用
        // projects.has(key) 当判据，空项目条目也会让它恒真（误报根因）。
        const liveServers = this.projects.get(key)?.servers.size ?? 0;
        if (liveServers > 0 || !message.includes("ENOENT")) {
          ok = false;
          error = message;
        }
        rows = [];
      }
      desiredByProject.set(key, { projectRoot, rows, ok, error });
      // 诊断只记有信息量的扫描：异常，或确实解析出了配置行。干净且无配置的
      // 项目不写任何记录——否则每个被访问过的目录都会凭空多出 .dsh/.mcp-diag.json。
      if (!ok || rows.length > 0) {
        await this.writeDiag(projectRoot, { kind: "scan", ok, error, rows: rows.map((row) => row.rawName) });
      }
    }

    const catalogProjects = [...desiredByProject.values()]
      .filter((entry) => entry.ok)
      .map((entry) => ({ projectRoot: entry.projectRoot, names: entry.rows.map((row) => row.rawName) }));
    const globalNames = await this.providers.globalNames().catch(() => []);
    this.effective = effectiveServerNames(catalogProjects, globalNames);

    for (const [key, entry] of desiredByProject) {
      await this.reconcileProject(key, entry);
    }
    await this.sweepRestrictions();
  }

  private async reconcileProject(key: string, entry: { projectRoot: string; rows: DesiredProjectRow[]; ok: boolean; error: string | null }) {
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
    // 先卸载（同名重装载必须先释放 serverName 预留），再装载。
    for (const rawName of plan.toUnmount) await this.unmountServer(project, rawName);
    for (const item of plan.toMount) await this.mountServer(project, item);
  }

  // ── 装载诊断（写 <projectRoot>/.dsh/.mcp-diag.json，宿主日志不可见时定位失败）──
  // 调用方只在有异常或有配置行时写入：无配置的干净项目不创建该文件。

  private async writeDiag(projectRoot: string, event: Record<string, unknown>): Promise<void> {
    try {
      const path = join(projectRoot, ".dsh", ".mcp-diag.json");
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
      await writeFile(path, JSON.stringify(lines, null, 2), "utf8");
    } catch {
      // 诊断失败不影响主流程
    }
  }

  private async mountServer(project: ProjectEntry, item: DesiredProjectRow) {
    if (this.disposed) return;
    const key = projectKeyOf(project.projectRoot);
    const effectiveName = this.effective.get(key + "\u0000" + item.rawName);
    if (effectiveName === undefined) return;
    await this.writeDiag(project.projectRoot, { kind: "attempt", rawName: item.rawName, effectiveName });
    let config: Record<string, unknown>;
    try {
      const input = inputFromPatchRow(item.row);
      const configInput: any = { ...input, serverName: effectiveName };
      if (input.transport === "stdio" && typeof input.cwd === "string" && input.cwd !== "") {
        configInput.cwd = resolve(project.projectRoot, input.cwd);
      }
      config = toOfficialConfig(configInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeDiag(project.projectRoot, { kind: "config-invalid", rawName: item.rawName, error: message });
      this.ctx.logger.warn(`项目 MCP "${item.rawName}"（${project.projectRoot}）配置无效：${message}`);
      return;
    }
    let fiber: any;
    try {
      fiber = this.ctx.plugin(mcpClient as any, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeDiag(project.projectRoot, { kind: "plugin-throw", effectiveName, error: message });
      this.ctx.logger.error(`项目 MCP "${effectiveName}"（${project.projectRoot}）装载失败：${message}`);
      return;
    }
    const state: ProjectServerState = {
      projectRoot: project.projectRoot,
      rawName: item.rawName,
      effectiveName,
      row: item.row,
      fiber,
      phase: "mounting"
    };
    project.servers.set(item.rawName, state);
    fiber.then(
      () => {
        if (this.projects.get(key) !== project || project.servers.get(item.rawName) !== state) return;
        state.phase = "active";
        state.error = undefined;
        void this.writeDiag(project.projectRoot, { kind: "active", effectiveName });
        this.kickSweep();
      },
      (error: unknown) => {
        if (this.projects.get(key) !== project || project.servers.get(item.rawName) !== state) return;
        state.phase = "failed";
        state.error = error instanceof Error ? error.message : String(error);
        void this.writeDiag(project.projectRoot, { kind: "failed", effectiveName, error: state.error });
        this.ctx.logger.error(`项目 MCP "${effectiveName}"（${project.projectRoot}）装载失败：${state.error}`);
        this.kickSweep();
      }
    );
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

  /** 行级 view；未装载时 phase 按行状态推导。 */
  async serverView(projectRoot: string, rawName: string): Promise<any | undefined> {
    const key = projectKeyOf(projectRoot);
    const entry = this.projects.get(key);
    if (entry === undefined) return undefined;
    const state = entry.servers.get(rawName);
    const path = projectMcpFile(projectRoot);
    let row: PatchRow | undefined;
    try {
      const raw = await readPatchFile(path);
      row = extractManagedRows(raw).find((candidate) => rowNameOf(candidate) === rawName);
    } catch {
      row = state?.row;
    }
    if (row === undefined) return undefined;
    const view = patchRowToView(row, { kind: "workspace", path: projectRoot });
    if (view === undefined) return undefined;
    const effectiveName = this.effective.get(key + "\u0000" + rawName);
    return {
      ...view,
      ...(effectiveName === undefined ? {} : { effectiveServerName: effectiveName }),
      fiberPhase: state === undefined ? (row.disabled === true ? null : "pending") : phaseToFiberPhase(state.phase),
      toolCount: state !== undefined && state.phase === "active" ? mcpToolCount(this.ctx, state.effectiveName) : 0
    };
  }

  /** 全量快照：每个已知项目一个文件分区。 */
  async snapshot(): Promise<ProjectFileState[]> {
    await this.enqueue(async () => {
      await this.reconcileAll();
    });
    const out: ProjectFileState[] = [];
    for (const [key, entry] of this.projects) {
      const path = projectMcpFile(entry.projectRoot);
      const file: ProjectFileState = { project: entry.projectRoot, path, ok: true, error: null, servers: [] };
      let raw: string | undefined;
      try {
        raw = await readPatchFile(path);
      } catch (error) {
        if (entry.servers.size === 0) continue; // 无配置文件且无装载：不展示
        file.ok = false;
        file.error = error instanceof Error ? error.message : String(error);
        out.push(file);
        continue;
      }
      let rows: PatchRow[];
      try {
        rows = extractManagedRows(raw);
      } catch (error) {
        // 受管块损坏 / 不支持的标签（如 !!js）：只标该文件失败，不炸全局快照。
        file.ok = false;
        file.error = error instanceof Error ? error.message : String(error);
        out.push(file);
        continue;
      }
      for (const row of rows) {
        const rawName = rowNameOf(row);
        if (rawName === undefined) continue;
        const view = patchRowToView(row, { kind: "workspace", path: entry.projectRoot });
        if (view === undefined) continue;
        const state = entry.servers.get(rawName);
        const effectiveName = this.effective.get(key + "\u0000" + rawName);
        file.servers.push({
          ...view,
          ...(effectiveName === undefined ? {} : { effectiveServerName: effectiveName }),
          fiberPhase: state === undefined ? (row.disabled === true ? null : "pending") : phaseToFiberPhase(state.phase),
          toolCount: state !== undefined && state.phase === "active" ? mcpToolCount(this.ctx, state.effectiveName) : 0
        });
      }
      out.push(file);
    }
    return out;
  }
}
