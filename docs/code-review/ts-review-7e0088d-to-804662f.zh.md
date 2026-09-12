# 代码审查：7e0088d 至 804662f 的 TypeScript 变更

[← 返回 README](../README.zh.md) ｜ 相关：[上一轮审查（v0.4.3 至 v0.6.0）](ts-review-v0.4.3-to-v0.6.0.zh.md) ·
[v0.6.0 发布说明](../releases/v0.6.0.md) ·
[运行时稳健性与 JSON 互通提案](../design/proposal-runtime-robustness-and-json-interop.md)

**审查日期**：2026-09-13 ｜ **区间**：`7e0088d`…`804662f`（含两端；git 口径
`7e0088d^..804662f`）｜ 分支 `feat/runtime-robustness-and-json-interop`
**范围**：`src/*.ts`——6 文件 `+334 / −147`（`registry.ts` +256、`cli.ts` +145、
`model.ts` +42、`json-file.ts` +23、`service.ts` +13、`status.ts` +2）。本区间
**没有**新功能，是上一轮审查 H/M/L 的落地批次；`src/index.ts` / `mcp-file.ts` /
`json-write.ts` / `dsh-paths.ts` / `project-root.ts` 无改动。
**方法**：通读含两端的 `.ts` diff 与当前代码，对照上一轮发现、提案 A1/B3 与
`test/*.mjs`；行号以审查时 HEAD（`src/` 与 `804662f` 一致）为准。不重审 v0.4.3→v0.6.0
的功能集本身。

> 中文「A 到 B」含两端。git `A..B` 不含 A，故统计与 log 用 `7e0088d^..804662f`。

---

## 1. 变更概览

18 个 commit，按依赖从 H → M → L，与上一轮「修复优先级建议」一致：

| commit | 关闭 | 内容 |
|---|---|---|
| `7e0088d` | H1 | 健康自愈按 fiber 世代清 `everHadTools`；`snapshot()` 不再入队 `reconcileAll`；`schemaToolId` 改 `name` 优先（L2） |
| `c3dcf7c` | H2 | 摘要按配置目录计 `rows`；idle 不覆盖已有 skip；give-up 进 `skipReasons` / `unhealthy` |
| `1457ea6` | M2 | `import` 同名 skip 放进 `updateJsonServers` / `updateManagedRows` 锁内 |
| `0ff8adf` | M1 | 指纹纳入现取 profile 名与排序后的宿主全局名 |
| `dcabbed` | M6 | `writeDiagAt` 走 `withPatchLock` |
| `a3bf9a3` | M3 | `canonicalConfig` 剥掉顶层 `tools`；仍挂着的行就地换 `row`/`source` |
| `9129f4b` | M4 | 预算回到阈值下时 `warnGated(..., "", ...)` 清门控 |
| `a6671e9` | M5 | `patchRowToView` / `get` / `list` 展示 `tools.allow`/`deny` |
| `f094587` | M7 | 无 `type`/`transport` 时 `command`+`url`/`httpUrl` 拒绝 |
| `34ee304` | M8 | 用户层 watcher 监听 `$DSH_HOME/dsh-mcp.json` |
| `1fee116` | L1 | 传输别名表 `Object.create(null)` + `Object.hasOwn` |
| `4914476` | L3 | 非法工具 glob 条目告警（`invalidToolGlobs`） |
| `d29bde2` | L6/L7 | 指纹签名只算一遍；`prunePerProjectState` 收 `idleSince` / `lastScanDesired` |
| `bb47ae8` | L8 | `serverView` 返回 `McpServerRuntimeView` |
| `781ad28` | L10 | `status --scope` 只打印对应层诊断 |
| `ea24c81` | L11 | 对方文件名里出现 `mcpServers` 给改路径提示 |
| `cb8fac5` | L12 | `reconnect` 对象字面量缩进 |
| `804662f` | L4/L9 | 文档写明生效名 glob 与 `add` 无过滤开关（无 `.ts` 逻辑） |

---

## 2. 总体评价

这是一轮对得上审查单的修复：每条上一轮发现几乎都有对应 commit 和测试，没有把无关重构塞进来。值得肯定的点：

- **H1 的主因已拆开**：新 fiber 的 0 工具窗口不再立刻拆连接（测试断言
  `new fiber without tools does not remount`）；`snapshot()` 连续调用不再推高
  `debugReconcileCount`，B3 轮询不会再当巡检驱动。
- **H2 状态机与摘要对齐**：`summarizeScope` 用 `lastScanDesired` / `lastGlobalDesired`
  计行；idle 只在没有既有标记时落 `skipReason: "idle"`（`env-missing` 能活过宽限卸载）；
  give-up 即使 fiber 仍 `active` 也进 `unhealthy`，`dsh-mcp status` 打得出名字。
- **M2/M6 锁口径与 v0.4.1 的 add 一致**：import skip 在锁内读现网名字；诊断 RMW 进同一把
  项目锁。并发 import 测试期望只有一条胜出。
- **M3 少拆连接**：只改 `tools.*` 时 `planProjectChanges` 视为未变，`kickSweep` 重扫
  restrict 即可。
- **低优先级项大多是真修而不是文档搪塞**（L4/L9 按审查建议用文档关闭，可接受）。

上一轮 2 高 + 8 中已全部有落地 commit。本轮**没有新的高优先级项**（不再会因为查询快照而拆官方重连，诊断也不会把 idle/give-up 说成零配置/健康装载）。余下是修复引入的语义漂移、查询面并发，以及上一轮 H1 的边角。

以下发现按严重度排列：**高**＝可在现实使用中触发错误行为或把用户可观测状态说错；
**中**＝一致性/竞态/与已文档化语义不符；**低**＝可维护性与文案。

---

## 3. 发现清单

| # | 级别 | 位置 | 一句话 |
|---|---|---|---|
| M1 | 中 | registry.ts:1751-1786 | `remountCount` 在工具恢复后不重置，`givenUp` 也不清：A1「连续 3 次」变成进程内寿命配额 |
| M2 | 中 | registry.ts:2083-2114、2015-2031；service.ts:4-15 | `snapshot`/`serverView` 离开 `enqueue` 链且仍读盘，与「只读内存态」不符，可与对账交叉成撕裂视图 |
| M3 | 中 | registry.ts:1771-1798 | 同一 fiber 上 `tools/list_changed` 的短暂 0 工具窗口仍会触发重挂（H1 残留，严重度已下降） |
| L1 | 低 | registry.ts:1377-1390、695 | `warnGates` 仍不随 `prunePerProjectState` 剪 |
| L2 | 低 | registry.ts:1893-1895 vs status.ts:20-22 | deny 展开用 `id ?? name`，预算/巡检用 `name ?? id` |
| L3 | 低 | registry.ts:1569-1572；cli.ts:953 | idle 行进 `unhealthy`，`status` 打成「不健康：(idle)」 |
| L4 | 低 | json-file.ts:202-236 | 显式 `type:"stdio"` 仍可带 `url`，静默丢 url（测试视为有意） |
| L5 | 低 | cli.ts:73-81、973-991 | `status --scope profile` 实际等同 `--scope user`；HELP 未写 profile |
| L6 | 低 | registry.ts:1519-1545 | 诊断锁超时被吞，summary 可静默不写；`.mcp-diag.json.mcp-project.lock` 会出现在 `.dsh/` |
| L7 | 低 | registry.ts:798-806、1148-1154 | `kick` / 宽限 timer `.unref()`：进程退出可能丢掉已排队的 150ms 对账 |

---

## 4. 上一轮发现落地情况

### 高 / 中（全部有对应 commit）

| 原 # | 状态 | 说明 |
|---|---|---|
| H1 | **主因已修，语义见本轮 M1/M3** | `unmountServer(..., "generation")` 只清 `everHadTools`；新世代 0 工具不重挂。`snapshot()` 不再 `reconcileAll`。`tools > 0` **不再**清 `remountCount`（代码注释写明是为了让跨世代 give-up 能攒上）——与上一轮建议的「恢复则清零」相反，见 M1。 |
| H2 | **关闭** | 目录行数、idle、give-up 均有测试：idle 后 `rows` 仍 ≥1；`env-missing` 不被 idle 覆盖；give-up 出现在 summary / status。 |
| M1 | **关闭** | 跳过重读前现取 `resolveActiveProfileName()` 与 `host=` 指纹；改 profile / 宿主全局名会失配重读。 |
| M2 | **关闭** | `planImport` 在锁回调里根据当前 `servers`/`rows` 判定；并发测试断言只有一个 winner。dry-run 仍锁外预演（不写盘，可接受）。 |
| M3 | **关闭** | `canonicalConfig` 过滤 `key !== "tools"`；`reconcileContainer` 对仍挂着的行赋值 `state.row`。 |
| M4 | **关闭** | 回落到阈值下清门控；再超同一数量会第二次告警（测试覆盖）。 |
| M5 | **关闭** | view 含 `tools`；`list` 有 `toolFilterHint`；`get` 打印 Allow/Deny。 |
| M6 | **关闭** | 诊断写进 `withPatchLock`；fiber settle 的 diag 仍经 `enqueue`，与对账链串行。 |
| M7 | **关闭** | 未声明传输且同时有 command 与 url/httpUrl → entry error。显式 stdio+url 仍放行，见 L4。 |
| M8 | **关闭** | `syncUserWatcher` 加入 `foreignUserMcpJsonFile`（与 `mcp.json` 同路径时跳过）；测试覆盖创建对方文件会 kick。 |

### 低

| 原 # | 状态 |
|---|---|
| L1 | 关闭（`Object.create(null)` 别名表） |
| L2 | 关闭（`schemaToolId`：`name` 然后 `id`）。deny 路径未改，见本轮 L2 |
| L3 | 关闭（非法 glob 告警，去重后列出） |
| L4 | 按建议文档关闭（glob 对生效名；不改匹配两边） |
| L5 | 关闭（registry 模块头已改成全局 `MountContainer` 一条） |
| L6 | 部分关闭（`idleSince`/`lastScanDesired` 已剪；`warnGates` 未剪 → 本轮 L1） |
| L7 | 关闭（`shouldSkipConfigReread` 返回 `{ skip, signature }`） |
| L8 | 关闭 |
| L9 | 按建议文档关闭 |
| L10 | 关闭（`--scope user\|profile` 不打项目诊断，`--scope project` 不打全局） |
| L11 | 关闭 |
| L12 | 关闭 |

---

## 5. 中优先级发现（详细）

### M1 `remountCount` 变成寿命配额，恢复后也不清 `givenUp`

**位置**：`registry.ts:1751-1756`（注释）、`1778-1786`（`tools > 0` 只置 `everHadTools`）、
`1783-1785`（`givenUp` 后直接 `continue`）

**上一轮 H1 建议**是：世代化 `everHadTools`，并且 **工具重新出现时清 `remountCount`**，
give-up 仍表示「连续 N 次重挂后仍为 0 工具」。提案 A1 / `CHANGELOG` / 发布说明写的也是
「连续 3 次」。

本轮实现为了让「每代都曾有过工具、再掉到 0」能攒满上限，选择**恢复后不清
`remountCount`**。测试也改成了这个语义（`three generation deaths remount three times`，
然后第四次 pulse 走 give-up）。日志仍说「连续重挂 N 次后仍无工具」，与计数方式不一致。

后果（长会话、项目一直 `keepMounts`）：

1. 偶发掉线但每次都能救活的服务器，历史上重挂满 3 次后，第 4 次掉线直接
   `give-up`、不再自愈——即使中间已经完全恢复过。idle 卸载会 `forget` 健康记录，
   所以配额只在「会话/cwd 保活」期间累积，对常开的 dsh 会话仍然现实。
2. give-up **不拆 fiber**（这是对的，把官方内部重连留给现世代）。若之后官方重连成功、
   工具回来：`tools > 0` 分支既不清 `givenUp`，也不删 `skipReasons` 的 `give-up`。
   `summarizeScope` 见 `givenUp` 就记不健康并 `continue`，**不算已装载**。快照/
   `status` 会把一个已经又有工具的实例说成 give-up。

**建议**：

- `tools > 0` 时：`remountCount = 0`、`givenUp = false`、删掉该行的 `give-up` 标记。
  这样 give-up 重新表示「连续失败」，与 A1 一致；世代化 `everHadTools` 仍然防止新 fiber
  的首连窗口被拆掉。
- 若产品就是要寿命配额：改发布说明 / CHANGELOG / 告警文案，去掉「连续」，并写明
  重启宿主或 idle 卸载会重置。不要只留在代码注释里。
- 新世代若长时间从未列出工具，用**本世代超时**（或官方 `maxAttempts` 镜像）而不是
  跨世代累加 `remountCount`。

**测试**：① 三次「有工具 → 清零 → 重挂 → 再有工具」之后第四次清零，应再重挂而不是
give-up；② give-up 之后把 schema 加回去再 `reconcileNow`，summary 不应再把该行标
give-up，且 `mounted` 计入。

---

### M2 `snapshot` / `serverView` 不是内存快照，且不再与对账串行

**位置**：`registry.ts:2083+`（`snapshot`）、`2015-2031` / `2050+`（`locateRow` /
`serverView`）、`1971-1974`（`reconcileNow` 仍走 `enqueue`）；`service.ts:4-15`
写「只读内存态，不触发对账」

H1 把 `snapshot()` 从「先 `enqueue(reconcileAll)`」改成直接跑，避免查询驱动巡检——
这一半是对的。副作用有两层：

1. **不再进 `enqueue` 链**。`snapshot` 在 `for (const [key, entry] of this.projects)`
   里 `await readPatchFile` / `readDshJsonFile`；`serverView` 同样 `await` 各层文件。
   这些 await 点上 `reconcileAll` 可以改 `entry.servers`、`skipReasons`、`effective`、
   `userLayer`。分区结果会把 T1 的文件行和 T2 的装载态拼在一起。JS 单线程不会把 Map
   迭代打崩，但 B3 轮询正好会打在文件事件对账的中间。`globalState()` 才是同步内存读。
2. **仍读盘**，不是「内存快照」。文件已被 CLI 改、watcher 尚未 debounce 完时，查询面
   显示新文件 + 旧 fiber（或相反），和 `lastScanDesired` 也不对齐。`reload()` 才能收敛，
   这一点注释写了，但服务面文案「只读内存态」会让调用方以为不碰磁盘、也不需要自己
   串行化。

**建议**（不必重新触发对账）：

```ts
async snapshot(): Promise<ProjectFileState[]> {
  return this.enqueue(async () => this.buildSnapshotFromMemory());
}
```

内存侧用 `lastScanDesired` + 当前 `servers` / `skipReasons` 拼 view；若必须反映尚未
对账的磁盘内容，在文档里写明「读盘且与 `reload` 并发不安全」，并让 `snapshot` 至少
`enqueue` 空转以与 `reconcileAll` 互斥。`serverView` 对用户层已有 `this.userLayer`
缓存，项目层也可走 `lastScanDesired` 而不是每次 `locateRow` 读文件。

**测试**：在 `reconcileNow` 进行中（或注入慢 `statFile`/`readPatchFile`）并发调用
`snapshot()`，断言不抛、且同一项目的 `servers` 与 `skipReason` 来自同一世代（例如
对账计数或 mount 代数）。

---

### M3 同一世代的 0 工具窗口仍会重挂

**位置**：`registry.ts:1771-1798`

H1 修的是**新 fiber** 尚未 `tools/list` 成功。同一 `state` 上官方 `list_changed`
若先清空再填回，`everHadTools === true` 且 `phase === "active"`，巡检会当成连接死亡。
`snapshot` 不再驱动对账后，这条只剩 watcher / agent / 指纹跳过后的 `reconcileAll`
（含健康巡检）会撞上。窗口比以前窄，但仍可能误拆一条正在热更新工具列表的连接，并
计入 M1 的 `remountCount`。

**建议**：0 工具持续超过本世代宽限（或连续 N 轮巡检）再重挂；不要在单次
`mcpToolCount === 0` 边沿拆 fiber。可与 M1 的「本世代超时」共用一条计时。

---

## 6. 低优先级发现

- **L1 `warnGates` 未剪**（registry.ts:1377-1390）。`idleSince` / `lastScanDesired`
  已按 known keys 收；告警门控仍按历史 `gateKey` 常驻。量级小，项目拆掉后下次同样
  签名不会再告——通常反而是想要的。若担心测试隔离或长期宿主泄漏，可按前缀扫掉
  未知项目键。
- **L2 工具 id 口径分裂**。`registeredToolIds`（restrict/deny 展开）仍
  `schema.id ?? schema.name`；`schemaToolId`（计数/预算）是 `name ?? id`。官方
  `ToolSchema` 只有 `name`，两条路径在假 ctx 下都绿。一旦两边都在且不一致，deny
  集与预算统计会对不上。建议两处都调用 `schemaToolId`。
- **L3 idle 进 `unhealthy`**。H2 要求 idle 可见，实现上走了同一条 `addUnhealthy`。
  `dsh-mcp status` 因而打印 `不健康：alpha (idle)`——宽限卸载并不是故障。可把
  `idle` 从 `unhealthy` 拆到摘要的另一字段，或 status 把 idle 打成「未装载（无会话）」。
- **L4 显式 `type:"stdio"` + `url`** 仍按 stdio 解析并丢掉 url。未声明并存已拒绝
  （M7）；这条是「你写了 type 就按 type」。建议报 warning，或在错误文案里点名
  `httpUrl`（现在一律说「与 url」）。
- **L5 `status --scope profile`**。过滤条件是「是否项目源」，与 `--scope user`
  相同（所有用户层 + 全部 profile 文件）。HELP 的 status 行仍写
  `[--scope project|user]`。要么按 `--profile` 只打那一层，要么 HELP 写明
  profile 与 user 同口径。
- **L6 诊断锁**。超时 5s 后 `writeDiagAt` 外层 `catch` 吞掉，对账继续、summary
  可能丢一轮。进程内其实已有 `enqueue` 串行，锁主要防跨进程；崩溃残留锁需等 30s
  陈旧才会被拆，中间 5s 等待失败就会静默。至少 `logger.warn` 一声。锁文件名
  `.mcp-diag.json.mcp-project.lock` 会进 `.dsh/`，可接受但值得知道。
- **L7 `timer.unref()`**。debounce / 宽限不等待进程退出。长生命周期宿主无感；
  短进程或测试若在 150ms 内退出，已 `kick()` 的对账会被丢掉。这是有意不挡退出，
  文档或注释写一句即可。

---

## 7. 建议补充的测试（按发现编号）

| # | 用例 | 断言要点 |
|---|---|---|
| T1 (M1) | 有工具 → 0 → 重挂 → 再有工具，重复 3 轮后再次 0 | 第四次仍 remount，不 give-up；`remountCount` 在恢复后回到 0 |
| T2 (M1) | 走到 give-up 后把 schema 加回去再对账 | `givenUp === false`，summary 不再将该行标 give-up，`mounted` 含该行 |
| T3 (M2) | `snapshot()` 与进行中的 `reconcileNow` 交错（慢 IO） | 不抛；同一项目分区的 phase/skipReason 不出现「已 unmount 却无 skip、文件行还在」的撕裂 |
| T4 (M3) | 同一 fiber：`schemas.length = 0` 后立刻下一轮对账，backoff 内再填回工具 | 不 unmount（或至少 `ctx.plugin` 次数不增加） |

T1 与当前 `pulseDead`×4 用例冲突：落地 M1 时要改现有「三次世代死亡」断言，不要并存两套语义。

---

## 附录 A：与上一轮建议测试的对照

上一轮 T1–T9 在本区间均已有对应用例（世代窗口、snapshot 只读、idle/env-missing/give-up
摘要、改 profile 指纹、并发 import、只改 tools 不拆连接、预算回落再告警、command+url
entry error）。不必再补那些。本附录 A 的新 T1–T4 只覆盖**修复引入或故意留下**的缺口。

---

**修复优先级建议**：M1（恢复则清 `remountCount`/`givenUp`，让 A1「连续」重新成立，
否则长会话里偶发掉线会被寿命配额放弃，且 give-up 后工具回来 status 仍撒谎）→
M2（`snapshot`/`serverView` 进 `enqueue` 或不读盘，避免 B3 轮询打到撕裂视图）→
M3（同世代 0 工具去抖）→ L2（统一 `schemaToolId`）其余文案/HELP 可随手清。
