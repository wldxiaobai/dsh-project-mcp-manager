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
  source: string;
  projectRoot: string;
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
