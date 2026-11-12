# 查询面（`projectMcp`）

[English](service.md) | 中文

[← 返回 README](../README.zh.md) ｜ 相关：[配置来源与分层](layers.zh.md) · [CLI `dsh-mcp`](cli.zh.md) · [设置页](settings-ui.zh.md) · [Lazy 设计记录](../design/lazy-mcp.md)

其它插件和配套 UI 经 cordis 服务 `ctx.projectMcp` 读装载状态。核心服务只在进程内
发事件：对账成功结束时通知一次，装载在那之后才完成时再通知一次。浏览器走 bundle
内的配套 UI 自己建的 SSE，核心服务不打开那条通道。

## 方法

| 方法 | 行为 |
|---|---|
| `snapshot()` | 上一轮对账的内存分区（项目文件与用户层）。进对账队列，不读盘，不发起对账。 |
| `serverView(projectRoot, rawName)` | 一行的内存 view。排队规则与 `snapshot()` 相同。 |
| `globalState(rawName)` | 该原名的全局层运行态；项目行返回 `undefined`。 |
| `contextCost(sessionId?)` | 该会话可见的 MCP 工具定义占多少上下文。同步、只读内存；不传会话时取焦点工作区里的会话。 |
| `resultCost(sessionId?)` | 该会话当前仍保留的 MCP 工具调用结果占多少上下文。同步、只读内存；会话选择与 `contextCost()` 相同。 |
| `reload()` | 一次全量对账（`reconcileNow`）。 |
| `writeTargets()` | 添加对话框当前能写的受管 yml：当前工作区、用户层、当前 profile。 |
| `addServer(source, projectRoot, draft)` | 按表单追加一条受管 yml 行（没有文件就创建）并排一次对账。同名已在该文件里则拒绝，文件不动。 |
| `setServerEnabled(source, projectRoot, rawName, enabled)` | 受管 yml 行就地翻 `disabled`。其它来源的行在同作用域受管 yml 里落一条：启用写完整拷贝，停用写 `disabled: true` 占位。 |
| `setLoadingMode(source, projectRoot, rawName, mode)` | 把 `mode`（`eager`/`lazy`）写进该作用域的受管 yml 行。其它来源的行在受管 yml 还没有对应行时完整复制过去；原 JSON / `.mcp.json` 不动；`disabled` 保持原值。缺少有效连接配置的占位行会被拒绝，文件不动。写完排一次对账并返回文件路径，**不等待对账结束**。 |
| `removeServer(source, projectRoot, rawName)` | 删掉受管 yml 行；低层还有同名或同服务身份时改留 `disabled: true` 占位。其它来源的行落一条占位。 |
| `setToolEnabled(source, projectRoot, rawName, tool, enabled)` | 把一个精确工具名写进受管行的 `tools.allow` / `tools.deny`。含 glob 字符的拒绝。 |
| `toolStates(projectRoot, rawName)` | 已注册工具（短名）与各自是否可见。服务器未 active 时为空。 |
| `managedPathFor(source, projectRoot)` | 该来源的行会写到哪份受管 yml；解析不出 profile 名时为 `undefined`。 |
| `prepareManagedYml(source, projectRoot)` | 受管 yml 不存在时建一个 YAML 空列表（`[]`），返回绝对路径；第一次写服务器时再生成受管块。 |
| `openConfigFile(source, projectRoot)` | 经宿主注入的 opener 打开受管 yml。 |
| `subscribeUpdated(listener)` | 订阅下文的更新信号；返回退订函数。 |

服务器与工具修改方法（`addServer`、`setServerEnabled`、`setLoadingMode`、
`removeServer`、`setToolEnabled`）只碰三份受管 yml（工作区 `.dsh/mcp.yml`、
`~/.dsh/mcp.yml`、`~/.dsh/profiles/<当前>/mcp.yml`），会校验允许的写入位置；非焦点
工作区在改文件前拒绝。`setLoadingMode` 还会先把选中的行重新按服务器输入解析；没有
有效连接配置的占位行在写盘前拒绝。每次修改都在写文件后排一次对账，返回时对账可能
尚未完成；要等对账结束再读结果，调用 `reload()`。路径查询、文件准备和打开接口不代表
相同的修改权限检查，也不触发对账。JSON 文件与 `.mcp.json` 从不写。

`snapshot()` / `serverView()` / `globalState()` / `contextCost()` /
`resultCost()` 不发事件。

### 上下文占用

`contextCost()` 读的是**会话作用域**已经暴露的那份工具 schema——也就是本插件
`tools.restrict({ deny })` 与条目 `tools.allow` / `tools.deny` 过滤之后仍然可见的
部分——把其中每个 `mcp__<生效名>__<工具>`，以及可见的 `mcp_search`、
`mcp_describe`、`mcp_call` 定义计价：

```text
estTokens = ceil(JSON.stringify(tools).length / 4) + 4
```

这与 `@deepseek-ai/dsh-token-meter` 给工具 schema 计价的口径一致，所以数字能和
宿主的上下文分解对上。它是**估算**，不是 provider 计数，也不含服务器
`instructions`（那部分走系统提示，不在工具列表里）。标了 `deferLoading` 的工具
不进本次请求，不计入。

三个 Lazy 代理在 `servers` 里合成一个共享分项，保留名为 `[lazy proxies]`，并带可选
`kind: "lazy-proxy"`；普通服务器不带 `kind`。按当前会话实际可见的定义只计一次，不随
Lazy 服务器数量倍增，不连接服务器或计入内存中的远端目录。被 deny 的代理不计入；
搜索、描述和调用结果属于消息历史，不在工具定义指标内（见[工具调用结果占用](#工具调用结果占用)）。会话作用域查询不可用时，
全局回退至少排除本插件按项目隔离隐藏的代理，但无法重建其它宿主策略。

还没有会话时 `sessionId` 为 `null`，调用方据此区分「没有会话」与「有会话但没有
MCP 工具」。分项按各自那一组单独计价，与总数可能差几个 token。结果自带
`level`（低于 `warnTokens` 为 `ok`、5000 起 `warn`、10000 起 `alert`），消费方
不必自己再实现阈值。

`request/header` 或 `request/context` 事件之后占用签名变化时，registry 会再发一次
`projectMcp/updated`；`tool/result`、`compaction/summary` 或 `compaction/prune`
改变仍保留的结果集时同样会发。页面在该事件上重读即可拿到新数字，不需要轮询。

### 工具调用结果占用

`resultCost()` 读会话当前的模型可见消息（`session.deriveMessages()`），对仍留在
surface 上的每条 `tool/result` 消息按 `dsh-token-meter` 的逐条消息口径计价：

```text
消息 = 各块价格之和 + 4（角色开销）
文本/推理块 = ceil(字符数 / 4) + 4
```

只有能对应到 MCP 工具调用的结果才计入。Eager 结果按
`mcp__<生效名>__<工具>` 归属；Lazy 结果按 `mcp_call` / `mcp_describe`（以及
指定了 `server` 的 `mcp_search`）参数里的服务器归属，跨服务器的搜索归入
`[lazy proxies]` 共享组。`servers[].kind` 为 `"lazy"` 表示 Lazy 服务器，
`"lazy-proxy"` 表示共享组；`calls` 是仍保留的结果消息条数，失败调用也计入。

这是**当前仍占用**的上下文：被
`dsh-compaction-tool-result-pruner` 裁剪或被压缩移除的结果已经不在 surface 上，
不计。数字是**估算**，不是 provider 计数；图片结果按结构引用计价，不用路由的
视觉 token 口径。

## 加载模式

`McpLoadingMode` 是 `"eager" | "lazy"`。`mode` 在所有结构里都是可选字段，省略等价于
`eager`：`McpServerView.mode` 只在行里显式写了 `lazy`/`eager` 时出现，
`McpAddDraft.mode` 由添加表单按需携带（只在选 Lazy 时发送），`snapshot()` /
`serverView()` 返回的视图会带上它。

`setLoadingMode()` 只写受管 yml：受管行已存在时只替换 `config.mode`；行来自 JSON /
`.mcp.json` 且受管 yml 还没有对应行时，把整行复制进受管 yml 再写 `mode`，原文件不动。
写盘前会重新按服务器输入解析选中的行；没有有效连接配置的占位行（例如只有 id 的手写
disabled 行）会被拒绝，文件保持不变。它不改 `disabled`：给停用行切模式，行仍然停用。
目标位置必须是 `writeTargets()` 里的当前工作区 / 用户层 / 当前 profile；其它工作区
在写文件前拒绝。

写文件后排一次 `reconcileAll`，但方法本身不等待对账结束；要等对账完成再读结果，调用
`reload()`。两种模式的运行差异、会话连接生命周期、搜索扇出和限制见
[配置格式](format.zh.md#加载模式) 与 [Lazy 设计记录](../design/lazy-mcp.md)。

## 事件

每次 **成功** 的 `reconcileAll` 结束都会 emit——指纹未变、因而跳过重读、但仍跑完
健康巡检、会话 deny、工具预算和摘要的那一轮也算。装载 fiber 如果在这次对账
**结束之后**才变成 active 或 failed，会再发一次：连接完成时 `fiberPhase` 和
`toolCount` 才落定，不补这一次的话，设置页会停在「正在启动」，直到关掉重开。
对账进行中 settle 的不另发，收尾那一次已经读得到新状态。注册表调用：

```ts
ctx.on("projectMcp/updated", async () => {
  const snapshot = await ctx.projectMcp.snapshot();
});
```

事件名是 `PROJECT_MCP_UPDATED_EVENT`（`"projectMcp/updated"`）。无载荷，也不带
diff。派发是同步的，不会等待监听方返回的 Promise。监听方读 `snapshot()` 或
`serverView()`，和自己上次推出去的结果比较。对账中途因 `disposed` 返回，或对账
内部抛错，都不发。监听方抛错会记一条 `项目 MCP 变更事件投递失败：…`，对账本身
仍算成功。

## 类型

具名视图类型从包入口导出。`exports` 不开放 `lib/registry.js` 深导入。

```ts
import {
  PROJECT_MCP_SERVICE,
  PROJECT_MCP_UPDATED_EVENT,
  type FiberPhaseView,
  type McpAddDraft,
  type McpLoadingMode,
  type McpRowSource,
  type McpScopeInfo,
  type McpServerRuntimeView,
  type McpServerView,
  type McpTransport,
  type PatchRow,
  type ProjectFileState,
  type ProjectMcpService,
  type ProjectServerPhase,
  type ProjectServerState,
  type ReconnectConfig,
  type ToolFilter,
} from "dsh-project-mcp-manager";
```

`snapshot()` 的元素类型是 `ProjectFileState`。每一行是 `McpServerRuntimeView`
（`McpServerView` 再加 `source`、`fiberPhase`、`skipReason`、`toolCount`）。
`globalState()` 返回 `ProjectServerState`。`McpServerView.mode` 可选；缺省表示 Eager。
`McpAddDraft.mode` 同样可选，添加表单只在选 Lazy 时发送。

## 对配套 UI 的语义化版本

`projectMcp` 的方法、`projectMcp/updated`，以及上面导出的视图类型，**对配套 UI**
按语义化版本承诺：

| 版本位 | 对这个面意味着 |
|---|---|
| patch | 修复，方法、事件和视图形状不变。 |
| minor | 只增加字段、方法或事件。 |
| major | 删除、改名，或改变含义。 |

`setLoadingMode` 是新增方法，`McpLoadingMode`、`McpAddDraft.mode`、`McpServerView.mode`
是新增类型/字段，按上表都属于 **minor** additive 变更。旧 UI 忽略 `mode` 字段仍然
可用；新 UI 调用 `setLoadingMode` 时要求核心已经提供该方法，所以不能用旧核心配新
UI。包含这些改动的两个包必须一起升版、一起发布，不能只升其中一个。本次源码改动不改
版本号；发版时再按 minor 一起提升两个包。

manager 以**同一精确版本**的运行时 dependency 依赖 `dsh-project-mcp-ui`；UI
保留同一精确版本的 manager peer dependency。发布后的两份契约都不用 `^` 或
`~`，两个包必须同步升版、同步发布。用户只安装 manager，它的默认 bundle 负责
核心与 UI 两行；UI 不再单独声明 `dsh.bundle`（[安装与迁移](settings-ui.zh.md#安装)）。

manager 发布后的依赖契约：

```json
{
  "dependencies": {
    "dsh-project-mcp-ui": "<本包的精确版本>"
  }
}
```

UI 配套的 peer 契约：

```json
{
  "peerDependencies": {
    "dsh-project-mcp-manager": "<本包的精确版本>"
  }
}
```

两个占位符都换成 manager/UI 同步发布的版本。源码 workspace 中，manager 使用
`workspace:<精确版本>`，`pnpm pack` 时会转为上面的精确版本；不要直接对含
workspace 协议的 manifest 使用 `npm pack`。根目录 `pnpm run build` 先编译核心
再构建 UI，使 UI 消费当前核心的类型声明；UI 构建先清空自己的产物目录。

未来获准发布时，应把验收过的 UI 与 manager tarball 发布到非 `latest` 的 staging
标签，经全新消费方安装冒烟检查后，再一起提升标签。这是发布指引，不表示已经发布
或已经通过该检查。
