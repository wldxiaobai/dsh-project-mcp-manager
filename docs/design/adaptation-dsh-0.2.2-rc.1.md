# 适配记录：dsh v0.2.2-rc.1

[← 返回 README](../README.zh.md) ｜ 相关：[dsh 0.2.1-rc.5 适配记录](adaptation-dsh-0.2.1-rc.5.md) ·
[v0.11.0 发布说明](../releases/v0.11.0.md)

**记录日期**：2026-11-06 ｜ **插件**：`dsh-project-mcp-manager` v0.11.0
**宿主**：npm 上的 `@deepseek-ai/dsh@0.2.2-rc.1`；本机桌面运行时同为
0.2.2-rc.1（`resources/app.asar` 内 `@deepseek-ai/dsh-desktop-runtime` 清单）。
对照发布包 `@deepseek-ai/dsh-mcp-client@0.2.2-rc.1`、`@deepseek-ai/cordis@4.1.0`、
`@deepseek-ai/cordis-plugin-loader@1.1.0`，以及 rc.1 的 client UI 包。
本次没有在本机 headless profile 里跑 `dsh`。

**结论**：0.2.2-rc.1 对本插件的装载器、查询面和页面注册**没有接口变更**，但工具
链整体换代（cordis 4.1.0、loader 1.1.0、include 1.1.0、schemastery 3.19.0），
所以 v0.11.0 把依赖下限连同 `engines.dsh` 一起抬到 `^0.2.2-rc.1`。0.2.1-rc.2–rc.5
宿主继续使用 v0.10.0。

---

## 1. 发布包对照

`dsh-mcp-client` 0.2.1-rc.5 与 0.2.2-rc.1 在本次关心的区域逐行相同：

| 点 | 0.2.1-rc.5 | 0.2.2-rc.1 |
|---|---|---|
| cordis peer | `~4.0.5` | `~4.1.0` |
| dsh peer | 精确 `0.2.1-rc.5`（tools、scope、timeout、attachment、llm、subprocess；resources 与 system-prompt 可选） | 精确 `0.2.2-rc.1`，可选 peer 不变 |
| 直接依赖 | MCP client SDK `2.2.0`、schemastery `~3.18.5`、`dsh-util-values@0.2.1-rc.5` | SDK `2.2.0`、schemastery `~3.19.0`、`dsh-util-values@0.2.2-rc.1` |
| `Config` schema | `stdio` / `streamable-http` 判别联合，`toolCallTimeoutMs` 60000、`failOnStartupError` false、`maxInstructionBytes` 32768、`reconnect` 上限 `2147483647` | 同一段 schema，字段与默认值未变 |
| 导出 | `{ Config, apply, createMcpToolDefinition, inject, name }` | 同一组导出 |
| 新增 | — | `exports` 增加 `./locale/*.json`（client 自带文案，不影响插件） |

---

## 2. 对本插件有影响的宿主变更

| 点 | 0.2.1-rc.5 → 0.2.2-rc.1 | 处置 |
|---|---|---|
| 依赖范围 | rc.1 client 的 peer 是精确 rc.1 包；`^0.2.1-rc.5` 会被解析到 rc.1，在旧宿主上混装 peer | 下限改为 `^0.2.2-rc.1`；旧宿主留在 v0.10.0 |
| `engines.dsh` | 宿主检查带 `includePrerelease`，caret 上限仍等价 `<0.3.0-0` | 两包声明 `^0.2.2-rc.1` |
| Node 下限 | `engines.node >= 24.9.0` | 本仓库构建用 Node 26.7.0，不受影响；文档注明 |
| cordis | 4.0.5 → 4.1.0，新增 fiber 的 raw/resolve/effective 配置访问 | `ctx.effect(execute, label)` 与 `ctx.plugin(plugin, config)` 仍在。开发依赖 `^4.1.0` |
| loader | 1.0.6 → 1.1.0 | `Entry` 保留 `options.config`，**没有**顶层 `config` 访问器。`globalNames()` / `activeProfile()` 的 `entry?.config?.X ?? entry?.options?.config?.X` 回退正好覆盖 |
| schemastery | 3.18.5 → 3.19.0 | 本插件只用 zod，不直接依赖 |
| 工具执行器拆分 | 原生与 PTC 执行器改为按 Agent 作用域选择的插件；`tools.resolve/executable` 与提示词组装接口需迁移 | 目标是**直接注册工具**的插件；本插件经 mcp-client 装载，只调用 `tools.restrict()` 与 `tools.schemas()`，两者签名未变 |
| `tools.restrict()` | 新增两条前置校验：必须来自 `agent.ctx` 作用域；不得点名 `run_code` | 本插件用 `agent.ctx.tools.restrict({ deny })`，deny 里只有 `mcp__*` 工具名，不受影响 |
| `tools.schemas()` | 签名扩为 `schemas(scope, toolSet)`，两者都可省略 | 无参调用仍返回全局视图的已注册定义，预算统计不变 |
| 左侧栏槽位 | `sidebar.panellist`、`sidebar.panellist.actions` 仍由 ui-sidebar 声明 | 图标行注册照旧 |
| 主面板槽位 | `main` 仍是 root 作用域 keyed slot | 页面注册照旧 |
| 设置标签页 | `settings.plugins.tab` 仍存在 | 0.11.0 主动移除，不再依赖它 |
| 连接 API | `connection.fetch.register({ path, methods, requestBody, fetch })`，校验仍是「路径以 `/api` 开头、methods 非空且不重复」 | 七条路由照旧 |
| primitives | 页面用到的图标（`IconDatabaseOutlineRegular` 等）仍在 web 前端模块表 | 不改导入 |
| 官方 bundle 清单 | 改由 `@deepseek-ai/dsh-official-bundles` 导出 | 与本插件无关 |

---

## 3. 验证

- 依赖树按 rc.1 安装：`dsh-mcp-client`、`dsh-native-command` 与 client 开发依赖
  均为 0.2.2-rc.1，cordis 为 4.1.0，锁文件里没有 0.2.1-rc.5 残留。
- `npm run build` 通过；根与 client 两套 `tsc --noEmit` 通过。
- `npm test` 全绿：model 34 / mcp-file 7 / json-file 13 / json-write 6 /
  registry 63 / project-watch 5 / cli 21 / ui-collapse 14 / ui-paste 14 /
  ui-display 7 / panel-helpers / bundle / ui-lifecycle 11。
- 构建产物核对：`sidebar.panellist` 与 `main` 仍在；`settings.plugins.tab`
  已从 bundle 中消失；`dsh.client.inject` 只剩四项。
- 接口对照来自本机 `resources/app.asar` 内实际发布的 rc.1 包，不是只读发布说明。
- 未做真机点击回归。