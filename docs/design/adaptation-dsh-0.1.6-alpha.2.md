# 适配方案：dsh v0.1.6-alpha.2

[← 返回 README](../README.zh.md) ｜ 相关：[dsh 0.1.5-rc.2 适配记录](adaptation-dsh-0.1.5-rc2.md)

**状态**：设计决策记录。决策已按 dsh **0.2.0-rc.2** 落地，见
[v0.7.0 适配记录](adaptation-dsh-0.2.0-rc.2.md)。依赖下限是 `^0.2.0-rc.2`
（`0.2.0` 元组），不是本文当时写的 `^0.1.6-alpha.2`。**对比基线**：上游 `c291e7961a`
（`dsh-v0.1.5-rc.2` + 139 提交，即 v0.6.0 的适配基线）→ `dsh-v0.1.6-alpha.2`
（`ddefc45fbc`，区间 1548 提交）。**记录日期**：2026-09-14。
本文只定决策与理由，不含实施步骤；实施后按仓库惯例另写验证结论。

## 0. 结论一览

| # | 决策 | 一句话 |
|---|---|---|
| D1 | 依赖下限抬到 `^0.1.6-alpha.2`，v0.7.0 支持 dsh ≥ 0.1.6-alpha.2 | 0.1.5 用户停留在 v0.6.0（在 0.1.6 宿主上行为等价，无需回补） |
| D2 | 删除 `agent/session-start` 监听 | 该事件已从上游删除；其职责由 `agent/created`（新增 `source`）完整吸收 |
| D3 | 镜像新增可选字段 `maxInstructionBytes` | 现状会静默剥离用户配置，违背字段镜像原则 |
| D4 | 官方行为收紧只做文档与诊断交代，不改装载逻辑 | 均为 client 内部行为，与能力边界声明一致 |
| D5 | 重述定位：官方机制关系 + 三点留白 | README 能力边界章节改写 |
| D6 | 发 v0.7.0（minor），不等 0.1.6 正式版 | 范围 `^0.1.6-alpha.2` 已覆盖 0.1.6 元组后续全部版本 |
| D7 | 验证设计见 §3 各决策验证要点与 §4 | 单宿主矩阵 + resume 边回归 |

## 1. 上游变更与本插件的关系

### 1.1 `@deepseek-ai/dsh-mcp-client`（区间 15 个提交）

- **MCP SDK 整体更换**：`@modelcontextprotocol/sdk ^1.12.0` → `@modelcontextprotocol/client`
  精确 pin `2.0.0`；协议协商升级（自动选 2026-07-28 协议并回落），stdio 协商先起临时
  探测进程再起服务进程；tools/list 分页移交 SDK。
- **Config 纯新增、零删除**：两个 transport 分支各新增可选 `maxInstructionBytes`
  （int ≥ 1，默认 32768；`packages/mcp/mcp-client/src/index.ts:129,139`）。传输集合仍为
  `stdio | streamable-http`（无 sse）；`serverName` 正则、`command/args/env/cwd`、
  `url/headers`、`toolCallTimeoutMs`、`failOnStartupError`、`reconnect.*`（默认
  500/30000/10）与工具名 `mcp__<serverName>__<raw>` 全部未变。
- **行为收紧**：legacy `toolResult` 归一化删除（非规范 tools/call 结果直接抛错）；
  服务器 instructions 超 `maxInstructionBytes` 拒绝该次连接。
- **行为修复**：无 tools capability 的资源型服务器从"连接失败进重连"变为"空工具集
  保持连接"。
- **新能力**：新文件 `server-context.ts` 经可选注入（`mcpResources`、`systemPrompt`）
  为每个实例注册 MCP resources provider 与 `mcp:<serverName>` 系统提示节；新导出
  `createMcpToolDefinition`；新增可选 peer `dsh-mcp-resources`、`dsh-system-prompt`；
  `zod` 移入 devDependencies。
- **不变**：命名导出函数插件形态（`name`/`inject = ['tools']`/`Config`/`apply`）；
  serverName 预留按 `scopeOf(ctx)` 作用域（两版相同）；重连策略本体（退避、共享
  预算、串行 sync 队列）未变。

### 1.2 mcp-resources 与 profile 装配

新包 `@deepseek-ai/dsh-mcp-resources` 进入 base bundle（
`packages/bundle/base/cordis.patch.yml:478`），所有 shipped profile 默认装载：三个共享
工具 `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`。它是
纯消费端，不做任何配置装载；**第三方编程式挂载的 client 实例自动获得资源工具与
提示节**（官方范例即 `packages/experimental/browser-use-runtime/src/mcp.ts`）。
**mcp-client 本身仍是 opt-in**（`apps/cli/tests/profile-mcp.spec.ts` 断言所有 shipped
profile 中 mcp-client 行数为 0）。装配生态其余变化：官方 `plugin_manager` 工具 +
"configuration-only bundle" 模式（官方 skill 教模型自助连 MCP）；HMR 配置热重载默认
开启；`dsh plugin` CLI 与 bundle patch 合成机制不变。

### 1.3 宿主核心事件面

**`agent/session-start` 事件被删除**（旧 `packages/core/agent/src/runtime-types.ts:316`
→ 新版无此声明），职责并入 `agent/created`：payload 变为
`{ agent, source: 'startup'|'resume'|'clear'|'compact', signal? }`，经 `ctx.serial`
串行派发（`packages/core/agent/src/index.ts:533-553`），每个 agent 条目 announce 一次。
`agent/disposed` 保留不变。cordis `ctx.on` 不校验事件名
（`vendor/cordis/src/events.ts:288`）——对已删除事件的监听**不抛错、静默永不触发**。
`tools.restrict` / `tools.schemas` 签名不变；插件入口 `inject = ["tools","agents"]`
所依赖的服务面不变。

### 1.4 与本插件无关（知悉即可）

`packages/experimental` 下的 browser-use/computer-use MCP 驱动为实验性浏览器/电脑
使用 provider，只消费 mcp-client，与项目级装载无关。`docs/user/guide/mcp-memory.md`
代表的官方推荐配置方式（`$DSH_HOME` 层 cordis.patch.yml / `--patch` overlay）不含
项目级发现。

## 2. 兼容性矩阵

| 插件依赖点 | 0.1.6-alpha.2 现状 | 结论 |
|---|---|---|
| `ctx.plugin(mcpClient, config)` 挂载路径与 `apply` 签名 | 未变 | 兼容 |
| `toOfficialConfig()` 生成的全部字段 | Config 纯新增，旧字段全保留 | 兼容 |
| 传输集合 `stdio \| streamable-http`、别名与报错文案派生 | 未变 | 兼容，注释中的版本号表述需更新 |
| `MAX_TIMER_DELAY_MS` / reconnect 上限镜像 | 官方 `resolveReconnectPolicy` 未变 | 兼容 |
| serverName 正则与 `mcp__<名>__<工具>` 前缀 | 未变 | 兼容（effectiveName 策略不动） |
| `tools.restrict({deny})` 精确名展开 / `tools.schemas()` | 签名未变 | 兼容 |
| `agent/created` / `agent/disposed` 监听（解构 `{ agent }`） | payload 新增字段，serial 派发 | 兼容（见 D2） |
| `agent/session-start` 监听（`src/registry.ts:796`） | **事件已删除，监听静默失效** | 需处理（D2） |
| 依赖范围 `^0.1.5-rc.1` 解析 `0.1.6-alpha.2` | **不可解析**（semver 预发布规则） | 需处理（D1） |
| 用户在配置行写 `maxInstructionBytes` | 官方支持，但本插件 schema 会剥离 | 需处理（D3） |
| zod 直接依赖 | 官方移入 devDeps 不影响本插件（自声明 `zod@^4`） | 兼容 |
| `dsh plugin` CLI 安装入口 / bundle patch 挂载 | 不变 | 兼容 |

## 3. 设计决策

### D1 支持矩阵与依赖范围：抬下限 `^0.1.6-alpha.2`

**问题**。semver 预发布规则下，`^0.1.5-rc.1` 只能解析 `0.1.5` 元组的预发布与正式版，
解析不到 `0.1.6-alpha.*`（与 0.1.2 → 0.1.5 时"必须改范围"是同一局面，见
[rc.2 记录 §2](adaptation-dsh-0.1.5-rc2.md)）。若不改：0.1.6 宿主 profile 内安装本
插件会产生嵌套的 0.1.5-rc.2 副本——旧协议协商、旧行为，且**拿不到 mcp-resources
协同**（server-context 注册只存在于新代码）；双副本还意味着两份模块级
`activeServerNames` WeakMap，serverName 预留彼此不可见。

**决策**。依赖范围抬到 `^0.1.6-alpha.2`；v0.7.0 的支持矩阵定为 **dsh ≥
0.1.6-alpha.2**；0.1.5 宿主用户继续使用 v0.6.0（npm 两个版本并存，安装文档已按需
指定版本）。

**理由**。

1. **宿主副本一致性是挂载路径的正确性前提**。本插件经
   `ctx.plugin(mcpClient, config)` 装载（`src/registry.ts:1762`），必须与宿主共享同一
   份 client 实现；嵌套副本的模块级状态（serverName 预留、SDK Client 类）会与宿主
   副本分叉。抬下限后 0.1.6 宿主内 range 直接命中宿主已解析版本，唯一副本。
2. **与 0.1.2 → 0.1.5 的既定先例一致**（当时直接抬下限 `^0.1.5-rc.1`），仓库已有
   心智模型与文档表述。
3. **`^0.1.6-alpha.2` 覆盖 0.1.6 元组后续全部版本**（alpha 后续、rc、正式版均可
   解析），0.1.6 周期内不再需要动范围；0.1.7 出现时按惯例重新评估。
4. **否决 OR 范围**（`^0.1.5-rc.1 || ^0.1.6-alpha.2`）：解析器对 OR 范围独立选版时
   取满足范围的最高版本，0.1.5 宿主内反而嵌套 0.1.6 副本，"双向复用"依赖解析器
   实现细节而不可依赖；且双宿主测试矩阵翻倍，收益仅剩"0.1.5 用户装新版插件"——
   该人群升级插件却没有升级宿主的动机本来就弱。
5. **否决维持现状**：嵌套旧副本在目标宿主（0.1.6）上丢失本版本最重要的协同收益
   （mcp-resources 自动作用于插件挂载的 server），等于适配目的落空。

**后果**。v0.7.0 起README 安装示例的版本说明需注明支持矩阵；0.1.5 用户是稳定人群，
v0.6.0 在 0.1.6 宿主上的行为等价性论证见 D2，不构成回补义务。

### D2 事件面：删除 `agent/session-start`，收敛到 `agent/created`

**事实**。上游删除了该事件；本插件在 `src/registry.ts:796` 的监听在新宿主上是
**静默死代码**（cordis 不校验事件名，不抛错、永不触发）。新 `agent/created` 的
payload 携带 `source: 'startup'|'resume'|'clear'|'compact'`，经 `ctx.serial` 串行
派发、每个 agent 条目 announce 一次——即原 `agent/session-start`（含恢复/重挂场景
补扫）的职责被完整吸收。

**决策**。删除该监听，不新增替代注册；现有 `agent/created` 监听
（`src/registry.ts:781`：`resolveProject` + `reconcileAll`，同步 enqueue）保持原样，
不改为 await。需要区分边类型的将来需求由 `payload.source` 满足，当前不需要。

**理由**。

1. 并集保留（两个事件都注册）只在"同时支持新旧宿主"时才有意义；D1 已把支持矩阵
   抬到 0.1.6+，新宿主上 `created(source)` 覆盖全部四条边，死监听没有存在理由。
2. 监听保持同步 enqueue、不阻塞 serial 派发：装载是尽力而为的 reconcile，不应
   阻塞 agent 激活时序——与旧版行为一致，新版 serial 语义下这一点反而更值得守住。
3. v0.6.0 在 0.1.6 宿主上的行为等价性：session-start 监听变死代码，但其补扫职责
   由 `created(source=resume|…)` 覆盖，`agent/disposed` 与构造时 `liveAgents()` 补扫
   不变——**旧版插件在新宿主上无行为回归**，这支持 D1 的"0.1.5 用户停留 v0.6.0"
   并降低本次适配的紧迫性。

**验证要点**。resume / clear / compact 三条边各触发一次 reconcile（对应旧
session-start 的全部职责面）；插件先于 agent 加载、晚于 agent 加载（热更）两个
时序的补扫不回归。

### D3 新配置字段 `maxInstructionBytes` 的镜像透传

**事实**。官方 Config 新增可选 `maxInstructionBytes`（int ≥ 1，默认 32768）；
超限的处置是**拒绝该次连接**——这是一个用户可调的失败模式。本插件的
`mcpServerInputSchema` 无此字段，zod 默认 strip：用户在 `.dsh/mcp.yml` / JSON 方言
里写了会被**静默剥离**，永远落回官方默认，且用户无从自救。

**决策**。按既有的字段镜像原则（与 `MAX_TIMER_DELAY_MS`、`SUPPORTED_MCP_TRANSPORTS`
同性质，见 AGENTS.md「关键行为约定」）透传三处：

1. `mcpServerInputSchema`（`src/model.ts`）加可选 `maxInstructionBytes`
   （`z.number().int().min(1).optional()`）——只镜像官方存在的边界（int ≥ 1），
   不发明官方没有的上界；
2. `toOfficialConfig()` 有值时写入该键，缺省不写键（让官方默认生效，不复制
   默认值——默认值属于官方，复制会漂移）；
3. JSON 方言白名单 `jsonServerEntrySchema` + `passthroughKeys()`
   （`src/json-file.ts:132-156`）加同名键。

**CLI 不加参数**。理由：`dsh-mcp` CLI 面板输入项面向最常用路径，instructions 字节
调优是高级场景，写配置文件即可；保持 CLI 表面积稳定（与 `reconnect` 子字段不进
CLI 同一口径）。

**文档**。`docs/guide/format*.md` 字段表补一行：语义（含归属头的服务器 instructions
字节上限）、默认 32768、超限行为（该服务器连接失败，进官方重连；本插件健康巡检
按既有 0 工具退避逻辑处理，连续失败满 3 次 `give-up`）。

### D4 官方行为收紧：只做文档与诊断交代，不改装载逻辑

三条收紧均为 client 内部行为，本插件不拦截、不包装（与 README「能力边界：
传输类型由官方 client 决定」同一分工）：

1. **legacy `toolResult` 服务器**（旧版容忍、新版每次调用抛 invalid MCP result）：
   文档 FAQ 加一条——升级 0.1.6 后某服务器调用开始报错是服务器端返回非规范结果，
   修复方向在服务器侧（返回规范 content 数组）；本插件的 `plugin-throw` /
   健康巡检诊断口径不变（调用期错误不经过插件）。
2. **instructions 超限拒绝连接**：连接失败走官方重连 → 本插件健康巡检（fiber 世代
   0 工具退避）→ remount 循环 → `give-up`，既有链路自然覆盖；D3 落地后用户可通过
   调大 `maxInstructionBytes` 自救，文档与该字段说明合并交代。
3. **stdio 协商探测进程**：启动期子进程数与日志文案变化（官方日志新增
   "transport closure could not be confirmed…" 等）；本插件无进程数断言，仅文档
   提示一句，避免用户误判为插件行为。

### D5 定位重述：官方机制的关系与三点留白

**官方已覆盖**（v0.7.0 文档需要承认，避免用户误判被取代）：全局/每 profile 声明
（`$DSH_HOME` 层 `cordis.patch.yml`）、配置热重载（官方 HMR 默认开，作用于
**profile 配置层**）、运行时装载（`plugin_manager` + configuration-only bundle，官方
skill 教模型自助）、协议/重连/分页/instructions/resources 全部收进官方
mcp-client + mcp-resources。

**本插件的三点留白**（README「能力边界」章节改写方向）：

1. **项目级配置发现**：`<projectRoot>/.dsh/mcp.yml|json`（含只读遗留 `.mcp.json`）
   ——团队可版本化共享的 per-repo 配置；官方配置全部锚在 `$DSH_HOME` profile 层。
2. **按会话 cwd 隔离工具可见性**：官方有 scope 机制但无 cwd→配置/scope 的自动映射。
3. **MCP 专用友好格式 + `dsh-mcp` CLI**：官方要求用户写 Cordis patch 语法（insert
   包装、`!!js`），对普通用户门槛高；官方无 MCP 专用 CLI。

**热重载叙述边界**：项目文件热重载（本插件 chokidar，监视对象不在官方 HMR 的
profile 配置面内，机制不冲突）vs profile 配置热重载（官方 HMR）——文档明确两者
分工，不再笼统说"热重载"。

**协同收益**：升级依赖后（D1），本插件挂载的每个 server 自动获得三个资源工具与
`mcp:<serverName>` 提示节（mcp-resources 已默认在所有 profile）——README 定位章节
作为"与官方机制互补"的例证写入。本插件继续不碰协议层与 resources 粘合。

### D6 版本与发布策略：v0.7.0，不等 0.1.6 正式版

**决策**。以 v0.7.0（minor）发布本次适配；`package.json` 与 `CHANGELOG.md` 同步
（仓库既定规则）。

**理由**。范围抬升（D1）与新字段透传（D3）是行为面变化，不是 bug 修复，minor
合适；0.6.x 打补丁号会造成"同版本号不同依赖范围"的混乱。alpha dist-tag 已在 npm
发布，alpha 宿主用户现在就能撞上嵌套副本问题，没有理由压着不发。上游 API 是
pre-stable（官方 AGENTS 明示），alpha → rc 之间 Config/事件面可能再变：本方案的
决策框架（§3）按增量核对即可复用，`^0.1.6-alpha.2` 范围已覆盖 0.1.6 元组后续
版本，官方再动 Config 字段时按 D3 的镜像流程处理，不需要等正式版再一次性做大改。

### D7 验证设计（不含步骤）

- **单宿主矩阵**：dsh 0.1.6-alpha.2（支持矩阵抬升后不再跑 0.1.5 矩阵）；`test/`
  六套全量 + 手工场景。
- **resume/clear/compact 边回归**：D2 的职责迁移验证；含插件先于/晚于 agent 加载
  两个时序。
- **`maxInstructionBytes` 端到端**：yml 行与 JSON 行各写一个显式值 → 装载 → 断言
  client 收到该键；缺省行断言键不出现（官方默认生效）。
- **副本唯一性**：0.1.6 宿主 profile 内安装 v0.7.0 后，
  `pnpm why @deepseek-ai/dsh-mcp-client` 应只有宿主一份。
- **mcp-resources 协同烟测**：挂载一个带 instructions 的 fixture server，确认
  `mcp:<serverName>` 提示节与资源工具出现（验证 D1 副本一致性带来的协同生效）。

## 4. 风险与开放问题

1. **pre-stable API**：本方案按 0.1.6-alpha.2 快照决策；0.1.6-rc / 正式发布时官方
   Config、事件面、peer 集合仍可能变动，按 §3 框架增量核对（重点：Config 字段、
   `agent/created` payload、mcp-client peer 清单）。
2. **战略风险**：官方方向是"一切皆 Cordis 组合 + plugin_manager 自服务"。若上游
   未来补项目级配置发现（本插件留白一），核心价值被替代；D5 的三点留白是当前的
   差异化底线，README 定位随官方演进持续校准。
3. **嵌套副本的实际解析行为未实测**（0.1.5 宿主安装 v0.7.0 的边缘场景）：已通过
   支持矩阵声明规避（该组合不在支持范围），README 版本说明写清即可，不做兼容
   测试投入。
4. **官方新增可选 peer 的传递影响**：mcp-client 新增 `dsh-mcp-resources` /
   `dsh-system-prompt` 可选 peer，宿主 profile 内两者默认在装载（前者进 base
   bundle），无需本插件干预；若用户在极简 profile（sdk-minimal 之外的自定义组合）
  中缺装，server-context 静默不注册属官方设计，不构成本插件的问题面。
