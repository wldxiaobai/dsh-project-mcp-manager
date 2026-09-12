/**
 * 其它插件 / 宿主 UI 经 cordis 服务面查询本插件状态。
 *
 * 服务名 `projectMcp` 与方法集**不承诺稳定 API**（提案 B3）：`snapshot` /
 * `serverView` / `globalState` 只读上一轮对账的内存态（查询进 enqueue 与对账
 * 互斥，不读盘、不跑 reconcileAll）；`reload` 才跑一次 reconcileAll。
 * 插件原有导出（`inject`、`globalNames()`、`activeProfile()`）不变。
 */
import type { McpServerRuntimeView, ProjectFileState, ProjectMcpRegistry, ProjectServerState } from "./registry.js";

/** cordis 服务名；经 `ctx.provide` / `ctx.get` / `ctx.projectMcp` 取用。 */
export const PROJECT_MCP_SERVICE = "projectMcp";

export interface ProjectMcpService {
  /** 只读上一轮对账的内存快照；进 enqueue 与对账互斥，不读盘、不触发对账。 */
  snapshot(): Promise<ProjectFileState[]>;
  /** 行级内存 view；进 enqueue 与对账互斥，不读盘。 */
  serverView(projectRoot: string, rawName: string): Promise<McpServerRuntimeView | undefined>;
  globalState(rawName: string): ProjectServerState | undefined;
  /** 触发一次全量对账（等同 `registry.reconcileNow()`）。 */
  reload(): Promise<void>;
}

export function bindProjectMcpService(registry: ProjectMcpRegistry): ProjectMcpService {
  return {
    snapshot: () => registry.snapshot(),
    serverView: (projectRoot, rawName) => registry.serverView(projectRoot, rawName),
    globalState: (rawName) => registry.globalState(rawName),
    reload: () => registry.reconcileNow()
  };
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    projectMcp: ProjectMcpService;
  }
}
