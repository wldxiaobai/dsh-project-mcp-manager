# PR #32 保持工作区连接并按会话隔离发现 — 两轮审查报告

- 日期：2026-11-11 初审；2026-11-11 增量复审；2026-11-12 整理为本报告。
- PR：[wldxiaobai/dsh-project-mcp-manager#32](https://github.com/wldxiaobai/dsh-project-mcp-manager/pull/32)，作者 @yangjh0127（CONTRIBUTOR）。
- 基线：`dev` @ `31e41a0`；PR head `b5e75a9`（6 提交，20 文件，+596/−659，GitHub 报告 mergeable clean）。
- 本地分支：`pr-32`（经 `refs/pull/32/head` 拉取，两次快进：`31f02fa` → `b5e75a9`，旧顶端可经 reflog 回溯）。
- 范围：挂载模型与会话隔离、Lazy 连接生命周期、生效名稳定性、宿主事件契约、测试与双语文档。
- 操作边界：审查阶段只拉取与只读审查，不合并、变基或推送；修复阶段经用户指示在 `pr-32` 分支实施并提交（见文末实施记录），不推送。
- 行号约定：除注明外均相对 PR head `b5e75a9`，不是当前 `dev` 工作区；Sonar 行号为服务器分析版本。

## PR 概要

初审 3 提交（`cedd30d`、`61dcaee`、`31f02fa`）把 v0.6.0 的「聚焦独占挂载、切走即卸载」改为「**已发现工作区常驻挂载 + 按会话隔离可见性**」：Eager 经会话级 `tools.restrict({ deny })` 隔离，服务器 instructions 经 `system-prompt/assemble` 过滤，资源调用经 `tools/pre-execute` 门检；Lazy 连接改为每会话首次 `mcp_search` 独立激活、会话结束才释放（删除 5 分钟空闲关闭与 `UNMOUNT_GRACE_MS` 宽限卸载）。

复审 3 提交（`f746af4`、`45c9f17`、`b5e75a9`）：会话创建不再等待连接重挂（`prepareAgent` 同步落 deny，对账异步排队）；新增 `agent/pre-step` 钩子在 `step===1` 时等待可见 Eager 就绪（上限 20 秒）；`effectiveServerNames` 增加 `retained` 参数，保留已挂载 Eager 的生效名，新来的同名行才加前缀，避免在线实例被改名重挂。

作者动机（PR 评论）：多工作区会话来回切换后 MCP 失联；新工作区建会话时旧逻辑同名重命名 + 等旧连接释放再重挂，实测界面卡约 15 秒。维护者已认可方向（「合理。待代码审查和功能验证之后即可并入 dev」）。

## 优先级定义

| 级别 | 含义 |
| --- | --- |
| P0 | 功能性缺陷，阻塞合入 |
| P1 | 合入前应处理（文档同步、质量门禁） |
| P2 | 建议改进，可 follow-up |
| P3 | 合入时事项与备注 |

## 问题总表

| 编号 | 优先级 | 发现 / 风险 | 处置与验收 | 状态 |
| --- | --- | --- | --- | --- |
| R32-01 | P0 | `agent/pre-step` 等待发生在宿主逐步工具/提示词快照**之后**，被延迟的当前步骤仍看不到等待期间挂载的工具，最多白等 20 秒 | 把等待挪到快照之前，或移除等待并改文档；用慢挂载服务器复验 step 1 请求的 tools 列表 | **已修复**（等待移回 `agent/created`，见实施记录） |
| R32-02 | P1 | 文档同步缺口：AGENTS.md 三处旧口径、registry 模块头「确定性」声明、`docs/design/lazy-mcp.md` 空闲关闭、CHANGELOG/how-it-works 等待措辞 | 按下方清单逐项同步，中英双版 | **已修复**（文档已同步） |
| R32-03 | P1 | SonarCloud 新增 2 项：S1994（CRITICAL 级异味）与 S9382（MINOR） | S1994 改写循环；S9382 属有意轮询，标记 accepted 并注明理由 | 部分（S1994 已改 while；S9382 已注理由，Sonar 侧 accepted 待维护者操作） |
| R32-04 | P2 | UI/CLI 的 `idle` 死分支：`skipReason==="idle"` 与「空闲」分组标记不再触发；CLI `summary.idle` 输出恒空 | 后续清理或改语义；CLI 保留可读旧诊断文件亦合理 | **已修复**（删 UI/registry 死分支；旧诊断文件只读兼容保留） |
| R32-05 | P2 | `clearClosedWorkspaceFocus` 未查 `liveSessionCwds()`，「已恢复但尚无 agent」的工作区可能被误清焦点 | 补检查，或注释说明仅影响管理页展示 | **已修复**（补恢复会话检查） |
| R32-06 | P2 | `isLive()` 从 id 比较改为对象同一性，依赖宿主返回稳定 agent 对象，假设未注释 | 加注释固化假设（宿主注册表已核实稳定） | **已修复**（已注释） |
| R32-07 | P2 | `filterMcpPrompt` 正则与宿主文案强耦合，失配时整段丢弃 | 注释来源包 `dsh-mcp-resources`；保留 fail-closed 方向 | **已修复**（已注释来源与 fail-closed） |
| R32-08 | P2 | `availableServerName` 哈希后缀兜底分支（生成名撞字面名/截断名）无单测 | 补纯函数测试 | **已修复**（补碰撞/保留单测） |
| R32-09 | P2 | `LazyConnections.release` 的 `closing.then(…)` 无 catch | 防御性 catch，或注释论证当前实现不会 reject | **已修复**（两态均摘除集合元素） |
| R32-10 | P2 | 保留的生效名在冲突消失后仍保持前缀名直到卸载（有意稳定化权衡） | 在文档中明示该权衡 | **已修复**（AGENTS.md/how-it-works 已明示） |
| R32-11 | P3 | 合入时事项：CHANGELOG 条目补 `@yangjh0127` 与 `#32`，两版 README 末尾补致谢 | 按 AGENTS.md 外部 PR 合入规则执行 | 待合入 |
| R32-12 | P3 | 实机复核（维护者合入条件）：全量 `pnpm test` + R32-01 场景 + 多工作区切换 | 作者声称已通过；维护者侧复核后再合入 | 本地全量测试已通过；实机 GUI 待维护者复核 |

## R32-01（P0）等待时序与宿主快照冲突

**证据链**（DSH 0.2.2-rc.1 宿主源码，经 app.asar 解包逐段核实）：

1. `dsh-agent-loop` `preStep()` 的顺序是：`tools.resolve({agent})` → `systemPrompt.assemble({…toolSet})` → `waterfall("agent/pre-step", …)`。PR 的 `waitForVisibleEager` 挂在 waterfall 内，即**快照之后**。
2. `dsh-tools` `resolve()` 把准入工具冻结进 `admitted` Map；返回的 `view(scope)` 只对 admitted 集按当前可见性再过滤，**不纳入 resolve 之后注册的工具**。
3. `dsh-agent-loop` `step(decision)` 直接 `renderPrompt(decision.assembly)`、`buildRequest(…, assembly.tools, …)`；`refreshContext` 只刷新运行时上下文段，不重新解析工具、不重新装配提示词。

**后果**：等待期间挂载完成的服务器，其工具与 instructions 不会进入被延迟的这一步。工具要到下一步（step 2 重新走 preStep）才可见；若模型第一步未调用任何工具，回合直接结束——用户白等最多 20 秒，得到一个没有 MCP 参与的回答。这正是该功能针对的冷启动慢挂载场景。快挂载场景（快照时已就绪）不受影响，因此作者实机验证与现有测试（只断言等待时序，不涉及宿主快照）均无法暴露它。

**复验方法**：用一个故意延迟 initialize（如 10 秒）的 stdio 服务器，冷启动后立即发第一条消息，抓 step 1 模型请求里的 tools 列表——按当前实现应缺该服务器。

**修复选项**（供作者权衡）：

- 把等待挪到快照之前的时机（如串行 `agent/created` 内按需等待——会部分回退「会话秒开」收益；或请宿主在 waterfall 后重解析，属宿主改动）；
- 或移除等待，文档如实说明「工具自下一步起可见」，并删除 CHANGELOG 相应承诺；
- 无论取舍，`step===1` 是**每个回合的第一步**（宿主 payload 同时含 `turn` 与 `step`），健康重挂期间每条新消息都可能触发等待，文档与延迟预期需按此描述。

**验收**：慢挂载场景下 step 1 请求可见已就绪工具（或文档不再承诺）；等待不再引入无收益延迟。

## R32-02（P1）文档同步清单

| 文件 | 位置 | 现状 | 应改为 |
| --- | --- | --- | --- |
| `AGENTS.md` | L15 目录结构 registry 段 | `skipReason` 含 `idle`、「idle 卸载进 summary.idle」、「会话边只听 agent/created 与 agent/disposed」 | idle 不再产生；事件清单补 session/created、session/disposed、session/event、tools/change、system-prompt/assemble、tools/pre-execute、agent/pre-step |
| `AGENTS.md` | L26 UI 段 | 「其它有 idle 行的组标『空闲』」 | 已随 R32-04 改为「其它分组不标记」 |
| `AGENTS.md` | L48「全局 vs 项目」 | 「项目层按需挂载（有会话或进程 cwd）」 | 与已更新的「工作区挂载」条目一致 |
| `AGENTS.md` | 目录结构 model.ts 段、「生效名 vs 原名」 | 只描述「冲突改 `p<hash>_`」 | 补 retained 优先保留、宿主全局名例外、23+8 哈希兜底 |
| `src/registry.ts` | 模块头 | 生效名「确定性、与装载顺序无关」 | retained 使生效名依赖挂载历史，声明失效 |
| `docs/design/lazy-mcp.md` | L15/67/118 | 「空闲五分钟关闭」 | 改为会话级生命周期；`docs/guide/service.md` 已链接它作为「会话连接生命周期」权威 |
| `CHANGELOG.md`、`docs/guide/how-it-works.md`/`.zh.md` | 等待描述 | 「Before the first model request / 首个模型请求」「DSH waits」 | 每回合第一步、等待方是插件；若 R32-01 移除等待则同步删除 |

历史 release/code-review 记录（`docs/releases/`、旧审查）不改。

## R32-03（P1）SonarCloud 新增 2 项

质量门仍通过（[QG API](https://sonarcloud.io/api/qualitygates/project_status?projectKey=wldxiaobai_dsh-project-mcp-manager&pullRequest=32)），但上一提交刚专门修过 Sonar 新代码问题，建议保持新增问题清零：

- `typescript:S1994`（CRITICAL 级异味）`src/model.ts:412`：`for (let attempt = 0; used.has(candidate); attempt++)` 循环条件不含增量变量。改写为 `while (used.has(candidate))` 循环体内递增即可。
- `typescript:S9382`（MINOR）`src/registry.ts:1195`：`waitForVisibleEager` 轮询循环内 await 是**有意串行轮询**，非性能缺陷；在 Sonar 标记 accepted 并注明理由，不必改写。

## P2 细节

- **R32-04（已清理）**：`packages/ui/src/client/McpPanel.tsx`、`workspace.ts` 的 `idle` 分支与「空闲」分组标记、`workspaceIdle`/`workspaceIdleHint` 文案、`.group-note` 样式均已删除；`src/cli.ts` 的 `summary.idle` 打印保留为旧诊断文件只读兼容；registry 侧删除 `collectSkipMarks` 的 idle 分支与 `summary.idle` 写入，只保留 `DiagSummary.idle`/`parseIdleNames` 的读取兼容。
- **R32-05**：焦点只影响管理页展示与写入目标，无安全后果；但冷启动恢复态下可能误清，建议补 `liveSessionCwds()` 检查。
- **R32-06**：已核实宿主 `agents.announce()` 要求 agent 先入注册表才派发 serial `agent/created`，且注册表持有稳定对象——当前实现安全；注释固化假设，防止宿主将来返回投影时 Lazy 工具静默 fail-closed。
- **R32-07**：正则 `/^(.*: )(\[.*\])\.$/s` 与 `dsh-mcp-resources` 现行文案逐字匹配（已核实）；失配丢整段是 fail-closed，方向安全。按仓库「镜像值」惯例注释来源，便于宿主升级追踪。
- **R32-08**：兜底路径 `preferred.slice(0,23) + "_" + sha256(key\0attempt)前8hex`（≤32 字符，符合 zod 上限）逻辑正确但无测试；纯函数易补。
- **R32-09**：`close()` 的 shutdown 链当前不会 reject（abort/close/ready 均已 catch），补 catch 属防御。
- **R32-10**：冲突消失后已挂实例保持前缀名直到卸载，避免改名 churn，是有意权衡；文档明示。

## 已核实通过项

**宿主契约（初审，对照 0.2.2-rc.1 asar 源码）**：

| 依赖 | 核实结果 |
| --- | --- |
| `tools/change`、`system-prompt/assemble`、`tools/pre-execute` | 存在且签名匹配（waterfall + next；`{kind:"deny"}` 是合法 PreToolDecision） |
| 提示词小节 `mcp:<生效名>` | 由 `dsh-mcp-client` 以 `` name: `mcp:${server}` `` 注册 |
| `mcp-resource-servers` 文本 | 与 `dsh-mcp-resources` 实际文案匹配；装配时 text 已解析为字符串 |
| 资源工具只查 `arguments.server` | 三个资源工具 `server` 均 required，无遗漏路径 |
| `sessions.list()` 启动发现 | `SessionStore.list()` 只返回内存在线会话，不会拉起历史项目 |

**实现要点（两轮）**：`denySetFor(undefined, …)` fail-closed；`releaseFiber` 先 `lazy.dispose()` 再拆 fiber；`unmountRow` 等 name-release 后才删 Map 项，与「卸载中仍参与隔离」自洽；`UNMOUNT_GRACE_MS`/`unmountGraceMs` 未从包入口导出过，删除不构成公共 API 破坏；`prepareAgent` 的同一性门安全（见 R32-06）；retained 两遍算法正确（宿主全局名优先、retained 次之、冲突计数取前缀、兜底防撞）；`mountedEagerNames` 正确排除 lazy/disabled/无 fiber 行；`lastScanDesired` 含全部已知项目，无配置工作区不等待；lazy-only、disabled、env-missing/name-taken（有 skip 标记）、failed 均不阻塞等待；abort 经 `timers/promises.wait({signal})` 正确抛 AbortError；`fakeCtx` 通用 handlers/emit 支持新事件。

**测试**：删除的测试与被删功能一一对应；新增回归覆盖多工作区隔离、动态工具目录、提示词/资源过滤、每会话独立激活、agent 替换复用连接、会话销毁回收、会话创建不等 dispose（<1s 且隔离已生效）、pre-step 等待/取消/lazy-only 不等待、重名保留在线实例。断言到真实 stdio trace 的 initialize/exit 计数。注意：现有测试不覆盖 R32-01 的快照时序（也非插件单测所能覆盖）。

## 设计权衡（维护者需知情，非缺陷）

- 隔离从「物理卸载」变为 **deny + 提示词过滤 + 资源门** 三层防御；未解析项目的会话 fail-closed。
- Eager 进程数随已发现工作区数线性增长且常驻；Lazy 连接按「会话 × 激活行」增长、空闲不再回收，会话结束才释放。工具预算护栏仍告警、永不裁剪。
- stdio 安全边界不变：项目/用户层配置文件仍是可执行代码载体，只用于可信项目。
- 生效名从「目录确定性」变为「挂载历史稳定化」：在线实例不因新冲突改名重挂（R32-10 的权衡）。

## 验证记录与边界

- 已做：两轮完整 diff 静态审查；宿主 asar 源码逐段核实（事件签名、提示词格式、资源工具参数、sessions/agents 注册表语义、preStep/step/resolve 时序）；GitHub API 与 SonarCloud issues API 核对。修复阶段在本地运行核心 `tsc --noEmit` 与全量 `pnpm test`（含 core/UI 构建），见实施记录。
- 未做：未实机 GUI 点测；未做 npm 发布 smoke；R32-01 的慢挂载实机复验（延迟 initialize 的 stdio 服务器）仍建议维护者侧补做。
- 作者声称：Windows、Node.js 22 全量 `pnpm test` 通过（含构建）；DSH 0.2.2-rc.1 配合两个 stdio MCP 服务实机验证工作区切换与隔离。Sonar QG 通过（复审时新增 2 项问题，见 R32-03）。
- 环境边界：本会话沙箱内 pwsh 无法初始化（0xC0000142），git/构建/测试命令经逐次批准提权执行；属执行环境限制，不计为产品缺陷。
- 本报告为本地记录，尚未贴到 PR；对外发布需维护者确认。

## 结论

- **初审**：方向正确、实现质量较高，宿主契约全部核实；建议补文档同步并实机复核后合入。
- **复审**：发现 R32-01（P0）——等待钩子位于宿主快照之后，宣称的「首个模型请求等到工具就绪」在慢挂载场景不成立。
- **修复实施（2026-11-12）**：经维护者选定「等待移回会话创建路径」方案，R32-01 已修复；R32-02/R32-03（S1994）及 P2 各项（R32-04～R32-10）已一并落实，全量 `pnpm test` 通过。**合入前仍余**：R32-03 的 S9382 Sonar 侧 accepted、R32-11 合入时事项、R32-12 实机 GUI 复核。详见实施记录。

## 实施记录（2026-11-12，pr-32 分支）

经用户指示，将审查报告与索引落到 `pr-32` 提交，并按本报告实施必要修复。P0 方案由维护者在「等待移回会话创建」与「移除等待并改文档」之间选定前者。

**处置映射**：

| 编号 | 处置 | 产物 |
| --- | --- | --- |
| R32-01 | 完成 | `src/registry.ts`：删除 `agent/pre-step` 钩子，`agent/created` 串行返回前对新建会话 `waitForVisibleEager`（≤20s、100ms 轮询、replay 不等待、agent 离列即停）；`test/test-registry.mjs` 两处用例改断言创建时等待/取消/replay 不等待/lazy-only 不等待；CHANGELOG 与 how-it-works 中英同步 |
| R32-02 | 完成 | AGENTS.md（skipReason/summary.idle、事件清单、全局 vs 项目、生效名、工作区挂载）、registry 模块头、how-it-works 中英「生效名」段、lazy-mcp.md 文首 PR #32 生命周期更新注记 |
| R32-03 | 部分 | S1994：`availableServerName` 改 `while` 循环；S9382：轮询处注明有意串行（Sonar 侧 accepted 待维护者操作） |
| R32-05 | 完成 | `clearClosedWorkspaceFocus` 补 `liveSessionCwds()` 恢复会话检查 |
| R32-06 | 完成 | `isLive()` 注释宿主 agent 同一性假设与 fail-closed 后果 |
| R32-07 | 完成 | `filterMcpPrompt` 注释来源包（dsh-mcp-client / dsh-mcp-resources）与 fail-closed 方向 |
| R32-08 | 完成 | `test/test-model.mjs` 补 retained 保留、宿主全局名优先、生成名撞字面名哈希后缀兜底三组断言 |
| R32-09 | 完成 | `LazyConnections.release` 的 `closing.then(drop, drop)` 两态均摘除集合元素 |
| R32-10 | 完成 | AGENTS.md 与 how-it-works 中英明示「冲突消失后已挂实例保持前缀名直到卸载」 |
| R32-04 | 完成 | 删除 UI 的 `skipReason==="idle"` 判定、`workspaceGroupMarker` 的 idle 分支与「空闲」标签/说明、`workspaceIdle`/`workspaceIdleHint` 与 `.group-note` 样式；registry 删除 `collectSkipMarks` 的 idle 分支、`summarizeScope` 的 idle 数组与 `summary.idle` 写入；`statusIdle` 文案改为「已启用 · 等待装载」。**保留**旧诊断文件的只读兼容（`DiagSummary.idle`/`parseIdleNames`/`status` 打印，均已注释）。测试、AGENTS.md、cli/env-expansion/settings-ui 双语指南同步 |

**本地提交**（接在作者 `b5e75a9` 之后）：

- `3e9bddd` — docs(review): 归档 PR #32 两轮审查报告并更新记录索引。
- `ac554f9` — fix(mcp): 生效名兜底改 while 循环并补碰撞单测（R32-03/R32-08）。
- `662ba8d` — fix(lazy): 连接释放清理链补防御性拒绝处理（R32-09）。
- `0f165b6` — fix(mcp): Eager 等待移回会话创建并加固隔离（R32-01/R32-05/R32-06/R32-07）。
- `a2e756f` — docs(mcp): 同步常驻挂载与 Lazy 会话生命周期口径（R32-02/R32-10）。
- `4de505d` — docs(review): 回填 PR #32 审查修复实施记录。
- `d180c75` — refactor(mcp): 移除 idle 死分支并更正等待装载文案（R32-04）。
- 本实施记录提交 — 报告状态与实施记录回填（提交本身不嵌入自身 hash）。

**验证**：核心与 UI `tsc --noEmit` 均 exit 0；全量 `pnpm test`（pretest 完整 core/UI 构建）**exit 0**——model 36、mcp-file 7、json-file 13、json-write 6、registry 64、project-watch 5、cli 21、ui-collapse 14、ui-paste 14、ui-display 7、ui-workspace 11、ui-entries 9、bundle 7、ui-client-wiring 17，lazy lifecycle/dependency/naming 与 panel-helpers、ui-lifecycle 全通过。新增生效名单测、改写的会话等待用例与 idle 清理后的分组/计数用例均通过，未删除/跳过/放宽既有断言（旧诊断文件的 idle 只读兼容用例保留）。

**保留边界**：未实机 GUI 点测、未做 npm 发布 smoke；R32-01 建议维护者用延迟 initialize 的 stdio 服务器做慢挂载实机复验。本轮不改版本号、不发布、不推送；合入远端 `dev` 由维护者决定。

## 附：作者提交清单（PR head `b5e75a9`）

| 提交 | 说明 |
| --- | --- |
| `cedd30d` | fix(mcp): 保持工作区连接并按会话隔离发现 |
| `61dcaee` | fix(lazy): 按会话搜索激活并保持连接 |
| `31f02fa` | fix(mcp): 修复 SonarCloud 新代码质量问题 |
| `f746af4` | fix(mcp): 将连接重挂移出会话创建路径 |
| `45c9f17` | fix(mcp): 保留已有生效名并在模型请求前等待 |
| `b5e75a9` | docs(mcp): 记录会话启动与重名挂载优化 |

参考：[PR #32](https://github.com/wldxiaobai/dsh-project-mcp-manager/pull/32)、[作者场景说明](https://github.com/wldxiaobai/dsh-project-mcp-manager/pull/32#issuecomment-6789178661)、[作者追加改动说明](https://github.com/wldxiaobai/dsh-project-mcp-manager/pull/32#issuecomment-6791036333)、[Sonar issues API](https://sonarcloud.io/api/issues/search?componentKeys=wldxiaobai_dsh-project-mcp-manager&pullRequest=32&sinceLeakPeriod=true&issueStatuses=OPEN,CONFIRMED)。

## 2026-11-12：隔离时序缝隙探测（T1–T5）与 T1 修复

### 探测结果（对 `fc10f63`，即 R32-01 等修复之后）

实现 `test/test-isolation-race.mjs`（假宿主 + holdDispose/失败注入，不依赖真实 stdio，秒级跑完）：

| 场景 | 首跑结果 | 结论 |
| --- | --- | --- |
| T1 首次 restrict 失败 + 卡住的对账 | **失败** | 新会话无任何限制，别工作区的 `mcp__alpha__read` 可见 |
| T2 创建时 agent 未入注册表 | 通过 | 创建不挂起；入册后下一次对账补上 deny |
| T3 未知 scope 的提示词/资源门 | 通过 | fail-closed：项目小节全隐藏、跨工作区资源调用被 deny |
| T4 retained 同名交换窗口 | 通过 | deny 连续；挂载等 nameRelease；交换后无越权 |
| T5 tools/change 重入风暴 | 通过 | 守卫有效；终态一致；无 disposer 泄漏 |

### T1 根因与修复（`0e8a334`）

`applyRestriction` 的 catch 回退是「保留上一份限制」，但新会话没有上一份 → fail-open；叠加对账链卡在慢 dispose、期间无 `tools/change`，窗口可任意长。修复：首次失败且无上一份限制时，临时 deny 全部已注册 `mcp__` 工具（精确名，不会再触发 unknown-name），下一次成功 sweep 恢复精确可见性；兜底自身同步发的 `tools/change` 由 `applyingRestrictions` 守卫挡住。修复后 T1–T5 全过；套件纳入 `npm test` 链，全量通过（registry 64 passed）。

### 保留备注

- 触发条件是 `tools.restrict` 抛错（历史「未知名」竞态）；`tools/change` 普及后概率低，但回退语义现已 fail-closed。
- 兜底代价：极罕见失败后该会话短暂失去全部 MCP（含自己的），直到下一次成功 sweep。
- R32-01 的宿主快照时序已由作者在 `0f165b6` 修复（等待移回 `agent/created` 串行路径，replay 不等待）；本轮探测未再涉及。
- 本轮结束时本地 `pr-32` 领先远端 PR head 两个提交（本报告回填 + T1 修复），推送待维护者指示。

## 2026-11-12（续）：兜底的可感知性 —— 保护通知与链外自动重试（`6e1ca87`）

T1 修复后兜底是「静默生效」的：模型只会发现工具突然消失，用户只在日志里看到一条 warn。按维护者要求补上告知与恢复交互（方案 A：通知 + 自动重试，不改 UI）：

- **模型侧**：兜底期间 `system-prompt/assemble` 给该会话追加 `mcp-protection-notice` 小节，按「成因简述 → 影响 → 恢复路径」组织：宿主拒绝限制应用（如工具名注册竞态）→ `mcp__*` 工具临时全部禁用 → 后台自动重试数秒内恢复；重试用尽后转为「请用户修改任一 MCP 配置或新开会话」。通知**不含原始错误文本**（可能带别的工作区的工具名），完整错误只进日志与诊断。恢复后通知自动消失。
- **用户侧**：`logger.warn` 升级为含成因与恢复指引；全局诊断（`$DSH_HOME/.mcp-diag.json`）记 `restrict-fallback` 事件（agent、成因、尝试次数）。
- **恢复语义**：链外退避重试（缺省 500ms/2s/5s、至多 3 次，`fallbackRetryDelaysMs` 可注入）——刻意不排队进对账链，T1 的卡链场景下也能自愈；重试再失败会续上退避链并替换旧兜底限制（首版实现漏了这条，重试链在第一次重试后即断，由 T6 抓出）。成功 sweep、释放 agent、插件销毁均清通知与定时器。
- **验证**：T6 覆盖通知内容与脱敏、健康会话无通知、卡链下的链外自愈、重试用尽转手动指引、手动触发恢复、诊断事件落盘；T1–T6 与全量 `npm test` 通过。AGENTS.md「会话隔离」条目与目录结构段已同步。
- **未做**：管理页横幅（方案 B）留作可选后续；模型没有主动触发 reload 的工具，通知以「等自动重试 / 请用户操作」为恢复指引。
- 本地 `pr-32` 现领先远端 PR head 四个提交（T1 修复、报告回填、保护通知与重试、本次文档同步），推送待维护者指示。

## 2026-11-12（续二）：SonarCloud 14 项研判与 CHANGELOG 署名

- 远端 PR head 已更新为 `891d4a8`（含 T1 修复与保护通知提交），Sonar 重扫基线与本地一致。14 条 OPEN issues 全部研判：**4 条修复**（S3776 applyRestriction 拆分、S7747 Map 直接迭代、S7739 假 fiber 改真 Promise——唯一门禁阻塞项、S7770 map(String)），**10 条有意串行 S9382 保留**（理由 A/G，建议维护者 Accepted）。Quality Gate 现为 ERROR（`new_reliability_rating` 3>1，仅由 S7739 导致），修复重扫后预期恢复。逐条清单见 [Sonar PR #32 研判报告](<sonar-pr32.zh.md>)。
- **R32-11 部分完成**：CHANGELOG 三条属于作者贡献的 Unreleased/Fixed 条目已补 `Contributed by @yangjh0127 in #32`（格式对齐 #30）；维护者侧审查修复沿用 #30 先例不署名。两版 README「致谢」小节仍待合入时补充。
- 本地提交：`537721e`（registry 重构）、`f4db7fa`（测试改造）、`0736efb`（CHANGELOG 署名）、本次报告回填。T1–T6 与全量 `npm test` exit 0。`pr-32` 现领先远端 PR head（`891d4a8`）四个提交，推送待维护者指示。
