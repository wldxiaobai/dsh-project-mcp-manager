# 设计提案：MCP 管理页的 UI 入口与“当前工作区”提示

[← 返回 README](../README.zh.md) ｜ 相关：[MCP 管理页使用指南](../guide/settings-ui.zh.md) · [dsh 0.2.2-rc.1 适配记录](adaptation-dsh-0.2.2-rc.1.md) · [v0.12.0 发布说明](../releases/v0.12.0.md)

**状态**：已实现（v0.12.0，实机点击回归待补） ｜ **提出日期**：2026-11-09 ｜ **目标版本**：v0.12.0
**关联**：`AGENTS.md`（UI 入口与槽位）、`packages/ui/src/client/index.ts`（现有注册）、`packages/ui/src/index.ts`（宿主半区）

## 0. 裁决结果

| 待决问题 | 裁决 |
|---|---|
| 入口开关放哪 | **设置 → 通用**（`settings.general.item`），不放在三个入口内部 |
| 主页页面形态 | **平面页 + 当前工作区抬头**，不做卡片 |
| 当前工作区提示 | **仅页面抬头**（工作区名、路径、服务器数）；三处入口都显示 |
| 开关持久化 | **`mcp-project-ui` 行的 Config**（宿主设置文档），浏览器经 `ctx.configForms` 读写 |
| 通用行形态 | 一行 +「设置…」按钮，弹小窗勾选三个开关 |
| 返回按钮 | **仅主页左侧栏页面**；标题行右侧，图标 +「回到当前工作区」 |
| 会话头部计数、工作区树标记、切换 toast | 本次不做，记录在 §7 |

术语：**工作区**在界面上指项目层（`<projectRoot>/.dsh/mcp.yml` 等），与代码、文档里的“项目层”同义。
“左侧栏”有两处含义：主页左侧栏 = `sidebar.panellist`；设置页左侧栏 = `settings.section` 导航。

## 1. 背景与目标

v0.11.1 有两个 UI 入口：左侧栏图标行（`sidebar.panellist` + `main`）和设置「插件」标签页（`settings.plugins.tab`），两者渲染同一个 `McpPanel`。

本次要解决三件事：

1. **入口可控**：用户可以选择在哪些位置显示 MCP 管理页，而不是只能整体启用/停用 UI 行。
2. **位置补齐**：增加设置页左侧栏入口，让不想用主页图标行的人也能在设置里找到。
3. **不迷路**：插件按当前工作区自动挂载/卸载组件，用户需要知道自己正处在哪个工作区、页面里看到的是不是当前工作区的服务器；主页页面替换了会话，必须有一条明确的返回路径。

非目标：不改装载器、查询面（`projectMcp` 服务契约）、CLI、配置格式与文件写入；不做跨入口的状态共享；不新增全局壳层（状态栏、底部栏）。

## 2. 三个入口

### 2.1 主页左侧栏

- `sidebar.panellist`：`id: "project-mcp"`、`order: 10`、`label: panelLabel`（“MCP 管理”），组件 `McpPanelIcon`（数据库图标）。
- `main`：`key: "project-mcp"`，组件 `McpSidebarPage`。
- `McpSidebarPage`：标题行（`h1` + 返回按钮）→ `McpPanel`。
- 平面页，不做卡片（理由见 §7）；保留整页滚动与 `--dsh-frame-top-clearance` 内边距，内容上限 960。

### 2.2 设置页左侧栏（新增）

- `settings.section`：`id: "project-mcp"`、`order: 20`（通用 0、模型 10、插件 15 之后）、`label: panelLabel`。
- `settings.section.icon`：同 `id`，组件 `McpPanelIcon`，复用数据库图标；没有该注册时外壳回落默认齿轮。
- 页面组件 `McpSettingsSection`：只渲染 `McpPanel`，不加标题、不加返回按钮——设置外壳已有标题与关闭按钮；也不额外加外层 padding，沿用设置内容列的边距，实机过挤再补。
- `id` 与主页侧栏相同不是因为共用一个槽位，只是文档与日志里统一叫法；两个槽位互不影响。

### 2.3 设置页「插件」标签页（旧位置）

- 保持 `settings.plugins.tab`：`id: "projectMcp"`、`order: 30`、`label: tab`（“插件：MCP 管理”），组件仍是 `McpPanel`。
- 没有外壳，因此**没有**返回按钮。
- 这是 v0.11.1 恢复的旧入口，本次只给它加显隐开关，默认仍显示，文案不变。

### 2.4 槽位与键

| 入口 | 槽位 | 键 / 选项 | 组件 |
|---|---|---|---|
| 主页左侧栏 | `sidebar.panellist` | `id: "project-mcp"`、`order: 10` | `McpPanelIcon` |
| 主页页面 | `main` | `key: "project-mcp"` | `McpSidebarPage` |
| 设置页左侧栏 | `settings.section` | `id: "project-mcp"`、`order: 20` | `McpSettingsSection` |
| 设置页左侧栏图标 | `settings.section.icon` | `id: "project-mcp"` | `McpPanelIcon` |
| 设置页「插件」标签页 | `settings.plugins.tab` | `id: "projectMcp"`、`order: 30` | `McpPanel` |
| 设置 → 通用行 | `settings.general.item` | `id: "mcp-entries"`、`order: 12` | `McpEntriesRow` |

## 3. 入口显隐设置

### 3.1 位置与形态

- 注册到 `settings.general.item`，`id: "mcp-entries"`、`order: 12`（外观 10/11、代码工作工具 15 之间）。
- 一行：标题「MCP 管理页入口」+ 说明「选择在哪些位置显示 MCP 管理页。」+ 右侧 `Button`「设置…」。
- 点「设置…」打开 `Modal`（body portal，与面板现有弹窗同一个 primitive）：
  - 标题「MCP 管理页入口设置」；
  - 三个 `Checkbox` 行：主页左侧栏、设置页左侧栏、设置页「插件」标签页；
  - 底部「取消 / 完成」；宽度约 440px。
- 弹窗内是**草稿**：打开时从表单快照初始化，点「完成」把有变化的字段合成一次 `mutate` 提交，然后关闭；取消丢弃草稿。
- 表单不可写（远程浏览器没有权限）时，三个勾选框禁用并显示说明；写入失败时保留弹窗并显示错误文案。

### 3.2 配置模型

`mcp-project-ui` 行新增 Config（schemastery，与其它 dsh 插件一致；需要给 `packages/ui` 增加 `@deepseek-ai/schemastery` 依赖）：

```ts
// packages/ui/src/index.ts
export const Config = Schema.object({
  sidebar: Schema.boolean().default(true),
  settingsSection: Schema.boolean().default(true),
  settingsTab: Schema.boolean().default(true)
});
```

- 三个默认值都是 `true`，即 v0.11.1 的行为不变。
- 值落**宿主设置文档**，不写 profile patch；`cordis.patch.yml` 不需要写 `config` 段。
- 浏览器端通过 `ctx.configForms.get("mcp-project-ui")` 读取与写入：
  - 快照 `{ value, base, user, revision, writable }`；
  - `mutate(operations, revision)` 一次提交多个字段；
  - 订阅快照变化，外部改动（另一个浏览器）也能同步。
- 这条路径与“代码工作工具”开关（`ctx.configForms.get("ui-settings")`）一致，可作为实现参照。

### 3.3 运行时生效

- 客户端插件在 `apply` 时读取表单快照，算出三个布尔；之后订阅变化，每次重算。
- 关闭某个入口：调用对应注册的 disposer。
- 打开某个入口：重新 `slots.inject(...)` + `slots.register(...)`；槽位若已声明会立即注册。
- 幂等：保存每对注册的 disposer 与当前状态，避免重复注册或重复释放。
- 主页侧栏的两个注册**成对处置**（`main` + `sidebar.panellist`）；关闭前若 `layout.panelInfo.activePanelId === "project-mcp"`，先 `layout.selectPanel(null)`，否则 `main` 会指向一个已注销的 key。
- 设置分区：成对处置 `settings.section` 与 `settings.section.icon`。
- 插件标签页：处置 `settings.plugins.tab`；若它正被选中，`ui-settings-plugins` 自身会回落到「已安装」。

### 3.4 全部关闭与逃生口

- **允许三个入口全关**。通用行不属于这三个开关，始终存在，是恢复入口；因此不设“至少保留一个”的约束。
- 前提是 `mcp-project-ui` 行本身启用。整行停用后所有 UI（含通用行）消失，需要在「插件」页重新启用该行——这是现有的总开关，行为不变。

### 3.5 依赖与降级

- 客户端插件 `inject` 增加 `layout` 与 `configForms`：
  - `layout` 用于返回按钮与“关闭前先交还会话”；
  - `configForms` 用于通用行与显隐同步。
- DSH Web 的默认组合始终提供这两个服务；若设置域缺席，整个客户端插件不激活，与现在缺少 `dsh-client-ui-settings-plugins` 时标签页不出现一致。
- 备选（**未采用**）：把显隐同步放进 `ctx.inject(["configForms"])` 子作用域、服务缺席时默认全显示。它只在“有侧栏、无设置域”的组合里有收益，复杂度更高，本次不做。

## 4. 主页页面

### 4.1 平面页，不做卡片

- 沿用现有 `.dsh-mcp-page`：整页滚动、`padding: calc(var(--dsh-frame-top-clearance, 0px) + 16px) 32px 32px`；`.dsh-mcp-page-inner` 上限 960。
- 不引入卡片边框、圆角、阴影或卡片背景。
- 理由：`main` 是 keyed slot，同一时刻只渲染一个 entry（`renderSlot("main", {}, { entryKey: panelId ?? "conversation" })`），选中本页就会卸载 `conversation`。卡片背后不会是会话，做不到“视觉上不脱离当前会话”；既然做不到，就不做半吊子卡片。

### 4.2 标题行与返回按钮

- 标题行：左侧 `h1`「MCP 管理」，右侧 `Button variant="outline" size="sm"`，图标 `IconChevronLeftOutlineMedium` + 文案「回到当前工作区」。
- 行为：`ctx.layout.selectPanel(null)`——选中会话界面，**不改变当前会话**。
- 只出现在 `McpSidebarPage`。设置分区与插件标签页都没有；设置外壳自己的关闭按钮就是它们的退路。
- 没有打开会话时按钮仍然有效，会落到新建会话页；不做按会话隐藏。
- 它不是模态：不拦截 Esc，不锁焦点，不画遮罩；只是导航。
- 实现上经 slot 的 `inject` 把 `onBack` 传给组件，避免 `entries.tsx` 直接依赖 cordis 上下文。

### 4.3 三处入口的差异

| 项 | 主页左侧栏 | 设置页左侧栏 | 设置页「插件」标签页 |
|---|---|---|---|
| 外壳 | `McpSidebarPage` | `McpSettingsSection` | 无（直接 `McpPanel`） |
| 页面标题 | 有（`h1`） | 无（设置外壳） | 无（标签页） |
| 返回按钮 | 有 | 无 | 无 |
| 当前工作区抬头 | 有 | 有 | 有 |
| 页面形态 | 平面页 | 设置内容列 | 标签内容 |

## 5. 当前工作区抬头

### 5.1 位置与结构

- 放在 `McpPanel` 顶部，三个入口自动一致；入口壳不再重复渲染。
- 结构（自上而下）：
  1. 小标签「当前工作区」；
  2. 工作区名（`basename(activeProject)`）；
  3. 完整路径（代码字体、超长省略、`title` 显示全文）；
  4. 状态行：`N 个服务器 · M 运行中 · K 待会话 · J 已禁用`（只显示非零项）；
  5. 说明行：「只装载当前工作区的服务器；切到其它工作区后自动装载。」
- 没有任何工作区焦点时：名称显示「当前工作区未确定」，隐藏路径，说明改为「打开一个会话或发送一条消息后确定。」

### 5.2 数据来源

- `McpUiState`（`packages/ui/src/wire.ts`）增加 `activeProject: string | null`。
- UI 宿主半区（`packages/ui/src/index.ts`）从 `mcp.writeTargets()` 里 `id === "project"` 的 `projectRoot` 取值：
  - `writeTargets()` 内部就是 `focusedProjectRoot()`：有焦点时给当前工作区；只有一个已知工作区时也给它；多个工作区且无焦点时没有项目项。
  - 因此**不需要**改 `projectMcp` 服务契约，也不需要新增服务方法；这个值同时是「添加 MCP」默认写入的工作区，抬头与可编辑范围一致。
- 计数只统计 `servers` 中 `projectRoot === activeProject` 的行：
  - 运行中：`active === true`；
  - 待会话：`skipReason === "idle"`；
  - 已禁用：`enabled === false`；
  - 启动中、失败等其它状态不单列，总数仍包含它们。
- 用户层 / profile 层的行 `projectRoot` 为空，不计入工作区抬头。

### 5.3 分组标记

- 当前工作区那一组置顶，组标题后挂「当前」标签。
- 其它工作区分组挂「空闲」，并附一句「切到该工作区时装载。」。
- 判断依据：该组行出现 `skipReason === "idle"`；已有更具体原因（`env-missing`、`env-invalid`、`name-taken` 等）不覆盖。
- 用户层、profile 层分组不加这些标签。

## 6. 文案

新增键（`packages/ui/src/client/locales.ts`，中英同步）：

| key | zh | en |
|---|---|---|
| `backToWorkspace` | 回到当前工作区 | Back to current workspace |
| `currentWorkspace` | 当前工作区 | Current workspace |
| `workspaceUnknown` | 当前工作区未确定 | Current workspace not determined |
| `workspaceUnknownHint` | 打开一个会话或发送一条消息后确定。 | Open a session or send a message to determine it. |
| `workspaceScopeNote` | 只装载当前工作区的服务器；切到其它工作区后自动装载。 | Only this workspace's servers are loaded; others load when you switch. |
| `workspaceCurrent` | 当前 | Current |
| `workspaceIdle` | 空闲 | Idle |
| `workspaceIdleHint` | 切到该工作区时装载。 | Loads when you switch to this workspace. |
| `entriesTitle` | MCP 管理页入口 | MCP management page entries |
| `entriesHint` | 选择在哪些位置显示 MCP 管理页。 | Choose where the MCP management page appears. |
| `entriesOpen` | 设置… | Configure… |
| `entriesDialogTitle` | MCP 管理页入口设置 | MCP management page entries |
| `entriesSidebar` | 主页左侧栏 | Main sidebar |
| `entriesSettingsSection` | 设置页左侧栏 | Settings sidebar |
| `entriesSettingsTab` | 设置页「插件」标签页 | Settings › Plugins tab |
| `entriesDone` | 完成 | Done |
| `entriesReadOnly` | 当前页面没有修改权限。 | This page cannot change these settings. |
| `entriesWriteFailed` | 保存失败，请重试。 | Couldn't save. Try again. |

复用现有键：`panelLabel`（侧栏行、设置分区、页面标题）、`tab`（标签页）、`cancel`（取消）。

## 7. 不采用与延后

| 方案 | 结论 | 理由 |
|---|---|---|
| 卡片页 | 不采用 | `main` 选中即卸载会话，卡片背后不是会话；无法达成“不脱离当前会话” |
| 面板挂载即弹 Modal + 交还会话 | 不采用 | 会话组件卸载重挂，滚动位置与输入焦点可能丢；首帧有风险 |
| 从「更多」菜单弹 Modal | 延后 | 干净、能保留会话，但入口不是图标行；以后要浮层再考虑 |
| `plugins.row.config` 插件页配置 | 不采用 | 用户选择“设置 → 通用”；插件页行配置路径更深 |
| localStorage | 不采用 | 桌面端每次启动端口可能变化，origin 变则配置丢失 |
| 会话头部计数下拉（MCP · N） | 延后 | 本次只做页面抬头；需要把面板的数据订阅提成共享 store |
| 工作区树的会话行标记 | 延后 | 每个会话行都标会显得吵，收益比不高 |
| 切换工作区 toast | 延后 | 默认关闭也要写一套“只在挂载集合变化时提示”的逻辑 |
| `shell.bottom` 状态栏 | 不采用 | 占一整行高度、缩小三栏；且是全局而非每会话 |
| `sidebar.footer.action` | 不采用 | 单席位，和 Settings 抢位置 |
| 右侧栏新 tab | 不采用 | 为一个状态开一个面板，过重 |
| 动态侧栏 label | 不采用 | 槽位只在 locale / ledger 变化时解析 label，跟不上工作区切换 |

## 8. 实现要点与风险

1. **Config 写入是否触发该行重载**：需要实测。参考 `ui-settings.enabled` 走同一路径；若确实重载，弹窗已采用“草稿 + 一次提交”，最多闪一次，提交后关闭即可。测试时要覆盖“勾选后立即关闭弹窗”的路径。
2. **`settings.section.icon` 实机渲染**：0.2.2-rc.1 声明为 root 作用域 list（`inline: true`），已确认存在；图标视觉效果（16px、active 态）需在桌面端与 web 端各看一次；缺失时回落默认齿轮。
3. **关闭侧栏入口的顺序**：先 `selectPanel(null)`（如果在页面上），再 dispose `main` 与 `sidebar.panellist`。
4. **设置分区在另一浏览器被隐藏**：若当时正停在我们的分区，设置内容列可能为空；只能换一个分区。属于接受的边缘情况。
5. **并发面板数**：三处入口最多同时挂两个 `McpPanel`（侧栏页 + 设置里一个面），SSE 最多两条，与 v0.11.1 相同；本次不引入共享 store。
6. **`activeProject` 为空**：多个工作区且尚无焦点时按“未确定”显示，不猜；只有一个工作区时 `writeTargets()` 会给它。
7. **新增客户端依赖**：`layout`、`configForms` 都是硬注入；DSH Web 默认组合始终提供。若某个部署去掉设置域，整个 UI 插件不激活（与现在缺少 settings-plugins 时行为一致）。
8. **测试**：`test/test-bundle.mjs` 需要断言新增的 `settings.section`、`settings.section.icon`、`settings.general.item` 注册与 `mcp-project-ui` 的 Config 字段；新增 UI 测试覆盖开关增删注册、返回按钮回调、抬头在有/无 `activeProject` 两种状态下的渲染。

## 9. 验收清单

- [ ] 默认三个入口全显示，v0.11.1 行为不变。
- [ ] 通用行出现；「设置…」打开小窗；三个勾选框；「完成」一次提交；「取消」丢弃。
- [ ] 关闭主页入口：侧栏行消失；若正停在该页，先回到会话，`main` 注册一并移除。
- [ ] 关闭设置分区：设置导航不再出现该分区。
- [ ] 关闭插件标签页：标签消失；若正停在该标签页，回落到「已安装」。
- [ ] 三个全关后通用行仍在，可恢复。
- [ ] 主页页面无卡片；返回按钮只在主页侧栏页出现。
- [ ] 返回按钮回到会话界面，且当前会话不变。
- [ ] 抬头显示当前工作区名、路径与计数；无焦点时显示「未确定」。
- [ ] 其它工作区分组标「空闲」，当前工作区分组置顶并标「当前」。
- [ ] 设置分区与插件标签页显示同一抬头。
- [ ] 构建、类型检查、现有测试全部通过。

## 10. 未决事项

- 目标版本号：暂定 v0.12.0。
- 设置分区图标：先复用数据库图标；如果视觉上比内置分区的图标重，再换更细的图标。
- 通用行副标题是否显示「当前显示 N/3 个入口」：可选，不影响行为。

## 11. 实现记录（v0.12.0）

- 宿主半区：`packages/ui/src/index.ts` 导出 `Config`（`sidebar` /
  `settingsSection` / `settingsTab`，默认全 `true`），`McpUiState` 增加
  `activeProject`（取 `writeTargets()` 的项目项）；`packages/ui` 增加
  `@deepseek-ai/schemastery` 依赖。
- 浏览器半区：`client/index.ts` 的 `inject` 增加 `layout`、`configForms`；槽位
  描述集中在 `entries-registry.ts`；显隐模型与提交操作在 `entries-settings.ts`；
  幂等增删注册在 `entries-controller.ts`；通用行在 `entries-row.tsx`；抬头与
  分组判断在 `workspace.ts`。
- 三个入口：主页侧栏行 + `main`（返回按钮经 slot `inject` 传入）、设置页
  `settings.section` + `settings.section.icon`、`settings.plugins.tab`，外加
  `settings.general.item` 的显隐行（id `mcp-entries`、order 12）。
- 测试：`test/test-ui-workspace.mjs`、`test/test-ui-entries.mjs`、
  `test/test-ui-client-wiring.mjs`（加载构建后的浏览器 bundle 驱动 `apply()`），
  并更新 `test/test-bundle.mjs` 与 `test/test-ui-lifecycle.mjs`。
- 未做：真机点击回归；§8.1 的「Config 写入是否触发该行重载」未实测。
