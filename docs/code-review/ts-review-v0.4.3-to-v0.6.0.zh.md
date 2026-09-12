# 代码审查：v0.4.3 至 v0.6.0 的 TypeScript 变更

[← 返回 README](../README.zh.md) ｜ 相关：[v0.6.0 发布说明](../releases/v0.6.0.md) ·
[运行时稳健性与 JSON 互通提案](../design/proposal-runtime-robustness-and-json-interop.md) ·
[上一轮审查（v0.3.1 以来，已在 v0.4.1 落地）](ts-review-since-v0.3.1.zh.md)

**审查日期**：2026-09-12 ｜ **区间**：`v0.4.3..HEAD`（HEAD = `8996af1`，分支
`feat/runtime-robustness-and-json-interop`；尚未打 `v0.6.0` tag，内容即发布说明所述的
v0.6.0）
**范围**：`src/*.ts` 全部修改——9 文件 `+1213 / −104`（新增 `src/service.ts`），即提案
A0/A1/A2b/A3/A4/A5/B1/B2/B3/C1/C2/C4（C3 本轮不做）。`src/mcp-file.ts` /
`src/project-root.ts` 本区间无改动。
**方法**：通读全量 diff 与当前代码，对照提案验收点与 `test/*.mjs` 覆盖；行号以审查时
HEAD 为准。上一轮 H1–H4 / M1–M10 已在 v0.4.1 关闭，本文只报本区间新引入或被本轮放大的问题。

---

## 1. 变更概览

| 文件 | 变更 | 内容 |
|---|---|---|
| `src/model.ts` | +207 | `SUPPORTED_MCP_TRANSPORTS` 镜像常量、别名/报错派生、`globToRegExp` / `deniedToolsForFilter`、schema 增收 `tools` |
| `src/json-file.ts` | +115 | `httpUrl` / `transport`、SSE 可执行报错、对方 `{version,servers}` 检测、JSON 工具过滤键 |
| `src/json-write.ts` | +15 | `toJsonEntry` 写 `type`（由常量派生）与 `tools` |
| `src/cli.ts` | +337 | `status`、`import --from`、`--dry-run` / `--overwrite`、传输解析改走 `parseCliTransport` |
| `src/registry.ts` | +541 | 指纹跳过重读、健康重挂、按需挂载+5 分钟宽限、工具过滤 deny、预算巡检、诊断 `summary` |
| `src/status.ts` | +52 | `mcpToolBudgetStats`、`parseToolBudgetWarn`；`mcpToolCount` 改走预算统计 |
| `src/service.ts` | 新增 34 | `ctx.provide("projectMcp", …)` 查询面（不承诺稳定 API） |
| `src/index.ts` | +9 | `apply` 里 `provide`；导出服务符号 |
| `src/dsh-paths.ts` | +7 | `foreignUserMcpJsonFile` |

功能 commit 顺序与提案落地清单一致：A0 → C1 → C2 → C4 → A3 → A5 → A1/A2b → A4 → B2 → B3 → B1。

---

## 2. 总体评价

方向正确、按提案拆 commit 的一轮大改，可维护性明显好于把 A/B/C 揉进单 commit。值得肯定的点：

- **传输值域真正收敛**（`SUPPORTED_MCP_TRANSPORTS` + `MCP_TRANSPORT_ALIASES` +
  `unsupportedTransportMessage`）：JSON `type`/`transport`、CLI `--transport`、yml
  `inputFromPatchRow` 走同一句话；`sse` 文案区分了「MCP SSE 端点传输」，与提案 §1.6 一致；
- **`toOfficialConfig` 剥掉 `tools`**（model.ts:481–503，测试有断言），过滤只发生在
  `tools.restrict` 管道，不把本插件的策略键传给官方 client；
- **按需挂载的命名口径正确**：扫描与 `effectiveServerNames` 仍按全量目录，挂载集才按
  会话∪cwd 裁——改名不依赖谁先挂上；宽限用注入时钟、测试覆盖了「宽限内保留 / 到期卸载 /
  cwd 保活 / 会话回来再挂」；
- **v0.4.1 的告警门控 / 压制守卫 / 锁内 yml 写**在本轮新路径上大体被沿用（`warnGated`、
  `globalMountable`、`updateManagedRows`）；
- **C4 检测条件谨慎**：`mcpServers` 一旦存在即不告警，避免双插件字段并存时误伤本方言。

以下发现按严重度排列：**高**＝可在现实使用中触发错误行为或把用户可观测状态说错；
**中**＝一致性/竞态/健壮性；**低**＝可维护性与清理项。

---

## 3. 发现清单

| # | 级别 | 位置 | 一句话 |
|---|---|---|---|
| H1 | 高 | registry.ts:1646-1702、1983-1986 | 健康自愈把 `everHadTools` 跨 fiber 沿用：官方还在内部重连时会被拆掉，3 次后 `give-up`；`snapshot()` 轮询放大 |
| H2 | 高 | registry.ts:1407-1414、1465-1522 | 诊断摘要跟不上新状态机：宽限卸载后 `rows=0` 且 skipReasons 被剪光；`give-up` 仍算已装载、不进 `unhealthy` |
| M1 | 中 | registry.ts:1153-1201、924-937 | 指纹跳过重读时 `activeProfileName` / `suppressedGlobals` 不随 env 或宿主 patch 集刷新 |
| M2 | 中 | cli.ts:854-880 | `import` 的同名 skip 在锁外判定，并发两次导入可绕过「默认跳过」 |
| M3 | 中 | registry.ts:253-285、1757-1775 | 改 `tools.allow`/`deny` 走连接级 unmount/mount，本可只重扫 restrict |
| M4 | 中 | registry.ts:1705-1717 | 预算告警门控在回落到阈值下时不清理，同数量再超不告警 |
| M5 | 中 | cli.ts:578-595、model.ts:525-596 | `get` / `list` / `patchRowToView` / 快照都不展示条目级工具过滤 |
| M6 | 中 | registry.ts:1442-1462 | `writeDiagAt` 无锁读-改-写：event 与 summary 交叉会丢其中一方 |
| M7 | 中 | json-file.ts:192-209 | 无 `type` 时同时给 `command`+`url` 静默丢 `url`、按 stdio 装载 |
| M8 | 中 | registry.ts:994-1027、967-975 | 不监听 `$DSH_HOME/dsh-mcp.json`，对方文件出现要等下一次无关对账才诊断 |
| L1-L12 | 低 | 见 §6 | 原型链别名查找、模块注释过时、查询面类型、CLI 缺口等 |

---

## 4. 高优先级发现（详细）

### H1 健康自愈跨 fiber 误杀：官方还在重连就被拆掉，直至 give-up

**位置**：`registry.ts:1646-1702`（`healthOf` / `remountUnhealthyIn`）、`registry.ts:1630-1640`
（`unmountServer` 不重置 health）、`registry.ts:1983-1986`（`snapshot()` 先跑
`reconcileAll`）、`src/service.ts:1-6,13-18`（把该查询面标成「只读」并经 B3 公开）。

**官方 client 的真实时序**（`@deepseek-ai/dsh-mcp-client` 0.1.5-rc.1 `apply`）：

- `apply` 只等**第一轮** `connectGeneration`；`failOnStartupError` 缺省 `false` 时，
  首连失败也 settle 成功，随后在内部按 `reconnect.maxAttempts`（缺省 10）退避重连；
- 官方耗尽 `maxAttempts` 后注销工具并停止重连——这正是 A1 要靠 unmount/mount 救的场景；
- `tools/list_changed` 换代是「先 dispose 上一轮、再 register 下一轮」，中间有一个
  **0 工具窗口**。

**本插件的判据**（registry.ts:1678-1701）：

```
tools > 0  → everHadTools=true，清 remountCount
否则，若 everHadTools && phase==="active" && !givenUp && 过了退避 → unmount+mount
```

`healthByMount` 按 `containerKey\0rawName` 存，**跨 fiber 世代存活**。因此：

1. 某行曾经列出过工具（`everHadTools=true`）；
2. 官方放弃或连接断开 → 工具清零 → 本插件重挂（这一步符合 A1）；
3. **新实例首连失败**（npx 冷启动、瞬时网络）：官方 fiber 已 active，内部还在重连，
   工具仍为 0，但 `everHadTools` 仍是上一代的 `true`；
4. `HEALTH_REMOUNT_BACKOFF_MS` 缺省 5 秒后下一次 `reconcileAll` 再拆——官方 10 次
   内部重连被打断；
5. 连做 3 次后 `give-up`，新连接也停。用户感知与「官方放弃后本插件救活」正好相反。

首次装载被 `everHadTools===false` 保护，测试 23（从未有过工具不重挂）是绿的；测试 22
的 fake fiber 在 microtask 内 settle、且用 `healthRemountBackoffMs: 0`，**覆盖不到**
「重挂后官方仍在内部重连」这条路径。

**放大**：`snapshot()` 每次先 `reconcileAll`（v0.3.1 即如此），B3 却把服务面写成
「只读查询」。宿主 UI / 其它插件若轮询 `ctx.projectMcp.snapshot()`，等于用查询在驱动
健康状态机与宽限卸载。`globalState()` / `serverView()` 才是无副作用的。

**修复建议**（最小、且与官方生命周期对齐）：

`everHadTools` 改为**当前 fiber 世代**的标志，unmount 时删掉该 key（或给 state 一个
generation，重挂后清零）：

```ts
private async unmountServer(container: MountContainer, rawName: string) {
  this.healthByMount.delete(this.healthKey(container.key, rawName));
  // ...现有 dispose
}
```

这样「这一代曾经列出过工具、后来变成 0」才重挂——对应官方耗尽 maxAttempts 的场景；
新一代首连失败交给官方内部重连，本插件不再抢跑。`give-up` 仍按「本 rawName 连续
N 次世代都是：settle 后曾经有工具、又掉到 0」计数。

配套：`snapshot()` 改为只读内存态（与 `serverView` 同口径），全量对账只走已经公开的
`reload()`。若必须保留「查之前先收敛」，至少不要在文档/服务注释里写「只读」。

**建议测试**：fake client 模拟「首连失败、2 秒后才注册工具」→ 重挂后 5 秒内的
`reconcileNow` **不得**再 unmount；`snapshot()` 连续调用不得增加 `ctx.mounts`。

---

### H2 诊断摘要跟不上新状态机：idle 卸载后像零配置，give-up 像健康

**位置**：`summarizeScope`（registry.ts:1465-1492）、`writeSummaries`
（1495-1522）、`reconcileContainer` 对 skipReasons 的剪枝（1407-1414）、
`cmdStatus`（cli.ts:934-952）只是把这份 summary 打印出来。

A3 的验收是：`dsh-mcp status` 能一行定位「为什么没生效」。本轮 B1/A1 改了装载生命周期，
摘要口径还按 v0.4.x 的「`servers` Map + skipReasons = 全部行」。

**现象一（宽限卸载）**：项目仍有配置行，5 分钟无会话且不是 cwd 后
`keepMounts=false` → `desired=[]` → skipReasons 按「不在 desired 里」剪光 →
`servers.size===0` → `summary.rows===0, mounted===0`。若 `.mcp-diag.json` 已存在，
仍会**用这份空摘要覆盖**（1498-1507）。`status` 于是出现：

```
project (.dsh/mcp.yml)  3 行  [fs, gh, browser]
诊断 …/.mcp-diag.json
  行 0，已装载 0
```

文件层说有行，摘要说没行；此前的 `env-missing` / `env-invalid` 也一起消失。对账事件
还在 `events` 里，但 `status` 主路径读的是 `summary`。

**现象二（give-up）**：自愈放弃后实例仍在 `servers` 里、`phase==="active"`、
不在 skipReasons。`summarizeScope` 只把 `failed` 和 skipReasons 算进 `unhealthy`。
结果：`行 N，已装载 N`，**不健康列表为空**，而工具数是 0 且不会再自愈。快照同样是
`fiberPhase: "active"`、`skipReason: null`。

**修复建议**：

- 行数以 `lastScanDesired`（或本轮 `entry.rows`）为准，不要用当前装载 Map；
- 因 B1 卸下的行写 `skipReason: "idle"`（或 `unmounted-idle`），宽限内仍算 mounted；
- `health.givenUp` 的行进 `unhealthy`，reason=`give-up`，快照 `skipReason` 同步；
- `writeSummaries` 在「有配置行但当前未挂」时仍写摘要，避免把有信息量的 skip 覆盖成 0。

**建议测试**：① 有 `env-missing` 的项目过了宽限 → summary.rows 仍为配置行数，且带
`idle`；② give-up 后 summary.unhealthy 含该名，`dsh-mcp status` 能打印出来。

---

## 5. 中优先级发现

### M1 指纹跳过重读时，非文件输入过期

`shouldSkipConfigReread`（registry.ts:1153-1162）在 `configEpoch` 未变且
mtime+size 全同时跳过 `readUserLayer` / `scanProject`。指纹串含
`profile=${activeProfileName}`（1137-1144），但 `activeProfileName` 只在
`readUserLayer` → `resolveActiveProfileName` 里刷新（924-941）。跳过重读时用的是
**上一轮缓存的名字**，运行中改 `DSH_MCP_PROFILE` 再 `reload()` / `snapshot()` 不会换
profile 层。

同理 `scanProject` 才写入 `suppressedGlobals`（1262-1263）。跳过时宿主
`globalNames()` 仍每轮现取（1182），全局 name-taken 会卸载，但项目侧压制集是旧的：
宿主释放某名字后，该项目会话可能暂时同时看见全局实例和项目实例。
`sweepRestrictions` 的 `globalServers.has` 守卫能挡住「压制一个不存在的全局名」
（H1 of v0.4.1），挡不住「该压制却没写进集合」。

`DSH_MCP_IGNORE_MCP_JSON` 已编进指纹（1143），这项是对的。

**建议**：指纹加入「当前 `resolveActiveProfileName()` + `hostGlobalNames` 排序签名」；
或跳过文件重读时仍用缓存行跑一遍 `suppressedGlobals` / profile 解析（不读盘、只重算）。

### M2 `import` 同名 skip 在锁外判定

`cmdImport`（cli.ts:854-867）先 `existingNames`（yml 路径甚至再读一次无锁文件），
再决定 skip/overwrite，最后 `writeImportedRows` 才进 `updateJsonServers` /
`updateManagedRows`。锁内 mutate **不再检查**「无 `--overwrite` 则勿覆盖」：

```ts
await updateJsonServers(target.path, (servers) => {
  for (const item of incoming) servers[item.name] = jsonEntryFromRow(item.row);
});
```

两个并发 `import` 同一新名、都无 `--overwrite`：双方都看到「不存在」→ 后写覆盖先写。
`add` 已在 v0.4.1 把判重放进锁内 mutate（cli.ts:496-508），import 应对齐。

### M3 改工具过滤会拆掉 MCP 连接

`planProjectChanges` 用 `canonicalConfig` 比较整份 `row.config`。`tools` 进了
config（`toPatchRow`），所以只改 `allow`/`deny` 也会 toUnmount+toMount。过滤实际只在
`sweepRestrictions` → `deniedToolsForFilter` 消费，不必重连。stdio 子进程被打死再拉
起，对「只想少暴露两个工具」过重。

**建议**：`canonicalConfig` 比较时忽略 `tools`（或 mount 后把 `state.row` 就地换成
desired，再 `kickSweep`）。身份/命令/url 变化仍走现有重挂。

### M4 预算告警门控只升不降

`inspectToolBudgets`（1715-1717）仅在**超阈值**时 `warnGated`；回到阈值下不会用空签名
清门控。于是：超了（告警一次）→ 掉回阈值下 → 再以**相同** tools/bytes 超标 → 静默。
数量变化才会再叫（签名含 `${stats.tools}\0${stats.bytes}`）。

**建议**：未超标时 `warnGated("budget\0"+name, "", () => {})`，与 `warnFileIssues`
空签名清门控同一套。

### M5 条目级 `tools.*` 在只读面上隐形

A4 是用户可配策略，但：

- `patchRowToView`（model.ts:567-596）没有 `tools` 字段；
- `printServerDetails` / `list` 不打印 allow/deny；
- B3 的 `serverView` / `snapshot` 同样看不到。

排障只能打开源文件。JSON `includeTools`/`excludeTools` 归一成 `tools` 之后更看不出
原键。

**建议**：view 增加脱敏的 `tools?: { allow?: string[]; deny?: string[] }`；`get` 打两行。

### M6 诊断文件读-改-写无锁

`writeDiagAt`（1442-1462）读盘 → 改 `events`/`summary` → tmp+rename，与配置文件的
`withPatchLock` 不同。`fiber.then` 入队写 `kind:active` 事件，可与 `writeSummaries`
交叉：后写的一方用过期文档覆盖，**丢掉对方刚写的 summary 或最后一条 event**。
A3 把 summary 变成 `status` 主数据后，这场竞态从「偶发丢日志」变成「status 撒谎」。

**建议**：与 mcp-file 共用一把按路径的锁；或 event 写入时若本轮没有新 summary 则保留
文件里已有的 `summary`（现已保留，但 TOCTOU 仍在）。

### M7 无声明时 `command`+`url` 并存：静默丢 URL

`jsonEntryToInput`（192-209）：`inferredHttp` 要求 `command === undefined`；`wantHttp`
还看 `declared.transport` / `httpUrl`。手写

```json
{ "command": "npx", "args": ["-y", "foo"], "url": "https://example/mcp" }
```

没有 `type`/`transport`/`httpUrl` 时走 stdio，**url 被丢掉且不报错**。本轮重写了该函数
（C2），应顺手变成条目级错误（「同时有 command 与 url，请显式写 type/transport」），
与 `url`/`httpUrl` 冲突、`transport`/`type` 冲突同一风格。

### M8 对方全局文件没有 watcher

`readUserLayer` 会读 `$DSH_HOME/dsh-mcp.json` 并写 `foreign-format`（967-975），指纹也
含该路径，但 `syncUserWatcher` 只盯用户层三文件（994-996）。单独创建/改写
`dsh-mcp.json` **不会 kick**。要等会话/项目文件/显式 `reload` 才诊断。C4 的「配了但不
生效」场景，用户往往只动了对方的文件。

**建议**：把 `foreignUserMcpJsonFile(...)` 加入 `syncUserWatcher` 的 targets（仍不装载
内容，只为了触发对账与诊断）。

---

## 6. 低优先级 / 清理项

- **L1 `MCP_TRANSPORT_ALIASES` 是普通对象**（model.ts:185-189）：
  `resolveMcpTransport(raw)` 用 `MCP_TRANSPORT_ALIASES[raw]`，`toString` /
  `constructor` 会命中原型方法，报错从「不支持该传输」变成后续 schema 胡话。改
  `Object.create(null)` 或 `Map`，查找用 `Object.hasOwn`。
- **L2 `schemaToolId` 优先 `id`**（status.ts:20-22）：官方 `tools.schemas()` 返回的
  `ToolSchema` 只有 `name` / `description` / `parameters`（无 `id`）。现网靠
  `name` fallback 才计数正确；测试 fake 却只填 `id`，真实路径没覆盖。预算字节用
  `inputSchema ?? parameters`，官方字段是 `parameters`，这条是对的。
- **L3 `globToRegExp` 非法字符类**：`[z-a]`、未闭合的复杂类会抛错，被
  `matchToolGlob` 吃掉返回 `false`——用户以为 deny 生效，实际从未命中。可在编译失败时
  记一条 entry 级警告。
- **L4 `patternHitsTool` 用 `pattern.includes("mcp__")` 切换全名/短名**
  （model.ts:114-116）：项目行一旦改名，配置里写死的 `mcp__原名__foo` 不再命中
  `mcp__p<hash>_原名__foo`。文档应写「完整名必须用生效名」，或两种都匹配。
- **L5 registry 模块头注释仍写「每个项目各挂一条用户服务器连接」**
  （registry.ts:33-35）。v0.4.0 已改成宿主级一条，本轮又大改文件，应改成与
  `MountContainer` 全局容器一致的表述，避免下一轮审查按过时模型推理。
- **L6 housekeeping**：`idleSince` / `lastScanDesired` / `warnGates` 不随
  `prunePerProjectState` 剪；`projects` 有意常驻，这三张表可按 known keys 收。量级小。
- **L7 指纹未跳过时 `configFingerprintSignature` 会 stat 两遍**（shouldSkip 一次，
  写入 lastFingerprint 又一次）。可把第一次的结果传下去。
- **L8 `ProjectMcpService.serverView` 返回 `Promise<unknown>`**（service.ts:15），
  registry 已有结构化 view；不承诺稳定也不妨碍给出内部类型，调用方少一层猜。
- **L9 CLI `add` 没有 `--allow`/`--deny`**：A4 只能手改文件或走 `import`。可接受，
  建议在 `cli.md` 写一句「过滤键请写文件 / import」。
- **L10 `status --scope` 仍打印项目+全局两份诊断**（cli.ts:946-948），与层列表的
  scope 过滤不一致。
- **L11 `$DSH_HOME/dsh-mcp.json` 若误用本插件的 `mcpServers` 方言**：C4 不告警、也不
  装载，表现为「写了但不生效」。可在「有 `mcpServers` 但路径是对方文件名」时给一条
  提示（改用 `mcp.json`）。
- **L12 `inputFromPatchRow` 里 `reconnect` 对象字面量缩进错位**（model.ts:613）——纯排版。

---

## 7. 建议补充的测试（按发现编号）

| # | 用例 | 断言要点 |
|---|---|---|
| T1 (H1) | 曾有工具 → 清零触发重挂 → fake 延迟 2s 才再注册工具；backoff=5s | 期间多次 `reconcileNow` 不再 unmount |
| T2 (H1) | `snapshot()` 连续 5 次 | `debugReconcileCount` 若不改为只读，至少 `ctx.mounts` 不因查询增长 |
| T3 (H2) | `env-missing` 行 + 注入时钟越过 `UNMOUNT_GRACE_MS` | summary.rows≥1，skippedByReason 含 idle 或仍保留 env-missing |
| T4 (H2) | 走到 give-up | summary.unhealthy 含 `give-up`；status 输出含该名 |
| T5 (M1) | 指纹未变时改 `DSH_MCP_PROFILE` 再 `reload` | 读到新 profile 层（或明确文档：必须碰一下文件） |
| T6 (M2) | 并发两个 `import` 同一新名、无 `--overwrite` | 锁内只有一条胜出，另一条 skip（或第二次报已存在） |
| T7 (M3) | 只改 `tools.deny` | `ctx.plugin` 次数不增加，restrict deny 集更新 |
| T8 (M4) | 超预算 → 降回阈值下 → 再超同一数量 | 第二次仍告警 |
| T9 (M7) | JSON 条目同时有 command 与 url、无 type | entryError，不装载 |

---

## 附录 A：逐文件变更摘要（v0.4.3 → HEAD）

- **model.ts**：新增传输镜像常量与 SSE/未知值文案；`parseCliTransport` 与
  `resolveMcpTransport` 分流（CLI 用户面仍是 `stdio|http`）；`globToRegExp` 实现完整
  glob（`*` / `**` / `?` / `[…]`）；`deniedToolsForFilter` deny 优先；`toPatchRow`
  把 tools 留在 config、`toOfficialConfig` 剥掉。
- **json-file.ts**：`type` 从枚举放宽为 string，统一走 `resolveMcpTransport`；接受
  `httpUrl`（显式 streamable-http）与原生 `transport`；冲突对（url/httpUrl、
  transport/type、httpUrl vs stdio）逐条报错；`detectForeignMcpFormat`；
  `tools.*` 覆盖 `includeTools`/`excludeTools`。
- **json-write.ts**：`type` 改由 `jsonTypeOfTransport` 派生；非缺省 `tools` 落盘。
- **cli.ts**：`status` 读各层行数 + `parseDiagDocument` 的 summary（不连宿主）；
  `import` 只认 `mcpServers`，拒绝 VS Code `servers` 对象与对方数组存储；dry-run
  复用 `shadowViewOf`。skip/overwrite 见 M2。
- **registry.ts**：`configEpoch`+mtime/size 指纹；`healthByMount`；`idleSince`+
  `UNMOUNT_GRACE_MS`；`liveMountKeys`；`inspectToolBudgets`；`writeSummaries`；
  `toolFilterDeniesForSession`。模块头「每项目一条用户连接」的注释未改（L5）。
- **status.ts**：`mcpToolCount` 改为 `mcpToolBudgetStats().tools`；字节统计
  JSON.stringify schema，循环引用则 extra=0。
- **service.ts / index.ts**：`ctx.provide("projectMcp", bindProjectMcpService(registry))`；
  `reload` = `reconcileNow`。测试覆盖 provide 与 snapshot 形状，未覆盖「查询无副作用」。

---

**修复优先级建议**：H1（世代化 `everHadTools` + 把 `snapshot` 从对账里拆出来，避免
B3 轮询误杀连接）→ H2（摘要用期望行而不是装载 Map，idle/give-up 进 skip/unhealthy，
否则 A3 的 status 在 v0.6.0 最常见的两种「为什么没工具」场景下是空的）→ M2（import
锁内 skip，与 v0.4.1 的 add 对齐）→ M1/M6（指纹与诊断竞态）→ 其余按批次清理。
