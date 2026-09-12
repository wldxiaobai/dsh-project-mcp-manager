/**
 * 其它插件 / 宿主 UI 经 cordis 服务面查询本插件状态。
 *
 * 服务名 `projectMcp` 与方法集**不承诺稳定 API**（提案 B3）：`snapshot` /
 * `serverView` / `globalState` 只读内存态，不触发对账；`reload` 才跑一次
 * reconcileAll。插件原有导出（`inject`、`globalNames()`、`activeProfile()`）不变。
 */
import type { McpServerRuntimeView, ProjectFileState, ProjectMcpRegistry, ProjectServerState } from "./registry.js";

/** cordis 服务名；经 `ctx.provide` / `ctx.get` / `ctx.projectMcp` 取用。 */
export const PROJECT_MCP_SERVICE = "projectMcp";

export interface ProjectMcpService {
  /** 只读内存快照；不触发对账。 */
  snapshot(): Promise<ProjectFileState[]>;
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
