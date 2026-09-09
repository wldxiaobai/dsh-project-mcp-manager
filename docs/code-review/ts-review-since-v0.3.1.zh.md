# 代码审查：v0.3.1 以来的全部 TypeScript 变更

[← 返回 README](../README.zh.md) ｜ 相关：[v0.4.0 发布说明](../releases/v0.4.0.md) ·
[JSON 配置层设计提案](../design/proposal-json-mcp-config.md)

> **本文所列 H1-H4 / M1-M10 / L1-L12 与 T1-T9 已在 v0.4.1 全部落地**，
> 逐项对应见 [v0.4.1 发布说明](../releases/v0.4.1.md) 与 `CHANGELOG.md` 的 `[0.4.1]` 段。

**审查日期**：2026-09-10 ｜ **区间**：`v0.3.1..HEAD`（HEAD = `6022706`，`dev` 分支）
**范围**：`src/*.ts` 全部修改——7 文件 `+1142 / −580`，即 v0.4.0 功能主体（DSH JSON 配置层、
用户层全局装载、CLI 双格式与 profile 作用域、移除 Claude 用户态读取）加上标签后的
可读性重构批次（`5b92ec8..HEAD`，Sonar 认知复杂度清理与排序写法统一）。
**方法**：通读全量 diff 与当前代码；`pnpm test` 实测全绿（registry 29 例、cli 14 例等）。
文中行号以审查时 HEAD 为准。

> 审查期间仓库 HEAD 从 `5b92ec8` 前进到 `6022706`：新增的 7 个 refactor commit
> （拆 `buildServerConfig`/`trackMount`、拆 `activeMountGroups`/`registeredToolIds`/
> `expandToToolNames`、拆 `removeFromTarget`、默认排序替代手搓比较器等）经逐段比对
> **均为行为等价改写**，未引入新问题；本文全部发现均已对照新 HEAD 复核行号。

---

## 1. 变更概览

| 文件 | 变更 | 内容 |
|---|---|---|
| `src/cc-file.ts` | 删除（−213） | `~/.claude.json` allowlist 读取、serversHash 门、cc-user 层整体移除 |
| `src/json-file.ts` | 新增（235） | JSON 方言只读读取器：六层 `McpRowSource`、宽松条目 schema、透传键、`enabled:false`/`disabled:true` 语义 |
| `src/json-write.ts` | 新增（120） | CLI 独占 JSON 写入器：锁内读-改-写、原子写、写前自校验、缺省值不落盘 |
| `src/cli.ts` | 重写（+337 变更） | `--format`/`DSH_MCP_CLI_FORMAT`、`--scope profile --profile <name>`、六层 list/get、remove 跨方言查找 |
| `src/registry.ts` | 大改（+773 变更） | `MountContainer` 抽象、用户层全局装载（`globalServers`）、项目侧压制（`suppressedGlobals`）、profile 名解析、家目录==项目根去重、快照全局分区补生命周期 |
| `src/index.ts` | 小改（+27 变更） | 新增 `activeProfile()` provider（`DSH_MCP_PROFILE` 优先，loader 路径推导兜底） |
| `src/model.ts` | 小改（−17） | 删除 `ccServerEntrySchema`（职责移入 json-file） |

## 2. 总体评价

方向正确、执行扎实的一轮大改。值得肯定的点：

- **`MountContainer` 抽象**（registry.ts:169-185）把项目层与全局层收敛到同一套
  对账/装载/诊断路径，`isCurrent` 回调防旧 fiber 回写的设计延续了原有严谨度；
- **移除 `~/.claude.json` 读取**消灭了整块哈希门与双开关冲突逻辑，隐私面与复杂度双降；
- **JSON 写入器契约**（解析失败拒绝覆盖、错误消息不含文件内容、锁内自校验、原子写）
  与 yml 写路径同一安全标准，且有并发测试（test-json-write.mjs:92-103）；
- **家目录==项目根去重**（`isSameFilePath`，registry.ts:786-791、1252、1322）读取、
  行定位、快照三处口径一致，并配了回归测试；
- `readUserLayer` 前移到 watcher 同步之前（registry.ts:768-771）有明确因果注释；
- 发布说明与设计提案文档质量高，多数行为变更有据可查。

以下发现按严重度排列：**高**＝可在现实使用中触发错误行为或数据丢失；
**中**＝一致性/日志噪音/健壮性问题；**低**＝可维护性与清理项。

## 3. 发现清单

| # | 级别 | 位置 | 一句话 |
|---|---|---|---|
| H1 | 高 | registry.ts:1112-1114 | 项目侧压制误伤：用户层 `disabled` 占名行（或 name-taken 被阻行）会让项目会话 deny 掉**自己的**同名服务器工具 |
| H2 | 高 | registry.ts:652-661、cli.ts:283 等 | 全链路硬编码 `homedir()/.dsh`，宿主支持的 `DSH_HOME` 重定位会让用户层整体**静默失效** |
| H3 | 高 | cli.ts:603-616 | `remove` 只删首个命中文件：另一方言文件的被遮蔽同名行**静默顶替生效**，无任何提示 |
| H4 | 中 | json-write.ts:67-74 | `updateJsonServers` 写回时静默丢弃 `mcpServers` 内的非对象条目（数据丢失） |
| M1 | 中 | registry.ts:884-887 | `name-taken` 告警无变更门控，每次对账重复刷 |
| M2 | 中 | registry.ts:716-720、833-836 | 用户层/项目层 `entryErrors`、`fileError` 告警无门控（与自家 identityShadowSigs 策略不一致） |
| M3 | 中 | registry.ts:353-356 | 用户层之间的**精确同名**遮蔽（profile vs user yml/json）宿主侧零告警零诊断 |
| M4 | 中 | registry.ts:806-810、820 | 纯用户层的 identity 冲突会让**每个零配置项目**写 diag、按项目归因告警（违反「零配置项目不留痕」） |
| M5 | 中 | cli.ts:91-95 vs registry.ts:215-219 | 行名提取口径相反（CLI 优先 `config.serverName`，装载器优先行 id），手改行会判重/删除失配 |
| M6 | 中 | cli.ts:535-540 | `get` 未命中提示只列 3 层，实际查 6 层（信息陈旧误导排障） |
| M7 | 中 | cli.ts:362 | list 遮蔽标注用固定 `SOURCE_LABEL[winner]`，profile 层胜者丢失具体 profile 名 |
| M8 | 中 | cli.ts:443-490 | `add` 不探测另一方言文件、不提示新行将被其它层遮蔽——设计提案 3.4 自己警示过的「双真相」 |
| M9 | 中 | cli.ts:482-486 | yml 写路径锁外读-改-写（并发丢更新）+ `.catch(() => "[]")` 吞非 ENOENT 错误 |
| M10 | 中 | index.ts:54-56、registry.ts:701 | `DSH_MCP_PROFILE` 未做字符校验，可拼出 profiles 目录之外的路径 |
| L1-L12 | 低 | 见 §6 | 方法过长、映射无清理、重复字面量、快照 wire 字段语义变化、遗留层行为变更未入文档等 |

---

## 4. 高优先级发现（详细）

### H1 项目侧压制误伤：全局行未装载时，deny 命中项目自己（或宿主 patch）的同名工具

**位置**：`registry.ts:1112-1114`（sweepRestrictions 压制分支）、`registry.ts:817`
（suppressedGlobals 写入）、`registry.ts:353-356`（classifyShadow）。

**现象**（最小复现场景）：

1. 用户层 `~/.dsh/mcp.yml` 有 `disabled: true` 的占名行 `X`（AGENTS.md 与
   registry.ts:672-674 明确支持的「占名退出」机制）；
2. 项目 A 的 `.dsh/mcp.yml` 有正常行 `X`，且是全目录唯一定义。

结果：**项目 A 的会话看不到自己的 `mcp__X__*` 工具**——而 snapshot/serverView 显示
`fiberPhase: active`、无 skipReason，完全静默。

**推导链**（全部为当前 HEAD 行号）：

- 逐项目合并（registry.ts:796）里，用户层 disabled 行带占位旗进入
  `mergeSourcedRows`；项目行先占 `byName`，用户行命中后走 `classifyShadow`
  （registry.ts:355）：item rank 4 > 2、winner rank 0 ≤ 2 → `shadowedUser += "X"`
  ——**该分支不检查 item.disabled，也不检查这条用户行是否会真的全局装载**；
- `suppressedGlobals[A] = {X}`（registry.ts:817）；
- 全局合并（registry.ts:840）中 disabled 行被 `mergeSourcedRows` 过滤
  （registry.ts:424）→ `X` 不进 `globalMerged.rows` → 不装载，也不进
  `globalNames`（registry.ts:848）→ 项目 A 的 `X` 生效名保持原名 `X`
  （model.ts:140 计数为 1）；
- `sweepRestrictions`（registry.ts:1112-1114）把 `X` 并入 `hidden` →
  `expandToToolNames` 按前缀 `mcp__X__` 展开（registry.ts:117-124）→ 命中的是
  **项目 A 自己刚装载的实例的工具** → `tools.restrict({ deny })` 生效，自杀完成。

**同族第二场景（name-taken）**：宿主 profile patch 行占用 `X`，用户层文件也写了
`X`（被 reconcileGlobals 判 blocked，registry.ts:876-883，不装载），项目 A 又有自己的
`X` 行（此时因 globalNames 含宿主 `X` 而改名 `p<hash>_X`）。`suppressedGlobals[A]={X}`
→ deny 命中的是**宿主 patch 实例**的 `mcp__X__*` 工具。v0.3.1 从不 deny profile patch
行——项目文件遮蔽用户文件，不应连带压制宿主全局 patch 服务器，这是可见性回归。

**修复建议**（最小改法，sweep 侧加守卫）：

```ts
// registry.ts sweepRestrictions（1112-1114）
if (project !== undefined) {
  for (const rawName of this.suppressedGlobals.get(project) ?? []) {
    // 仅当全局实例确实以原名装载时才压制：disabled 占名行与 name-taken 行
    // 没有全局实例，此时 rawName 可能被项目自身（或宿主 patch）占用，误 deny 会自伤。
    if (this.globalServers.has(rawName)) hidden.push(rawName);
  }
}
```

正常压制场景不受影响：全局行装载 ⇒ `globalServers` 有 `X` ⇒ 项目行必已改名
（globalNames 计数 ≥ 2），deny `mcp__X__*` 仍精确命中全局实例；全局装载失败
（phase failed）时工具本来就没注册，`expandToToolNames` 返回空，行为不变。
**更彻底的配套**：把 `globalMerged`（registry.ts:840）前移到项目循环之前，
`suppressedGlobals.set` 时按「本轮真正会全局装载的名字集」过滤——数据流上就排除
未装载行，sweep 侧守卫作双保险（也顺带服务 M3/M4 的修复，见下）。

**建议测试**（test-registry.mjs，补在 28 号压制用例旁）：用户 yml `disabled` 占名行
`X` + 项目 yml 行 `X` → 项目会话 deny **不含** `mcp__X__*`，项目实例 active 且工具可见；
name-taken 变体 → 宿主 patch 工具不被 deny。

### H2 `DSH_HOME` 重定位时用户层整体静默失效（且与自家文档矛盾）

**位置**：`registry.ts:652-661`（resolveUserLayerPaths 硬编码 `join(homedir(), ".dsh")`）、
`registry.ts:701`（profileJson 拼接）、`registry.ts:942/949-952`（注释与发布说明都写
「`$DSH_HOME/.mcp-diag.json`」，实现是 `dirname(mcpYml)` = `~/.dsh`）；CLI 侧
`cli.ts:283、299、392-393、416、569` 同样硬编码。

**依据**：本仓库 README.md:60 / docs/README.zh.md:53 明确「dshHome 默认为
`%USERPROFILE%\.dsh`（设置了 `DSH_HOME` 则用其值）」；设计提案
（proposal-json-mcp-config.md:108）实测宿主进程环境**含 `DSH_HOME`**、:113 提到宿主有
`ctx.provide("dshHomePath", …)` 服务。即宿主支持重定位，本插件不支持。

**现象**（设 `DSH_HOME=D:\dsh-home`）：profile 名仍能从 loader 真实路径正确解析
（profileNameFromConfigPath 只取 `<name>`），但随后 join 到
`~/.dsh/profiles/<name>/mcp.json`（registry.ts:701）→ 文件不存在 → profile 层**静默为空**；
用户 yml/json 同样读错位置 → 静默为空；全局 diag 写到 `~/.dsh`；CLI list/get/add/remove
全部作用于错误目录。没有任何告警——用户层「看起来就是不生效」。
用户 yml 的 homedir 硬编码属 v0.3.1 既有，但 v0.4.0 把用户层足迹扩大到三个文件 +
全局 diag + CLI 双格式，且发布说明（v0.4.0.md:99-100）宣称 `$DSH_HOME`，缺口应在本轮补齐。

**修复建议**：抽一个共享解析（如 model.ts 或新 `dsh-paths.ts`）：

```ts
export function dshHomeDir(home = homedir()): string {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv !== undefined && fromEnv !== "" ? resolve(fromEnv) : join(home, ".dsh");
}
```

registry 的 `resolveUserLayerPaths` 与 CLI 的各处 `join(home, ".dsh", …)` 统一改走它
（测试注入点 `userLayerPaths`/`deps.home` 保留原优先级）；更稳的做法是宿主侧再经
providers 注入 `dshHomePath` 服务值（若可取），env 作兜底。**先与宿主确认 `DSH_HOME`
的确切语义**（指向 `.dsh` 目录本身——按 README 措辞是），并补一条注入 env 的回归测试。

### H3 `remove` 首个命中即返回：另一文件的被遮蔽同名行静默顶替

**位置**：`cli.ts:603-616`（cmdRemove）、`cli.ts:564-577`（removeTargets 返回
`[yml, json]`）。发布说明 v0.4.0.md:51 只写「按优先序查找命中项」，未披露顶替后果。

**现象**：项目同时有 `.dsh/mcp.yml` 与 `.dsh/mcp.json` 的同名行 `foo`（json 行被遮蔽，
`add` 只查目标文件判重——cli.ts:464-469——所以这种状态可以合法产生）。
`dsh-mcp remove foo` 删掉 yml 行、打印「已移除」、返回 0——但下一轮对账后 **json 里的
`foo` 顶替生效**，服务器换了一份定义继续跑。用户视角是「remove 没删掉」，且没有任何
提示指向真正生效的文件。跨 scope 同理（删项目行后被压制的用户层行恢复可见——那个是
文档化的遮蔽语义，但本 CLI 输出同样一字不提）。

**修复建议**（保留「首个命中即删」语义，补顶替提示）：

```ts
for (let i = 0; i < targets.length; i++) {
  const outcome = await removeFromTarget(targets[i], name, io);
  if (outcome === "removed") {
    for (const other of targets.slice(i + 1)) {
      const rest = await existingNames(other, io);
      if (Array.isArray(rest) && rest.includes(name)) {
        io.out(`注意：${other.path} 中还有同名 "${name}"，删除后将由该定义接管生效。`);
      }
    }
    return 0;
  }
  if (outcome !== "absent") return fail(io, outcome.error);
}
```

可选增强：用 `collectLayers` 顺带提示用户层/只读层的同名行将恢复可见。
**建议测试**：yml+json 同名 → `remove` → stdout 含「接管」提示；仅剩 json 行时再
`remove` 才真正清空。

### H4（中偏高）`updateJsonServers` 写回时静默丢弃非对象条目

**位置**：`json-write.ts:67-74`（`current` 只收 `isPlainObject` 条目，写回
`{ ...doc, mcpServers: next }`）；`json-write.ts:53-57`（readJsonServers 同样过滤）。
现有测试只断言**读侧**过滤（test-json-write.mjs:62-67），写回保留无覆盖。

**现象**：`mcp.json` 里 `"mcpServers": { "legacy": "node x.js", "ok": {…} }`
（生态里确实存在字符串速记/坏条目），任何一次 `dsh-mcp add/remove` 都会把 `legacy`
键**从文件里永久删掉**——模块契约承诺的是「保留其他顶层键」，但用户的 `mcpServers`
内部条目被静默清除同样属于数据丢失，且 `remove legacy` 会报「不在文件中」（读侧也过滤了）。

**修复建议**（原样保留未知形态条目，读写口径分开）：

```ts
// updateJsonServers：current 收全部条目（值类型放宽为 unknown），
// CLI 的 mutate 回调只做键级增删查，不会触碰坏条目的内部结构。
const rawServers = isPlainObject(doc.mcpServers) ? doc.mcpServers : {};
const current = { ...rawServers } as JsonServers; // JsonServers 值类型放宽为 unknown
const next = mutate(current) ?? current;
```

`readJsonServers`（供 `existingNames` 报名字）保留全部键——`remove` 就能顺手清掉坏条目；
读取器 json-file.ts 一侧本就逐条报错，不受影响。**建议测试**：含非对象条目的文档经
`add` 后，坏条目原样保留、新条目写入成功。

---

## 5. 中优先级发现

### M1 `name-taken` 告警无变更门控

`registry.ts:884-887`：blocked 行每次 `reconcileAll` 各 warn 一遍——文件事件、新会话、
fiber settle 都会触发对账，持续刷屏。同文件对 identity 遮蔽专门做了签名门控
（identityShadowSigs，registry.ts:801-810），且测试 28 明确断言「集合不变就沉默」；
blocked 集合应享受同等待遇。**建议**：`blockedSig = [...blocked].sort().join("\0")` 存入
门控 Map，变化才 warn；skipReasons 照写（便宜且快照依赖它）。

### M2 `entryErrors` / `fileError` 告警同样无门控

`registry.ts:716-720`（用户层三源）与 `registry.ts:833-836`（项目 json/cc，逐项目）每次
对账全量重发。一个持续存在的坏条目 → 每次对账 × 每个已知项目各一条 warn——正是
registry.ts:799-800 注释自己点名的放大模式（cc 层属既有，本轮把同一模式扩展到了三个新层）。
**建议**：抽通用助手（同时服务 M1）：

```ts
private warnGated(gate: Map<string, string>, key: string, signature: string, emit: () => void): void {
  const prev = gate.get(key);
  if (signature === "") gate.delete(key); else gate.set(key, signature);
  if (signature !== prev) emit();
}
```

签名 = 该 scope 的 `fileError + entryErrors` 拼接；key = projectKey 或用户层路径。

### M3 用户层之间的精确同名遮蔽：宿主侧零可见性

`classifyShadow`（registry.ts:353-356）只有两个桶：cc→项目层、用户层→项目层。
profile json 的 `X` 遮蔽用户 yml 的 `X`（两侧 rank 都 > 2）不进任何桶——全局合并
（registry.ts:840）静默丢弃败者，无告警、无诊断；快照唯一线索是败者分区
`fiberPhase: null`（registry.ts:1400、1405）。CLI list 能解释，宿主日志不能。
**建议**：给 `ShadowBuckets` 加第三桶（如 `shadowedGlobal`：item、winner 均为用户层），
`reconcileGlobals` 消费之——按 M1 的门控 warn 一次，并写一条全局 diag
（`writeGlobalDiag`，落 `$DSH_HOME/.mcp-diag.json`）。注意 identity/normname 维度的
用户层内部重复已由 per-project 循环「代为」告警（归因还是错的，见 M4），修复 M4 后
这两个维度也应落到全局归因。

### M4 纯用户层 identity 冲突污染零配置项目（diag 留痕 + 归因错位）

profile 层 `unityMCP` 与用户 yml `unity-mcp` 这类**与项目文件无关**的冲突，会出现在
每个已知项目的 `merged.shadowedIdentity` 里：首次对账每个项目各 warn 一遍
「项目 MCP（<root>）：跳过重复服务定义…」（registry.ts:806-810，归因误导），并触发
scan diag 写入（条件含 `shadowedIdentity.length > 0 && shadowChanged`，registry.ts:820）
——`ownRows` 为空的**零配置项目也会创建 `.dsh/.mcp-diag.json`**，与 AGENTS.md
「零配置项目不留痕」约定冲突（test-registry.mjs:621 恰有「无行项目不写 diag」断言，
但该场景没造用户层内部冲突，未覆盖到）。
**建议**：`globalMerged` 前移到项目循环之前；全局层的 shadowedIdentity 以全局归因
warn/diag 一次（M1 式门控）；项目循环里只保留「loser 或 winner 至少一侧是项目层行」的
条目——需要 `IdentityShadow` 增补 loser/winner 的 `source` 字段（`mergeOneRow`
（registry.ts:366-386）手头就有 `item.source`/`dupWinner.source`；新增可选字段对
diag 消费方向后兼容）。

### M5 行名提取口径相反：CLI `nameOf` vs 装载器 `rowNameOf`

`cli.ts:91-95` 优先 `config.serverName`、`registry.ts:215-219` 优先受管行 id。
手改行两者不一致时（id `panel-mcp-foo`、serverName `bar`）：装载管线全程按 `foo`
（生效名表由 rowNameOf 的名字计算，`buildServerConfig` 再以生效名覆写 serverName，
registry.ts:1032），而 CLI 的判重/`remove`/`list` 按 `bar` → `dsh-mcp remove foo`
报「不在文件中」，实际却在运行。**建议**：把 `rowNameOf` 移入 model.ts 统一导出，
CLI 的 `nameOf` 直接复用（装载口径为准），补一条 id≠serverName 的一致性测试。

### M6 `getMissMessage` 层列表陈旧

`cli.ts:535-540` 只列 `.dsh/mcp.yml`、`.mcp.json`、`~/.dsh/mcp.yml`——`collectLayers`
实际查 6 层（含 `.dsh/mcp.json`、全部 profile json、`~/.dsh/mcp.json`）。未命中提示是
排障第一入口，漏层直接误导。**建议**：从 `collectLayers` 返回的层路径动态拼接，
或至少补全三处；profile 层可注明「全部 profile」。

### M7 list 遮蔽标注丢失 profile 名

`cli.ts:362` 用 `SOURCE_LABEL[winner]`：胜者是 profile 层时显示固定的
「profile (mcp.json)」（cli.ts:197），而层本身有带名 label（cli.ts:274）。多 profile
机器上「被哪个 profile 遮蔽」不可辨。**建议**：`seen` 改存展示名
（`seen.set(name, sourceLabel(layer))`），标注处直接用。

### M8 `add` 不防「双真相」、不提示新行将被遮蔽

设计提案 3.4（proposal-json-mcp-config.md:93-94）明确警告过「yml 一条、json 一条」的
双真相风险并建议自动探测；实现的 `add` 固定按 `--format`/env 落一个文件，且判重只查
目标文件（cli.ts:464-469）——新行可能被另一方言文件或用户层的同名/同服务行遮蔽，
用户以为生效实际没有。**建议**（提示不阻断，成本低）：写入成功后复用现成的
`collectLayers` + `shadowViewOf`（cli.ts:330-346）检查新行：不在 `effective` → 打印
「注意：该行将被 <层 label> 的同名/同服务定义遮蔽，不会装载」；另一方言文件非空 →
打印「提示：<path> 已有 N 条服务器（当前写入 <target>）」。

### M9 yml 写路径：锁外读-改-写 + 吞错

`cli.ts:483`：`readPatchFile(...).catch(() => "[]")` 在**锁外**预读行列表，随后
`writeManagedRows`（锁内）用这份过期数据整体替换受管块——两个并发 `dsh-mcp add`
（yml 方言）会丢一条。JSON 路径已示范正确姿势（锁内 mutate，cli.ts:474-478 +
test-json-write.mjs:92-103），yml 路径应对齐。另外 `.catch(() => "[]")` 把 EACCES、
受管块标记损坏等所有错误吞成空列表，让判重（cli.ts:464-466）基于错误数据通过；
`mcp-file.ts:209-213` 的 `createIfMissing` 也把「任意读取错误」当文件缺失处理。
**建议**：mcp-file.ts 增加锁内读-改-写入口，CLI 判重也移进锁内：

```ts
export async function updateManagedRows(
  path: string,
  mutate: (rows: PatchRow[]) => PatchRow[],
  options: { createIfMissing?: boolean } = {}
): Promise<string> {
  return withPatchLock(path, async () => {
    let raw: string;
    try {
      raw = await readPatchFile(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.createIfMissing !== true || !message.includes("ENOENT")) throw error;
      await mkdir(dirname(path), { recursive: true });
      raw = "";
    }
    const next = replaceManagedBlock(raw, mutate(extractManagedRows(raw)));
    await validatePatchText(next);
    await writeFileAtomic(path, next);
    return next;
  });
}
```

`cmdAdd`/`removeFromTarget` 的 yml 分支改走它（add 的判重在 mutate 内抛错，与 json
路径同构）；`createIfMissing` 兜底顺带收紧为仅 ENOENT。

### M10 `DSH_MCP_PROFILE` 无校验

`index.ts:54-56` 返回任意非空串，`registry.ts:701` 直接 `join(profilesDir, name, …)`：
`DSH_MCP_PROFILE=../../somewhere` 会让用户层读到 profiles 目录之外（本机 env 自控，
安全影响有限，但笔误同样静默读错文件）。CLI 侧已有目录枚举校验（cli.ts:396-408），
registry 侧缺。**建议**：`activeProfileName` 落库前校验 `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`
（显式拒绝 `.`/`..`），不合法 warn 一次并按「解析不出」降级。

---

## 6. 低优先级 / 清理项

- **L1 `reconcileAll` 过长**（registry.ts:765-856，约 92 行）：项目循环体可抽
  `private async scanProject(...)`；配合 M3/M4 把全局合并前移后，方法会自然缩短。
- **L2 逐项目 Map 无清理**：`suppressedGlobals`（registry.ts:444、817）与
  `identityShadowSigs`（registry.ts:485）对每个进过 `knownProjects` 的目录留条目且不随
  项目消失剪枝（`projects` 的保留是有意为之，registry.ts:861-863 有注释，这两张表可
  按本轮 known keys 剪）。量级小，属长会话 housekeeping。
- **L3 cli.ts 清理集**：a) `collectLayers` 对 yml 层的双重包装仍在（cli.ts:287-289、
  300-302——`readNativeLayer` 已返回完整 `LayerRows`，再拆重建等价但冗余，直接 push 即可）；
  b) `existingNames(target, io)` 的 `io` 参数未用（cli.ts:426）；c) `ccLayerNote`
  名字已名不副实（cli.ts:248-252，现服务全部 JSON 层，建议改 `jsonLayerNote`/`layerNote`）；
  d) `".dsh"`/`"mcp.yml"` 字面量重复 5 处（cli.ts:286、299、419、422、572），可 import
  现成的 `projectMcpFile`/`PROJECT_MCP_FILE`（cli.ts 已从 registry import 别的符号）。
- **L4 快照全局分区 `project` 字段语义变化**：旧 `dirname(dirname(mcpYml))`＝家目录 →
  新 `dirname(path)`＝`~/.dsh`（registry.ts:1389）；profile 分区则是 profiles/<name> 目录。
  wire 可见变化，需确认 dsh-skill-mcp-panel 等消费方是否按 `project` 分组/去重。
- **L5 JSON 读取错误丢 code**：`json-file.ts:202` 非 ENOENT 一律「读取失败」——`error.code`
  不含文件内容，可安全附带（EACCES/EISDIR/ENOTDIR 可区分，排障价值高）。
- **L6 `toJsonEntry` 不写 `type` 键**（json-write.ts:95-120）：本方言回读靠推断没问题；
  若期望 `~/.dsh/mcp.json` 被其它生态工具直接消费（宣称与 Cursor/CC 写法一致），显式
  `type: "stdio"|"http"` 更稳。可选。
- **L7 blocked 告警措辞**：registry.ts:886 说「已由 profile patch 行（全局层）占用」，
  实际 `globalNames()` 收集的是**全部** loader patch 行（含 bundle 层，index.ts:25-50），
  建议改「宿主全局 patch 行」。
- **L8 遗留 `.mcp.json` 层行为变更未入文档**（均为本轮统一方言带来，方向正确但兼容性
  可见）：a) 条目级显式 `cwd` 现在生效（旧 cc-file 强制 cwd=项目根且 schema 无 cwd 键；
  现 json-file.ts:139-146 优先条目值）；b) DSH 透传键 `toolCallTimeoutMs`/
  `failOnStartupError`/`reconnect` 现在生效（旧层忽略，json-file.ts:109-115）；
  c) `disabled:true` 从「静默跳过、不占名」改为「占名不装载」（旧 cc-file 对
  enabled/disabled 一视同仁跳过；现 json-file.ts:172、189-190 分开处理）——会影响
  「`.mcp.json` 禁用行不再让位给下层」的用户。建议补进 CHANGELOG `[Unreleased]` 或
  `docs/guide/layers*.md` 的遗留层小节。
- **L9 `serverView` 对用户层行的 `scope` 字段**：registry.ts:1287 固定
  `{ kind: "workspace", path: projectRoot }`——定位到用户层的行也应报
  `kind: "global"` + 层文件路径（快照 `pushGlobal` 已是正确口径，registry.ts:1397）。
  既有问题（v0.3.1 同款），可让 `locateRow` 顺带返回命中路径一并修。
- **L10 `activeProfile` 调用防御**：registry.ts:698 `this.providers.activeProfile().catch(...)`
  ——注入实现若同步抛错（返回非 Promise）会 TypeError；`await Promise.resolve(...).catch`
  更稳。测试注入场景才会踩到，防御性。
- **L11 `planProjectChanges` 的 O(n²) `current.find`**（registry.ts:247）：n 为单项目行数，
  实践无害；改 `Map` 顺手（既有代码）。
- **L12 `--format`/`-f`、`--profile`/`-p` 成为保留短名**（cli.ts:54）：此前「不识别的
  `-x` 一律透传为服务器参数」，现在 `-f`/`-p` 开头的 spawn 参数必须放 `--` 之后。
  属既定设计，建议在 CHANGELOG/CLI 文档标注一句迁移提示。

## 7. 建议补充的测试（按发现编号）

| # | 用例 | 断言要点 |
|---|---|---|
| T1 (H1) | 用户层 `disabled` 占名行 + 项目同名行 | 项目会话 deny 不含自身 `mcp__X__*`；实例 active |
| T2 (H1) | 宿主 patch 占名 + 用户层行 blocked + 项目同名行 | 宿主 patch 工具不被该项目会话 deny |
| T3 (H2) | 注入重定位的 dshHome（或 env） | 用户层三文件、全局 diag、CLI 路径全部跟随 |
| T4 (H3) | yml+json 同名 → `remove` | 输出含「接管生效」提示；二次 remove 才清空 |
| T5 (H4) | `mcpServers` 含非对象条目 → CLI add/remove | 坏条目原样保留；`remove <坏条目名>` 可清除 |
| T6 (M1/M2) | 持续 blocked / 持续坏条目 + N 次 reconcile | 每类告警只在集合变化时出现一次 |
| T7 (M4) | 零配置项目 + 用户层内部 identity 冲突 | 项目不写 `.mcp-diag.json`；告警按全局归因一次 |
| T8 (M5) | 行 id 与 config.serverName 不一致 | CLI 判重/remove 与装载器同名口径 |
| T9 (M9) | 并发两个 yml `add` | 两条都在（锁内读-改-写） |

## 附录 A：逐文件变更摘要（v0.3.1 → HEAD）

- **cc-file.ts（删）**：cc-user 层、`DSH_MCP_READ_CLAUDE_USER`/`DSH_MCP_IGNORE_CLAUDE_JSON`
  双开关、canonicalJsonString/serversHash 门整体退役；`mcpJsonLayerEnabled`、
  `CC_PROJECT_FILE`、`McpRowSource`/`SourcedRow` 迁往 json-file.ts。
- **json-file.ts（新）**：单一读取器覆盖 4 个 JSON 位置；`jsonServerEntrySchema`
  （looseObject + DSH 透传键 + reconnect 上限镜像 MAX_TIMER_DELAY_MS）；
  `requireMcpServers` 区分遗留 `.mcp.json`（缺字段报错）与 DSH 自有层（缺字段=空层）；
  parse 错误不含文件内容的约定保持。
- **json-write.ts（新）**：见 H4；其余（拒绝覆盖、自校验、原子写、toJsonEntry 缺省不落盘）
  实现与注释契约一致。
- **cli.ts**：六层 collectLayers、profile 层枚举与带名 label、WriteTarget 抽象、
  removeTargets/removeFromTarget 跨方言删除、HELP 全面改写；见 H3/M5-M9。
- **index.ts**：`PROFILE_ENV` + `activeProfile()`（env 覆盖 → loader entries → baseUrl 兜底），
  降级路径（解析不出 → 不读 profile 层）与发布说明一致；见 M10。
- **registry.ts**：`MountContainer`/`reconcileContainer` 统一对账；`reconcileGlobals` +
  `GLOBAL_SCOPE_KEY` + name-taken；`suppressedGlobals` 项目侧压制（见 H1）；
  `profileNameFromConfigPath`（file URL/Windows 盘符/目录形态兜底，逻辑正确）；
  家目录==项目根三处去重；`writeGlobalDiag`；快照全局分区补 fiberPhase/skipReason/toolCount；
  标签后批次拆分 mountServer/sweepRestrictions（行为等价）。
- **model.ts**：仅删 `ccServerEntrySchema`；`expandEnvRefs`/`effectiveServerNames` 等核心
  纯函数未动。

---

**修复优先级建议**：H1（自伤性 deny，修复一行守卫 + 两个测试）→ H3（remove 提示）→
H2（DSH_HOME，需先与宿主确认语义）→ H4 → M1/M2/M4（同一套告警门控基建可一并做）→
其余按批次顺手清理。
