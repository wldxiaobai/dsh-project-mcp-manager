/** Host route payloads shared by the settings panel. No secrets. */

export const MCP_UI_STATE_PATH = "/api/project-mcp/state";
export const MCP_UI_EVENTS_PATH = "/api/project-mcp/events";
export const MCP_UI_OPEN_PATH = "/api/project-mcp/open";
export const MCP_UI_SERVER_PATH = "/api/project-mcp/server";
export const MCP_UI_ADD_PATH = "/api/project-mcp/add";
export const MCP_UI_TOOL_PATH = "/api/project-mcp/tool";
export const MCP_UI_TOOLS_PATH = "/api/project-mcp/tools";

export type McpUiLayer = "project" | "user";

export interface McpUiServer {
  serverName: string;
  mode?: "eager" | "lazy";
  source: string;
  /** 工作区路径，用于显示与写回请求。用户层 / profile 层是配置文件所在目录。 */
  projectRoot: string;
  /**
   * 宿主用核心 `projectKeyOf()` 算好的工作区身份键（Windows 下已小写化）。
   * 浏览器只用它判断「是不是同一个工作区」，不自己规范化路径：浏览器可能
   * 远程访问另一个平台的宿主。用户层 / profile 层为空串。
   */
  projectKey: string;
  filePath: string;
  managedPath: string | null;
  /** 来源不是受管 yml 时，写入会在 managedPath 新建或修改一条更高优先级的记录。 */
  needsYmlTakeover: boolean;
  layer: McpUiLayer;
  enabled: boolean;
  active: boolean;
  fiberPhase: string | null;
  skipReason: string | null;
  toolCount: number;
  endpoint: string;
  /** 与装载器服务身份键相同。null 表示这行没有可比较的命令或地址。 */
  serviceKey: string | null;
}

export interface McpUiOpenTarget {
  id: string;
  label: string;
  path: string;
  source: string;
  projectRoot: string;
}

/** 添加对话框的写入位置。id 是 project | user | profile。 */
export interface McpUiWriteTarget {
  id: "project" | "user" | "profile";
  source: string;
  projectRoot: string;
  path: string;
}

export interface McpUiState {
  revision: number;
  servers: McpUiServer[];
  openTargets: McpUiOpenTarget[];
  writeTargets: McpUiWriteTarget[];
  /** 当前工作区（`writeTargets()` 的项目项）；多个工作区且尚无焦点时为 null。 */
  activeProject: string | null;
  /** `activeProject` 的工作区身份键（宿主 `projectKeyOf()`）；未确定时为 null。 */
  activeProjectKey: string | null;
  /** OS user home. The page uses it to show `~` for user and profile paths. */
  homeDir: string;
}

export interface McpUiTool {
  name: string;
  enabled: boolean;
}

export interface McpUiOk {
  ok: true;
  path?: string;
  tools?: McpUiTool[];
}

export interface McpUiConfirm {
  ok: false;
  code: "confirm-yml";
  managedPath: string | null;
  filePath: string;
}

export interface McpUiErr {
  ok: false;
  code?: string;
  message: string;
}

export type McpUiResult = McpUiOk | McpUiConfirm | McpUiErr;
