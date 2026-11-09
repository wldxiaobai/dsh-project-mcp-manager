# SonarCloud PR #29：全部 issues 研判与修复记录

[← 记录索引](<../records.zh.md>) · [上一轮代码审查](<review-v0.9.0-to-v0.12.0.zh.md>)

## 最新跟进：剩余 S1523 已移除字符串执行

2026-11-10 后续查询[用户给出的新代码 issue 列表](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&s=IMPACT_RANK&sinceLeakPeriod=true&issueStatuses=OPEN%2CCONFIRMED>)，对应 [API](<https://sonarcloud.io/api/issues/search?componentKeys=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&sinceLeakPeriod=true&issueStatuses=OPEN%2CCONFIRMED&ps=100&p=1&additionalFields=rules>) 的 `total=1`：仍为 `AaHBVPzPSIHBt2A01lxz` / `javascript:S1523`，定位到[接线测试](<../../test/test-ui-client-wiring.mjs>)中的 `new Function`。

**复评结论**：未发现不可信数据进入执行器，首轮“不构成生产接口注入”的安全判断仍成立；但保留 `new Function` 并非唯一能测试真实 bundle 的方法。改用固定字面量路径的 `await import("../packages/ui/lib/client.js")`，让 Node 模块加载器加载同一份构建产物，去掉 `readFile` + 源码字符串执行。不使用 eval、Function、node:vm、data URL，也不添加扫描抑制。

- 暂时设置 `globalThis.window.__ModuleLoader__` 捕获同一 wrapper 的注册，随后仍调用原 `factory` 并运行全部接线断言，未改成只测源码或伪造模块。
- 在 `finally` 中恢复完整的原 `window` 属性描述符；原本没有该属性时删除，并用断言检查没有全局污染。
- [正式测试命令](<../../package.json>)为该测试增加 `--disallow-code-generation-from-strings`，防止重新引入字符串执行。模块加载仍需信任仓库和构建产物，不将 import 描述为隔离沙箱。
- 接线测试以单独 Node 进程运行，只需首次导入，标准 ESM 缓存不影响现有测试方式。
- 定向测试在禁用字符串代码生成时 7 项全部通过；另以预先存在的不可写、可配置 `window` 属性启动，原描述符及对象身份均被还原。
- 正式命令加入禁用选项后，再次执行 `pnpm test`（含 core/UI 构建），全部测试通过；`git diff --check` 通过。此次只调整测试装载与测试命令，不改生产装载器或浏览器 bundle。

下面第 1–5 节保留首轮 86 项快照及当时处置作为历史记录；其中“85 项修改、1 项保留”和建议远端 False Positive 已由本节的代码调整取代。**现在原 86 项都有对应代码调整，但本轮尚未重新运行远端扫描，不声称 issue 已关闭或 Quality Gate 已通过。** 新查询带 `sinceLeakPeriod=true`，不能仅凭这一个过滤视图推断全项目所有历史问题已清零。此次 PR 元数据接口仍返回首轮提交信息，故不将其误写为本次新扫描提交。

## 1. 范围与结论（首轮记录）

- **处理日期**：2026-11-10（Asia/Shanghai）。
- **来源**：[用户指定的 PR #29 issue 列表](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issueStatuses=OPEN%2CCONFIRMED&s=IMPACT_RANK>)。
- **完整性**：[issues API](<https://sonarcloud.io/api/issues/search?componentKeys=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issueStatuses=OPEN%2CCONFIRMED&ps=500&p=1&additionalFields=rules>) 返回 `total=86`，实际取得 86 项，单页覆盖全部 OPEN/CONFIRMED 项，无分页遗漏。此次快照全部为 OPEN。
- **对应版本**：[PR 分析元数据](<https://sonarcloud.io/api/project_pull_requests/list?project=wldxiaobai_dsh-project-mcp-manager>) 显示分析提交为 `6058fac370ce53a9cbf3a280ff7332e7c94a12b9`，与本轮修改前本地 HEAD 一致；分析时间为 `2026-11-09T17:21:43Z`（北京时间 11 月 10 日 01:21:43）。
- **原始分类**：79 个 CODE_SMELL、6 个 BUG、1 个 VULNERABILITY；严重度为 MINOR 74、MAJOR 5、CRITICAL 7，估算总债务 530 分钟。

**结论：86 项均已逐项对照代码研判，其中 85 项有对应代码修改，1 项经安全审查保留现状。** 85 项修改不等于 85 个真实功能缺陷：实际需要修复的是工作区名称解析的二次正则回溯；其余主要是类型约束、原生语义及测试可读性。Sonar 标作 BUG 的 6 项都是测试排序，并非已证实的产品运行错误；唯一的 VULNERABILITY 是测试装载可信本地构建产物的动态执行，未发现用户输入进入执行器。

没有修改远端 issue 状态、添加 `NOSONAR`、关闭规则或扩大扫描排除。**本轮没有重新运行 SonarCloud 扫描，没有推送，不能声称远端已关闭 85 项或 Quality Gate 已恢复。** “已修改”仅表示对应代码与本地验证已落地，远端结果以新一次分析为准。

上一轮 R1–R3 的修复在本轮基线中已经存在，本轮没有重复实现这些功能。

## 2. 按规则研判

| 规则 | 数量 | 判断与处置 | 主要文件 |
|---|---:|---|---|
| typescript:S8786 | 1 | 真实性能问题：用线性扫描与最后分隔符索引替换可二次回溯的正则 | [workspace.ts](<../../packages/ui/src/client/workspace.ts>) |
| typescript:S7755 | 1 | 随同上项重写去掉整个 split/末尾数组索引，不再需要单纯改成 `.at(-1)` | [workspace.ts](<../../packages/ui/src/client/workspace.ts>) |
| typescript:S6759 | 5 | 合理的类型约束：组件 props 的接口/内联成员标为 readonly，无运行时变化 | [McpPanel.tsx](<../../packages/ui/src/client/McpPanel.tsx>)、[entries-row.tsx](<../../packages/ui/src/client/entries-row.tsx>)、[entries.tsx](<../../packages/ui/src/client/entries.tsx>) |
| typescript:S6819 | 1 | 保存冲突属于操作结果反馈，改用隐式 status 的原生 output；保留外层 p 和样式，紧急失败的 role=alert 不变 | [entries-row.tsx](<../../packages/ui/src/client/entries-row.tsx>) |
| typescript:S6582 | 2 | 合理简化：ready 判断改 optional chaining，保留空快照时默认显示/只读的短路行为 | [entries-settings.ts](<../../packages/ui/src/client/entries-settings.ts>) |
| javascript:S7780 | 55 | 路径夹具改 String.raw，运行时字符串不变；其中工作区测试 43 处，生命周期测试 12 处 | [工作区测试](<../../test/test-ui-workspace.mjs>)、[生命周期测试](<../../test/test-ui-lifecycle.mjs>) |
| javascript:S1199 | 8 | 裸块本来用于测试隔离，并非行为错误；改为具名 test(name, run)，保留独立作用域、断言和执行顺序 | [入口测试](<../../test/test-ui-entries.mjs>)、[工作区测试](<../../test/test-ui-workspace.mjs>) |
| javascript:S2871 | 6 | 原默认排序有意做确定性键集比较，不是产品 bug；显式 UTF-16 码元比较器写清意图，不能机械改 localeCompare | [接线测试](<../../test/test-ui-client-wiring.mjs>)、[入口测试](<../../test/test-ui-entries.mjs>)、[生命周期测试](<../../test/test-ui-lifecycle.mjs>)、[工作区测试](<../../test/test-ui-workspace.mjs>) |
| javascript:S2692 | 2 | 原 indexOf > 0 是刻意检查释放晚于索引 0 的导航，不是漏掉元素；改为明确检查事件存在且晚于导航事件 | [接线测试](<../../test/test-ui-client-wiring.mjs>) |
| javascript:S1481 | 1 | 删除未使用的 detach 夹具 | [入口测试](<../../test/test-ui-entries.mjs>) |
| javascript:S1854 | 1 | 与上项指向同一未使用声明/赋值，一次删除覆盖两项 | [入口测试](<../../test/test-ui-entries.mjs>) |
| javascript:S9382 | 2 | 两种语言的元数据验证互相独立，改 Promise.all；不改核心装载器需要串行的循环 | [bundle 测试](<../../test/test-bundle.mjs>) |
| javascript:S1523 | 1 | 人工审查后保留可信本地 bundle 的 new Function 加载；补充信任边界注释，建议远端标记 False Positive（本轮未操作） | [接线测试](<../../test/test-ui-client-wiring.mjs>) |
| **合计** | **86** | **85 项有代码修改，1 项保留并说明原因** | |

### 2.1 S8786：为何必须改，而不是忽略

原表达式 `projectRoot.trim().replace(/[\\/]+$/, "")` 的量词虽然没有嵌套，但搜索未锚定开头。遇到中间很长的分隔符序列、末尾又跟普通字符时，引擎会从序列中的每个位置重新尝试匹配至结尾，产生二次回溯。

本机 Node 26.7.0 对 `/a` + N 个 `/` + `x` 的观测如下（单次实验值，仅作证据，不作为测试阈值）：

| 中间分隔符数量 | 原算法 | 新算法 |
|---:|---:|---:|
| 4,000 | 9.39 ms | 0.010 ms |
| 8,000 | 37.19 ms | 0.009 ms |
| 16,000 | 146.55 ms | 0.009 ms |
| 100,000 | 未继续放大旧算法 | 0.042 ms |

新实现从末尾线性剥离分隔符，再用 `lastIndexOf` 定位名字起点，保留旧名称显示及全分隔符根路径的回退行为，不参与工作区身份判断。对新旧实现的 5,000 条合成输入等价性比较通过；固定回归覆盖中间/末尾的 100,000 个正斜杠和反斜杠，以及全分隔符根路径，不设置易受机器负载影响的毫秒断言。

### 2.2 S2871 / S2692：不照搬建议，保留原测试语义

- **排序**：语言键、路由和注册键都是机器标识符的确定性集合/顺序比较。默认 sort 的码元序原本合理；新增显式比较器与核心 [byCodeUnit](<../../src/model.ts#L33-L42>) 一致。不用 `localeCompare`，避免宿主地区设置影响结果。除了 6 个报告位置，也一致调整同一生命周期测试内的两处既有默认排序。
- **释放顺序**：原来先断言 `added[0] === "selectPanel:null"`，再要求两个 release 的索引 > 0，语义正确。新写法保留第一条断言，并显式检查每个 release 存在、且索引大于 navigationIndex；仅改成 includes 会丢失时序保障，未采纳。

### 2.3 S1523：动态执行的安全边界

问题 `AaHBVPzPSIHBt2A01lxz` 指向浏览器 bundle 的测试装载器：

1. 输入来自仓库固定相对位置的 [构建产物](<../../packages/ui/lib/client.js>)，相对 `import.meta.url` 解析。
2. 不接受 HTTP 请求、剪贴板、命令行指定文件或可变加载地址。
3. 仓库测试本来就执行本仓库代码；若攻击者能够替换源码或构建产物，已处于构建/测试信任边界内。不能把运行未知来源仓库测试描述为安全。
4. 这里正要验证真实 browser module wrapper；改成 node:vm 并不构成可靠安全边界，只是替换动态执行 API。

因此保留 new Function，不把它误报为生产接口中的代码注入，也不以换 API 的方式“消警”。已加代码注释，建议有权限的维护者在 SonarCloud 将该 issue 标记为 False Positive 并引用本节；本轮未修改远端状态。未来如果加载器开始接受任意路径或不可信数据，必须重新审查。

### 2.4 低风险清理的边界

- readonly 只限制属性重赋值，没有宣称深度冻结服务器数组，也没有改变服务契约。
- 保存被拒绝后的冲突说明改为 output 的原生结果语义，外层 p 和原 class 保留，避免改变现有块布局；失败告警仍保留 role=alert。
- optional chaining 只改 ready guard；不能把“非空且不可写才显示说明”的另一个判断盲改成 `snapshot?.writable !== true`，否则空快照也会误显示无权限。
- 19 个入口/工作区测试组统一改具名同步 helper，其中 8 个被规则报告；不会将原同步测试变成异步或合并词法作用域。
- 两个以反斜杠结尾的普通字符串本来未被 S7780 报告，且不能直接写成以单反斜杠结束的 raw 模板，保持原样。

## 3. 修改与本地提交

| 提交 | 内容 |
|---|---|
| `0762f5e` | 线性工作区名称解析、长分隔符回归、相关工作区测试可读性清理及 changelog |
| `71a473d` | readonly props、原生 output 状态结果、optional chaining |
| `ed1a531` | 其余测试路径夹具、具名测试组、显式排序、释放顺序断言及独立元数据并行检查 |

上述提交均在 `feat/ui-entries-workspace` 本地完成；不改版本号、不改依赖、不触碰 main，不推送。构建更新了本地忽略产物，但没有宣称当前 Web GUI 已完成刷新或实机验收。

## 4. 验证

- `pnpm test`（含 core/UI 构建）全通过：model 34、mcp-file 7、json-file 13、json-write 6、registry 63、project-watch 5、cli 21、ui-collapse 14、ui-paste 14、ui-display 7、ui-workspace 10、ui-entries 9、ui-client-wiring 7、ui-lifecycle 12，另 panel-helpers / bundle 脚本断言通过。
- `tsc --noEmit -p packages/ui/tsconfig.client.json`：通过。
- `tsc --noEmit -p tsconfig.json`：通过。
- 显式排序比较器最终调整后，五个涉及的测试脚本再次通过。
- `git diff --check`：通过。
- 新旧路径算法 5,000 条等价性输入：通过；100,000 长分隔符回归：通过。
- optional chaining 对旧表达式的 38 种空快照/状态/权限/值组合矩阵：等价。

未进行真实浏览器的视觉、辅助技术或跨窗口操作验收，也未运行新一次 SonarCloud 分析。建议推送并触发扫描后，核对下表 86 个原 issue 的状态与新增告警；保留项由维护者按安全审查结论在远端处置。

## 5. 全部 86 项逐项处置清单

以下位置均为 Sonar **分析基线** 的文件与行号，不是修改后的行号。每项保留完整 issue key、规则、原严重度与具体处置，避免把同一规则的多个报告漏算。文件链接指向当前源码以供对照。

| # | Issue key | 规则 | 原严重度 | 基线位置 | 逐项处置 |
|---:|---|---|---|---|---|
| 1 | [AaHBVPr_SIHBt2A01lwn](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPr_SIHBt2A01lwn>) | typescript:S6759 | MINOR | [McpPanel.tsx:675](<../../packages/ui/src/client/McpPanel.tsx#L675>) | 已修改：props 成员标 readonly，保留运行语义 |
| 2 | [AaHBVPsISIHBt2A01lwq](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPsISIHBt2A01lwq>) | typescript:S6759 | MINOR | [entries-row.tsx:31](<../../packages/ui/src/client/entries-row.tsx#L31>) | 已修改：props 成员标 readonly，保留运行语义 |
| 3 | [AaHBVPsISIHBt2A01lwr](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPsISIHBt2A01lwr>) | typescript:S6819 | MAJOR | [entries-row.tsx:122](<../../packages/ui/src/client/entries-row.tsx#L122>) | 已修改：保存结果用原生 output，保留外层排版与失败 alert |
| 4 | [AaHBVPsISIHBt2A01lws](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPsISIHBt2A01lws>) | typescript:S6759 | MINOR | [entries-row.tsx:135](<../../packages/ui/src/client/entries-row.tsx#L135>) | 已修改：props 成员标 readonly，保留运行语义 |
| 5 | [AaHBVPpWSIHBt2A01lwl](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPpWSIHBt2A01lwl>) | typescript:S6582 | MINOR | [entries-settings.ts:66](<../../packages/ui/src/client/entries-settings.ts#L66>) | 已修改：ready guard 用 optional chaining，保留空值短路 |
| 6 | [AaHBVPpWSIHBt2A01lwm](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPpWSIHBt2A01lwm>) | typescript:S6582 | MINOR | [entries-settings.ts:72](<../../packages/ui/src/client/entries-settings.ts#L72>) | 已修改：ready guard 用 optional chaining，保留空值短路 |
| 7 | [AaHBVPsBSIHBt2A01lwo](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPsBSIHBt2A01lwo>) | typescript:S6759 | MINOR | [entries.tsx:22](<../../packages/ui/src/client/entries.tsx#L22>) | 已修改：props 成员标 readonly，保留运行语义 |
| 8 | [AaHBVPsBSIHBt2A01lwp](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPsBSIHBt2A01lwp>) | typescript:S6759 | MINOR | [entries.tsx:41](<../../packages/ui/src/client/entries.tsx#L41>) | 已修改：props 成员标 readonly，保留运行语义 |
| 9 | [AaHBVPntSIHBt2A01lwj](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPntSIHBt2A01lwj>) | typescript:S8786 | MAJOR | [workspace.ts:50](<../../packages/ui/src/client/workspace.ts#L50>) | 已修复：线性扫描替换二次回溯正则，补长分隔符回归 |
| 10 | [AaHBVPntSIHBt2A01lwk](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPntSIHBt2A01lwk>) | typescript:S7755 | MINOR | [workspace.ts:53](<../../packages/ui/src/client/workspace.ts#L53>) | 已修改：随名称解析重写去掉 split 与末尾数组索引 |
| 11 | [AaHBVP1iSIHBt2A01lx3](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVP1iSIHBt2A01lx3>) | javascript:S9382 | MINOR | [test-bundle.mjs:33](<../../test/test-bundle.mjs#L33>) | 已修改：两种语言检查无依赖，Promise.all 并行 |
| 12 | [AaHBVP1iSIHBt2A01lx4](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVP1iSIHBt2A01lx4>) | javascript:S9382 | MINOR | [test-bundle.mjs:35](<../../test/test-bundle.mjs#L35>) | 已修改：两种语言检查无依赖，Promise.all 并行 |
| 13 | [AaHBVPzPSIHBt2A01lxz](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPzPSIHBt2A01lxz>) | javascript:S1523 | CRITICAL | [test-ui-client-wiring.mjs:26](<../../test/test-ui-client-wiring.mjs#L26>) | 保留：可信固定本地 bundle 的测试装载；建议远端 False Positive，未改远端状态 |
| 14 | [AaHBVPzPSIHBt2A01lx0](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPzPSIHBt2A01lx0>) | javascript:S2871 | CRITICAL | [test-ui-client-wiring.mjs:139](<../../test/test-ui-client-wiring.mjs#L139>) | 已修改：显式 UTF-16 码元比较器，不使用区域排序 |
| 15 | [AaHBVPzPSIHBt2A01lx1](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPzPSIHBt2A01lx1>) | javascript:S2692 | MAJOR | [test-ui-client-wiring.mjs:207](<../../test/test-ui-client-wiring.mjs#L207>) | 已修改：显式检查释放事件存在且晚于导航，非改成仅 includes |
| 16 | [AaHBVPzPSIHBt2A01lx2](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPzPSIHBt2A01lx2>) | javascript:S2692 | MAJOR | [test-ui-client-wiring.mjs:208](<../../test/test-ui-client-wiring.mjs#L208>) | 已修改：显式检查释放事件存在且晚于导航，非改成仅 includes |
| 17 | [AaHBVPw1SIHBt2A01lw6](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw1SIHBt2A01lw6>) | javascript:S1199 | MINOR | [test-ui-entries.mjs:25](<../../test/test-ui-entries.mjs#L25>) | 已修改：具名 test helper，保留独立作用域与原执行顺序 |
| 18 | [AaHBVPw1SIHBt2A01lw7](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw1SIHBt2A01lw7>) | javascript:S1199 | MINOR | [test-ui-entries.mjs:35](<../../test/test-ui-entries.mjs#L35>) | 已修改：具名 test helper，保留独立作用域与原执行顺序 |
| 19 | [AaHBVPw1SIHBt2A01lw8](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw1SIHBt2A01lw8>) | javascript:S1199 | MINOR | [test-ui-entries.mjs:43](<../../test/test-ui-entries.mjs#L43>) | 已修改：具名 test helper，保留独立作用域与原执行顺序 |
| 20 | [AaHBVPw1SIHBt2A01lw-](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw1SIHBt2A01lw->) | javascript:S1854 | MAJOR | [test-ui-entries.mjs:92](<../../test/test-ui-entries.mjs#L92>) | 已修改：同一 detach 的无用赋值随声明一起删除 |
| 21 | [AaHBVPw1SIHBt2A01lw9](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw1SIHBt2A01lw9>) | javascript:S1481 | MINOR | [test-ui-entries.mjs:92](<../../test/test-ui-entries.mjs#L92>) | 已修改：删除未使用 detach 声明 |
| 22 | [AaHBVPw1SIHBt2A01lw_](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw1SIHBt2A01lw_>) | javascript:S1199 | MINOR | [test-ui-entries.mjs:196](<../../test/test-ui-entries.mjs#L196>) | 已修改：具名 test helper，保留独立作用域与原执行顺序 |
| 23 | [AaHBVPw1SIHBt2A01lxA](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw1SIHBt2A01lxA>) | javascript:S2871 | CRITICAL | [test-ui-entries.mjs:197](<../../test/test-ui-entries.mjs#L197>) | 已修改：显式 UTF-16 码元比较器，不使用区域排序 |
| 24 | [AaHBVPw1SIHBt2A01lxB](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw1SIHBt2A01lxB>) | javascript:S2871 | CRITICAL | [test-ui-entries.mjs:197](<../../test/test-ui-entries.mjs#L197>) | 已修改：显式 UTF-16 码元比较器，不使用区域排序 |
| 25 | [AaHBVPwySIHBt2A01lwt](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPwySIHBt2A01lwt>) | javascript:S2871 | CRITICAL | [test-ui-lifecycle.mjs:184](<../../test/test-ui-lifecycle.mjs#L184>) | 已修改：显式 UTF-16 码元比较器，不使用区域排序 |
| 26 | [AaHBVPwySIHBt2A01lwu](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPwySIHBt2A01lwu>) | javascript:S7780 | MINOR | [test-ui-lifecycle.mjs:227](<../../test/test-ui-lifecycle.mjs#L227>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 27 | [AaHBVPwySIHBt2A01lwv](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPwySIHBt2A01lwv>) | javascript:S7780 | MINOR | [test-ui-lifecycle.mjs:227](<../../test/test-ui-lifecycle.mjs#L227>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 28 | [AaHBVPwySIHBt2A01lww](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPwySIHBt2A01lww>) | javascript:S7780 | MINOR | [test-ui-lifecycle.mjs:229](<../../test/test-ui-lifecycle.mjs#L229>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 29 | [AaHBVPwySIHBt2A01lwx](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPwySIHBt2A01lwx>) | javascript:S7780 | MINOR | [test-ui-lifecycle.mjs:229](<../../test/test-ui-lifecycle.mjs#L229>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 30 | [AaHBVPwySIHBt2A01lwy](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPwySIHBt2A01lwy>) | javascript:S7780 | MINOR | [test-ui-lifecycle.mjs:230](<../../test/test-ui-lifecycle.mjs#L230>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 31 | [AaHBVPwySIHBt2A01lwz](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPwySIHBt2A01lwz>) | javascript:S7780 | MINOR | [test-ui-lifecycle.mjs:231](<../../test/test-ui-lifecycle.mjs#L231>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 32 | [AaHBVPwySIHBt2A01lw0](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPwySIHBt2A01lw0>) | javascript:S7780 | MINOR | [test-ui-lifecycle.mjs:311](<../../test/test-ui-lifecycle.mjs#L311>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 33 | [AaHBVPwySIHBt2A01lw1](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPwySIHBt2A01lw1>) | javascript:S7780 | MINOR | [test-ui-lifecycle.mjs:312](<../../test/test-ui-lifecycle.mjs#L312>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 34 | [AaHBVPwySIHBt2A01lw2](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPwySIHBt2A01lw2>) | javascript:S7780 | MINOR | [test-ui-lifecycle.mjs:321](<../../test/test-ui-lifecycle.mjs#L321>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 35 | [AaHBVPwySIHBt2A01lw3](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPwySIHBt2A01lw3>) | javascript:S7780 | MINOR | [test-ui-lifecycle.mjs:322](<../../test/test-ui-lifecycle.mjs#L322>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 36 | [AaHBVPwySIHBt2A01lw4](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPwySIHBt2A01lw4>) | javascript:S7780 | MINOR | [test-ui-lifecycle.mjs:346](<../../test/test-ui-lifecycle.mjs#L346>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 37 | [AaHBVPwySIHBt2A01lw5](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPwySIHBt2A01lw5>) | javascript:S7780 | MINOR | [test-ui-lifecycle.mjs:347](<../../test/test-ui-lifecycle.mjs#L347>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 38 | [AaHBVPw3SIHBt2A01lxC](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxC>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:27](<../../test/test-ui-workspace.mjs#L27>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 39 | [AaHBVPw3SIHBt2A01lxD](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxD>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:28](<../../test/test-ui-workspace.mjs#L28>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 40 | [AaHBVPw3SIHBt2A01lxE](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxE>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:29](<../../test/test-ui-workspace.mjs#L29>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 41 | [AaHBVPw3SIHBt2A01lxF](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxF>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:30](<../../test/test-ui-workspace.mjs#L30>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 42 | [AaHBVPw3SIHBt2A01lxG](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxG>) | javascript:S1199 | MINOR | [test-ui-workspace.mjs:44](<../../test/test-ui-workspace.mjs#L44>) | 已修改：具名 test helper，保留独立作用域与原执行顺序 |
| 43 | [AaHBVPw3SIHBt2A01lxH](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxH>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:45](<../../test/test-ui-workspace.mjs#L45>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 44 | [AaHBVPw3SIHBt2A01lxI](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxI>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:51](<../../test/test-ui-workspace.mjs#L51>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 45 | [AaHBVPw3SIHBt2A01lxJ](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxJ>) | javascript:S1199 | MINOR | [test-ui-workspace.mjs:55](<../../test/test-ui-workspace.mjs#L55>) | 已修改：具名 test helper，保留独立作用域与原执行顺序 |
| 46 | [AaHBVPw3SIHBt2A01lxK](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxK>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:57](<../../test/test-ui-workspace.mjs#L57>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 47 | [AaHBVPw3SIHBt2A01lxL](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxL>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:57](<../../test/test-ui-workspace.mjs#L57>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 48 | [AaHBVPw3SIHBt2A01lxM](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxM>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:58](<../../test/test-ui-workspace.mjs#L58>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 49 | [AaHBVPw3SIHBt2A01lxN](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxN>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:58](<../../test/test-ui-workspace.mjs#L58>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 50 | [AaHBVPw3SIHBt2A01lxO](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxO>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:62](<../../test/test-ui-workspace.mjs#L62>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 51 | [AaHBVPw3SIHBt2A01lxP](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxP>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:67](<../../test/test-ui-workspace.mjs#L67>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 52 | [AaHBVPw3SIHBt2A01lxQ](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxQ>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:68](<../../test/test-ui-workspace.mjs#L68>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 53 | [AaHBVPw3SIHBt2A01lxR](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxR>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:78](<../../test/test-ui-workspace.mjs#L78>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 54 | [AaHBVPw3SIHBt2A01lxS](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxS>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:78](<../../test/test-ui-workspace.mjs#L78>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 55 | [AaHBVPw3SIHBt2A01lxT](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxT>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:80](<../../test/test-ui-workspace.mjs#L80>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 56 | [AaHBVPw3SIHBt2A01lxU](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxU>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:81](<../../test/test-ui-workspace.mjs#L81>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 57 | [AaHBVPw3SIHBt2A01lxV](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxV>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:84](<../../test/test-ui-workspace.mjs#L84>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 58 | [AaHBVPw3SIHBt2A01lxW](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxW>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:86](<../../test/test-ui-workspace.mjs#L86>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 59 | [AaHBVPw3SIHBt2A01lxX](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxX>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:86](<../../test/test-ui-workspace.mjs#L86>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 60 | [AaHBVPw3SIHBt2A01lxY](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxY>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:99](<../../test/test-ui-workspace.mjs#L99>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 61 | [AaHBVPw3SIHBt2A01lxZ](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxZ>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:100](<../../test/test-ui-workspace.mjs#L100>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 62 | [AaHBVPw3SIHBt2A01lxa](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxa>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:103](<../../test/test-ui-workspace.mjs#L103>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 63 | [AaHBVPw3SIHBt2A01lxb](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxb>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:103](<../../test/test-ui-workspace.mjs#L103>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 64 | [AaHBVPw3SIHBt2A01lxc](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxc>) | javascript:S1199 | MINOR | [test-ui-workspace.mjs:119](<../../test/test-ui-workspace.mjs#L119>) | 已修改：具名 test helper，保留独立作用域与原执行顺序 |
| 65 | [AaHBVPw3SIHBt2A01lxd](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxd>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:140](<../../test/test-ui-workspace.mjs#L140>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 66 | [AaHBVPw3SIHBt2A01lxe](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxe>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:140](<../../test/test-ui-workspace.mjs#L140>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 67 | [AaHBVPw3SIHBt2A01lxf](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxf>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:143](<../../test/test-ui-workspace.mjs#L143>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 68 | [AaHBVPw3SIHBt2A01lxg](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxg>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:155](<../../test/test-ui-workspace.mjs#L155>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 69 | [AaHBVPw3SIHBt2A01lxh](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxh>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:155](<../../test/test-ui-workspace.mjs#L155>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 70 | [AaHBVPw3SIHBt2A01lxi](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxi>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:156](<../../test/test-ui-workspace.mjs#L156>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 71 | [AaHBVPw3SIHBt2A01lxj](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxj>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:156](<../../test/test-ui-workspace.mjs#L156>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 72 | [AaHBVPw3SIHBt2A01lxk](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxk>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:157](<../../test/test-ui-workspace.mjs#L157>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 73 | [AaHBVPw3SIHBt2A01lxl](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxl>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:157](<../../test/test-ui-workspace.mjs#L157>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 74 | [AaHBVPw3SIHBt2A01lxm](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxm>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:158](<../../test/test-ui-workspace.mjs#L158>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 75 | [AaHBVPw3SIHBt2A01lxn](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxn>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:159](<../../test/test-ui-workspace.mjs#L159>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 76 | [AaHBVPw3SIHBt2A01lxo](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxo>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:167](<../../test/test-ui-workspace.mjs#L167>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 77 | [AaHBVPw3SIHBt2A01lxp](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxp>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:167](<../../test/test-ui-workspace.mjs#L167>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 78 | [AaHBVPw3SIHBt2A01lxq](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxq>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:167](<../../test/test-ui-workspace.mjs#L167>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 79 | [AaHBVPw3SIHBt2A01lxr](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxr>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:168](<../../test/test-ui-workspace.mjs#L168>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 80 | [AaHBVPw3SIHBt2A01lxs](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxs>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:168](<../../test/test-ui-workspace.mjs#L168>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 81 | [AaHBVPw3SIHBt2A01lxt](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxt>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:168](<../../test/test-ui-workspace.mjs#L168>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 82 | [AaHBVPw3SIHBt2A01lxu](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxu>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:168](<../../test/test-ui-workspace.mjs#L168>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 83 | [AaHBVPw3SIHBt2A01lxv](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxv>) | javascript:S7780 | MINOR | [test-ui-workspace.mjs:169](<../../test/test-ui-workspace.mjs#L169>) | 已修改：String.raw 路径夹具，保留运行时字符串 |
| 84 | [AaHBVPw3SIHBt2A01lxw](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxw>) | javascript:S1199 | MINOR | [test-ui-workspace.mjs:177](<../../test/test-ui-workspace.mjs#L177>) | 已修改：具名 test helper，保留独立作用域与原执行顺序 |
| 85 | [AaHBVPw3SIHBt2A01lxx](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxx>) | javascript:S2871 | CRITICAL | [test-ui-workspace.mjs:178](<../../test/test-ui-workspace.mjs#L178>) | 已修改：显式 UTF-16 码元比较器，不使用区域排序 |
| 86 | [AaHBVPw3SIHBt2A01lxy](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=29&issues=AaHBVPw3SIHBt2A01lxy>) | javascript:S2871 | CRITICAL | [test-ui-workspace.mjs:178](<../../test/test-ui-workspace.mjs#L178>) | 已修改：显式 UTF-16 码元比较器，不使用区域排序 |
