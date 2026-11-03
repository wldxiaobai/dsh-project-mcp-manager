# 适配记录：dsh v0.2.1-rc.5

[← 返回 README](../README.zh.md) ｜ 相关：[dsh 0.2.1-rc.2 适配记录](adaptation-dsh-0.2.1-rc.2.md) ·
[v0.10.0 发布说明](../releases/v0.10.0.md)

**记录日期**：2026-11-04 ｜ **插件**：`dsh-project-mcp-manager` v0.10.0
**宿主**：npm 上的 `@deepseek-ai/dsh@0.2.1-rc.5`；本机桌面运行时同为
0.2.1-rc.5（`resources/app.asar` 内 `@deepseek-ai/dsh-desktop-runtime` 清单）。
对照发布包 `@deepseek-ai/dsh-mcp-client@0.2.1-rc.5`、`@deepseek-ai/cordis@4.0.5`、
以及 rc.5 的 client UI 包。本次没有在本机 headless profile 里跑 `dsh`。

**结论**：rc.2 → rc.5 没有对插件可见的接口变更。rc.3 的「更多」菜单、rc.5 的思考
内容展示都属于 UI 体验改动，发布说明里没有 client 配置字段、槽位或连接 API 的
变化。v0.10.0 只把依赖下限、开发依赖和 `engines.dsh` 抬到 `^0.2.1-rc.5`；装载器、
查询面、UI 注册和数据读写代码一行未改。0.2.1-rc.2–rc.4 宿主继续使用 v0.9.0。

---

## 1. 发布包对照

`dsh-mcp-client` 0.2.1-rc.2 与 0.2.1-rc.5 的 `lib/index.js` 在本次关心的区域
逐行相同：

| 点 | 0.2.1-rc.2 | 0.2.1-rc.5 |
|---|---|---|
| cordis peer | `~4.0.5` | `~4.0.5` |
| dsh peer | 精确 `0.2.1-rc.2`（tools、scope、timeout、attachment、llm、subprocess；resources 与 system-prompt 可选） | 精确 `0.2.1-rc.5`，可选 peer 不变 |
| 直接依赖 | MCP client SDK `2.2.0`、schemastery `~3.18.5`、`dsh-util-values@0.2.1-rc.2` | SDK `2.2.0`、schemastery `~3.18.5`、`dsh-util-values@0.2.1-rc.5` |
| `Config` schema | `stdio` / `streamable-http` 判别联合，`toolCallTimeoutMs` 60000、`failOnStartupError` false、`maxInstructionBytes` 32768、`reconnect` 上限 `2147483647` | 同一段 schema，字段与默认值未变 |
| 导出 | `{ Config, apply, createMcpToolDefinition, inject, name }` | 同一组导出 |
| serverName 预留 | `activeServerNames` 按注册作用域（agent / root）分组 | 同一实现 |

`dsh-native-command@0.2.1-rc.5` 与 rc.2 的包内容一致，`openNativeTextFile` 调用
不变。

---

## 2. 对本插件有影响的宿主变更

| 点 | 0.2.1-rc.2 → 0.2.1-rc.5 | 处置 |
|---|---|---|
| 依赖范围 | rc.5 client 的 peer 是精确 rc.5 包；`^0.2.1-rc.2` 会被解析到 rc.5，在 rc.2–rc.4 宿主上混装 peer | 下限改为 `^0.2.1-rc.5`；旧宿主留在 v0.9.0 |
| `engines.dsh` | 宿主检查带 `includePrerelease`，caret 上限仍等价 `<0.3.0-0` | 两包声明 `^0.2.1-rc.5` |
| 供应链策略 | 仓库 `minimumReleaseAgeExclude` 只列 rc.2，pnpm 会把范围依赖回落到 rc.2 | 列表整体换成 rc.5 |
| 左侧栏槽位 | `sidebar.panellist` 与 `sidebar.panellist.actions` 仍由 ui-sidebar 声明 | 0.10 的图标行与旧标签页注册照旧 |
| 主面板槽位 | `main` 仍是 root 作用域 keyed slot | 页面注册照旧 |
| 设置标签页 | `settings.plugins.tab` 仍是 list slot | 迁移期标签页照旧 |
| 连接 API | `connection.fetch.register({ path, methods, requestBody, fetch })` 形状不变 | 七条路由照旧 |
| primitives | 页面用到的图标（`IconDatabaseOutlineRegular` 等）仍在 web 前端模块表 | 不改导入 |
| cordis | 4.0.5 未变 | 开发依赖不变 |

---

## 3. 验证

- 依赖树按 rc.5 安装：`pnpm install` 后 `dsh-mcp-client`、`dsh-native-command` 与
  client 开发依赖均为 0.2.1-rc.5，锁文件里没有 rc.2 残留。
- `npm run build` 通过；根与 client 两套 `tsc --noEmit` 通过。
- `npm test` 全绿：model 34 / mcp-file 7 / json-file 13 / json-write 6 /
  registry 63 / project-watch 5 / cli 21 / ui-collapse 14 / ui-paste 14 /
  ui-display 7 / panel-helpers / bundle / ui-lifecycle 11。
- rc.5 运行时包的接口对照来自本机 `resources/app.asar` 内实际发布的
  `@deepseek-ai/dsh-mcp-client@0.2.1-rc.5` 与 rc.5 client 包，不是只读发布说明。
- 未做真机点击回归；桌面运行时已升级到 rc.5，但本机 profile 里装的是已发布
  0.9.0 副本，不是本仓库链接。
