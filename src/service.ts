/**
 * 其它插件 / 配套 UI 经 cordis 服务面查询本插件状态。
 *
 * 服务名 `projectMcp`、方法集、`projectMcp/updated` 事件，以及包入口导出的
 * 视图类型，对配套 UI **按语义化版本承诺**（提案 B3 的「不承诺稳定」自该消费方
 * 独立成包起不再作为现行口径）。`snapshot` / `serverView` / `globalState`
 * 只读上一轮对账的内存态（查询进 enqueue 与对账互斥，不读盘、不跑
 * reconcileAll）；`reload` 才跑一次 reconcileAll。对账成功结束由 registry
 * `ctx.emit(PROJECT_MCP_UPDATED_EVENT)`，无载荷。插件原有导出（`inject`、
 * `globalNames()`、`activeProfile()`）不变。
 */
import type { McpServerRuntimeView, ProjectFileState, ProjectMcpRegistry, ProjectServerState } from "./registry.js";
import type { McpRowSource } from "./json-file.js";

/** cordis 服务名；经 `ctx.provide` / `ctx.get` / `ctx.projectMcp` 取用。 */
export const PROJECT_MCP_SERVICE = "projectMcp";

/**
 * 一次全量对账成功结束后发出的 cordis 事件名。无载荷。
 * 监听方再读 `snapshot()`；本包不打开浏览器 SSE。
 */
export const PROJECT_MCP_UPDATED_EVENT = "projectMcp/updated";

export interface ProjectMcpService {
  /** 只读上一轮对账的内存快照；进 enqueue 与对账互斥，不读盘、不触发对账。 */
  snapshot(): Promise<ProjectFileState[]>;
  /** 行级内存 view；进 enqueue 与对账互斥，不读盘。 */
  serverView(projectRoot: string, rawName: string): Promise<McpServerRuntimeView | undefined>;
  globalState(rawName: string): ProjectServerState | undefined;
  /** 触发一次全量对账（等同 `registry.reconcileNow()`）。 */
  reload(): Promise<void>;
  /** 打开该来源对应作用域的受管 yml（经宿主注入的 openPath）；返回文件路径。 */
  openConfigFile(source: McpRowSource, projectRoot: string): Promise<string>;
  /** 启用/停用一台服务器（只写受管 yml；其它来源落同身份行或 disabled 占位）。 */
  setServerEnabled(source: McpRowSource, projectRoot: string, rawName: string, enabled: boolean): Promise<string>;
  /** 删除一台服务器（yml 行就地移除；其它来源落 disabled 占位行遮蔽）。 */
  removeServer(source: McpRowSource, projectRoot: string, rawName: string): Promise<string>;
  /** 单个工具的可见开关（写入受管 yml 的 tools.allow/deny）。 */
  setToolEnabled(source: McpRowSource, projectRoot: string, rawName: string, tool: string, enabled: boolean): Promise<string>;
  /** 一台服务器当前已注册工具的逐项可见性（短名）；未装载返回空列表。 */
  toolStates(projectRoot: string, rawName: string): { name: string; enabled: boolean }[];
  /** 该来源对应作用域的受管 yml 路径（只读层/解析不出 profile 时为 undefined）。 */
  managedPathFor(source: McpRowSource, projectRoot: string): string | undefined;
}

export function bindProjectMcpService(registry: ProjectMcpRegistry): ProjectMcpService {
  return {
    snapshot: () => registry.snapshot(),
    serverView: (projectRoot, rawName) => registry.serverView(projectRoot, rawName),
    globalState: (rawName) => registry.globalState(rawName),
    reload: () => registry.reconcileNow(),
    openConfigFile: (source, projectRoot) => registry.openConfigFile(source, projectRoot),
    setServerEnabled: (source, projectRoot, rawName, enabled) => registry.setServerEnabled(source, projectRoot, rawName, enabled),
    removeServer: (source, projectRoot, rawName) => registry.removeServer(source, projectRoot, rawName),
    setToolEnabled: (source, projectRoot, rawName, tool, enabled) => registry.setToolEnabled(source, projectRoot, rawName, tool, enabled),
    toolStates: (projectRoot, rawName) => registry.toolStates(projectRoot, rawName),
    managedPathFor: (source, projectRoot) => registry.managedPathFor(source, projectRoot)
  };
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    projectMcp: ProjectMcpService;
  }

  interface Events {
    /**
     * 一次全量对账成功结束。无载荷。
     * 监听方再读 `projectMcp.snapshot()`；本事件不带 diff，也不打开浏览器 SSE。
     */
    "projectMcp/updated"(): void;
  }
}
