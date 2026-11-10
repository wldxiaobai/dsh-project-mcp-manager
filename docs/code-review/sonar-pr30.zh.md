# SonarCloud PR #30：33 条 issue 研判与必要修复

[← 记录索引](<../records.zh.md>) · [Gate 1 审查](<pr30-lazy-gate1.zh.md>) · [Lazy 架构决策](<../design/lazy-mcp.md>)

## 1. 快照与结论

- 日期：2026-11-11（Asia/Shanghai）。本轮基线 `2605f32`。
- 来源：[用户指定的 issue 列表](<https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=30&issueStatuses=OPEN%2CCONFIRMED&s=IMPACT_RANK>)。
- [issues API](<https://sonarcloud.io/api/issues/search?componentKeys=wldxiaobai_dsh-project-mcp-manager&pullRequest=30&issueStatuses=OPEN,CONFIRMED&ps=100&p=1&s=SEVERITY>) 返回 `total=33`，实际取得 33 条，单页完整覆盖 OPEN/CONFIRMED，全部为 OPEN。
- [PR 分析元数据](<https://sonarcloud.io/api/project_pull_requests/list?project=wldxiaobai_dsh-project-mcp-manager>) 指向提交 `2605f32c3792e495d2ffc8fb7f5eee4e14c5e456`，分析时间 `2026-11-10T16:21:14Z`，即北京时间 **11 月 11 日 00:21:14**。它与本轮基线一致。
- 元数据显示 **Quality Gate OK、0 Bug、0 Vulnerability、33 Code Smell**。因此上一轮重复率红门禁已由新分析确认恢复；这不等于这 33 条不需要审查。
- 严重度：30 MINOR、3 MAJOR；影响维度均为可维护性，4 MEDIUM、29 LOW。规则分布：S9382 **29** 条、S2681 **2** 条、S1121 **1** 条、S7750 **1** 条。

**结论：33 条全部研判，9 条有代码修改，24 条保留有意串行语义，建议维护者人工 Accepted 并引用本报告。** 没有证实新的运行时功能/安全缺陷；不能把“循环里有 await”一律判成并发性能缺陷。24 条保留项也不是“已关闭”：本轮未更改远端 issue 状态，未添加 NOSONAR、规则禁用或扫描排除。

## 2. 按规则处置

| 规则 | 数量 | 代码修改 | 保留 | 结论 |
| --- | ---: | ---: | ---: | --- |
| javascript/typescript:S9382 | 29 | 5 | 24 | 只有独立目录/文件准备和元数据读取可并发；固定两次重试显式写出；同步屏障、轮询、进程场景及共享 spy 保留顺序 |
| javascript:S2681 | 2 | 2 | 0 | 两处单行 catch 的 if + continue/return + throw 易被误读，展开为多行；原行为正确，不把它描述为真实条件分支错误 |
| typescript:S1121 | 1 | 1 | 0 | 将 dispose 的缓存赋值与 return 分开，保留同一 Promise 的幂等契约 |
| javascript:S7750 | 1 | 1 | 0 | 用 findLast 替换 filter().at(-1)，避免创建临时数组，查找含义更明确 |
| **合计** | **33** | **9** | **24** | |

### 2.1 为什么不能把所有 await 改成 Promise.all

S9382 是“可能错失并发”的通用建议，不理解此处的所有因果/资源依赖。对应 [ESLint no-await-in-loop 的例外说明](<https://eslint.org/docs/latest/rules/no-await-in-loop#when-not-to-use-it>)也明确指出：有前后结果依赖、重试、资源限制和必须串行的操作可以在循环中等待。该说明是判断原则的参考，不冒充本次未成功取得的 Sonar S9382 规则正文。

本轮不以异步递归、forEach 回调、迁移测试框架等方式仅把 await 移出循环来“消警”。有意串行的地方加简短意图注释，并在下表提供可用于人工 Accepted 的理由。

**保留理由代码：**

- **A — 有界轮询**：下一次观察必须在前一次检查和短暂退避之后。并行启动各轮会读取同一时刻状态、失去期限与退避语义，不能更快证明子进程已退出。
- **B — 共享连接取消场景**：先等 connect/list 到达指定阶段，再取消一方，随后核对存活者、只初始化一次，最后 dispose 和 PID 回收。步骤不能并行，多个真实进程场景顺序执行也限制资源重叠。
- **C — 最后调用者取消**：事件到达 → abort → 拒绝落定 → dispose → 回收 → 检查没有 initialize。任意调换都可能把回收尚未完成误判为泄漏，或根本没有覆盖指定阶段。
- **D — dispose 生命周期证明**：到指定连接阶段 → dispose 屏障 → 原操作落定 → PID 回收 → trace 快照 → 拒绝重用 → trace 不变。后一步依赖前一步完成。
- **E — 共享 UI spy**：每个模式请求都先清空同一个 modeCalls 数组，再请求、读响应并核对精确调用记录。并行会混合 eager/lazy 记录，破坏测试而非优化它。
- **F — 生产世代屏障**：等待当前 closing Promise 后必须再比较它是否被新 shutdown 替换；循环中再次等待是防止新连接越过旧世代回收的正确性要求，不是可独立并发的集合。

### 2.2 有意义的独立 I/O 并发

- [依赖测试](<../../test/test-lazy-dependencies.mjs>)：两个包及各自 direct/nested 元数据读取彼此独立，使用 Promise.all 同时读取，收齐后保留原兼容断言。向上查找所属包元数据的循环有数据依赖，本轮不扩展为无界并发。
- [Registry 隔离设施](<../../test/test-registry.mjs>)：home/A/B 目录彼此独立；三份配置文件也彼此独立。用 map 收集操作，但不直接使用提前失败的 Promise.all 让 finally 与尚未完成的写入竞争；通过 finishFixtureWrites 的 Promise.allSettled 等全部操作落定后再抛出首个错误，之后才清理临时目录。仍保持“目录完成 → 配置完成 → 注册宿主”的阶段顺序。
- [生命周期测试](<../../test/test-lazy-lifecycle.mjs>)：同一个失败实例固定试两次，是验证失败后可重试，不应并行。直接写两次 assert.rejects 比二次计数循环更明确，两个检查仍然依次执行。

## 3. 33 条逐项清单

行号均指 Sonar 分析快照的原始行号；修改后的行号会移动。`修改` 仅表示代码已调整，不声称远端已关闭；`保留` 表示建议 Accepted，本轮未执行该远端操作。

### 3.1 [Lazy 生命周期测试](<../../test/test-lazy-lifecycle.mjs>)：23 条

| Issue key | 原行 | 规则 | 处置与理由 |
| --- | ---: | --- | --- |
| AaHGM5aLarJfnqNPJp9I | 65 | S2681 | 修改：展开 JSON.parse catch；仅 SyntaxError 才 continue，其它错误仍抛出 |
| AaHGM5aLarJfnqNPJp9L | 84 | S2681 | 修改：展开 PID 检查 catch；仅 ESRCH 返回 true，其它错误仍抛出 |
| AaHGM5aLarJfnqNPJp9J | 75 | S9382 | 保留 A：逐轮等待检查条件 |
| AaHGM5aLarJfnqNPJp9K | 77 | S9382 | 保留 A：逐轮退避不能并行 |
| AaHGM5aLarJfnqNPJp9M | 126 | S9382 | 保留 B：先等待指定协议事件 |
| AaHGM5aLarJfnqNPJp9N | 128 | S9382 | 保留 B：取消方拒绝须先落定 |
| AaHGM5aLarJfnqNPJp9O | 129 | S9382 | 保留 B：验证存活方继续成功 |
| AaHGM5aLarJfnqNPJp9P | 130 | S9382 | 保留 B：成功之后检查初始化次数 |
| AaHGM5aLarJfnqNPJp9Q | 131 | S9382 | 保留 B：验证后关闭实例 |
| AaHGM5aLarJfnqNPJp9R | 132 | S9382 | 保留 B：关闭后再确认 PID 回收 |
| AaHGM5aLarJfnqNPJp9S | 142 | S9382 | 保留 C：必须进入被测阶段后再 abort |
| AaHGM5aLarJfnqNPJp9T | 144 | S9382 | 保留 C：等待取消拒绝落定 |
| AaHGM5aLarJfnqNPJp9U | 145 | S9382 | 保留 C：随后等待关闭屏障 |
| AaHGM5aLarJfnqNPJp9V | 146 | S9382 | 保留 C：关闭后验证子进程退出 |
| AaHGM5aLarJfnqNPJp9W | 147 | S9382 | 保留 C：退出后检查 probe 未升级为 session |
| AaHGM5aLarJfnqNPJp9X | 155 | S9382 | 保留 D：先等连接到指定阶段 |
| AaHGM5aLarJfnqNPJp9Y | 158 | S9382 | 保留 D：等待第一次 dispose 返回的屏障 |
| AaHGM5aLarJfnqNPJp9Z | 159 | S9382 | 保留 D：确保原目录调用落定 |
| AaHGM5aLarJfnqNPJp9a | 160 | S9382 | 保留 D：随后验证 PID 回收 |
| AaHGM5aLarJfnqNPJp9b | 161 | S9382 | 保留 D：退出后的 trace 作为不可再启动的基准 |
| AaHGM5aLarJfnqNPJp9c | 162 | S9382 | 保留 D：已释放实例必须拒绝重用 |
| AaHGM5aLarJfnqNPJp9d | 163 | S9382 | 保留 D：重用失败后 trace 必须保持不变 |
| AaHGM5aLarJfnqNPJp9e | 247 | S9382 | 修改：同实例两次失败重试明确写成两次依次 assert.rejects |

### 3.2 [UI 生命周期测试](<../../test/test-ui-lifecycle.mjs>)：2 条

| Issue key | 原行 | 规则 | 处置与理由 |
| --- | ---: | --- | --- |
| AaHGM5eVarJfnqNPJp9f | 505 | S9382 | 保留 E：请求必须位于清空 spy 与精确记录检查之间 |
| AaHGM5eVarJfnqNPJp9g | 507 | S9382 | 保留 E：在开始下一模式前读完响应并完成当前断言 |

### 3.3 [Registry 测试](<../../test/test-registry.mjs>)：4 条

| Issue key | 原行 | 规则 | 处置与理由 |
| --- | ---: | --- | --- |
| AaHGM5hFarJfnqNPJp9h | 74 | S9382 | 保留 A：等待上轮检查完成后退避，再检查进程退出 trace |
| AaHGM5hFarJfnqNPJp9l | 3092 | S7750 | 修改：findLast 直接定位最后一次 own 装载记录 |
| AaHGRCZXztPAhBD66GF0 | 2815 | S9382 | 修改：独立目录并发创建，全部落定后再进入下一阶段 |
| AaHGRCZXztPAhBD66GF1 | 2859 | S9382 | 修改：独立文件并发写入，全部落定后才允许失败清理 |

### 3.4 [依赖契约测试](<../../test/test-lazy-dependencies.mjs>)：2 条

| Issue key | 原行 | 规则 | 处置与理由 |
| --- | ---: | --- | --- |
| AaHGM5hHarJfnqNPJp9m | 25 | S9382 | 修改：direct 元数据与其它独立读取同时启动 |
| AaHGM5hHarJfnqNPJp9n | 26 | S9382 | 修改：nested 元数据与 direct 同时启动，读取后仍核对全部版本契约 |

### 3.5 [Lazy 连接实现](<../../src/lazy/connection.ts>)：2 条

| Issue key | 原行 | 规则 | 处置与理由 |
| --- | ---: | --- | --- |
| AaHGM5kBarJfnqNPJp9o | 101 | S9382 | 保留 F：世代屏障必须循环等待最新 closing，补意图注释 |
| AaHGM5kBarJfnqNPJp9p | 174 | S1121 | 修改：先 `this.disposal ??= this.close()`，再 return；不改 async 函数，不包装成另一个 Promise |

## 4. 验证与本地提交

- 完整 `pnpm test`（含 core/UI 重建）**exit 0**：registry 67、UI lifecycle 17、命名对拍 3 等既有套件均通过，新增依赖和真实 stdio 生命周期脚本通过。
- 生产赋值拆分后独立编译核心并运行生命周期脚本：通过，其中 `assert.strictEqual(server.dispose(), first)` 继续验证同一 Promise 身份。
- 独立依赖契约脚本、UI lifecycle 17 项、语法检查及 `git diff --check`：通过。
- 生命周期的缺失命令 fixture 在 stderr 输出两次预期启动失败，正用于验证同实例两次重试；不是测试失败。
- 未删断言、不迁移测试框架、不改依赖或版本号，不进行分支切换、合并、变基或推送。

| 本地提交 | 内容 |
| --- | --- |
| `cc8c91c` | 明确生产 dispose 赋值与世代屏障意图 |
| `80b73cf` | 展开两处 catch，并明确同实例两次失败重试 |
| `f7611be` | 独立目录/文件/元数据准备并发化，findLast，顺序等待说明 |
| 本文档提交 | 33 项逐条结论及验证记录 |

## 5. 远端后续

1. 用户推送后，等待 SonarCloud 对新提交重扫；9 条修改项的实际匹配结果以重扫为准，不能从本地测试推断远端 issue 已关闭。
2. 对上述 **24 条保留项**，建议维护者根据 A～F 理由人工标为 **Accepted**，附本报告链接；不建议当作安全漏洞，也不必为了清零改错并发语义。本轮没有代为修改状态。
3. 目前获知的 Quality Gate OK 属 `2605f32` 的已有分析；不冒充本轮新提交的扫描结果。若要求所有 OPEN 清零，仍需重扫及上述人工裁决，而不是简单再改代码。
