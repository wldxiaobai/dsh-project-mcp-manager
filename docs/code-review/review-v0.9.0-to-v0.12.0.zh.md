# 代码审查：v0.9.0 至当前 v0.12.0 工作分支

**审查日期**：2026-11-10（Asia/Shanghai）

**分支**：`feat/ui-entries-workspace`

**基线**：`v0.9.0`（`32bfb0af57c3e15c352b886b5673dce249b5223c`，不含该标签自身已存在的改动）

**主要审查终点**：`7deffbbcb0d02f7241b3ed5aa58272fa67bd150c`（开始审查时的 HEAD，源码版本 `0.12.0`）
**补充终点**：`174b2fd1fa675c9ae4759d0e9397222f47d137bd`（审查期间新增三个纯文档提交，已核对范围及关键差异；业务代码与主要终点相同）

## 1. 结论与优先级

确认 **3 项本范围引入的问题：P2 × 2、P3 × 1**；未发现可证实的 P0/P1 问题。建议在下一次发布前修复 R1、R2，R3 可随统计修复一并处理。现有测试全部通过，但没有覆盖这些边界条件；不能以测试全绿代替下面的修复验收。

| 优先级 | 编号 | 问题 | 主要影响 | 建议顺序 |
|---|---|---|---|---|
| P2 | R1 | 入口设置弹窗使用旧草稿和最新 revision，静默覆盖别处更新 | 用户未编辑的设置被回滚 | 1 |
| P2 | R2 | 路径归一化无条件忽略大小写，把 POSIX 上不同工作区当成同一个 | 当前工作区计数、标签和排序错误 | 2 |
| P3 | R3 | 工作区计数未排除全局层，目录相同时计入 user/profile 服务器 | 特定合法配置下抬头统计错误 | 3 |

级别口径：P0 = 紧急阻断；P1 = 高影响、应优先修复；P2 = 正常优先级的确定性功能缺陷；P3 = 低频、影响有限的准确性问题。**本报告只审查并提出建议，没有修复业务代码。**

## 2. 范围与方法

### 2.1 改动范围

主要终点相对基线为 29 个提交（含合并提交），净改动 39 个文件，`+3300 / −606`。主要变化为：

- v0.10.0：增加主页左侧栏与主页面入口，适配 dsh 0.2.1-rc.5。
- v0.11.0 / v0.11.1：适配 dsh 0.2.2-rc.1、cordis 4.1.0，调整并恢复设置标签页入口。
- 当前 v0.12.0 工作分支：设置左侧栏入口、三个入口显隐设置、当前工作区抬头与分组、插件管理页设置入口、按语言选择 README，以及相应测试和文档。

根目录 [src/](<../../src/>) 内的核心装载器、配置模型、CLI 和配置写入实现，在基线至主要终点之间**没有净代码改动**。本轮检查它们与新增 UI 的交互及依赖升级兼容性，但不把未改代码做了一次完整重新审计，也不把基线已存在的行为当作新增问题。

审查期间另有 `e6887b6`、`a2cb725`、`174b2fd` 三个纯文档提交，已核对范围及关键差异，不改变本报告代码结论。它们由并行编辑产生，未将其内容混入本报告的修改或提交；完整业务代码审查仍固定在主要终点。

### 2.2 方法与边界

- 检查全部净改动清单，重点通读 UI、宿主接入、构建/依赖及新增测试的差异和相关上下文。
- 将新增设置表单、槽位注册和生命周期用法与本地安装的 dsh 0.2.2-rc.1 / cordis 4.1.0 实现及类型对照，而不只依据自定义接口和假服务测试。
- 由两个独立审查方向分别检查入口/表单/生命周期，以及工作区展示/宿主状态；主审独立重跑了本报告三项问题的最小复现。
- 执行完整构建与测试，并额外检查浏览器端 TypeScript。
- 未启动替代 Web 服务，未修改当前宿主的插件配置，未连接真实 MCP 服务器，也未在实际浏览器中做点击、视觉布局或跨窗口端到端验收。下面的组件驱动、真实 Cordis/槽位隔离验证不等同于实际浏览器验收。

## 3. 必要修复建议

### R1 · P2：入口设置会静默覆盖弹窗打开后其他客户端的修改

**位置**：[entries-row.tsx:35–47](<../../packages/ui/src/client/entries-row.tsx#L35-L47>)；[index.ts:59–61](<../../packages/ui/src/client/index.ts#L59-L61>)。

**原因**：打开弹窗时只保存 `draft`，没有保存作为编辑基线的 flags 和 revision。提交时却使用**实时更新后的** `flags` 与**打开时留下的** `draft` 比较；随后 `saveEntries()` 再读取提交瞬间的最新 revision。这样既把未编辑字段误判为需要写回，也绕过了本应保护旧草稿的 revision fence。

**触发步骤**：

1. revision 1 时三个入口都是 `true`；窗口 A 打开设置弹窗。
2. A 只取消 `sidebar`。
3. 窗口 B 将 `settingsTab` 设为 `false`，宿主更新同步到 A，快照变成 revision 2。
4. A 点「完成」。

**实测结果**：A 提交了以下操作，并携带 revision **2**，因此 B 的改动会被当作合法的最新写入覆盖：

```json
{
  "ops": [
    { "op": "set", "path": ["sidebar"], "value": false },
    { "op": "set", "path": ["settingsTab"], "value": true }
  ],
  "revision": 2
}
```

`settingsTab` 并不是 A 编辑的字段。甚至 A **不改任何勾选项**，只在 B 更新后点「完成」，也可能把 B 的修改还原。该问题不仅涉及两处设置入口，也涉及多个浏览器窗口或其他设置编辑器。

**验证证据**：加载实际构建的浏览器 bundle，使用真实 JSX runtime、内存 hook 状态与可变 ConfigForm 快照驱动 `McpEntriesRow`，执行上述交互，得到上述操作和 revision。另核对宿主 `ConfigForm.mutate(ops, expectedRevision)` 的契约：传入较早读取的 revision 正是用来保留编辑器的读版本 fence；当前接线没有把这个版本从编辑器传出来。

**建议修复**：

- 弹窗打开时同时保存 `{ baselineFlags, baselineRevision, draft }`。
- 用 `entryOps(baselineFlags, draft)` 计算本次真正的编辑，而不是用最新快照作比较基线。
- 让 `save` 接受编辑器保存的 revision，传给 `form.mutate`；不要在接线层替换为最新 revision。
- 遇到版本冲突，保留草稿并提示重新加载或确认后重试。如果选择自动合并，须明确采用“仅提交用户实际触碰的字段”的策略，不能默默回写整份旧草稿。

**验收测试**：

- A 无编辑，B 更新后 A 完成：不产生回滚 B 的写入。
- A、B 分别编辑不同字段：A 不得提交 B 字段的旧值；采用严格 fence 时应冲突拒绝并给出恢复路径。
- A、B 编辑同一字段：必须按明确定义的冲突策略处理。
- 断言写入 revision 来自编辑基线，而不是提交瞬间的快照。

### R2 · P2：POSIX 上两个不同工作区被误认成一个

**位置**：[workspace.ts:40–48](<../../packages/ui/src/client/workspace.ts#L40-L48>)；影响计数、分组标签和置顶排序。

**原因**：`normalizeProjectPath()` 无条件执行 `.toLowerCase()`，并把所有反斜杠都转换成路径分隔符。核心 [projectKeyOf():343–345](<../../src/model.ts#L343-L345>) 则仅在 Windows 下忽略大小写。浏览器新增的比较口径与宿主项目身份不一致。

在大小写敏感的 POSIX 文件系统上，`/workspace/App` 与 `/workspace/app` 可以是两个独立的合法工作区；它们现在会被视为同一个。POSIX 目录名中的合法反斜杠、前后空白也不应未经平台判断就被改写或裁掉。

**复现**（仓库根目录，Node 26；不访问对应目录）：

```js
import {
  sameProjectPath, workspaceCounts, workspaceGroupMarker, orderWorkspaceGroups
} from './packages/ui/src/client/workspace.ts';

const rows = [
  { projectRoot: '/workspace/App', layer: 'project', enabled: true, active: true, skipReason: null },
  { projectRoot: '/workspace/app', layer: 'project', enabled: true, active: false, skipReason: 'idle' }
];
console.log(sameProjectPath('/workspace/App', '/workspace/app'));
console.log(workspaceCounts(rows, '/workspace/App'));
console.log(workspaceGroupMarker('/workspace/app', [rows[1]], '/workspace/App'));
console.log(orderWorkspaceGroups([
  ['/workspace/app', 1], ['/workspace/App', 2]
], '/workspace/App'));
```

**实际 / 预期**：

| 项目 | 实际 | 预期 |
|---|---|---|
| 两路径是否同项目 | `true` | `false` |
| 当前工作区计数 | total 2、running 1、waiting 1 | total 1、running 1、waiting 0 |
| 另一工作区标记 | `current` | `idle` |
| 真正当前组排序 | 仍在第二位 | 移到第一位 |

这会在三个入口里一致呈现错误的“当前”身份和统计，但本次未发现它改变核心挂载或工具隔离；不要将其夸大成隔离泄漏。

**建议修复**：优先由宿主返回 canonical project key，让抬头和分组用宿主的项目身份比较；若暂时仍比较路径，应携带宿主平台信息，并严格镜像 `projectKeyOf()`。不要用浏览器操作系统替代宿主平台，因为浏览器可能远程访问另一平台的宿主。

**验收测试**：保留 Windows 盘符、目录名大小写不敏感的既有用例；新增 POSIX 大小写不同路径、合法反斜杠和空白目录名的不同身份用例，并分别断言计数、标记与排序。

### R3 · P3：目录相同时，全局服务器被计入“本工作区”统计

**位置**：[workspace.ts:65–74](<../../packages/ui/src/client/workspace.ts#L65-L74>)。

**原因**：`workspaceCounts()` 只比较 `row.projectRoot`，没有排除 `row.layer !== 'project'`。但全局行的这个字段并不保证为空：

1. 核心 [pushGlobalSnapshot():3153–3158](<../../src/registry.ts#L3153-L3158>) 将全局快照的 `project` 设为配置文件所在目录。
2. UI 宿主 [serverFrom():75–84](<../../packages/ui/src/index.ts#L75-L84>) 将它保留为全局行的 `projectRoot`。
3. 新统计直接把这个目录与 `activeProject` 比较。

**触发条件**：当前工作区根恰好等于 `DSH_HOME`，或当前 profile 的配置目录。例如将 `DSH_HOME` 设到某个工作目录后，在该目录开会话。这不是被禁止的路径：[findProjectRoot()](<../../src/project-root.ts>) 找不到 Git 根时会回退到 cwd。

**验证证据**：通过真实 `ProjectMcpRegistry.pushGlobalSnapshot()` 构造全局快照，再用真实 Cordis Context 挂载编译后的 UI 宿主，以隔离的 connection 注册表调用 `/api/project-mcp/state`。没有项目层行时，得到：

```json
{
  "activeProject": "D:\\isolated-workspace",
  "rows": [
    { "layer": "user", "projectRoot": "D:\\isolated-workspace" }
  ],
  "counts": { "total": 1, "running": 0, "waiting": 0, "disabled": 0 }
}
```

本工作区总数应为 **0**，因为唯一一行属于全局 user 层。若全局行 active 或 disabled，对应子计数也会受影响。该问题目前限于抬头展示，不影响全局常驻或项目装载策略，因此列 P3。

**建议修复**：在路径比较前先过滤 `row.layer === 'project'`，不要依赖全局行路径为空这一假设。设计提案 [§5.2](<../design/proposal-ui-entries-and-workspace.md#L165-L176>) 中关于全局行路径为空的描述，也应随修复改为正确的数据契约。

**验收测试**：构造 user/profile 行的 `projectRoot` 都与 `activeProject` 相同，断言它们不计入 total/running/waiting/disabled；同时保留真正项目行的统计。

## 4. 已验证项目与未列为缺陷的疑点

| 检查项 | 结果 |
|---|---|
| 入口动态关闭、恢复 | 隔离的实际 cordis + renderer SlotRegistry 下，三个入口均能移除/恢复；两条设置恢复行始终保留 |
| 槽位延迟声明、销毁和重新声明 | 隔离验证能正确注册、释放、重建；最终 fiber dispose 后七处注册均清零，表单监听器也清零 |
| 常驻设置行的卸载 | 真实槽位服务会将 `inject/register` 自动归属消费 fiber；假测试卸载后留下两行不代表真实资源泄漏 |
| ConfigForm 同步 | 宿主持续监听配置更新；表单订阅不是仅在弹窗打开后才刷新，故 R1 的并发触发链成立 |
| activeProject 来源 | 与 `writeTargets()` 同源，符合当前工作区与可编辑范围一致的设计；未发现本次新增的焦点选择逻辑问题 |
| 抬头行数与折叠卡片数不同 | 设计明确按原始配置行统计，不按折叠后逻辑服务器卡片统计；不作为本轮缺陷 |
| 构建与包元数据 | 同版本 manager/UI、bundle、locale 文档路径的现有断言通过；未据此声称已完成 npm 发布包安装验收 |
| 现有安全边界 | 未发现本范围新增的任意路径写入、秘密泄漏或项目工具隔离回归的可证实问题；并非对全仓库安全性的保证 |

## 5. 测试记录

环境：Windows，Node `26.7.0`，仓库指定的 pnpm `12.3.4`，已安装依赖对应 dsh `0.2.2-rc.1`。

### 5.1 完整构建与现有回归测试

执行 `pnpm test`（包含 pretest 的 core/UI 构建）通过：

| 测试组 | 结果 |
|---|---|
| model / mcp-file / json-file / json-write | 34 / 7 / 13 / 6 passed |
| registry / project-watch / cli | 63 / 5 / 21 passed |
| ui-collapse / ui-paste / ui-display | 14 / 14 / 7 passed |
| ui-workspace / ui-entries | 8 / 8 passed |
| panel-helpers / bundle | 脚本断言通过 |
| ui-client-wiring / ui-lifecycle | 7 / 11 passed |

首次受限运行在 esbuild 拉起子进程时出现 `spawn EPERM`，尚未进入完整测试；这是 Windows 沙箱管道限制，不计为代码失败。对同一命令获准放宽后重新执行，构建与全部测试通过。测试产生的仓库内临时 pnpm 缓存已清理。

### 5.2 额外检查

- `tsc --noEmit -p packages/ui/tsconfig.client.json`：通过。
- `tsc --noEmit -p tsconfig.json`：通过。
- `git diff --check v0.9.0 7deffbb`：通过。
- R1：实际构建组件的内存交互驱动，确认未编辑字段写回与最新 revision。
- R2：直接执行工作区纯函数，确认身份、计数、标签与排序四项错误。
- R3：真实全局快照 + 编译 UI 宿主路由 + 工作区统计，确认全局行误计入。

### 5.3 建议补充的测试（按优先级）

1. **P2：编辑器生命周期/并发交互**。现有 [纯函数测试](<../../test/test-ui-entries.mjs>) 验证 `entryOps`，但不能覆盖“草稿打开 → 外部快照更新 → 提交”；[浏览器接线测试:35–36](<../../test/test-ui-client-wiring.mjs#L35-L36>) 明确不渲染组件，正好漏过 R1。
2. **P2：跨平台项目身份**。在 [工作区测试](<../../test/test-ui-workspace.mjs>) 加入 POSIX 与 Windows 两套身份语义，防止把仅适用于 Windows 的规则推广到所有宿主。
3. **P3：跨层目录碰撞**。用户层/profile 层与当前项目路径相等时，断言只计项目层。
4. **P3：保留真实服务集成回归**。将此次隔离验证的实际 Cordis + SlotRegistry 延迟声明、重建和卸载场景沉淀成测试；保留现有轻量假服务测试，但不要把它当成真实资源生命周期的完整替代。

## 6. 推荐处理顺序

1. 单独修复 R1，补并发草稿与 revision fence 测试。
2. 单独修复 R2，统一宿主/浏览器项目身份契约并补跨平台测试。
3. 修复 R3，补层级过滤测试并更正设计中的全局路径假设。
4. 再跑完整构建、两套类型检查及全部测试；最后在两个浏览器窗口与大小写敏感宿主上做定向人工验收。

没有必要仅为风格、函数长度或个人偏好扩大这次修复范围；以上建议均围绕已验证的行为问题或直接相关的测试缺口。
