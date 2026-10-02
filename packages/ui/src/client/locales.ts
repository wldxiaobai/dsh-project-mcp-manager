/** Settings copy for the MCP panel. Keys are the locale dictionary. */

export type McpUiLocaleKey =
  | "tab"
  | "intro"
  | "open"
  | "add"
  | "addTitle"
  | "addDescription"
  | "addScope"
  | "addScopeProject"
  | "addScopeUser"
  | "addScopeProfile"
  | "addNoWorkspace"
  | "addNoProfile"
  | "addWhere"
  | "addTransport"
  | "addTransportStdio"
  | "addTransportHttp"
  | "addName"
  | "addNamePlaceholder"
  | "addCommand"
  | "addCommandPlaceholder"
  | "addArgs"
  | "addArgsPlaceholder"
  | "addUrl"
  | "addUrlPlaceholder"
  | "addEnv"
  | "addEnvPlaceholder"
  | "addHeaders"
  | "addHeadersPlaceholder"
  | "addSubmit"
  | "addNameInvalid"
  | "addCommandRequired"
  | "addUrlRequired"
  | "addPairInvalid"
  | "addNoTarget"
  | "projectLayer"
  | "userLayer"
  | "empty"
  | "loading"
  | "error"
  | "statusRunning"
  | "statusRunningDetail"
  | "statusIdle"
  | "statusIdleDetail"
  | "statusOff"
  | "statusOffDetail"
  | "statusStarting"
  | "statusStartingDetail"
  | "statusFailed"
  | "statusUnmounted"
  | "skipNameTaken"
  | "skipEnvMissing"
  | "skipEnvInvalid"
  | "skipGiveUp"
  | "skipConfigInvalid"
  | "skipOther"
  | "sourceDetail"
  | "readOnlyDetail"
  | "endpointCmd"
  | "endpointUrl"
  | "tools"
  | "toolsCount"
  | "toolsTitle"
  | "toolsEmpty"
  | "toolsClose"
  | "remove"
  | "cancel"
  | "continueWrite"
  | "takeoverTitle"
  | "takeoverWill"
  | "takeoverWont"
  | "removeTitle"
  | "removeWill"
  | "removeWont"
  | "enableLabel"
  | "toolEnableLabel"
  | "userFile"
  | "profileFile"
  | "projectFile";

export const en: Record<McpUiLocaleKey, string> = {
  tab: "MCP",
  intro: "Servers available to this profile. Add, the switch, and Remove write the managed mcp.yml. A server read from another file asks before that yml is updated.",
  open: "Edit managed yml",
  add: "Add MCP",
  addTitle: "Add MCP",
  addDescription: "Confirm writes a row into the managed mcp.yml. A running session loads it on its own.",
  addScope: "Save to",
  addScopeProject: "Workspace",
  addScopeUser: "User",
  addScopeProfile: "Profile",
  addNoWorkspace: "No workspace is open. Open a session first.",
  addNoProfile: "No active profile was found.",
  addWhere: "Writes {path}",
  addTransport: "Type",
  addTransportStdio: "Local command",
  addTransportHttp: "Remote URL",
  addName: "Name",
  addNamePlaceholder: "gitlab",
  addCommand: "Command",
  addCommandPlaceholder: "npx",
  addArgs: "Arguments (optional, one per line)",
  addArgsPlaceholder: "-y\n@modelcontextprotocol/server-gitlab",
  addUrl: "URL",
  addUrlPlaceholder: "https://mcp.example.com/mcp",
  addEnv: "Environment (optional, KEY=value)",
  addEnvPlaceholder: "GITLAB_TOKEN=${GITLAB_TOKEN}",
  addHeaders: "Headers (optional, Name: value)",
  addHeadersPlaceholder: "Authorization: Bearer ${TOKEN}",
  addSubmit: "Add",
  addNameInvalid: "Use 1–32 letters, digits, underscores, or hyphens.",
  addCommandRequired: "Enter the command to run.",
  addUrlRequired: "Enter the server URL.",
  addPairInvalid: "Cannot read this line: {line}",
  addNoTarget: "That save location is not available. Close this and open Add MCP again.",
  projectLayer: "Project",
  userLayer: "User",
  empty: "No MCP servers yet. Choose Add MCP and fill in a name and command or URL.",
  loading: "Loading…",
  error: "Could not read MCP state.",
  statusRunning: "Running",
  statusRunningDetail: "Enabled, and mounted for the workspace you are in.",
  statusIdle: "Enabled · not mounted",
  statusIdleDetail: "The switch is on, but no session is using this workspace, so it has not been started.",
  statusOff: "Off",
  statusOffDetail: "The switch is off, so this server will not start.",
  statusStarting: "Starting",
  statusStartingDetail: "Enabled, and the connection is still coming up.",
  statusFailed: "Failed to start",
  statusUnmounted: "Not mounted",
  skipNameTaken: "Another server already uses this name, so this one did not start.",
  skipEnvMissing: "An environment variable in the config is missing, so this one did not start.",
  skipEnvInvalid: "The config is invalid after expanding environment variables, so this one did not start.",
  skipGiveUp: "It still had no tools after several reconnects, so retries stopped.",
  skipConfigInvalid: "The config is invalid, so this one did not start.",
  skipOther: "It did not start ({reason}).",
  sourceDetail: "Read from {file}.",
  readOnlyDetail: "That file is not the managed yml. Saving asks first, then writes the yml.",
  endpointCmd: "cmd",
  endpointUrl: "url",
  tools: "Manage tools",
  toolsCount: "Manage tools ({count})",
  toolsTitle: "Tools · {name}",
  toolsEmpty: "This server has no registered tools yet.",
  toolsClose: "Close",
  remove: "Remove",
  cancel: "Cancel",
  continueWrite: "Write yml",
  takeoverTitle: "This file is not the managed yml",
  takeoverWill: "Continuing writes a higher-priority row in the managed yml. Later loads use that row.",
  takeoverWont: "Leaves {file} unchanged. Writes to {yml}.",
  removeTitle: "Remove {name}?",
  removeWill: "Deletes “{name}” from the managed yml.",
  removeWont: "If a copy remains in another file, that file stays, and a disabled placeholder is written so it does not start again.",
  enableLabel: "Enabled",
  toolEnableLabel: "Tool {name}",
  userFile: "User mcp.yml",
  profileFile: "Profile mcp.yml",
  projectFile: "Project mcp.yml"
};

export const zh: Record<McpUiLocaleKey, string> = {
  tab: "MCP",
  intro: "这里列出当前能用的 MCP。添加、开关和删除都写入受管的 mcp.yml。从别的文件读到的服务器，改动前会先确认，再写入这份 yml。",
  open: "编辑受管 yml",
  add: "添加 MCP",
  addTitle: "添加 MCP",
  addDescription: "确认后写入受管 mcp.yml。正在运行的会话会自己装载。",
  addScope: "保存到",
  addScopeProject: "工作区",
  addScopeUser: "用户",
  addScopeProfile: "Profile",
  addNoWorkspace: "还没有打开工作区。先打开一个会话。",
  addNoProfile: "没有解析到当前 profile。",
  addWhere: "将写入 {path}",
  addTransport: "类型",
  addTransportStdio: "本地命令",
  addTransportHttp: "远程地址",
  addName: "名称",
  addNamePlaceholder: "gitlab",
  addCommand: "命令",
  addCommandPlaceholder: "npx",
  addArgs: "参数（可选，每行一个）",
  addArgsPlaceholder: "-y\n@modelcontextprotocol/server-gitlab",
  addUrl: "地址",
  addUrlPlaceholder: "https://mcp.example.com/mcp",
  addEnv: "环境变量（可选，每行 KEY=值）",
  addEnvPlaceholder: "GITLAB_TOKEN=${GITLAB_TOKEN}",
  addHeaders: "请求头（可选，每行 名称: 值）",
  addHeadersPlaceholder: "Authorization: Bearer ${TOKEN}",
  addSubmit: "添加",
  addNameInvalid: "名称只能是 1–32 位字母、数字、下划线或连字符。",
  addCommandRequired: "填写要运行的命令。",
  addUrlRequired: "填写服务器地址。",
  addPairInvalid: "这一行无法识别：{line}",
  addNoTarget: "这个保存位置现在不可用。关掉窗口后重新点「添加 MCP」。",
  projectLayer: "项目层",
  userLayer: "用户层",
  empty: "还没有 MCP 服务器。点「添加 MCP」，填写名称和命令或地址。",
  loading: "正在读取…",
  error: "读取 MCP 状态失败。",
  statusRunning: "运行中",
  statusRunningDetail: "已启用，并且已经挂到当前工作区。",
  statusIdle: "已启用 · 未挂载",
  statusIdleDetail: "开关是开的，但当前没有正在使用这个工作区的会话，所以没有启动。",
  statusOff: "已关闭",
  statusOffDetail: "开关已关，不会启动。",
  statusStarting: "正在启动",
  statusStartingDetail: "已启用，连接还在建立。",
  statusFailed: "启动失败",
  statusUnmounted: "未挂载",
  skipNameTaken: "已经有同名服务器，这一条没有启动。",
  skipEnvMissing: "配置引用的环境变量没有值，这一条没有启动。",
  skipEnvInvalid: "环境变量展开后配置不合法，这一条没有启动。",
  skipGiveUp: "多次重连仍然没有工具，已停止重试。",
  skipConfigInvalid: "配置不合法，这一条没有启动。",
  skipOther: "没有启动（{reason}）。",
  sourceDetail: "读取自 {file}。",
  readOnlyDetail: "这份文件不是受管 yml。修改前会先确认，再写入 yml。",
  endpointCmd: "命令",
  endpointUrl: "地址",
  tools: "管理工具",
  toolsCount: "管理工具 ({count})",
  toolsTitle: "工具 · {name}",
  toolsEmpty: "这台服务器还没有已注册的工具。",
  toolsClose: "关闭",
  remove: "删除",
  cancel: "取消",
  continueWrite: "写入 yml",
  takeoverTitle: "这份文件不是受管 yml",
  takeoverWill: "继续后，会在受管 yml 里写一条更高优先级的记录，之后以它为准。",
  takeoverWont: "不会修改 {file}。写入位置：{yml}。",
  removeTitle: "删除 {name}？",
  removeWill: "从受管 yml 里删掉「{name}」。",
  removeWont: "如果它还写在别的文件里，那个文件不动，只加一条禁用占位，避免再次启动。",
  enableLabel: "启用",
  toolEnableLabel: "工具 {name}",
  userFile: "用户层 mcp.yml",
  profileFile: "当前 profile 的 mcp.yml",
  projectFile: "项目 mcp.yml"
};
