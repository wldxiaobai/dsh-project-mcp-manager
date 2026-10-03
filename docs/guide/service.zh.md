# 查询面（`projectMcp`）

[English](service.md) | 中文

[← 返回 README](../README.zh.md) ｜ 相关：[配置来源与分层](layers.zh.md) · [CLI `dsh-mcp`](cli.zh.md) · [设置页](settings-ui.zh.md)

其它插件和配套 UI 经 cordis 服务 `ctx.projectMcp` 读装载状态。核心服务只在进程内
发事件：对账成功结束时通知一次，装载在那之后才完成时再通知一次。浏览器走 bundle
内的配套 UI 自己建的 SSE，核心服务不打开那条通道。

## 方法

| 方法 | 行为 |
|---|---|
| `snapshot()` | 上一轮对账的内存分区（项目文件与用户层）。进对账队列，不读盘，不发起对账。 |
| `serverView(projectRoot, rawName)` | 一行的内存 view。排队规则与 `snapshot()` 相同。 |
| `globalState(rawName)` | 该原名的全局层运行态；项目行返回 `undefined`。 |
| `reload()` | 一次全量对账（`reconcileNow`）。 |
| `writeTargets()` | 添加对话框当前能写的受管 yml：当前工作区、用户层、当前 profile。 |
| `addServer(source, projectRoot, draft)` | 按表单追加一条受管 yml 行（没有文件就创建）并排一次对账。同名已在该文件里则拒绝，文件不动。 |
| `setServerEnabled(source, projectRoot, rawName, enabled)` | 受管 yml 行就地翻 `disabled`。其它来源的行在同作用域受管 yml 里落一条：启用写完整拷贝，停用写 `disabled: true` 占位。 |
| `removeServer(source, projectRoot, rawName)` | 删掉受管 yml 行；低层还有同名或同服务身份时改留 `disabled: true` 占位。其它来源的行落一条占位。 |
| `setToolEnabled(source, projectRoot, rawName, tool, enabled)` | 把一个精确工具名写进受管行的 `tools.allow` / `tools.deny`。含 glob 字符的拒绝。 |
| `toolStates(projectRoot, rawName)` | 已注册工具（短名）与各自是否可见。服务器未 active 时为空。 |
| `managedPathFor(source, projectRoot)` | 该来源的行会写到哪份受管 yml；解析不出 profile 名时为 `undefined`。 |
| `prepareManagedYml(source, projectRoot)` | 受管 yml 不存在时建一个 YAML 空列表（`[]`），返回绝对路径；第一次写服务器时再生成受管块。 |
| `openConfigFile(source, projectRoot)` | 经宿主注入的 opener 打开受管 yml。 |
| `subscribeUpdated(listener)` | 订阅下文的更新信号；返回退订函数。 |

服务器与工具修改方法（`addServer`、`setServerEnabled`、`removeServer`、
`setToolEnabled`）只碰三份受管 yml（工作区 `.dsh/mcp.yml`、`~/.dsh/mcp.yml`、
`~/.dsh/profiles/<当前>/mcp.yml`），会校验允许的写入位置；非焦点工作区在改文件前
拒绝。每次修改都排一次对账。路径查询、文件准备和打开接口不代表相同的修改权限
检查，也不触发对账。JSON 文件与 `.mcp.json` 从不写。

`snapshot()` / `serverView()` / `globalState()` 不发事件。

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
`globalState()` 返回 `ProjectServerState`。

## 对配套 UI 的语义化版本

`projectMcp` 的方法、`projectMcp/updated`，以及上面导出的视图类型，**对配套 UI**
按语义化版本承诺：

| 版本位 | 对这个面意味着 |
|---|---|
| patch | 修复，方法、事件和视图形状不变。 |
| minor | 只增加字段、方法或事件。 |
| major | 删除、改名，或改变含义。 |

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
