# 设计提案：运行时稳健性改进与 JSON 格式互通

[← 返回 README](../README.zh.md) ｜ 相关：[DSH 自有 JSON 配置层](proposal-json-mcp-config.md)、[dsh v0.1.5-rc.1 适配记录](adaptation-dsh-0.1.5-rc1.md)

**状态**：已落地 v0.6.0（C3 本轮不做） ｜ **提出日期**：2026-09-12 ｜ **目标版本**：一次发布为 v0.6.0（因 B1 语义变化，跳过原建议的 0.4.4 / 0.5.0 切分）
**核查对象**：`@wingsky-1/dsh-mcp-manager` v0.2.3（`wingsky-1/dsh-plugin-hub`，commit `da8da6379415d96db95bdc33d68aba37556ccea6`）
**关联**：`AGENTS.md`（关键行为约定与提交节奏）、`docs/guide/layers.md`、`docs/guide/format.md`、`docs/guide/cli.md`、`CHANGELOG.md`

## 0. 结论速览（已裁决，已落地 v0.6.0）

| 编号 | 条目 | 组 | 优先级 | 破坏性 | 建议版本 | 落地 |
|---|---|---|---|---|---|---|
| A0 | 传输值域镜像常量（C1/C2 前置） | 前置 | 高 | 否 | v0.4.4 | v0.6.0 |
| C1 | `sse` 条目的可执行报错 | 互通 | 高 | 否 | v0.4.4 | v0.6.0 |
| C2 | 接受 `httpUrl`；显式 `transport` 键；`url` 语义文档化 | 互通 | 高 | 否 | v0.4.4 | v0.6.0 |
| C4 | 「非本插件格式」诊断 + 共存声明 | 互通 | 高 | 否 | v0.4.4 | v0.6.0 |
| A3 | 诊断摘要段 + `dsh-mcp status` | 机制 | 高 | 否 | v0.4.4 | v0.6.0 |
| A5 | `dsh-mcp import`（批量导入 + dry-run） | 机制 | 高 | 否 | v0.4.4 | v0.6.0 |
| A1 | 连接健康巡检与自愈 | 机制 | 中高 | 否 | v0.5.0 | v0.6.0 |
| A2 | 停用/故障分类与外部改动兜底 | 机制 | 中 | 否 | v0.5.0 | v0.6.0（A2b 仅指纹，无 timer） |
| A4 | 工具级 `allow`/`deny` | 机制 | 中高 | 否 | v0.5.0 | v0.6.0 |
| B2 | 工具预算护栏（只告警不裁剪） | 架构 | 中 | 否 | v0.5.0 | v0.6.0 |
| B3 | `ctx.provide` 查询服务面 | 架构 | 中 | 否 | v0.5.0 | v0.6.0 |
| B1 | 按需挂载（只挂活跃项目） | 架构 | 中 | 语义变化 | v0.6.0 | v0.6.0（5 分钟宽限） |
| C3 | VS Code `.vscode/mcp.json` 只读兼容层 | 互通 | 可选 | 否 | v0.6.0 | **本轮不做** |

## 1. 背景与边界

### 1.1 动机

`@wingsky-1/dsh-mcp-manager` 与本插件解决同一问题（按项目自带 MCP），但实现路线不同：它自建 MCP 连接池（官方 `@modelcontextprotocol/sdk` 传输）、以中间件按 workspace root 路由、带全套 Web UI；本插件坚持两条主线——**配置即项目文件**、**装载复用官方 `@deepseek-ai/dsh-mcp-client`**。

排除 UI 交互后，对方仍有若干机制值得吸收（内存自愈、诊断一次说清、工具级策略、批量导入），另有若干与生态 JSON 方言的互通差异值得补齐。本提案把它们固化为可裁决、可验收的条目。

### 1.2 两条不可动的主线

1. **装载链路**：仍走官方 `@deepseek-ai/dsh-mcp-client`（`ctx.plugin`），工具命名/预留/重连/`tools/list_changed`/附件投影/子进程环境净化全部继承官方语义。
2. **配置载体**：项目层写 `<projectRoot>/.dsh/mcp.yml`（受管块）或 `.dsh/mcp.json`；用户层三源；宿主侧永不写配置文件，写只走 `dsh-mcp` CLI。

### 1.3 非目标（明确不做）

- 不做 Web/面板/HTTP 路由/**浏览器 SSE 推送**（无 UI 定位，另见 §5）。注意此处 "SSE" 指浏览器推送通道，与 MCP 的 SSE 端点传输无关——两者同名不同物，见 §1.6。
- 不自建传输或 supervisor，不引入 `@modelcontextprotocol/sdk` 直连。
- 不引入代理式渐进披露（`ws_mcp_*` 类入口工具）：会绕过官方附件/`list_changed` 语义，且与宿主原生 PTC 模式重复。
- 不改本插件写出的 JSON 顶层键（保持 `mcpServers`），不采纳对方的 `{version, servers: []}` 存储格式。

### 1.4 核查方式（可复现）

- 对方源码：`https://fastly.jsdelivr.net/gh/wingsky-1/dsh-plugin-hub@<commit>/packages/dsh-mcp-manager/<path>`（本机 `raw.githubusercontent.com` 不可达；目录清单用 `api.github.com` git tree 核对）。
- 宿主原生语义：本地 dsh 0.1.5-rc.1 的 `dsh-mcp-client`、`dsh-tools`、`dsh-skill-filesystem` 源码与 README。
- 生态格式：VS Code、Cursor、Gemini CLI、Codex 官方文档（见 §4.1 来源）。
- MCP 规范：[Transports（2025-06-18）](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)，用于确认标准传输集合与「HTTP+SSE 被 Streamable HTTP 取代」的原文表述（见 §1.5）。

### 1.5 传输能力边界政策（能力跟随官方）

> **政策**：MCP 传输的**实现**一律跟随官方 `@deepseek-ai/dsh-mcp-client`；本插件不实现任何 MCP 传输，只负责传输的**表达**（配置方言、schema 校验、诊断、文档、CLI），并与官方能力保持同步。

三点展开：

1. **上界**：本插件可装载的传输集合 = 官方 client 支持的传输集合。官方不支持的类型，本插件既不自己实现，也不静默降级。
2. **增值在中游**：本插件的价值在来源治理（六层 shadow 合并）、按会话隔离、热重载与 CLI，不在传输层。
3. **表达面必须自洽**：同一条能力边界要在 JSON 读取器、CLI、诊断、文档四处说同一句话。（现状：CLI 已说清、JSON 侧没说清——这就是 C1 的全部内容。）

**规范事实**（[2025-06-18 修订](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)）：规范只定义 `stdio` 与 `Streamable HTTP` 两个标准传输，并写明后者 "replaces the HTTP+SSE transport from protocol version 2024-11-05"；同时 Streamable HTTP **自身可选使用 Server-Sent Events 做流式响应**（"Server can optionally make use of SSE to stream multiple server messages"）。

**由此得到的判据**：

- 准确表述是「**官方支持任何新传输类型时本插件跟随**」，而不是「等官方支持 SSE」——老式独立 `/sse` 端点属**兼容存量**，官方补不补是路线选择而非必答题；规范方向是服务器收敛到单端点 `/mcp`。
- **不要为"未来可能有 SSE"预留复杂度**：不引入自建传输、不引入传输抽象层。对方插件正是用自建 MCP 客户端换来这份自由度，代价是自行追赶规范演进。
- **配置/诊断面不被阻塞**：C1 与官方何时支持 SSE 无关，现在就做（用户痛点是"配了为什么不生效"，不是"什么时候支持"）。

**跟进验收清单**（官方新增传输时，做完这些才算跟进完成）：

1. `SUPPORTED_MCP_TRANSPORTS`（A0）加值，并补官方 config 映射；
2. `dsh-mcp --transport <新值>` 可写，`add`/`get`/`list` 正常；
3. 读取侧不再有该传输的专属特判分支（走通用路径）；
4. `docs/guide/format.md`、`layers.md`、`cli.md`（中英）能力表更新；
5. 测试覆盖读取 / 写入 / 装载三条路径；
6. README 增补**能力矩阵**一行：「本插件能力 = 官方 `dsh-mcp-client` 能力 + 六层来源治理 + 按会话隔离；**传输类型子集由官方决定**」——避免用户把官方能力边界误记成插件缺陷。

**明确不做**：不为 `type: "sse"` 提供隐式回退（见 C1 与 §7-6）。

### 1.6 术语澄清：两个 "SSE"（注释）

> **注释**：本文档与代码、文案里出现的 "SSE" 有两个互不相干的含义。混淆会直接导出错误结论（"本插件不支持 SSE"到底指哪一件事），也会让报错文案无法自救。

| | 浏览器 SSE（Server-Sent Events） | MCP 的 "SSE transport" |
|---|---|---|
| 是什么 | 一个不结束的 HTTP 响应：`Content-Type: text/event-stream` + 持续写 `data:` 帧，页面用 `EventSource` 接收 | MCP 客户端与服务器之间的通信传输（2024-11-05 规范定义） |
| 方向 | 单向：服务器 → 页面 | 双向 JSON-RPC 会话（响应经事件流返回） |
| 典型用途 | 推状态/事件（宿主 HMR 事件流、对方插件的 `/api/dsh-mcp/events`） | 让宿主连上一个远端 MCP 服务器 |
| 规范现状 | 活跃的 Web 标准 | 已被 Streamable HTTP 取代（2025-03-26 起）；规范保留 Backwards Compatibility 指引，供需要兼容旧服务器的实现自行支持 |
| 与本插件的关系 | **非目标**（无 UI，见 §1.3） | **配置里出现即为不支持**（`type: "sse"`，见 C1） |

两者都基于 `text/event-stream`，这是混淆的根源；更微妙的是 **Streamable HTTP 内部也会用 SSE 流式**，所以"本插件支持 SSE 吗"这句话本身就是歧义的。准确表述：

> 本插件支持 **Streamable HTTP**（其流式响应可基于 SSE）；**不支持** 2024-11-05 规范的**独立 SSE 端点传输**；**不做**浏览器 SSE 推送通道。

代码与文案中引用本术语时，统一写作「浏览器 SSE 推送」与「MCP SSE 端点传输」，不要单写 "SSE"（C1 的报错文案同样遵守此约定）。

## 2. 机制类改进（A 组）

### A0（前置，跨组）传输值域镜像常量

**问题**：传输枚举散落在四处——`src/model.ts` 的 zod literal 判别联合、`src/json-file.ts` 的 `z.enum` 与 `sse` 特判分支、`src/cli.ts` 的 `--transport` 解析与文案、`src/json-write.ts` 的 `entry.type` 赋值。官方扩展传输时要在多处找分支，容易补出半吊子路径（例如只有 CLI 认、读取器不认）。

**提案**：收敛为**单一常量**（建议 `SUPPORTED_MCP_TRANSPORTS`，注释注明"镜像自 `@deepseek-ai/dsh-mcp-client` `<版本>`"），schema、CLI 解析、CLI→JSON 映射与报错文案全部从它派生。其性质与仓库既有的**「reconnect 上限镜像」**（`MAX_TIMER_DELAY_MS` 必须与 dsh-mcp-client 一致，越界值在本地 zod 拦下）完全相同：官方能力在本地以常量镜像，未知/越界值给出可执行文案，而不是留到 `ctx.plugin` 抛 plugin-throw。

**涉及文件**：`src/model.ts`（常量 + schema 派生）、`src/json-file.ts`、`src/cli.ts`、`src/json-write.ts`、`AGENTS.md`（关键行为约定新增一条镜像说明）。

**测试点**：`test/test-model.mjs`（未知传输值的报错文案）、`test/test-cli.mjs`（`--transport` 未知值）。

**验收**：官方新增传输时，跟进 = 常量加值 + 一条映射 + 文档 + 测试（约 4 个源文件），无需改动任何判定分支。

### A1 连接健康巡检与自愈

**问题**：官方 client 在 `maxAttempts` 次连续失败后注销该服务器全部工具并停止重连，其 README 明说"reload the plugin or restart the Host to reconnect"。本插件目前的触发点（文件事件、agent 创建、插件热更）只会重算期望集，**已装载但连接已死的行不会被重挂**——用户感知为"重启 dsh 才好"。

**提案**：
- 在 `reconcileAll()`（`src/registry.ts`）尾部增加一次轻量巡检，对 `this.projects` 中的已装载行判断是否需要重挂。
- 判据（全部满足才重挂）：行未 `disabled` → 曾经成功过（新增 `everHadTools`）→ 当前 `mcpToolCount(ctx, effectiveName) === 0`（`src/status.ts`）→ 距上次重挂已过退避窗口。
- 动作：复用既有顺序 `unmountServer` → `mountServer`（先释放 serverName 预留再挂，`reconcileContainer` 已保证该顺序）。
- 上限：单行连续重挂 N 次（建议 3）仍为 0 工具 → 停止重挂并写诊断 `kind: "give-up"`。
- 新增状态字段（仅内存）：`everHadTools`、`remountCount`、`nextRemountAt`。

> **落地口径（v0.6.0）**：`everHadTools` 按 fiber 世代（新一代首连窗口交给官方重连）；
> 同世代短暂 0 工具去抖（单次巡检不拆）；`tools > 0` 清 `remountCount` / `givenUp`
> （连续失败而非寿命配额）。

**涉及文件**：`src/registry.ts`（tracker、`reconcileAll`）、`src/status.ts`（复用）、`src/model.ts`（若退避/上限需常量）。

**风险**：合法 0 工具服务器被误判。缓解：`everHadTools` 前置 + 退避 + 次数上限；诊断可回溯。

**测试点**（`test/test-registry.mjs`）：fake ctx 工具层可控 → ①首次挂载成功（有工具）→ 人为清零工具 → 下一次 reconcile 触发一次重挂；②从未有过工具的行不重挂；③`disabled` 行不重挂；④重挂 N 次仍失败后停止并写 `give-up`。

**验收**：模拟"连接死亡 + 工具注销"后，无需重启 dsh，下一次触发点即恢复；日志与诊断能说明"重挂了第几次/为何放弃"。

### A2 停用/故障分类与外部改动兜底

**问题**：巡检必须永远不复活"用户显式停用"的行，否则会把 `disabled: true` 变成临时开关。

**提案**：
- A2a（随 A1 一起）：巡检前置条件显式包含 `SourcedRow.disabled !== true`（原生 yml 的 `disabled: true` 占名行）与 JSON `enabled: false`（静默跳过行，本就不在装载集合）。
- A2b（可选，需裁决）：**外部改动兜底**。chokidar 在 `git checkout`、原子替换、网络盘/WSL 场景会丢事件。提案是在已有触发点（reconcileAll 入口）先比对已知 4+3 个精确路径的 `mtimeMs + size` 指纹，指纹全同则跳过重读（省空转），任一变化则照常扫描。若要覆盖"完全没有事件"的情况，需要低频 timer（如 `DSH_MCP_RECONCILE_INTERVAL_MS`，默认关闭）——与"事件驱动"哲学有张力，列入 §7 待决。

**涉及文件**：`src/registry.ts`（指纹缓存与前置比对）。

**测试点**：指纹未变时不做文件读取（可用计数注入断言）；指纹变化时正常收敛。

**验收**：手工 `git checkout` 换配置后，不需要重启即收敛（有事件或定时兜底时）。

### A3 诊断摘要段 + `dsh-mcp status`

**问题**：`.mcp-diag.json` 是"事件流"（保留最近 30 条），回答"插件到底生效没有、为什么没生效"需要人工翻事件；对方的 `/health` 一条请求即给出汇总，这个价值与 UI 无关。

**提案**：
- 对账结束后，向诊断文件写入/更新一个 `summary` 段：`{ at, projects, rows, mounted, skippedByReason: {...}, unhealthy: [{name, reason}] }`。
- 遵守「零配置项目不留痕」：仅对"有行或有异常"的项目写；全局层写 `<dshHome>/.mcp-diag.json`。
- CLI 新增 `dsh-mcp status`：读取诊断文件 + 各层文件的存在性/条目数，打印"层 → 行数 → 生效名 → 跳过原因"；**不连接宿主内存**（CLI 既有契约：只读写文件）。

**涉及文件**：`src/registry.ts`（`writeDiag`/`writeDiagAt`）、`src/cli.ts`（新子命令 + 用法）、`docs/guide/cli.md` / `.zh.md`、`AGENTS.md`（`dsh-mcp` 能力描述）。

**测试点**：`test/test-registry.mjs`（摘要内容与"零配置不留痕"）、`test/test-cli.mjs`（status 输出、缺文件时的空态）。

**验收**：在"某行因 `env-missing` 被跳过"的项目里，`dsh-mcp status` 一行定位原因。

### A4 工具级 `allow`/`deny`

**问题**：目前只有"跨项目隔离"的自动 deny，用户无法按服务器收窄工具（生态里 Gemini 的 `includeTools`/`excludeTools`、Codex 的工具白/黑名单已是标配）。

**提案**：
- 配置面（yml 受管块与 JSON 方言一致）：条目级
  ```yaml
  tools:
    deny: ["delete_*", "mcp__github__create_issue"]
    allow: ["read_*"]     # 缺省全开；deny 优先
  ```
- 语义：列表项接受**裸工具名**或完整 `mcp__<生效名>__<tool>`；支持 `*` 通配；`deny` 优先于 `allow`。
- 实现：并入既有 `denySetFor()` 与 `tools.restrict` 管道（`src/registry.ts` 的 `applyRestriction` / `sweepRestrictions`）。**必须先把 serverName 展开成当前注册工具名再 deny**（`tools.restrict` 对 unknown names 报错），装载未 settle 时沿用"下一次 sweep 补上"的既有机制。
- 兼容读取（可选）：JSON 方言里把生态键 `excludeTools` → `tools.deny`、`includeTools` → `tools.allow` 映射，降低迁移成本。

**涉及文件**：`src/model.ts`（schema + 展开）、`src/registry.ts`（deny 集合）、`src/json-file.ts`（生态键映射）、`docs/guide/format.md` / `.zh.md`。

**测试点**：`test/test-model.mjs`（schema/通配/优先级）、`test/test-registry.mjs`（deny 展开、未知名重试、跨项目与本条目的叠加）。

**验收**：项目配置里 deny 某工具后，该会话模型看不到它，且不产生"未知名"告警。

### A5 `dsh-mcp import`（批量导入）

**问题**：CLI 现有 `add`/`list`/`get`/`remove`，迁移几十个服务器只能逐条敲；对方"粘贴 `mcpServers` JSON"是它最强的迁移钩子。

**提案**：
- 新子命令：`dsh-mcp import --from <file|-> [--scope project|user|profile] [--format yml|json] [--dry-run] [--overwrite] [--profile <name>]`。
- 输入方言：`{"mcpServers": {...}}`（主流）与 `{"servers": {...}}`（VS Code，若采纳 C3）；单条对象与数组不接受（避免歧义）。
- 复用：解析与逐条校验走 `parseJsonServersValue`（`src/json-file.ts`）；写入走 `updateJsonServers`（JSON）或 `writeManagedRows`（yml），均带锁 + 原子写 + 写前自校验。
- `--dry-run`：复用 `shadowViewOf`（`src/cli.ts`）打印**影子冲突预演**（将遮蔽/被遮蔽的行、服务身份重复），不做任何写入。
- 缺省行为：同名牌 `skip` 并报告（与对方一致），`--overwrite` 才覆盖。

**涉及文件**：`src/cli.ts`、`docs/guide/cli.md` / `.zh.md`、`AGENTS.md`。

**测试点**：`test/test-cli.mjs`（文件/stdin、dry-run 不写盘、同名 skip/overwrite、坏条目逐条报错、`--scope user` 目标路径）。

**验收**：`dsh-mcp import --from .cursor/mcp.json --scope project --dry-run` 能预演出与现有层的冲突且不落盘。

## 3. 架构类改进（B 组，需先裁决）

### B1 按需挂载

**问题**：当前所有已知项目的行都常驻装载——项目数增长时，宿主工具层注册量与 stdio 子进程数线性增长（deny 只影响可见性，不影响注册与进程）。

**提案**：**扫描保持全量，挂载只针对活跃项目**。
- 期望集照旧全量计算（`scanProject` 读文件很便宜），`effectiveServerNames` 仍按全目录算改名，保证命名确定性不依赖挂载集。
- 挂载集 = 有活跃会话的项目 ∪ 进程 cwd 所在项目；其余项目仅保留 watcher 与文件读取。
- 不变项：跨项目 deny 继续保留（同项目多会话共享连接、其他项目不可见）。

**风险**：首次进入某项目有容器创建 + 首连延迟；与会话结束时的卸载时机耦合（立即卸载 vs 宽限期）。

**测试点**：`test/test-registry.mjs`：两个已知项目、仅 A 有会话 → 只挂 A 的行；B 出现会话 → 增量挂 B；A 会话结束 → 按裁决策略卸载。

**验收**：20 个已知项目的场景下，工具层注册量与子进程数只与活跃项目数相关，且生效名与全量挂载时完全一致。

### B2 工具预算护栏（只告警不裁剪）

**问题**：没有对"某项目装载后工具过多/描述过大"的任何提示，用户容易在不知不觉中吃掉上下文预算。

**提案**：装载/巡检后统计每项目、每生效名的工具数与描述/schema 字节量（`ctx.tools.schemas()` 可得），超过阈值（建议 `DSH_MCP_TOOL_BUDGET_WARN`，缺省 200 工具/256KB）写诊断并告警一次。**不自动裁剪、不截断结果**——结果裁剪交给宿主原生 compaction/pruner，自己截会让模型看到与真实工具结果不一致的数据。

**涉及文件**：`src/status.ts`、`src/registry.ts`。

**测试点**：`test/test-registry.mjs`（超阈值告警一次、不重复刷屏）。

**验收**：诊断摘要里能看到"该项目 240 个工具，超阈值 200"。

### B3 `ctx.provide` 查询服务面

**问题**：`snapshot()`/`serverView()`/`globalState()` 只对内；别的插件（或宿主 UI）无法消费本插件的状态。

**提案**：以官方 storageDomain/service 模式 `ctx.provide("projectMcp", { snapshot, serverView, globalState, reload })`，并补类型声明合并。插件现有导出面（`inject = ["tools","agents"]`、`globalNames()`、`activeProfile()`）保持不变。

> **落地口径（v0.6.0）**：`snapshot` / `serverView` / `globalState` 进 enqueue 与对账互斥，按上一轮 `lastScanFiles` / `userLayer` 内存拼装，不读盘、不跑 `reconcileAll`；`reload` 才对账一次。

**风险**：服务名与稳定性承诺需评审；`reload` 的语义限定为"触发一次 reconcileAll"。

**测试点**：`test/test-registry.mjs`（provide 被调用、返回值与现有查询一致）。

**验收**：外部插件可只读拿到当前项目的装载快照，无需读诊断文件。

## 4. 格式互通类改进（C 组）

### 4.1 生态现状（2026-09 核查）

| 工具 | 文件 | 顶层键 | stdio | 远程传输表达 | 特有字段 |
|---|---|---|---|---|---|
| Claude Code / Cursor / Windsurf / Cline | `.mcp.json`、`.cursor/mcp.json` | `mcpServers` | `command`/`args`/`env`(+`cwd`) | `url`+`headers`，`type: "sse"\|"http"` 或由 `url` 推断 | CC `--scope local\|project\|user`；Cursor 项目/全局两份合并、项目优先 |
| VS Code / Copilot | `.vscode/mcp.json`（用户 profile 同名文件） | **`servers`** | `type:"stdio"`+`command`/`args`/`env`/`envFile`/`cwd` | `type:"http"\|"sse"`+`url`+`headers` | `inputs[]`、`sandbox{}`、`sandboxEnabled`、`dev`、`oauth` |
| Gemini CLI | `settings.json` | `mcpServers` | `command`/`args`/`env`/`cwd` | **`httpUrl`=streamable HTTP；`url`=SSE**（无 `type`） | `timeout`、`trust`、`includeTools`/`excludeTools`、OAuth、`$VAR`/`${VAR}` |
| Codex CLI | `~/.codex/config.toml` | TOML `[mcp_servers.<name>]` | `command`/`args`/`[.env]` | `url`+`bearer_token_env_var` | `enabled`、工具白/黑名单（非 JSON） |
| 本插件 | `.dsh/mcp.json` 等 | `mcpServers` | `type:"stdio"`+`command`/`args`/`env`/`cwd` | `type:"http"`+`url`+`headers` | `toolCallTimeoutMs`、`failOnStartupError`、`reconnect` |
| 对方插件 | `.dsh/mcp.json`、`~/.dsh/dsh-mcp.json` | `{version, servers: []}` | `transport:"stdio"`+`command`/`args`/`env`/`cwd` | `transport:"streamable-http"`+`url`+`headers` | `enabled`、`toolCallTimeoutMs`、`reconnect`、`description` |

来源：[VS Code MCP 配置参考](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)、[VS Code MCP 服务器](https://code.visualstudio.com/docs/agent-customization/mcp-servers)、[Cursor MCP](https://cursor.com/help/customization/mcp.md)、[Gemini CLI MCP](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html)、[Codex MCP Servers](https://mintlify.wiki/openai/codex/configuration/mcp-servers)。

**结论**：本插件写出的 `mcpServers` 与 Claude/Cursor 主流写法同构（可直接互换），与 VS Code（`servers`）、Gemini（`httpUrl`/`url` 语义）存在方言差；对方的 `{version, servers}` 与**任何**生态工具都不兼容。

### C1 `sse` 条目的可执行报错

**问题**：`jsonEntryToInput`（`src/json-file.ts`）对 `type: "sse"` 直接返回 unsupported 并跳过该条目。存量配置里这种 **MCP SSE 端点传输**很常见（Cursor/Gemini/CC 都在用），但报错信息不足以自救。

**设计依据**：§1.5（传输实现跟随官方）与 §1.6（两个 SSE 的区分）。本条目**不是**"提前支持 SSE"，而是让 JSON 入口与 CLI 入口说同一句话——CLI 已有同口径文案（`dsh-mcp --transport sse` → "不支持 sse 传输：装载后端（dsh-mcp-client）只有 stdio 与 streamable-http"）。

**提案**：把报错改成可执行提示——指出该条目是 **MCP SSE 端点传输**、装载后端（`dsh-mcp-client`）只支持 `stdio | streamable-http`，并给出两条具体出路：①服务端已支持 Streamable HTTP 时把 `type` 改为 `"http"`；②删除 `type` 只留 `url`（本插件按 streamable-http 推断）。同时写入逐条诊断与 `dsh-mcp status` 输出。文案遵循 §1.6 的术语约定（写"MCP SSE 端点传输"，不单写 "SSE"）。**不新增隐式回退**（是否给显式 opt-in 见 §7-6）。

**涉及文件**：`src/model.ts`（A0 的传输常量）、`src/json-file.ts`（删除 `sse` 专属分支，改由 A0 统一常量与通用报错路径产生）、`docs/guide/format.md` / `.zh.md`。

**测试点**：`test/test-json-file.mjs`（`type:"sse"` 条目的错误文案包含两条出路；其余条目不受影响）。

**验收**：从 Cursor 迁来的含 SSE 条目配置，报错本身即可指导修复。

### C2 `httpUrl` 别名、显式 `transport` 键与 `url` 语义

**问题**：①Gemini 用 `httpUrl` 表示 Streamable HTTP，本插件不认；②JSON 方言只认 `type`，不认原生 yml 的 `transport`；③`url` 无 `type` 时本插件按 streamable-http 推断，而 Gemini 按 SSE 解释——同一份文件在两处语义相反，必须文档化。

**提案**：
- 接受 `httpUrl` → 显式 streamable-http；`url` 与 `httpUrl` 同时出现（且指向不同值）时报条目级错误。
- 接受 `transport` 键（取值同原生 yml：`stdio`/`streamable-http`；`sse` 见 C1）；与 `type` 同时给出且冲突时报错；`transport` 优先于 `type`（原生方言优先）。
- 文档（`docs/guide/format.md` / `.zh.md`）明确写：**`url` 无 `type`/`transport` 时本插件按 Streamable HTTP 解释，与 Gemini CLI 的 `url`=SSE 相反**；给出两侧互转写法。

**涉及文件**：`src/model.ts`（与 C1 共用 A0 的传输常量）、`src/json-file.ts`、`docs/guide/format.md` / `.zh.md`。

**测试点**：`test/test-json-file.mjs`（`httpUrl`、`transport` 与 `type` 冲突、`url`+`httpUrl` 冲突、`transport:"sse"` 与 C1 一致）。

**验收**：Gemini 用户把 `mcpServers` 段抄进 `.dsh/mcp.json` 后可直接装载（除 SSE 条目外）。

### C3 VS Code `.vscode/mcp.json` 只读兼容层（可选）

**问题**：VS Code 的 MCP 配置顶层键是 `servers`（非 `mcpServers`），本插件完全不读；团队里已维护 `.vscode/mcp.json` 的项目需要重写一份。

**提案**：新增**只读**来源 `vscode-project`，路径 `<projectRoot>/.vscode/mcp.json`，读取顶层 `servers` 映射。默认**关闭**（`DSH_MCP_READ_VSCODE_MCP=1` 开启），理由：`.vscode/` 常被当作编辑器配置目录，默认装载等于替用户启动他没打算给 dsh 用的进程；而 `.mcp.json` 本身就是 MCP 专用文件名，默认读取的正当性不同。此默认值列入 §7 待决。

**语义处理（必须显式对待，不可静默）**：

| VS Code 概念 | 处理 |
|---|---|
| `inputs[]` + `${input:...}` | 无法解析 → 该条目报错跳过（`input` 变量是 VS Code 交互界面的产物，本插件无 UI） |
| `${workspaceFolder}` | **预处理替换为项目根**。注意不能留给装载期 `${VAR}` 展开：`workspaceFolder` 匹配 `EMBEDDED_ENV_REF_RE`，会被当作未定义环境变量而 `env-missing` 跳过 |
| `sandbox` / `sandboxEnabled` | 忽略并告警一次（本插件不做进程沙箱，宿主权限模型不变） |
| `envFile` | 暂不支持 → 条目级告警（不静默）；若后续要做，读取后并入 `env` 再走既有 `${VAR}` 展开 |
| `dev` / `oauth` | 忽略并告警一次 |
| `type: "sse"` | 按 C1 处理 |

**层序位置**：建议置于遗留兼容层同级、低于 DSH 自有层：`dsh-project` > `dsh-project-json` > `cc-project` > **`vscode-project`** > `dsh-profile-user` > `dsh-user-yml` > `dsh-user`。

**涉及文件**：`src/json-file.ts`（新读取器 + `McpRowSource` 扩展）、`src/dsh-paths.ts`（路径常量）、`src/registry.ts`（层序、watcher 精确路径 +1、诊断归因、`isSameFilePath` 保护）、`src/model.ts`（`SOURCE_RANK` 若在此）、`docs/guide/layers.md` / `.zh.md`、`AGENTS.md`。

**测试点**：`test/test-json-file.mjs`（`servers` 键、`inputs` 报错、`${workspaceFolder}` 替换、忽略键告警）、`test/test-registry.mjs`（层序与影子去重、watcher 路径覆盖）。

**验收**：开启开关后，仅有 `.vscode/mcp.json` 的项目可直接装载；关闭时该文件零影响。

### C4 「非本插件格式」诊断与共存声明

**问题**：对方的项目文件与本插件同路径（`<root>/.dsh/mcp.json`）但格式不同，双方都静默忽略对方（本插件缺 `mcpServers` = 合法空层；对方 `servers` 非数组则保留内存态）。用户表现为"我配了但没生效"，且这是最难自行排查的一类。

**提案**：
- **检测 + 诊断**：读取 `.dsh/mcp.json` 时，若文件存在、缺 `mcpServers`、且顶层含 `servers` 数组（或含 `version` + `servers`），写一条诊断/告警：该文件疑似 `@wingsky-1/dsh-mcp-manager` 的存储格式（`{version, servers}`），本插件不读取；并给出建议（改用 `mcpServers` 方言，或改用 `.dsh/mcp.yml`）。全局 `~/.dsh/dsh-mcp.json` 同理提示。
- **共存声明**：README（中英）、`docs/guide/layers.md` / `.zh.md` 增加一节「与同类插件共存」，说明三点：①项目文件格式互不兼容；②同名服务器会被两个插件各启动一次（stdio 可能互相抢资源）；③建议同一项目只启用一个，或让两者分居 `mcp.yml`（本插件）与 `.dsh/mcp.json`（对方）。
- **已知限制**：本插件的 `globalNames()` 只读 loader patch 行，看不到对方运行时注册的工具，因此"改名避让"不会覆盖对方——该限制写进上述文档一节。

**涉及文件**：`src/json-file.ts` 或 `src/registry.ts`（检测）、`README.md` / `docs/README.zh.md`、`docs/guide/layers.md` / `.zh.md`。

**测试点**：`test/test-json-file.mjs` / `test/test-registry.mjs`（检测命中写诊断；`mcpServers` 与 `servers` 同时存在时不告警）。

**验收**：把对方的文件放进项目后，`dsh-mcp status` 与诊断明确指认格式来源，而不是静默无行。

## 5. 明确不学的清单（附理由）

| 对方机制 | 不学理由 |
|---|---|
| `middleware` off/project/all 模式矩阵 + 虚拟 `@global` root | 为自建代理层服务；本插件无代理层，引入只增概念 |
| `dsh-mcp-user-state.json`（用户态断开/工具禁用独立持久化） | 与"配置即文件、可提交 git"冲突；要停用就写 `disabled: true` 或 A4 的 `tools.deny` |
| 自建传输 + 自写 supervisor + `@modelcontextprotocol/sdk` 直连 | 会放弃官方 `list_changed`、连接代际串行化、附件通道与结果投影，且需自行追赶 MCP 规范演进 |
| catalog last-good 缓存（`<DSH_HOME>/dsh-mcp-catalog/<hash>.json`） | 只有代理层需要 |
| `{version:1, servers:[]}` 存储格式 | 会把 `.dsh/mcp.json` 变成真正的争抢点；保持 `mcpServers` 方言 + C4 的显式不兼容声明更安全 |
| 子进程环境净化、64 字符哈希工具名、图片附件投影 | **已通过官方 client 免费继承**，无需实现，只要不在自建路径破坏它们 |
| loopback 围栏、body 限长 | 仅在引入 HTTP 路由后才需要（本提案非目标） |

## 6. 优先级与版本切分建议

原建议拆 v0.4.4 / v0.5.0 / v0.6.0。因 B1 为语义变化，实际一次发布为 **v0.6.0**。
C3 本轮跳过。

**已落地（v0.6.0）**

0. A0 传输值域镜像常量（C1/C2 的前置）
1. C1 `sse` 可执行报错
2. C2 `httpUrl` / `transport` / `url` 语义文档化
3. C4 非本插件格式诊断 + 共存声明
4. A3 诊断摘要段 + `dsh-mcp status`
5. A5 `dsh-mcp import`
6. A1 连接健康巡检与自愈（含 A2a 分类判据）
7. A4 工具级 `allow`/`deny`
8. B2 工具预算护栏
9. B3 `ctx.provide` 服务面
10. A2b 触发点内指纹比对（无低频 timer）
11. B1 按需挂载（5 分钟宽限）

**本轮不做**

12. C3 VS Code 只读兼容层

每项完成后立即单独 commit（`docs:` / `feat:` / `fix:`），保持提交后项目可编译、测试通过（`pnpm test`）。

## 7. 待决问题清单（已裁决）

1. **A2b 兜底形态**：只做触发点内指纹比对（`mtimeMs+size`），**无低频 timer**。
2. **A4 键名与语法**：`tools.allow`/`tools.deny`，同时读取 `includeTools`/`excludeTools`；**完整 glob**（`*`、`**`、`?`、`[…]`）。
3. **A5 作用域**：允许 `--scope project|user|profile`；缺省 **project**（与 `add` 一致）。
4. **B1 卸载策略**：无会话且非进程 cwd 后 **5 分钟宽限**再卸载。
5. **B3 服务名与稳定性**：服务名 `projectMcp`；**不承诺稳定 API**。
6. **C1 opt-in**：**只报错**，无 `sseAsStreamableHttp`，无环境开关。
7. **C3 默认值与层序**：**本轮不做**（不读 `.vscode/mcp.json`）。
