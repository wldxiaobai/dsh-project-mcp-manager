# SonarCloud PR #32：14 条 issue 研判与必要修复

[← 记录索引](<../records.zh.md>) · [PR #32 两轮审查](<pr32-keep-workspace-mounted.zh.md>) · [PR #30 Sonar 研判](<sonar-pr30.zh.md>)

## 1. 快照与结论

- 日期：2026-11-12（Asia/Shanghai）。本轮基线 `891d4a8`，与远端 PR head 一致（远端已含 T1 fail-closed 修复与保护通知提交），行号可直接对照本地代码。
- 来源：[用户指定的 issue 列表](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=32&issueStatuses=OPEN%2CCONFIRMED&s=IMPACT_RANK>)。
- [issues API](<https://sonarcloud.io/api/issues/search?componentKeys=wldxiaobai_dsh-project-mcp-manager&pullRequest=32&issueStatuses=OPEN,CONFIRMED&ps=100>) 返回 `total=14`，全部 OPEN，单页完整覆盖。
- [PR 分析元数据](<https://sonarcloud.io/api/project_pull_requests/list?project=wldxiaobai_dsh-project-mcp-manager>) 指向提交 `891d4a8f23a45039c140254662d17bbdc2393e06`，分析时间 `2026-11-12T09:03:33Z`，即北京时间 **11 月 12 日 17:03:33**。
- [Quality Gate](<https://sonarcloud.io/api/qualitygates/project_status?projectKey=wldxiaobai_dsh-project-mcp-manager&pullRequest=32>) **ERROR**：唯一失败条件是 `new_reliability_rating`（实际 3 > 阈值 1），由唯一的 MAJOR Bug S7739（测试假 fiber 手写 `then`）导致；安全、可维护性、重复率（1.5% < 3%）、热点审查均 OK。合计 1 Bug、0 Vulnerability、13 Code Smell。
- 严重度：1 CRITICAL（S3776）、1 MAJOR（S7739）、12 MINOR。规则分布：S9382 **10** 条，S3776 / S7747 / S7739 / S7770 各 **1** 条。

**结论：14 条全部研判，4 条有代码修改，10 条保留有意串行语义，建议维护者人工 Accepted 并引用本报告。** 门禁阻塞项 S7739 已通过假 fiber 改真 Promise 消除（§2.2）；推送重扫后可靠性评级预期回到 1、门禁恢复，远端结果以新一次分析为准。本轮未更改远端 issue 状态，未添加 NOSONAR、规则禁用或扫描排除。

## 2. 按规则处置

| 规则 | 数量 | 代码修改 | 保留 | 结论 |
| --- | ---: | ---: | ---: | --- |
| typescript/javascript:S9382 | 10 | 0 | 10 | 有界轮询与顺序场景断言，无可并发 I/O |
| typescript:S3776 | 1 | 1 | 0 | applyRestriction 拆出三个助手，认知复杂度降到阈值 15 以下 |
| javascript:S7739 | 1 | 1 | 0 | 假 fiber 改真 Promise，去掉手写 then（唯一门禁阻塞项） |
| typescript:S7747 | 1 | 1 | 0 | disposeRuntime 直接迭代 Map keys，去掉数组快照 |
| javascript:S7770 | 1 | 1 | 0 | `unhandled.map(String)` |
| **合计** | **14** | **4** | **10** | |

### 2.1 为什么保留 10 条循环内 await

沿用 [PR #30](<sonar-pr30.zh.md>) 的口径：S9382 是「可能错失并发」的通用建议，不理解此处的因果依赖；[ESLint no-await-in-loop 的例外说明](<https://eslint.org/docs/latest/rules/no-await-in-loop#when-not-to-use-it>)同样允许重试、轮询与必须串行的操作。本轮不以异步递归、forEach 回调等方式仅把 await 移出循环来「消警」，保留处补简短意图注释。

**保留理由代码：**

- **A — 有界轮询/重试**：下一次观察必须在前一次检查与短暂退避之后；并行启动各轮会读取同一时刻状态、失去期限与退避语义。共 5 条：rmRetry 退避重试（test:23）、until 轮询（test:192）、T6 通知文本轮询（test:483）、T6 诊断落盘轮询（test:508）、waitForVisibleEager 就绪轮询（registry:1232，作者此前已加意图注释）。
- **G — 顺序场景断言**：T3 的两个未知 scope 提示词过滤（test:300）与逐资源工具的四条门检断言（test:313–316）都是纯内存检查，无 I/O 可并发；顺序执行让失败信息按工具名定位，并行化没有收益。共 5 条。

### 2.2 S7739：假 fiber 手写 then 是唯一门禁阻塞项

- 旧假 fiber 在普通对象上手写 `then(onFulfilled)` 模拟 cordis fiber 的 thenable 契约，被 S7739 判为「给对象加 then」（MAJOR Bug），直接把 `new_reliability_rating` 推到 3、门禁 ERROR。
- 宿主消费面核对：`trackMount` 对每个 fiber 恰好调一次 `.then(onActive, onFailed)`（[registry.ts](<../../src/registry.ts>)），没有第二次 then，也没有直接 await fiber。因此改为 `Object.assign(new Promise(...), { config, dispose })` 行为完全等价：holdFibers 时挂起 resolve、释放后 settle；常态 queueMicrotask settle。
- 旧假件还有「第二次及以后的 then 丢弃回调」的潜在怪癖；真 Promise 没有这个问题，测试双件更贴近宿主真实语义。
- [test-registry.mjs](<../../test/test-registry.mjs>) 的同型假件属存量代码（不在本 PR 新代码期，未被标记），且其 holdFibers 场景依赖旧语义，本轮不动。

### 2.3 S3776：applyRestriction 认知复杂度 32 → 约 12

抽出三个私有助手（[registry.ts](<../../src/registry.ts>)），行为逐项不变：

- `agentTools(agent)`：统一 `ctx.get("tools") ?? ctx.tools` 取法（原两处三元）；
- `disposeRestriction(disposer)`：释放旧限制并吞错（原三处 try/catch）；
- `applyFailClosedRestriction(agent, previous, error)`：fail-closed 兜底分支整体。

空 deny、成功、失败三条路径的顺序与 delete/set 时机不变，`applyingRestrictions` 重入守卫语义不变；按规则计数估算复杂度约 12（阈值 15），以重扫为准。T1–T6（含兜底、链外重试、重试用尽、手动恢复、通知脱敏）全部通过。

## 3. 14 条逐项清单

行号均指 Sonar 分析快照（`891d4a8`）的原始行号；修改后的行号会移动。`修改` 仅表示代码已调整，不声称远端已关闭；`保留` 表示建议 Accepted，本轮未执行该远端操作。

### 3.1 [registry.ts](<../../src/registry.ts>)：3 条

| Issue key | 原行 | 规则 | 处置与理由 |
| --- | ---: | --- | --- |
| AaHPAB-XffjEXTZEPCwg | 2716 | S3776 | 修改：拆出 agentTools / disposeRestriction / applyFailClosedRestriction，复杂度 32 → 约 12 |
| AaHPAB-XffjEXTZEPCwf | 1092 | S7747 | 修改：Map 迭代允许删除当前键，直接遍历 keys，去掉数组快照 |
| AaHJuM4M9RBFuAW2C31s | 1232 | S9382 | 保留 A：Eager 就绪有界轮询，意图注释已在位 |

### 3.2 [test-isolation-race.mjs](<../../test/test-isolation-race.mjs>)：11 条

| Issue key | 原行 | 规则 | 处置与理由 |
| --- | ---: | --- | --- |
| AaHPAByVffjEXTZEPCwV | 86 | S7739 | 修改：假 fiber 改真 Promise + 附加属性，去掉手写 then（门禁阻塞项） |
| AaHPAByVffjEXTZEPCwe | 524 | S7770 | 修改：`unhandled.map(String)` |
| AaHPAByVffjEXTZEPCwU | 23 | S9382 | 保留 A：rmRetry 有界退避重试 |
| AaHPAByVffjEXTZEPCwW | 192 | S9382 | 保留 A：until 有界轮询 |
| AaHPAByVffjEXTZEPCwX | 300 | S9382 | 保留 G：未知 scope 顺序断言，纯内存过滤 |
| AaHPAByVffjEXTZEPCwY | 313 | S9382 | 保留 G：逐工具顺序资源门断言 |
| AaHPAByVffjEXTZEPCwZ | 314 | S9382 | 保留 G：同上 |
| AaHPAByVffjEXTZEPCwa | 315 | S9382 | 保留 G：同上 |
| AaHPAByVffjEXTZEPCwb | 316 | S9382 | 保留 G：同上 |
| AaHPAB-XffjEXTZEPCwc | 483 | S9382 | 保留 A：T6 重试用尽通知轮询 |
| AaHPAB-XffjEXTZEPCwd | 508 | S9382 | 保留 A：T6 诊断落盘轮询 |

## 4. 验证与本地提交

- 完整 `npm test`（含 core/UI 重建）**exit 0**：registry、隔离竞态 T1–T6、UI lifecycle 17 等既有套件全部通过。
- applyRestriction 拆分与假 fiber 改造后先单独跑 T1–T6：fail-closed 兜底、链外重试、重试用尽、手动恢复、通知脱敏行为不变。
- 未删断言、不迁移测试框架、不改依赖或版本号，不进行分支切换、合并、变基或推送。
- 同轮按仓库贡献规范为 CHANGELOG 中属于 @yangjh0127 PR #32 贡献的三条 Unreleased/Fixed 条目补署名（格式对齐 #30）；维护者侧审查修复沿用 #30 先例不署名。

| 本地提交 | 内容 |
| --- | --- |
| `537721e` | registry：applyRestriction 拆分与兜底清理迭代（S3776 / S7747） |
| `f4db7fa` | test：真 Promise 假 fiber、map(String)、串行意图注释（S7739 / S7770 + 保留项） |
| `0736efb` | CHANGELOG：三条 #32 贡献条目补 @yangjh0127/#32 |
| 本文档提交 | 14 项逐条结论及验证记录 |

## 5. 远端后续

1. 用户推送后，等待 SonarCloud 对新提交重扫：4 条修改项（含门禁阻塞项 S7739）的实际匹配结果以重扫为准；Bug 清零后 `new_reliability_rating` 预期回到 1、门禁恢复。不能从本地测试推断远端 issue 已关闭。
2. 对上述 **10 条保留项**，建议维护者根据 A / G 理由人工标为 **Accepted**，附本报告链接；不是安全漏洞，也不必为了清零改错串行语义。本轮没有代为修改状态。
3. 门禁 ERROR 属 `891d4a8` 的已有分析；不冒充本轮新提交的扫描结果。

### 2026-11-12 推送与重扫记录

- 首次推送（17:23:33）已把 PR head 更新为 `3904e23`（含全部修复），但 17:23:41 启动的 Sonar 新分析距推送仅 8 秒，取到的仍是未传播的旧 head `891d4a8`——14 条 issue 原封不动、门禁仍 ERROR。这是自动分析 webhook 与 GitHub head 传播的竞态，不是修复无效；CE 队列为空，干等不会有新分析。
- 经维护者选定，以补齐两版 README 致谢（R32-11 的另一半）的真实提交再次推送触发重扫；此时 `3904e23` 早已传播稳定，新分析必然覆盖修复提交。预期 S7739 / S3776 / S7747 / S7770 四条自动关闭、门禁恢复 OK；10 条 S9382 仍需人工 Accepted。