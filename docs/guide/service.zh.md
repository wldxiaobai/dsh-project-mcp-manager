# 查询面（`projectMcp`）

[English](service.md) | 中文

[← 返回 README](../README.zh.md) ｜ 相关：[配置来源与分层](layers.zh.md) · [CLI `dsh-mcp`](cli.zh.md)

其它插件和配套 UI 经 cordis 服务 `ctx.projectMcp` 读装载状态。本包只在进程内
发事件：对账成功结束时通知一次，装载在那之后才完成时再通知一次。浏览器仍走配套 UI
自己建的 SSE，本包不打开那条通道。

## 方法

| 方法 | 行为 |
|---|---|
| `snapshot()` | 上一轮对账的内存分区（项目文件与用户层）。进对账队列，不读盘，不发起对账。 |
| `serverView(projectRoot, rawName)` | 一行的内存 view。排队规则与 `snapshot()` 相同。 |
| `globalState(rawName)` | 该原名的全局层运行态；项目行返回 `undefined`。 |
| `reload()` | 一次全量对账（`reconcileNow`）。 |
| `writeTargets()` | 添加对话框当前能写的受管 yml：当前工作区、用户层、当前 profile。 |
| `addServer(source, projectRoot, draft)` | 按表单追加一条受管 yml 行（没有文件就创建）并排一次对账。同名已在该文件里则拒绝，文件不动。 |

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

配套 UI 把本包写成 peer dependency，并锁定到**同一精确版本**（不要写 `^` 或 `~`）。
查询面和 UI 一起动时，两边版本一起动：

```json
{
  "peerDependencies": {
    "dsh-project-mcp-manager": "<本包的精确版本>"
  }
}
```

把占位符换成 UI 所配套的那一版里、本包 `package.json` 的 `version`。
