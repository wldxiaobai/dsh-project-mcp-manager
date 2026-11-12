# 设计记录：按需装载（Lazy）MCP 服务器

[← 返回 README](../README.zh.md) ｜ 相关：[配置格式](../guide/format.zh.md#加载模式) · [查询面](../guide/service.zh.md) · [MCP 管理页](../guide/settings-ui.zh.md#加载模式)

**状态**：已实现并合入 `dev`（PR #30）；连接生命周期已按 PR #32 改为按会话口径 ｜ **记录日期**：2026-11-10 ｜ **目标版本**：v0.13.0（两个包同步 minor 升版）
**关联**：`AGENTS.md`（装载、会话隔离、写入边界）、`src/lazy/connection.ts`、`src/lazy/proxies.ts`、`src/registry.ts`（`setLoadingMode`、`syncLazyProxies`）、`packages/ui/src/client/McpPanel.tsx`

> **2026-11-12 更新（PR #32）**：连接生命周期已改为**按会话**，本文「空闲五分钟关闭」的原始设计已被取代，仅作历史记录保留。现行口径：每台 Lazy 行由 `LazyConnections` 为每个会话维护独立 `LazyServer`，会话首次成功 `mcp_search` 时激活自己的连接；连接在空闲与切换工作区时保持，直到**会话结束、行卸载/替换或插件销毁**才释放；不再有五分钟空闲计时器。首次发现尚未完成时最后一个等待者取消仍会回收该未完成连接。当前权威说明见 [配置格式 · 加载模式](../guide/format.zh.md#加载模式) 与 [工作原理](../guide/how-it-works.zh.md)。

## 0. 裁决摘要

| 待决问题 | 裁决 |
|---|---|
| `mode` 放在哪 | 行级可选字段：受管 YAML 写 `config.mode`，JSON 条目写顶层 `mode`；省略即 `eager` |
| 谁发起连接 | 每台 Lazy 行一个 `LazyServer`，首次代理调用时连接；不向 DSH 注册远端工具 |
| 代理工具 | `mcp_search` / `mcp_describe` / `mcp_call`；存在启用的 Lazy 行时全局注册，按会话可见性做 deny |
| 连接生命周期 | 并发请求共用一个连接；取消只影响发起者，最后一个取消者关闭世代；连接与列表固定 30 秒超时；空闲五分钟关闭；卸载、模式切换或插件销毁关闭；关闭/新建经屏障串行 |
| 写路径 | `setLoadingMode` 只写受管 yml；JSON 与 `.mcp.json` 原文件不动；`disabled` 保持原值；缺少有效连接配置的占位行拒绝且不写盘 |
| UI 计数 | workspace 抬头把 active Lazy 计入 standby / 待使用，不计入 running；这是展示投影，不能据此推断没有连接 |
| 依赖 | 直接声明 `@modelcontextprotocol/client@2.2.0` 与 `@deepseek-ai/dsh-subprocess@0.2.2-rc.1`；官方客户端仍是 `^0.2.2-rc.1`，CI 依赖对拍强制升级审查 |
| 版本 | 新方法、字段属于 additive minor；manager 与 UI 同步升版、同步发布；本分支不改版本号 |

## 1. 背景与目标

Eager（现有行为）在挂载时为每台 MCP 服务器建立连接，并把服务器返回的每个工具注册为
`mcp__<生效名>__<工具名>`。工具多、服务器多时，这些工具会占用模型上下文和工具预算；
服务器本身也会在启动时全部拉起。

Lazy 的目标是**延迟连接和发现**：挂载时只登记配置，模型先用三个代理工具发现和调用，
真正需要时才连接服务器。它要保留现有作用域、影子优先序、会话隔离、`tools.allow` /
`deny` 过滤和热更新，不新增第二套配置模型。

非目标：

- 不替代 Eager 的 DSH Resources、服务器 instructions、`maxInstructionBytes` 限制，以及
  按已注册工具名生效的宿主策略；这些继续要求 Eager。
- 不提供离线工具索引；搜索必须连接服务器才能拿到工具目录。
- 不改变 JSON / `.mcp.json` 的只读地位；宿主仍然只写三份受管 yml。
- 不改变 Eager 的装载、重连和工具注册行为。

## 2. 配置模型

### 2.1 字段与默认值

- `McpLoadingMode = "eager" | "lazy"`，由 `mcpLoadingModeSchema` 校验。
- 所有位置都是可选字段，省略等价于 `eager`：
  - 原生 YAML：行的 `config.mode`；
  - JSON 方言：条目的顶层 `mode`；
  - `McpAddDraft.mode`、`McpServerView.mode`、UI 的 `McpUiServer.mode`。
- `mode` 是本插件的行级元数据，不会传给 `@deepseek-ai/dsh-mcp-client`。`toPatchRow()`
  把它写进行配置；`toOfficialConfig()` 不写；`buildServerConfig()` 单独返回
  `{ config, mode }`，只有 Eager 分支把 `config` 交给 `ctx.plugin`。现有测试断言官方
  客户端收到的配置里没有 `mode`。
- JSON 的 `mode` 从 `jsonServerEntrySchema` 透传到 `mcpServerInputSchema`，再进入行配置；
  JSON 写入器（仅 CLI 使用）也会保留显式给出的 `mode`。宿主侧不写 JSON。

### 2.2 与 Eager 的行为差异

| 方面 | `eager` | `lazy` |
|---|---|---|
| 挂载时连接 | 是 | 否，首次代理调用时才连接 |
| DSH 工具注册 | 每个远端工具注册为 `mcp__<生效名>__<工具名>` | 不注册远端工具，只注册三个代理 |
| 模型上下文 / 工具预算 | 全部工具 | 三个代理工具（加上服务器的工具目录只在代理结果里出现） |
| 服务器 instructions、DSH Resources | 支持 | 不支持；需要时用 Eager |
| 按单个已注册工具名生效的宿主策略 | 支持 | 不支持；只受行级 `tools.allow` / `deny` 约束 |
| `reconnect` / `failOnStartupError` | 官方重连与启动失败策略 | 不执行；下一次请求重新连接 |
| `maxInstructionBytes` | 由官方客户端执行 | 忽略（不读取 instructions） |
| `toolCallTimeoutMs` | 单次工具调用 | 单次工具调用；连接与工具列表使用独立的固定 30 秒发现超时 |
| 空闲关闭 | 连接常驻 | 最后一个请求结束五分钟后关闭；最后一个调用者取消时关闭该世代 |
| 取消 | 不影响其它调用 | 只结束取消者自己的等待，其它进行中的调用保留连接；最后一个取消者经屏障回收世代 |
| 装载实例 | 一台服务器一个官方 fiber | 一台服务器一个 `LazyServer`，按需打开连接 |

### 2.3 代理工具

存在至少一条启用的 Lazy 行（全局或已扫描项目）时，registry 注册三个全局工具：

- `mcp_search({ query?, server?, limit? })`：连接可见的 Lazy 服务器，列出工具；`query`
  按空白分词，所有词都要命中服务器原名、工具名或描述；`limit` 只限制返回条数（默认
  10，最大 50），不限制连接数。
- `mcp_describe({ server, tool })`：返回该工具的 `description`、`inputSchema`、
  `outputSchema`、`annotations` 与 `execution`。
- `mcp_call({ server, tool, arguments? })`：调用工具；`arguments` 省略时按空对象处理。
  `execution.taskSupport === "required"` 的工具会被拒绝（不支持基于任务的执行）。

`server` 是**生效名**（搜索结果里的 `server` 字段）。项目行发生命名冲突时生效名可能是
`p<hash>_<原名>`，与文件里的 `serverName` 不同。

代理的注册是宿主级的；某个会话没有可见 Lazy 挂载时，`appendLazyProxyDenies()` 会把三个
代理名加入该会话的 deny 列表，避免没有 Lazy 配置的会话看到无意义的工具。代理注册失败
（例如与其它插件同名）会告警一次并保持未注册，下一次对账再试，不影响 Eager。

## 3. 运行模型

### 3.1 挂载

`mountServer()` 完成配置构建、`${VAR}` 展开和校验后，如果 `mode === "lazy"`：

- 不创建官方 fiber，不等待连接；
- 在容器里写入 `ProjectServerState`，`phase: "active"`，`lazy: new LazyServer(config)`；
- 该行不注册任何 `mcp__…` 工具，`toolCount` 为 0。

因此 Lazy 行在快照里是 active，但运行状态显示为「可按需连接」，而不是「运行中 ·
N 个工具」。健康巡检看到 0 工具也不会对 Lazy 行做 unmount/mount 自愈：它从未注册过工具，
`everHadTools` 为 false，不会进入 `remountDeadFiber`。

### 3.2 连接与空闲

`LazyServer` 的生命周期：

1. 第一次 `mcp_search` / `mcp_describe` / `mcp_call` 访问该行时，`withClient()` 创建
   `Client` 与传输层并连接。
2. stdio 使用 `scrubbedParentEnv()` 加行内 `env`，沿用行内 `cwd`；Streamable HTTP 使用
   行内 `headers`。与官方 Eager 的传输构造口径一致。
3. 并发请求共享同一个 `connection`；`connect()` 与 `listTools()` 使用独立的固定
   `DISCOVERY_TIMEOUT_MS = 30_000`，不再取 `min(30_000, toolCallTimeoutMs)`；单次工具
   调用仍使用 `toolCallTimeoutMs`。发现超时变长不会因为业务调用超时很短而提前失败。
   工具目录缓存在该连接上，`list_changed` 后失效，下一次代理调用重新拉取。
4. 每个代理调用有自己的 `AbortSignal` 等待。取消只拒绝发起取消的那个调用；同一连接上
   其它进行中的调用继续。请求计数减到 0 时：若最后一个调用已被取消，立即开始关闭该
   世代；否则启动五分钟空闲计时器。共享的 connect/listTools 不会因为一个等待者取消
   而中断。
5. 关闭与新建串行：空闲到期、行卸载、模式切换或 `dispose()` 时调用 `close()`；
   `withClient()` 先等待当前的 `closing` 屏障，`close()` 会 abort 该世代、关闭原始
   transport/client、等待 `ready` 落定，并把同一个 shutdown Promise 交给后续调用；
   重复 `dispose()` 返回同一屏障。新调用不会与旧世代清理并行，旧关闭也不会晚到清掉
   新连接。transport 的 start/close 另有串行屏障，避免 SDK 握手失败时的并发 close 提前
   返回，导致 session 子进程在 dispose 完成后才启动。
6. 关闭会等待 SDK connect 落定；connect 可能受传输/网络超时影响，因此**不能承诺严格的
   dispose 耗时上限**。不要改成先 race 返回、再让晚到的连接继续：那会放过晚到的 spawn。
   正确路径是 abort 并关闭原始 transport（SDK auto negotiation 期间 `client.transport`
   可能尚未挂上），再等待该世代 settle。
7. 连接失败对外统一为泛化的 `Unable to connect to the MCP server`，不泄露底层传输/网络
   细节；下一次请求重试。`mcp_search` 把失败的服务器放进 `unavailable` 并继续返回其它
   服务器的结果；`mcp_describe` / `mcp_call` 在找不到服务器或工具时抛
   「…unavailable in this session」，连接失败时抛上述泛化错误。

Lazy 没有启动连接，因此不执行官方的 `reconnect` 与 `failOnStartupError` 策略；也不读取
服务器 instructions，`maxInstructionBytes` 不会生效。需要这些行为时使用 Eager。

### 3.3 搜索的扇出

不带 `server` 的 `mcp_search` 会为**当前会话所有可见的 Lazy 行**并发建立连接并拉取工具
目录。这是发现工具的必要代价：没有连接就拿不到目录。它意味着：

- 第一次搜索可能同时启动多个 stdio 进程或 HTTP 连接，服务器多时会有明显延迟和资源
  峰值；传 `server` 可以只查一台。
- 单台连接失败不会让整次搜索失败，但会在 `unavailable` 中出现该服务器名；目前没有把
  具体错误文本返回给模型。
- `limit` 只限制返回条数，连接和目录拉取仍会覆盖所有可见服务器。

### 3.4 作用域与可见性

- 项目层 Lazy 行随项目容器常驻挂载；会话按 `header.cwd` 解析项目，只激活并看到本项目的行。
  每台行在每个会话按需创建独立 `LazyServer` 与连接，切换焦点不卸载项目，也不关闭已激活连接；
  连接在会话结束、行卸载/替换或插件销毁时释放。
- 全局（用户层 / profile 层）Lazy 行按宿主级一条登记，所有会话可见，除非项目行在影子
  规则里压制了同名全局服务器；压制时 `visibleLazyMounts()` 会排除该全局行。
- 行级 `tools.allow` / `deny` 在目录返回后、搜索/描述/调用之前过滤工具；完整名
  `mcp__<生效名>__<工具名>` 与裸工具名都支持。完整名的规范化与官方 Eager 的
  `publicToolName()` 一致（64 字符上限、非法字符替换、损失性规范化时追加 12 位
  SHA-256），因此同一份过滤规则在两种模式下含义相同。JSON 的 `includeTools` /
  `excludeTools` 仍映射到 `allow` / `deny`。
- `disabled: true` 的行不会被挂载，也不会创建 `LazyServer`；`enabled: false` 的 JSON 行
  仍按原有规则静默跳过。改 `mode` 不会改变启用状态。
- UI 的 workspace 抬头和等待计数把 active Lazy 记为 **standby / 待使用**，不计入
  running。这是展示投影：按需行可能已经有一个打开的代理连接，只是连接状态没有投影到
  抬头/卡片；不能从 standby 计数推断“没有连接”。

## 4. 写入与查询面

### 4.1 `setLoadingMode`

`ProjectMcpService.setLoadingMode(source, projectRoot, rawName, mode)`：

1. 先用 `mcpLoadingModeSchema.parse(mode)` 校验，非法值在写文件前拒绝。
2. 进 `enqueue` 与对账互斥；`requireSourceRow()` 校验目标可写（项目层必须是当前焦点
   工作区；用户层 / profile 层始终可写；profile 名必须解析得出）。
3. 在目标作用域的受管 yml 里按同名、再按服务身份查找行，并选出要改的基准行：
   - 找到：基准是该受管行，只替换 `config.mode`，保留 `id`、`disabled` 及其它配置；
   - 没找到：基准是来源行，把它完整复制进受管 yml，再写 `config.mode`。
4. 在锁内对合入新 mode 的待写行执行 `inputFromPatchRow(updated)` 重解析。没有有效连接
   配置的占位行（例如手写的、只有 id 的 disabled 行）会抛
   `服务器 "…" 缺少有效连接配置，不能切换加载模式`；`updateManagedRows()` 的回调拒绝，
   不执行文件替换，文件保持原样，也不会生成只有 `mode` 的半行。
5. 通过 `updateManagedRows()` 的受管块、锁和原子写落盘；`configEpoch` 加一，随后
   `schedule()` 一次 `reconcileAll`。
6. 返回受管 yml 路径。**不等待对账结束**：调用方应通过 `projectMcp/updated` 或下一次
   `snapshot()` 看结果；需要等到对账完成时调用 `reload()`。

`disabled` 保持原值：对已停用的行改模式，行仍然是停用的；要启用请另用
`setServerEnabled()`。JSON / `.mcp.json` 原文件不动，改动只落在更高优先级的受管 yml
覆盖行上。

UI 侧：服务器卡片上的模式控件和添加对话框分别调用 `setLoadingMode()` 与
`addServer()`。来源不是受管 yml 时，前端先弹 takeover 确认；服务端的
`/api/project-mcp/server` 在 `acknowledge !== true` 时返回 `confirm-yml`，确认后才写
覆盖行。模式切换和开关、删除共用同一套写入位置检查。

### 4.2 添加与视图

- `McpAddDraft.mode` 可选；表单只在选择 Lazy 时发送 `mode`，省略即 Eager。
- `addServer()` 走 `inputFromAddDraft()` → `mcpServerInputSchema` → `toPatchRow()`，显式
  `mode` 会写进新行的 `config.mode`。
- `McpServerView.mode` 可选；只有在行配置里读到 `lazy` 或 `eager` 时才出现在视图里。
  缺省表示 Eager；`McpServerRuntimeView` 继承这一字段，`snapshot()` 与
  `serverView()` 都会带上。
- 旧版 UI 忽略未知的 `mode` 字段，仍按 Eager 显示；新版 UI 调用
  `setLoadingMode` 时要求核心提供该方法。

### 4.3 API 语义化版本与两包同步

`setLoadingMode` 是新方法，`McpLoadingMode`、`McpAddDraft.mode`、`McpServerView.mode`
是新增类型/字段，按现有约定属于 **minor additive** 变更：

- 旧 UI + 新核心：可用；旧 UI 不读 `mode`，也不会调用新方法。
- 新 UI + 旧核心：不可用；`setLoadingMode` 不存在。因此 manager 对 UI 的依赖、UI 对
  manager 的 peer 都保持**同一精确版本**，两个包必须同步升版、同步发布。
- 本分支不提升版本号；发版时把两个包的版本一起提升，并同步更新
  `dsh-project-mcp-ui` 的精确依赖与 peer 占位符。

## 5. 安全边界与限制

Lazy **延迟连接，不延迟信任决策**：

- `stdio` 行仍然会在第一次使用时由 dsh 宿主 spawn；命令与参数来自配置文件。项目文件
  仍是可执行代码载体，只应对可信项目启用。
- `mcp_call` 是通用桥：模型可以对任意可见 Lazy 服务器调用任意通过行级
  `tools.allow` / `deny` 过滤的工具。宿主按 `mcp__<server>__<tool>` 注册名配置的
  允许/拒绝策略看不到 Lazy 目录里的单个工具；需要这种策略时使用 Eager。
- `mcp_search` 不带 `server` 时会连接所有可见 Lazy 服务器，可能同时拉起多个进程；
  这是显式的资源取舍，不是后台常驻连接。
- 不暴露服务器 instructions 与 DSH Resources；`maxInstructionBytes`、`reconnect`、
  `failOnStartupError` 在 Lazy 下不生效。
- 搜索结果包含工具描述（截断到 300 字符），`mcp_describe` 返回完整 Schema；这些内容
  与 Eager 一样属于服务器提供的不可信输入，存在提示注入面。
- 连接失败对外只给泛化的 `Unable to connect to the MCP server`，不把传输/网络细节
  放进工具结果；`mcp_search` 只列出 `unavailable` 服务器名。
- 页面/接口的权限边界不变：能使用 dsh Web GUI 或写受管 yml 的人就能添加并启动服务器。

## 6. 依赖决策

### 6.1 直接声明

`package.json` 新增两个运行时依赖，均为精确版本：

| 包 | 版本 | 用途 |
|---|---|---|
| `@modelcontextprotocol/client` | `2.2.0` | `Client`、`StdioClientTransport`、`StreamableHTTPClientTransport` |
| `@deepseek-ai/dsh-subprocess` | `0.2.2-rc.1` | `scrubbedParentEnv()`，与官方 Eager 使用同一套凭据擦除口径 |

`@deepseek-ai/dsh-mcp-client@0.2.2-rc.1` 的清单里，`@modelcontextprotocol/client` 是
`dependencies`（同为 `2.2.0`），`@deepseek-ai/dsh-subprocess` 是 `peerDependencies`
（`0.2.2-rc.1`，由 DSH 宿主提供）。本插件直接 `import` 这两者，所以必须在自己的清单里
声明。`pnpm-lock.yaml` 只新增 importer 边；当前安装去重为一份
（`node_modules` 中实际版本分别为 `2.2.0` 与 `0.2.2-rc.1`）。

注意：官方客户端在 `package.json` 里仍是 `^0.2.2-rc.1`，没有锁精确版本。项目的
标准测试对拍已安装依赖（§6.3）；目前仓库没有自动执行这些测试的 CI 配置，不能据此
承诺消费方的新安装不会漂移。

### 6.2 备选方案

| 方案 | 结论 | 理由 |
|---|---|---|
| 不引入 SDK，手写 MCP JSON-RPC / stdio / HTTP 传输 | 否决 | 要自行实现握手、协议版本协商、帧/流、超时、中止、错误映射，重复官方客户端且难以保持一致；安全和兼容风险高 |
| 从 `dsh-mcp-client` 深层导入 `Client` / 传输 / `scrubbedParentEnv` | 否决 | 官方发布包只带 `lib/index.js` 与类型声明，入口没有导出 `Client` / 传输 / `scrubbedParentEnv`；`src/*` 虽在 exports 表里但未随包发布，内部实现也不是稳定契约；升级即断 |
| 依赖传递解析（幽灵依赖） | 否决 | pnpm 的严格 `node_modules` 不保证可解析；其它包管理器/hoisting 行为不同；属于未声明依赖 |
| 改为 `peerDependencies` | 不作为主方案 | `dsh-subprocess` 是官方客户端的 peer，但本插件在 profile 内运行，不能假定安装器一定满足 peer；直接声明能保证运行时存在。代价是可能与宿主各持一份 |
| 上游在 `dsh-mcp-client` 暴露 Lazy/连接 API | 长期更优 | 可消除重复传输构造与版本耦合；当前上游没有该 API，需要上游改动与协调发布，本次不可用 |
| 复制 `scrubbedParentEnv` 的实现 | 否决 | 擦除规则会随宿主演进；复制会造成行为漂移，且容易漏掉凭据形态 |

### 6.3 风险与缓解

- **版本漂移**：DSH 或 `dsh-mcp-client` 升级后，官方依赖的 SDK / subprocess 版本可能
  变化；本插件仍固定旧版时会出现两份实现，协议或环境擦除行为可能不一致。
  缓解：随 `dsh-mcp-client` 的版本同步提升这两个精确版本；CI 必须运行
  `node test/test-package-contract.mjs`，同时核对 manager 的直接精确版本、官方
  `dependencies` / `peerDependencies` 声明和安装后的嵌套实际版本。
- **清单范围不一致**：`@deepseek-ai/dsh-mcp-client` 仍是 `^0.2.2-rc.1`，而两个直接依赖
  是精确版本。消费方安装时可能解析到更新的官方客户端，SDK / subprocess 却仍是
  `2.2.0` / `0.2.2-rc.1`。本轮保留既有范围，只增加标准测试对拍：仓库升级到不同契约时
  测试失败，必须显式审查并同步提升两个精确版本。对拍不是安装期约束，不覆盖消费方
  未运行测试的新解析；后续发布若要求完全锁步，应单独评估锁定官方客户端精确版本。
  本轮没有修改依赖版本或锁文件。
- **`dsh-subprocess` 的宿主耦合**：它是 DSH 内部 seam，不是为第三方插件设计的稳定 API；
  `scrubbedParentEnv()` 的语义变化会直接影响 Lazy 的 spawn 环境。当前用精确版本锁定，
  并由 `engines.dsh` 限定 0.2 线；跨 0.2 小版本升级时仍需复验。
- **SDK 双份**：若宿主或其它插件解析到不同的 `@modelcontextprotocol/client` 版本，
  Lazy 的 `Client` 与官方 Eager 的 `Client` 可能是两个类。协议层通常兼容，但类型、
  错误与生命周期细节不保证；精确版本 + lockfile 是当前的缓解手段。
- **锁文件**：`pnpm-lock.yaml` 只记录 importer 边；发布 tarball 不包含 lockfile，
  消费方仍按 package.json 的精确版本解析。

## 7. 验证与记录

`package.json` 的 `test` 脚本串起 Lazy 专项回归；下列单条命令假定已执行
`pnpm run build`（UI 路由读 `packages/ui/lib`）。`test-package-contract` 只读已安装
元数据，install 后可直接运行。

```powershell
node test/test-lazy-lifecycle.mjs
node test/test-package-contract.mjs
node test/test-lazy-naming.mjs
node test/test-ui-lifecycle.mjs
node test/test-ui-workspace.mjs
npx tsc --noEmit
```

覆盖：

- `test-lazy-lifecycle.mjs`：并发请求共享连接、取消只结束发起者、最后一个取消者回收
  未完成世代；已激活连接跨空闲保留、失败后可重试、dispose 屏障、晚到 spawn 不逃逸、
  clientInfo 版本。
- `test-package-contract.mjs`：manager 直接精确依赖 vs 官方 `dependencies` /
  `peerDependencies` vs 安装后的嵌套实际版本；官方 `^` 范围解析到不同契约时失败。
- `test-lazy-naming.mjs`：通过官方公开 `apply` 对拍合法名、非法字符、长名、64/65 边界、
  哈希与工具过滤；不深导入。
- `test-ui-lifecycle.mjs`：UI `/api/project-mcp/server` 的 `action:"mode"` 合法/非法
  模式、JSON takeover ack 门槛、core 错误响应与无成功副作用。
- `test-ui-workspace.mjs`：active Lazy 计入 standby/待使用，不计入 running。
- `test/test-registry-lazy.mjs` 的 Lazy 块：启动不 spawn、跨项目隔离、全局遮蔽、并发共享、
  过滤、热切换与 `mode` 不进入官方客户端配置。

Gate 1 的审查、处置和验证记录见
[PR #30 Lazy MCP — Gate 1 审查](../code-review/pr30-lazy-gate1.zh.md)。设计记录已加入
`docs/records.md` 与 `docs/records.zh.md` 的 Design 区。

手工检查：抬头把按需行显示为「待使用」而不是「运行中」，且不要据此断言没有连接；
对没有有效连接配置的手写 disabled 占位切模式，应被拒绝且文件不变；取消一个代理调用时
其它并发调用继续；JSON 行切换模式只改受管 yml，原 JSON 不动。