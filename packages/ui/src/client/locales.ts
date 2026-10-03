/** Settings copy for the MCP panel. Keys are the locale dictionary. */

export type McpUiLocaleKey =
  | "tab"
  | "intro"
  | "introHelp"
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
  | "addPaste"
  | "addPasteDenied"
  | "addPasteEmpty"
  | "addPasteParse"
  | "addPasteNone"
  | "addPasteSse"
  | "addPasteBoth"
  | "addPasteCommand"
  | "addPasteUrl"
  | "addPasteFields"
  | "addPasteTransport"
  | "addPasteSkipped"
  | "addNameInvalid"
  | "addCommandRequired"
  | "addUrlRequired"
  | "addPairInvalid"
  | "addNoTarget"
  | "projectLayer"
  | "profileLayer"
  | "profileLayerPlain"
  | "profileDesktop"
  | "profileWeb"
  | "profileNamed"
  | "userLayer"
  | "serverCount"
  | "empty"
  | "loading"
  | "error"
  | "statusRunning"
  | "statusRunningOne"
  | "statusRunningCount"
  | "statusIdle"
  | "statusOff"
  | "statusStarting"
  | "statusFailed"
  | "statusUnmounted"
  | "statusNameTaken"
  | "statusEnvMissing"
  | "statusEnvInvalid"
  | "statusGiveUp"
  | "statusConfigInvalid"
  | "skipNameTaken"
  | "skipEnvMissing"
  | "skipEnvInvalid"
  | "skipGiveUp"
  | "skipConfigInvalid"
  | "skipOther"
  | "badgeTakeover"
  | "badgeTakeoverHint"
  | "shadowedNote"
  | "shadowedIdentityNote"
  | "endpointCmd"
  | "endpointUrl"
  | "tools"
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
  | "workspaceLocked"
  | "toolEnableLabel"
  | "userFile"
  | "profileFile"
  | "profileFileNamed"
  | "projectFile";

export const en: Record<McpUiLocaleKey, string> = {
  tab: "Plugin: MCP Manager",
  intro: "MCP servers available right now.",
  introHelp: "Adding, switching, and removing write to the mcp.yml managed by the mcp-manager plugin.\nFor a server read from another file, you confirm first, then the managed mcp.yml is written.",
  open: "MCP config",
  add: "Add MCP",
  addTitle: "Add MCP",
  addDescription: "Adding writes to the mcp.yml managed by the mcp-manager plugin. Running sessions load it automatically.",
  addScope: "Save to",
  addScopeProject: "Workspace",
  addScopeUser: "User",
  addScopeProfile: "Profile",
  addNoWorkspace: "No workspace is open. Open a session first.",
  addNoProfile: "No active profile was found.",
  addWhere: "Writes to {path}",
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
  addEnv: "Environment variables (optional, one KEY=value per line)",
  addEnvPlaceholder: "GITLAB_TOKEN=${GITLAB_TOKEN}",
  addHeaders: "Headers (optional, one Name: value per line)",
  addHeadersPlaceholder: "Authorization: Bearer ${TOKEN}",
  addSubmit: "Add",
  addPaste: "Fill from clipboard",
  addPasteDenied: "Couldn't read the clipboard. Allow clipboard access and try again.",
  addPasteEmpty: "The clipboard is empty.",
  addPasteParse: "The clipboard content is not JSON or YAML.",
  addPasteNone: "No MCP server was found in the clipboard.",
  addPasteSse: "This entry uses the SSE transport. The form only supports a local command or a remote URL.",
  addPasteBoth: "The config sets both a command and a URL. Keep one, or set type.",
  addPasteCommand: "This config has no command.",
  addPasteUrl: "This config has no URL.",
  addPasteFields: "Arguments, environment variables, or headers contain a value the form cannot hold.",
  addPasteTransport: "This transport type cannot be filled in as a local command or a remote URL.",
  addPasteSkipped: "The clipboard has more than one server. Filled in the first; the other {count} were left out.",
  addNameInvalid: "Use 1–32 letters, digits, underscores, or hyphens.",
  addCommandRequired: "Enter the command to run.",
  addUrlRequired: "Enter the server URL.",
  addPairInvalid: "Cannot read this line: {line}",
  addNoTarget: "That save location is not available. Close this dialog and open Add MCP again.",
  projectLayer: "Workspace",
  profileLayer: "Profile: {end}",
  profileLayerPlain: "Profile",
  profileDesktop: "Desktop",
  profileWeb: "Web",
  profileNamed: "{name}",
  userLayer: "User",
  serverCount: "{count}",
  empty: "No MCP servers yet. Choose Add MCP and fill in a name and a command or URL.",
  loading: "Loading…",
  error: "Could not read MCP state.",
  statusRunning: "Running",
  statusRunningOne: "Running · 1 tool",
  statusRunningCount: "Running · {count} tools",
  statusIdle: "Enabled · waiting for a session",
  statusOff: "Disabled",
  statusStarting: "Starting",
  statusFailed: "Failed to start",
  statusUnmounted: "Not started",
  statusNameTaken: "Not started · name in use",
  statusEnvMissing: "Not started · missing environment variable",
  statusEnvInvalid: "Not started · invalid after variable expansion",
  statusGiveUp: "Not started · retries stopped",
  statusConfigInvalid: "Not started · invalid config",
  skipNameTaken: "Another server already uses this name, so this one did not start.",
  skipEnvMissing: "An environment variable used by the config has no value, so this one did not start.",
  skipEnvInvalid: "The config is invalid after expanding environment variables, so this one did not start.",
  skipGiveUp: "It still had no tools after several reconnects, so retries stopped.",
  skipConfigInvalid: "The config is invalid, so this one did not start.",
  skipOther: "It did not start ({reason}).",
  badgeTakeover: "{file} · unmanaged",
  badgeTakeoverHint: "Changes ask for confirmation first, then write to the mcp.yml managed by the mcp-manager plugin.",
  shadowedNote: "The same name in {files} is overridden by {winner} and does not start.",
  shadowedIdentityNote: "{names} uses the same command or address and does not start. {winner} is the one that runs.",
  endpointCmd: "Command:",
  endpointUrl: "URL:",
  tools: "Manage tools",
  toolsTitle: "Tools · {name}",
  toolsEmpty: "This server has no registered tools yet.",
  toolsClose: "Close",
  remove: "Remove",
  cancel: "Cancel",
  continueWrite: "Write mcp.yml",
  takeoverTitle: "This file is not the mcp.yml managed by the mcp-manager plugin",
  takeoverWill: "Continuing writes a higher-priority entry to the managed mcp.yml. That entry takes effect from then on.",
  takeoverWont: "{file} is left unchanged. The change is written to {yml}.",
  removeTitle: "Remove {name}?",
  removeWill: "Removes “{name}” from the mcp.yml managed by the mcp-manager plugin.",
  removeWont: "If another file also has this server, that file is left unchanged, and a disabled placeholder needs to be written so it does not start again.",
  enableLabel: "Enabled",
  workspaceLocked: "This workspace cannot be edited right now.",
  toolEnableLabel: "Tool {name}",
  userFile: "User mcp.yml",
  profileFile: "Profile mcp.yml",
  profileFileNamed: "Profile mcp.yml ({end})",
  projectFile: "Workspace .dsh/mcp.yml"
};

export const zh: Record<McpUiLocaleKey, string> = {
  tab: "插件：MCP 管理",
  intro: "这里列出当前可用的 MCP 服务器。",
  introHelp: "添加、开关和删除都会写入受 mcp-manager 插件管理的 mcp.yml。\n对从其他文件读到的服务器，改动前会先确认，再写入受管 mcp.yml。",
  open: "MCP 配置",
  add: "添加 MCP",
  addTitle: "添加 MCP",
  addDescription: "确认后写入受 mcp-manager 插件管理的 mcp.yml，正在运行的会话会自动装载。",
  addScope: "保存到",
  addScopeProject: "工作区",
  addScopeUser: "用户",
  addScopeProfile: "profile",
  addNoWorkspace: "还没有打开工作区。请先打开一个会话。",
  addNoProfile: "没有找到当前 profile。",
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
  addEnv: "环境变量（可选，每行一个 KEY=值）",
  addEnvPlaceholder: "GITLAB_TOKEN=${GITLAB_TOKEN}",
  addHeaders: "请求头（可选，每行一个 名称: 值）",
  addHeadersPlaceholder: "Authorization: Bearer ${TOKEN}",
  addSubmit: "添加",
  addPaste: "从剪贴板填入",
  addPasteDenied: "读不到剪贴板。请允许这个页面读取剪贴板后再试。",
  addPasteEmpty: "剪贴板是空的。",
  addPasteParse: "剪贴板里的内容不是 JSON 或 YAML。",
  addPasteNone: "剪贴板里没有找到 MCP 服务器。",
  addPasteSse: "这个条目使用 SSE 传输，表单只支持本地命令或远程地址。",
  addPasteBoth: "配置里同时有命令和地址。请只保留一个，或写明 type。",
  addPasteCommand: "这份配置没有命令。",
  addPasteUrl: "这份配置没有地址。",
  addPasteFields: "参数、环境变量或请求头里有表单无法填入的值。",
  addPasteTransport: "这种传输类型无法对应到本地命令或远程地址。",
  addPasteSkipped: "剪贴板里有多个服务器，只填入了第一个，其余 {count} 个没有填入。",
  addNameInvalid: "名称只能是 1–32 位字母、数字、下划线或连字符。",
  addCommandRequired: "请填写要运行的命令。",
  addUrlRequired: "请填写服务器地址。",
  addPairInvalid: "这一行无法识别：{line}",
  addNoTarget: "这个保存位置现在不可用。请关闭窗口，再重新点「添加 MCP」。",
  projectLayer: "工作区层",
  profileLayer: "profile 层：{end}",
  profileLayerPlain: "profile 层",
  profileDesktop: "桌面端",
  profileWeb: "web 端",
  profileNamed: "{name} 端",
  userLayer: "用户层",
  serverCount: "{count} 个",
  empty: "还没有 MCP 服务器。点「添加 MCP」，填写名称和命令或地址。",
  loading: "正在读取…",
  error: "读取 MCP 状态失败。",
  statusRunning: "运行中",
  statusRunningOne: "运行中 · 1 个工具",
  statusRunningCount: "运行中 · {count} 个工具",
  statusIdle: "已启用 · 等待会话启动",
  statusOff: "已禁用",
  statusStarting: "正在启动",
  statusFailed: "启动失败",
  statusUnmounted: "未启动",
  statusNameTaken: "未启动 · 名称已被占用",
  statusEnvMissing: "未启动 · 缺少环境变量",
  statusEnvInvalid: "未启动 · 环境变量展开后无效",
  statusGiveUp: "未启动 · 已停止重试",
  statusConfigInvalid: "未启动 · 配置无效",
  skipNameTaken: "已经有同名服务器，这一条没有启动。",
  skipEnvMissing: "配置引用的环境变量没有值，这一条没有启动。",
  skipEnvInvalid: "环境变量展开后配置无效，这一条没有启动。",
  skipGiveUp: "多次重连后仍然没有工具，已停止重试。",
  skipConfigInvalid: "配置无效，这一条没有启动。",
  skipOther: "没有启动（{reason}）。",
  badgeTakeover: "{file} · 待接管",
  badgeTakeoverHint: "改动前会先确认，再写入受 mcp-manager 插件管理的 mcp.yml。",
  shadowedNote: "{files} 里还有同名配置，已被 {winner} 覆盖，不会启动。",
  shadowedIdentityNote: "{names} 的命令或地址相同，不会启动。实际装载的是 {winner}。",
  endpointCmd: "命令：",
  endpointUrl: "地址：",
  tools: "管理工具",
  toolsTitle: "工具 · {name}",
  toolsEmpty: "这个服务器还没有已注册的工具。",
  toolsClose: "关闭",
  remove: "删除",
  cancel: "取消",
  continueWrite: "写入 mcp.yml",
  takeoverTitle: "这份文件不是受 mcp-manager 插件管理的 mcp.yml",
  takeoverWill: "继续后，会在受管 mcp.yml 里写一条更高优先级的条目，之后以它为准。",
  takeoverWont: "不会修改 {file}，改为写入 {yml}。",
  removeTitle: "删除 {name}？",
  removeWill: "从受 mcp-manager 插件管理的 mcp.yml 里删除「{name}」。",
  removeWont: "如果其他文件里也有这个服务器，那份文件不会修改，需要写一条禁用占位，避免它再次启动。",
  enableLabel: "启用",
  workspaceLocked: "这个工作区当前不能改",
  toolEnableLabel: "工具 {name}",
  userFile: "用户层 mcp.yml",
  profileFile: "profile 层 mcp.yml",
  profileFileNamed: "profile 层 mcp.yml（{end}）",
  projectFile: "工作区层 .dsh/mcp.yml"
};
