# 代码审查：feat/adapt-dsh-0.2.0-rc.2（v0.7.0，适配 dsh 0.2.0-rc.2）

[← 返回 README](../README.zh.md) ｜ 相关：[上一轮审查（7e0088d 至 804662f）](ts-review-7e0088d-to-804662f.zh.md) ·
[dsh 0.2.0-rc.2 适配记录](../design/adaptation-dsh-0.2.0-rc.2.md) ·
[v0.7.0 发布说明](../releases/v0.7.0.md)

**审查日期**：2026-09-30 ｜ **分支**：`feat/adapt-dsh-0.2.0-rc.2`（HEAD `1d586a9`）
**基线**：`dev`（merge-base `1af9887`）｜ **静态分析**：SonarCloud PR #13
（[issues 列表](https://sonarcloud.io/project/issues?id=wldxiaobai_dsh-project-mcp-manager&pullRequest=13&issueStatuses=OPEN%2CCONFIRMED&s=IMPACT_RANK)，
OPEN/CONFIRMED 共 24 条，技术债合计 120 min）

**范围**：4 个 commit，21 文件 `+583 / −954`。代码逻辑只动了 4 个 `src` 文件
（`model.ts` +23、`registry.ts` +1/−8、`json-file.ts` +2、`json-write.ts` +2/−1），
其余是依赖、锁文件与文档。

| commit | 内容 |
|---|---|
| `aea9aea` | `dsh-mcp-client` `^0.1.5-rc.1` → `^0.2.0-rc.2`，cordis `^4.0.2` → `^4.0.4`，重写 `minimumReleaseAgeExclude` |
| `1893ec5` | 删除 `agent/session-start` 监听 |
| `b2f945e` | 透传可选 `maxInstructionBytes`（yml / JSON / view / CLI 写 JSON） |
| `1d586a9` | 版本 0.7.0、CHANGELOG、README、适配记录、发布说明 |

**关于 PR #13 的口径**：GitHub 上 PR #13 是 `dev → main`（标题 "Dev"，无描述），
6 个 commit、21 文件 `+844 / −953`。这与本地 `origin/dev..feat/adapt-dsh-0.2.0-rc.2`
的统计完全一致，即 PR #13 = 本分支 4 个 commit + `1af9887`（0.1.6-alpha.2 方案文档）
+ `e76eb1c`（README 提示）。因此 Sonar 结果可以直接对应本分支。

**方法**：通读 `dev...feat` 全部 diff 与相关上下文；逐条对照 Sonar 问题所在行；
本地验证见第 5 节。

---

## 1. 结论

**可以合入，建议先处理 S1（未处理的 Promise）。** 本分支自身的改动小而准：
依赖范围、事件删除、新字段透传三处都和适配记录里的上游变化一一对应，测试覆盖了
新字段的透传与缺省省略。

Sonar 的 24 条问题**没有一条落在本分支改动的行上**：它们全在 `dev` 已有代码里
（创建日期 2026-08-22 至 2026-09-12，早于本分支），因为 PR 碰了 `registry.ts`
而被一并列出（S9381/S9382/S9383 是较新的规则编号）。其中只有 3 条 S9383 是真实的
可靠性问题，其余属于有意设计或风格项。

| 级别 | 数量 | 说明 |
|---|---|---|
| 中 | 1 | S1：构造函数里三处 `enqueue(...)` 未处理 rejection（Sonar S9383 ×3） |
| 低 | 5 | 分支自身 B1–B4；Sonar S7503 / S9381 风格项 |
| 接受现状 | 15 | Sonar S9382「循环内 await」：串行化是装载语义的一部分 |

---

## 2. Sonar 问题逐条研判

### 2.1 S9383 Promise 未处理（BUG，可靠性·中）×3 —— **应修**

位置：[registry.ts:784](../../src/registry.ts#L784)、[:792](../../src/registry.ts#L792)、[:798](../../src/registry.ts#L798)。

```ts
ctx.on("agent/created", ({ agent }: any) => {
  if (agent === undefined) return;
  this.enqueue(async () => { ... await this.reconcileAll(); });   // 返回值被丢弃
});
```

`enqueue()` 返回的是 `run`（[registry.ts:849-853](../../src/registry.ts#L849-L853)），
链尾 `this.chain` 吞掉了错误，但 `run` 本身仍会 reject。只要 `resolveProject` 之后的
`reconcileAll()` 抛出（chokidar `syncWatcher`、`scanProject` 中未捕获的 I/O 等），
就会产生 unhandled rejection。Node 15+ 默认对 unhandled rejection 直接终止进程；
宿主是否装了全局处理器本次没有核实，但插件不应依赖这一点。

同文件其他调用点（`kick`、`scheduleGraceUnmount`、`kickSweep`、`trackMount`）都已
`.catch(() => {})`，这三处是遗漏。本分支删除的 `agent/session-start` 监听恰好是第四处
同类问题，删掉后数量从 4 降到 3。

建议：

```ts
void this.enqueue(async () => { ... }).catch((error) => {
  this.ctx.logger.warn(`项目 MCP 对账失败：${error instanceof Error ? error.message : String(error)}`);
});
```

比 `.catch(() => {})` 多记一条日志，方便定位。可以顺手抽一个
`private schedule(work)` 统一所有「后台入队」调用。

### 2.2 S7503 async 箭头函数里没有 await（CODE_SMELL，低）×2

位置：[registry.ts:2208](../../src/registry.ts#L2208)（`serverView`）、[:2240](../../src/registry.ts#L2240)（`snapshot`）。

`this.enqueue(async () => this.serverViewFromMemory(...))`：`async` 只是为了满足
`enqueue` 的 `() => Promise<T>` 签名。行为正确。可改为
`this.enqueue(() => Promise.resolve(this.serverViewFromMemory(...)))`，
或者放宽 `enqueue` 的签名为 `() => T | Promise<T>`。优先级低。

### 2.3 S9381 嵌套 Promise（CODE_SMELL，低）×2

位置：[registry.ts:1826](../../src/registry.ts#L1826)、[:1835](../../src/registry.ts#L1835)，
在 `trackMount` 的 `fiber.then(onActive, onFailed)` 回调里再 `enqueue(...).catch()`。

这是有意的：fiber settle 时刻不在对账链上，诊断写必须排回链里以免 RMW 竞态（代码注释
已写明）。不需要改语义。想消掉告警可以抽 `private enqueueDiag(container, event)`，
回调里只调一个同步方法。

### 2.4 S9382 循环内 await（CODE_SMELL，可维护性·低）×15 —— **建议在 Sonar 标记 Accepted**

| 行 | 位置 | 能否并行 | 理由 |
|---|---|---|---|
| 800 | 构造补扫 `resolveProject` | 可以但无收益 | 一次性，会话数很小 |
| 903 | `knownProjects` 的 `findProjectRoot` | 可以 | 只读，`Promise.all` 安全 |
| 1150、1998 | `liveMountKeys` / `sweepRestrictions` 的 `resolveProject` | 可以但无收益 | 大多命中 `agentProjects` 缓存 |
| 1251 | 指纹 `statConfigFile` | **可以** | 纯只读 stat，每轮对账都跑，项目多时收益最明显 |
| 1298、1302 | `scanProject` | 不建议 | 会写诊断、改 `configReadCount`，并发后测试口径和日志顺序会变 |
| 1320 | 逐项目 `reconcileProject` | 不可以 | 生效名预留与装载顺序依赖串行 |
| 1589、1600 | 先 unmount 再 mount | **不可以** | AGENTS.md 明确要求同名先释放预留再装载 |
| 1714、1719 | `writeSummaries` 逐文件写 | 可以但无收益 | 各自有锁，数量小 |
| 1885、1934 | 健康巡检 remount | 不可以 | 逐条 unmount/mount 改动容器状态 |
| 2159、2174 | `waitForState` 轮询 `delay(200)` | 不适用 | 轮询本来就要逐次等待（测试辅助） |
| test-json-file.mjs:258 | 逐文件读 `lib/*.js` | 不适用 | 测试代码 |

只有 1251（以及可选的 903）值得改成 `Promise.all`，其余都是装载正确性依赖的串行化。
建议把其余 13 条在 Sonar 标为 Accepted 并附上「串行化是 reconcile 语义」的理由，
避免后续有人「按 Sonar 优化」时破坏 unmount → mount 顺序。

---

## 3. 分支自身的发现

### B1（低）`DEFAULT_MAX_INSTRUCTION_BYTES` 是死导出

[model.ts:193](../../src/model.ts#L193) 导出了 `32768`，注释说「用于文档与对照」，但
`src/` 与 `test/` 里没有任何引用。它和上游默认一旦漂移，也没有东西会报错。
建议删掉，或者在测试里用它断言 `patchRowToView` 缺省时不出现该键，让它有实际用途。

### B2（低）`agent/session-start` 删除后缺少回归测试

删除本身正确（dsh 0.2 已移除该事件，`agent/created` 带 `source`）。但
[test-registry.mjs](../../test/test-registry.mjs) 里没有针对 `agent/created` 的用例，
`resume` / `compact` / `clear` 这些原先靠 session-start 兜底的边沿只有 headless 实机验证。
建议补一条：fake ctx 触发 `agent/created`（带 `source: "resume"`、已有 `session.header.cwd`），
断言项目被挂载且 deny 被应用。

### B3（低）`maxInstructionBytes` 变化会拆连接，无测试

`canonicalConfig` 只剥 `tools`，所以改 `maxInstructionBytes` 会触发 unmount → mount。
这是正确行为（官方只在连接时读取），但值得一条 `planProjectChanges` 单测固化，
防止以后有人把它当作「非连接字段」加进剥离列表。

### B4（低）view 透传不校验

[model.ts:684](../../src/model.ts#L684) 的 `patchRowToView` 只判 `typeof === "number"`，
手写 yml 里的 `0` 或 `1.5` 会原样出现在 `dsh-mcp get` 里，而装载侧
（`inputFromPatchRow` → zod）会拒绝并记 `config-invalid`。与 `toolCallTimeoutMs`
等字段现有口径一致，可以接受；如果要改，应该所有数值字段一起改。

### 其他确认项（无问题）

- **依赖范围**：`^0.2.0-rc.2` 能解析到 `0.2.0` 正式版与后续 `0.2.x`，不会跨到 `0.3`，
  符合「`0.2.0` 线」的表述。锁文件缩减 ~950 行来自 client 0.2 换掉了一批直接依赖
  （适配记录第 2 节已说明）。
- **无 `peerDependencies` / `engines`**：0.1.5 宿主装上 v0.7.0 只会在 pnpm 那里看到
  client 的 peer 警告，插件本身不拦。现在靠 README / CHANGELOG 告知「0.1.5 用 v0.6.0」。
  可以考虑在 `activate` 时检测宿主版本并给一条明确告警，但不是本次必须。
- **缺省不落键**：`toOfficialConfig`、`toJsonEntry`、`patchRowToView`、`inputFromPatchRow`
  四处口径一致，测试覆盖了「缺省不存在该键」和「设置后往返保留」。
- **文档**：中英文 format / env-expansion 同步；stdio 环境清洗的说明对用户有实际价值
  （只放在环境里、没写进 `env` 的凭据在 0.2 下子进程拿不到了），建议在发布说明里
  把这点列为「升级注意」而非普通变化。

---

## 4. 修复优先级建议

1. **合入前**：S1（三处 `enqueue` 加 `.catch` + 日志）。改动 3 行，关掉 3 条 Sonar BUG。
2. **合入前可选**：B1 删死导出；PR #13 补标题与描述（目前标题是 "Dev"、描述为空）。
3. **后续**：B2、B3 补测试；指纹 stat（1251）改 `Promise.all`；S7503 / S9381 小重构。
4. **Sonar 操作**：其余 13 条 S9382 标 Accepted 并写理由。

---

## 5. 本地验证

| 检查 | 结果 |
|---|---|
| `tsc --noEmit` | 通过 |
| 编译到临时目录与 `lib/` 逐文件比哈希 | 11 个 `.js` 全部一致，`lib/` 即本分支源码的产物 |
| 六套测试（node 直接跑） | 全部通过：model 33 / mcp-file 7 / json-file 13 / json-write 6 / registry 46 / cli 21 |

未能执行的部分：`pnpm test` 因 pnpm store 锁文件无访问权限失败，`npm run build` 因
`lib/` 被占用无法清空（疑似宿主 junction 正在加载），所以改为上面的等价验证。
headless 实机结论引用自适配记录，本次没有复跑。
