/** Settings copy for the MCP panel. Keys are the locale dictionary. */

export type McpUiLocaleKey =
  | "tab"
  | "title"
  | "intro"
  | "open"
  | "refresh"
  | "projectLayer"
  | "userLayer"
  | "empty"
  | "loading"
  | "error"
  | "active"
  | "inactive"
  | "tools"
  | "toolsTitle"
  | "toolsEmpty"
  | "toolsClose"
  | "remove"
  | "cancel"
  | "continueWrite"
  | "takeoverTitle"
  | "takeoverBody"
  | "removeTitle"
  | "removeBody"
  | "enableLabel"
  | "toolEnableLabel"
  | "userFile"
  | "profileFile"
  | "projectFile"
  | "readOnlySource";

export const en: Record<McpUiLocaleKey, string> = {
  tab: "MCP",
  title: "MCP",
  intro: "Servers this profile can read. Edits are written only to the managed mcp.yml for that scope.",
  open: "Open config",
  refresh: "Refresh",
  projectLayer: "Project",
  userLayer: "User",
  empty: "No MCP servers are visible yet. Opening a workspace loads that directory's config; if a workspace you just opened is still missing, use Refresh.",
  loading: "Loading…",
  error: "Could not read MCP state.",
  active: "Active",
  inactive: "Inactive",
  tools: "Tools",
  toolsTitle: "Tools · {name}",
  toolsEmpty: "This server has no registered tools yet.",
  toolsClose: "Close",
  remove: "Remove",
  cancel: "Cancel",
  continueWrite: "Write yml",
  takeoverTitle: "This file is not the managed yml",
  takeoverBody: "“{name}” is read from {file}. Continuing creates or updates a higher-priority row in the managed block of {yml}. The original file stays unchanged, and this copy is what later loads.",
  removeTitle: "Remove {name}?",
  removeBody: "This removes the row from {yml}. A copy that only exists in another file is kept there and covered by a disabled placeholder, so it does not start again.",
  enableLabel: "Enabled",
  toolEnableLabel: "Tool {name}",
  userFile: "User mcp.yml",
  profileFile: "Profile mcp.yml",
  projectFile: "Project mcp.yml",
  readOnlySource: "Read from another file"
};

export const zh: Record<McpUiLocaleKey, string> = {
  tab: "MCP",
  title: "MCP",
  intro: "当前 profile 能读到的 MCP。修改只写入该作用域的受管 mcp.yml。",
  open: "打开配置文件",
  refresh: "刷新",
  projectLayer: "项目层",
  userLayer: "用户层",
  empty: "当前没有可读到的 MCP 服务器。打开工作区会自动装载该目录的配置；若刚打开的工作区仍不在列表里，点刷新。",
  loading: "正在读取…",
  error: "读取 MCP 状态失败。",
  active: "已激活",
  inactive: "未激活",
  tools: "工具状态",
  toolsTitle: "工具状态 · {name}",
  toolsEmpty: "这台服务器还没有已注册的工具。",
  toolsClose: "关闭",
  remove: "删除",
  cancel: "取消",
  continueWrite: "写入 yml",
  takeoverTitle: "这份文件不是受管 yml",
  takeoverBody: "“{name}”读取自 {file}。继续后会在 {yml} 的受管块里新建或修改一条优先级更高的记录。原文件保持不变，之后以这条 yml 为准。",
  removeTitle: "删除 {name}？",
  removeBody: "将从 {yml} 的受管块移除这一条。若它只存在于别的文件，原文件不删，改为写入 disabled 占位，避免它再次装载。",
  enableLabel: "启用",
  toolEnableLabel: "工具 {name}",
  userFile: "用户层 mcp.yml",
  profileFile: "当前 profile 的 mcp.yml",
  projectFile: "项目 mcp.yml",
  readOnlySource: "来自其他文件"
};
