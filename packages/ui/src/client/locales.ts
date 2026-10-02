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
  | "toolEnableLabel"
  | "userFile"
  | "profileFile"
  | "projectFile";

export const en: Record<McpUiLocaleKey, string> = {
  tab: "Plugin: MCP",
  intro: "MCP servers available right now.",
  introHelp: "Add, the switch, and Remove write the mcp.yml managed by the mcp-manager plugin.\nA server read from another file asks before that yml is updated.",
  open: "MCP config",
  add: "Add MCP",
  addTitle: "Add MCP",
  addDescription: "Confirm writes the mcp.yml managed by the mcp-manager plugin. A running session loads it on its own.",
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
  addPaste: "Fill from clipboard",
  addPasteDenied: "Couldn't read the clipboard. Allow clipboard access and try again.",
  addPasteEmpty: "The clipboard is empty.",
  addPasteParse: "The clipboard is not JSON or YAML.",
  addPasteNone: "No MCP server was found in the clipboard.",
  addPasteSse: "This entry uses SSE. Only a local command or a remote URL can be filled in.",
  addPasteBoth: "Both a command and a URL are set. Keep one, or set type.",
  addPasteCommand: "This config has no command.",
  addPasteUrl: "This config has no URL.",
  addPasteFields: "Arguments, environment, or headers contain a value that cannot go in the form.",
  addPasteTransport: "That transport cannot be filled in as a local command or a remote URL.",
  addPasteSkipped: "The clipboard has more than one server. Filled the first. {count} more were left out.",
  addNameInvalid: "Use 1–32 letters, digits, underscores, or hyphens.",
  addCommandRequired: "Enter the command to run.",
  addUrlRequired: "Enter the server URL.",
  addPairInvalid: "Cannot read this line: {line}",
  addNoTarget: "That save location is not available. Close this and open Add MCP again.",
  projectLayer: "Project",
  profileLayer: "Profile: {end}",
  profileLayerPlain: "Profile",
  profileDesktop: "Desktop",
  profileWeb: "Web",
  profileNamed: "{name}",
  userLayer: "User",
  serverCount: "{count}",
  empty: "No MCP servers yet. Choose Add MCP and fill in a name and command or URL.",
  loading: "Loading…",
  error: "Could not read MCP state.",
  statusRunning: "Running",
  statusRunningOne: "Running · 1 tool",
  statusRunningCount: "Running · {count} tools",
  statusIdle: "On · waiting for a session",
  statusOff: "Off",
  statusStarting: "Starting",
  statusFailed: "Failed to start",
  statusUnmounted: "Not started",
  statusNameTaken: "Not started · name in use",
  statusEnvMissing: "Not started · missing environment variable",
  statusEnvInvalid: "Not started · invalid after expansion",
  statusGiveUp: "Not started · retries stopped",
  statusConfigInvalid: "Not started · invalid config",
  skipNameTaken: "Another server already uses this name, so this one did not start.",
  skipEnvMissing: "An environment variable in the config is missing, so this one did not start.",
  skipEnvInvalid: "The config is invalid after expanding environment variables, so this one did not start.",
  skipGiveUp: "It still had no tools after several reconnects, so retries stopped.",
  skipConfigInvalid: "The config is invalid, so this one did not start.",
  skipOther: "It did not start ({reason}).",
  badgeTakeover: "{file} · unmanaged",
  badgeTakeoverHint: "Saving asks first, then writes the mcp.yml managed by the mcp-manager plugin.",
  shadowedNote: "Same name in {files} is covered by {winner} and does not start.",
  endpointCmd: "cmd:",
  endpointUrl: "url:",
  tools: "Manage tools",
  toolsTitle: "Tools · {name}",
  toolsEmpty: "This server has no registered tools yet.",
  toolsClose: "Close",
  remove: "Remove",
  cancel: "Cancel",
  continueWrite: "Write yml",
  takeoverTitle: "This file is not the mcp.yml managed by the mcp-manager plugin",
  takeoverWill: "Continuing writes a higher-priority row in the managed yml. Later loads use that row.",
  takeoverWont: "Leaves {file} unchanged. Writes to {yml}.",
  removeTitle: "Remove {name}?",
  removeWill: "Deletes “{name}” from the mcp.yml managed by the mcp-manager plugin.",
  removeWont: "If a copy remains in another file, that file stays, and a disabled placeholder is written so it does not start again.",
  enableLabel: "Enabled",
  toolEnableLabel: "Tool {name}",
  userFile: "User mcp.yml",
  profileFile: "Profile mcp.yml",
  projectFile: "Workspace .dsh/mcp.yml"
};

export const zh: Record<McpUiLocaleKey, string> = {
  tab: "插件：MCP管理",
  intro: "这里列出当前能用的 MCP。",
  introHelp: "添加、开关和删除都写入受mcp-manager插件管理的mcp.yml。\n从别的文件读到的服务器，改动前会先确认，再写入这份 yml。",
  open: "MCP 配置",
  add: "添加 MCP",
  addTitle: "添加 MCP",
  addDescription: "确认后写入受mcp-manager插件管理的mcp.yml。正在运行的会话会自己装载。",
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
  addPaste: "从剪贴板填入",
  addPasteDenied: "读不到剪贴板。允许这个页面读取剪贴板后再试。",
  addPasteEmpty: "剪贴板是空的。",
  addPasteParse: "剪贴板里的内容不是 JSON 或 YAML。",
  addPasteNone: "没有从剪贴板里认出 MCP 服务器。",
  addPasteSse: "这是 SSE 传输。这里只能填本地命令或远程地址。",
  addPasteBoth: "同时写了命令和地址。请只留一种，或写上 type。",
  addPasteCommand: "这份配置没有命令。",
  addPasteUrl: "这份配置没有地址。",
  addPasteFields: "参数、环境变量或请求头里有无法填进表单的值。",
  addPasteTransport: "这个传输类型没法对应到本地命令或远程地址。",
  addPasteSkipped: "剪贴板里有多个服务器，只填了第一个。另外 {count} 个没有填入。",
  addNameInvalid: "名称只能是 1–32 位字母、数字、下划线或连字符。",
  addCommandRequired: "填写要运行的命令。",
  addUrlRequired: "填写服务器地址。",
  addPairInvalid: "这一行无法识别：{line}",
  addNoTarget: "这个保存位置现在不可用。关掉窗口后重新点「添加 MCP」。",
  projectLayer: "项目层",
  profileLayer: "profile层：{end}",
  profileLayerPlain: "profile层",
  profileDesktop: "桌面端",
  profileWeb: "web端",
  profileNamed: "{name}端",
  userLayer: "用户层",
  serverCount: "{count} 个",
  empty: "还没有 MCP 服务器。点「添加 MCP」，填写名称和命令或地址。",
  loading: "正在读取…",
  error: "读取 MCP 状态失败。",
  statusRunning: "运行中",
  statusRunningOne: "运行中 · 1 个工具",
  statusRunningCount: "运行中 · {count} 个工具",
  statusIdle: "已开 · 等待会话启动",
  statusOff: "已关闭",
  statusStarting: "正在启动",
  statusFailed: "启动失败",
  statusUnmounted: "未启动",
  statusNameTaken: "未启动 · 名称已被占用",
  statusEnvMissing: "未启动 · 缺少环境变量",
  statusEnvInvalid: "未启动 · 展开后无效",
  statusGiveUp: "未启动 · 已停止重试",
  statusConfigInvalid: "未启动 · 配置无效",
  skipNameTaken: "已经有同名服务器，这一条没有启动。",
  skipEnvMissing: "配置引用的环境变量没有值，这一条没有启动。",
  skipEnvInvalid: "环境变量展开后配置不合法，这一条没有启动。",
  skipGiveUp: "多次重连仍然没有工具，已停止重试。",
  skipConfigInvalid: "配置不合法，这一条没有启动。",
  skipOther: "没有启动（{reason}）。",
  badgeTakeover: "{file} · 待接管",
  badgeTakeoverHint: "改动前会先确认，再写入受mcp-manager插件管理的mcp.yml。",
  shadowedNote: "{files} 里还有同名配置，已被 {winner} 覆盖，不会启动。",
  endpointCmd: "命令：",
  endpointUrl: "地址：",
  tools: "管理工具",
  toolsTitle: "工具 · {name}",
  toolsEmpty: "这台服务器还没有已注册的工具。",
  toolsClose: "关闭",
  remove: "删除",
  cancel: "取消",
  continueWrite: "写入 yml",
  takeoverTitle: "这份文件不是受mcp-manager插件管理的mcp.yml",
  takeoverWill: "继续后，会在受管 yml 里写一条更高优先级的记录，之后以它为准。",
  takeoverWont: "不会修改 {file}。写入位置：{yml}。",
  removeTitle: "删除 {name}？",
  removeWill: "从受mcp-manager插件管理的mcp.yml里删掉「{name}」。",
  removeWont: "如果它还写在别的文件里，那个文件不动，只加一条禁用占位，避免再次启动。",
  enableLabel: "启用",
  toolEnableLabel: "工具 {name}",
  userFile: "用户层 mcp.yml",
  profileFile: "当前 profile 的 mcp.yml",
  projectFile: "工作区的 .dsh/mcp.yml"
};
