# 代码审查：feat/project-trust（按 workspace 信任门与工作区级诊断）

[← 返回 README](../README.zh.md) ｜ 相关：[记录索引](../records.zh.md) · [工作区信任门指南](../guide/trust.zh.md)

**审查日期**：2026-11-19 ｜ **分支**：`feat/project-trust`（HEAD `84b78a5`）
**基线**：`dev`（merge-base `cd11378`）｜ **审查范围**：4 个 commit，27 个文件，`+1223 / −42`

| commit | 内容 |
|---|---|
| `59f79a7` | `feat(trust)`: 按 workspace 的信任门与 `dsh-mcp trust` 命令 |
| `d948d06` | `feat(ui)`: 未信任工作区的提示条与 `/api/project-mcp/trust` |
| `b62767d` | `docs`: 记录 workspace 信任门 |
| `84b78a5` | `fix(trust)`: 未信任工作区写入工作区级诊断 |

**审查维度**：分支代码可维护性；MCP 问题诊断（`84b78a5` 及协同路径）是否按设计方案实现；中英文文档完善性。

---

## 1. 结论

**未发现未信任路径会读取或执行项目配置的 P0 阻塞项**（`allowlist` 且未受信任时，`scanProject` 仅 `stat` 存在性、在任何 `readFile` / 解析前返回）。

但存在 **3 项 P1 问题**需要合入前处理：信任后或切回 `inherit` 若工作区无有效可装载行，旧的 `summary.untrusted` 不会清掉导致 `dsh-mcp status` 误报「已拦截」；信任表 `mcp-trust.json` 读-改-写在锁外，并发 `trust` / `untrust` 可能丢更新；`addServer` 在参数校验与重名检查之前就写入了工作区信任。另有若干 P2 / P3 边界与文档细节待补齐。

| 级别 | 数量 | 核心问题 |
|---|---|---|
| P0 | 0 | — |
| P1 | 3 | 空配置信任 / 切回 `inherit` 后 `summary.untrusted` 残留；`mcp-trust.json` 读-改-写在锁外；`addServer` 校验前提前写信任 |
| P2 | 6 | `status` 信任表文案硬编码；CLI `untrust` 不更新诊断；UI 无取消信任；`statConfigFile` 吞掉非 ENOENT 错误；`service.md` 错写 `unsupported` 字段；测试覆盖缺口 |
| P3 | 7 | 事件字段 `ts` vs `at`、去重仅看末尾 `kind`、`untrust` 未在表内路径输出、若干文档索引与细节对齐 |

---

## 2. 按优先级详情

### P0（严重缺陷 / 阻塞项）

无。`projectTrust=allowlist` 且工作区未受信任时，[scanProject](../../src/registry.ts#L2004) 仅通过 `stat` 判断三个项目层文件是否存在，不读取文件内容、不产生装载期望。

---

### P1（高优先级）

#### P1-1 信任后或切回 `inherit` 时若工作区无有效行，旧 `summary.untrusted` 不会清理

`dsh-mcp status` 只判断当前摘要的 `summary.untrusted === true`（[cli.ts:1005](../../src/cli.ts#L1005)），不会因历史 `untrusted` 事件误报。但如果工作区从未产生过 `projects` 条目，信任或切回 `inherit` 后若配置为空，旧摘要文件不会得到重写或删除：

1. 未信任且文件存在时，工作区尚未进入 `this.projects`，只记在 `this.untrustedDiagRoots` 上（[reconcileProject](../../src/registry.ts#L2173) 对 0 行且无旧条目的项目直接返回）。
2. 变为受信任或以 `inherit` 启动后，[scanProject](../../src/registry.ts#L2015) 先执行 `this.untrustedDiagRoots.delete(key)`，再读取配置文件。
3. 若工作区虽然有配置文件，但**没有可装载行**（如空受管块、全部 `disabled`、或 YAML 解析失败且无有效行），`projects` 仍然不会建立条目。
4. [writeSummaries](../../src/registry.ts#L2385) 只遍历 `this.projects` 与 `this.untrustedDiagRoots`。两边均无该工作区时，磁盘上 `$DSH_HOME/mcp-diag/<hash>.json` 既不重写也不删除，旧的 `summary.untrusted: true` 一直残留，导致 `dsh-mcp status` 继续误报「已拦截」。
5. 同理，进程改用 `inherit` 重启后，对从未装载过的空/已删配置工作区也没有清理遗留 `untrusted` 诊断的分支。

**建议**：在工作区变为受信任（且无有效行、也无需要保留的错误摘要）或启动处于 `inherit` 模式时，主动清理/重写遗留的 `untrusted` 诊断文件；若存在解析失败错误，则写入非 `untrusted` 的最新摘要覆盖旧状态。

#### P1-2 信任表 `mcp-trust.json` 的读-改-写在文件锁外

[writeTrustFile](../../src/trust.ts#L102) 仅将最终 `writeFileAtomic` 放进 `withPatchLock`；[applyTrust](../../src/registry.ts#L3483) 与 CLI 的 [applyTrustCommand](../../src/cli.ts#L1110) 均在锁外完成 `readTrustFile` → `setTrustedIn` → `writeTrustFile`。

- 宿主操作「信任 A」与 CLI「取消信任 B」并发时，后写入者会覆盖先写入者的变更（若丢失 `untrust`，该工作区会继续被装载）。
- 此外，`applyTrust` 在 `readTrustFile` 抛错（损坏或权限异常）时会回退使用内存 `this.trustDoc` 覆盖写盘；而 [refreshTrust](../../src/registry.ts#L3465) 读失败时会按 fail-closed 将内存收为空表，此时一次点击可能把磁盘上其余工作区的信任记录覆写成仅剩当前一条。

**建议**：参照 `updateManagedRows` / `updateJsonServers`，在 `src/trust.ts` 封装锁内读-改-写的 `updateTrustFile`，统一由 `applyTrust` 与 CLI 调用，并在读取失败时明确拒绝静默覆盖整表。

#### P1-3 `addServer` 在校验通过之前就写入工作区信任

在 [addServer](../../src/registry.ts#L3551) 中，代码先调用 `await this.applyTrust(projectRoot, true)`，之后才执行 `mcpServerInputSchema.safeParse(...)` 与重名检查：

- 若表单字段校验失败或同名服务器拒绝写入，受管 `mcp.yml` 虽然未被修改，但工作区信任已经落盘、配置指纹已作废，且信任表监听触发的后续对账会读取并装载该工作区里原本存在的 `.dsh/mcp.yml`、`.dsh/mcp.json`、`.mcp.json`（含 `stdio` 行）。

**建议**：将 `applyTrust(projectRoot, true)` 移至参数校验与重名检查均通过、确认写入即将落盘之后再执行。

---

### P2（中优先级：可维护性、边界与测试）

1. **`dsh-mcp status` 的信任表行固定打印 `projectTrust 缺省 inherit`**：[cli.ts:1091](../../src/cli.ts#L1091) 未像 `trusted` 子命令那样读取 `DSH_MCP_PROJECT_TRUST`（[cli.ts:1138](../../src/cli.ts#L1138)），当环境变量已设为 `allowlist` 时提示文案仍称缺省 `inherit`。
2. **CLI `dsh-mcp untrust` 自身不写诊断**：仅更新 `mcp-trust.json`（[cli.ts:1110](../../src/cli.ts#L1110)），诊断更新依赖宿主下一轮对账的 `refreshTrust` → `noteUntrustedProject`。宿主未运行时，紧接着运行 `dsh-mcp status` 仍会看到上一份摘要。
3. **管理页只提供「信任」，无「取消信任」UI 入口**：后端 `/api/project-mcp/trust`（[packages/ui/src/index.ts:345](../../packages/ui/src/index.ts#L345)）与 `setProjectTrusted(root, boolean)` 已支持双向布尔值，但 [McpPanel.tsx:444](../../packages/ui/src/client/McpPanel.tsx#L444) 仅发起 `trusted: true`，取消信任目前只能靠 CLI。
4. **`statConfigFile` 把所有 `stat` 错误都当成 `"missing"`**：[registry.ts:1799](../../src/registry.ts#L1799) 遇到 `EACCES` 等非 `ENOENT` 错误时同样返回 `"missing"`，会导致未信任分支误删已有诊断，使 `status` 表现得像零配置项目。
5. **英文服务文档误植 `unsupported: "code-mode"`**：[docs/guide/service.md:223-227](../../docs/guide/service.md#L223) 在 `trustState()` / `setProjectTrusted()` 返回 `ProjectTrustState` 后写了 `Both carry an optional unsupported: "code-mode"`，但 `ProjectTrustState`（[registry.ts:271-278](../../src/registry.ts#L271)）并无该字段；中文版 [docs/guide/service.zh.md:189-191](../../docs/guide/service.zh.md#L189) 仅将其放在 `contextCost` / `resultCost` 上，双语不一致。
6. **测试覆盖缺口**：[test/test-trust.mjs](../../test/test-trust.mjs) 未覆盖：信任后 0 行仍残留 `untrusted`、切回 `inherit` 后清理、仅存在 `.mcp.json`、`DSH_MCP_IGNORE_MCP_JSON=1` 开关生效、信任后 `status` 不再输出「已拦截」、外部 `untrust`、`addServer` 校验失败时不应提前写信任。此外，第 175–177 行的 `debugConfigReadCount` 在未信任分支本就会提前返回，无法真实证明指纹跳过。UI 测试（[test/test-ui-lifecycle.mjs](../../test/test-ui-lifecycle.mjs)）仅覆盖后端路由与载荷，未渲染或点击「信任此工作区」按钮。

---

### P3（低优先级：细节与文档微调）

- **事件时间戳字段名**：诊断事件实际沿用既有字段 `ts`（`{ ts, kind: "untrusted", message }`，[registry.ts:2317](../../src/registry.ts#L2317)），而非设计草案中的 `at`。
- **事件去重粒度**：`appendDiagEvent` 仅比对末尾最后一条事件的 `kind`（[registry.ts:653](../../src/registry.ts#L653)），连续对账不会重复追加；但中间若插入过 `scan` 等事件或再次 `untrust`，仍会追加一条新记录（`status` 不读事件，不受影响）。
- **对不在表里的目录执行 `untrust`**：[cli.ts:1116](../../src/cli.ts#L1116) 正确跳过了写盘，但仍打印「已取消信任」。
- **`status` 诊断与 `--scope`**：`--scope user` / `profile` 不读项目诊断，不显示「已拦截」，与现有 scope 过滤逻辑一致。
- **文档细节**：
  - [docs/guide/service.zh.md:156-181](../../docs/guide/service.zh.md#L156) 导出类型示例漏了 `ProjectTrustState`（英文版已列，方法表两边都有）。
  - [docs/guide/settings-ui.md:149-153](../../docs/guide/settings-ui.md#L149) 写「说明行变成提示条」，实际 UI 保留原说明并在上方增加 `TrustNotice`（[McpPanel.tsx:460](../../packages/ui/src/client/McpPanel.tsx#L460)）。
  - `docs/guide/how-it-works` 与 `layers`（中英文）未交叉链接 `trust` 门控文档。
- **可维护性与缓存协同**：纯函数独立置于 `src/trust.ts` 结构清晰，但诊断与门控策略仍集中在体量较大的 `src/registry.ts`，且事件载荷类型为 `Record<string, unknown>`。信任集变化会清空 `lastFingerprintSig` 与 `lastScanDesired`（[registry.ts:3476](../../src/registry.ts#L3476)），稳态未信任跳过重读时仍可依托 `untrustedDiagRoots` 刷新摘要，新建会话也不会为空目录空等 20s。

---

## 3. MCP 问题诊断设计方案逐条核对

| 设计方案条款 | 结论 | 依据 |
|---|---|---|
| 做「工作区级」诊断，而非「服务器行级」跳过计数 | ✅ 符合 | `DiagSummary.untrusted?: boolean`（[registry.ts:755](../../src/registry.ts#L755)），拦截时目录强制为 `[]`、`rows: 0`（[registry.ts:2388](../../src/registry.ts#L2388)），不写 `skippedByReason`。 |
| 仅用 `stat` / `access` 判断配置文件是否存在，绝不读内容 | ✅ 符合 | [projectLayerConfigPresent](../../src/registry.ts#L3524) 仅 `stat` `.dsh/mcp.yml`、`.dsh/mcp.json` 及受 `mcpJsonLayerEnabled()` 控制的 `.mcp.json`（并排除同路径用户层文件）；[scanProject](../../src/registry.ts#L2004) 在 `readFile` 前返回；指纹 `cc=` 变化会迫使重读。 |
| 三个项目层文件均不存在时保持「零配置项目不留痕」 | ✅ 符合 | [noteUntrustedProject](../../src/registry.ts#L3515) 清除标记并调用 `removeProjectDiag` 删除历史诊断文件。 |
| 有任意文件且未受信任时：写 `$DSH_HOME/mcp-diag/<hash>.json`、去重 `{ kind: "untrusted", ..., message }`、`DiagSummary.untrusted` 且 `rows: 0` | ⚠️ 基本符合 | `summary.untrusted = true` 与 `rows: 0` 已实现；事件时间戳字段为既有的 `ts`（非 `at`）；去重为「末尾连续同 `kind` 去重」而非全历史去重。 |
| 取消信任（`untrust`）时写入该状态而非直接删文件（仅切回 `inherit` 或已信任且真正空配置时清理） | ⚠️ 部分符合 | 宿主对账在文件仍在时写 `untrusted`，`applyTrust` 本身不删诊断；但存在 **P1-1**（信任后 0 行或切回 `inherit` 时未清理旧摘要）以及 **P2**（CLI `untrust` 单独执行不写诊断）。 |
| `dsh-mcp status` 读到 `summary.untrusted === true` 或 `untrusted` 事件时输出一行提示 | ⚠️ 基本符合 | [printDiagSummary](../../src/cli.ts#L1005) 仅判断 `summary.untrusted === true` 输出提示，不扫描历史事件（因此摘要被重写后不会因历史事件误报）；但受 **P1-1** 影响在 0 行场景下会因旧摘要残留误报，且孤立 `untrusted` 事件不会触发提示。 |

---

## 4. 文档完善性核对

`84b78a5` 已及时修正 `b62767d` 中「取消信任就删除诊断文件」的旧表述。`AGENTS.md`、`CHANGELOG.md`、`README.md`、`docs/README.zh.md`、`docs/guide/trust.md` / `trust.zh.md`、`docs/guide/cli.md` / `cli.zh.md` 已完整记录 `projectTrust`、`DSH_MCP_PROJECT_TRUST`、`dsh-mcp trust/untrust/trusted`、`mcp-trust.json`、管理页提示条与工作区级诊断语义，中英文核心指南基本对齐。

待修正项汇总：
1. 修复 [docs/guide/service.md:223-227](../../docs/guide/service.md#L223) 把 `unsupported: "code-mode"` 错挂到信任 API 的问题（P2）。
2. 在 [docs/guide/service.zh.md:156-181](../../docs/guide/service.zh.md#L156) 导出列表补齐 `ProjectTrustState`（P3）。
3. 修正 [docs/guide/settings-ui.md:149-153](../../docs/guide/settings-ui.md#L149) 关于提示条替换说明行的描述（P3）。
4. 视 `status` 文案与 `inherit` / 空配置清理修复结果，同步更新对应文档与 `how-it-works` / `layers` 交叉引用。

---

## 5. 验证记录

审查过程中（不改写代码、直接基于当前编译产物 `lib/`）执行了以下只读检查：

- `node test/test-trust.mjs`：6 passed
- `node test/test-ui-lifecycle.mjs`：17 passed
- `npx tsc --noEmit`：通过
- 未执行完整 `pnpm test`（避免 `pretest` 重建工作区 `lib/`）。

---

## 6. 修复复核（2026-11-19）

经一轮修改后，上述 **P1 / P2 / P3 主要问题已闭环修复**并按「核心/CLI → UI → 文档」拆分提交：

- **P1-1（空配置或切回 `inherit` 后残留 `summary.untrusted`）**：已修复。`registry.ts` 新增 `scanDiagWritten` 与 `settleTrustedEmptyDiags` / `clearStaleUntrustedDiag`，信任或以 `inherit` 启动时对无有效行工作区清理遗留 `untrusted` 诊断，或以非 `untrusted` 摘要覆盖解析失败记录。
- **P1-2（信任表读-改-写在锁外）**：已修复。`trust.ts` 新增锁内读-改-写的 `updateTrustFile`（读失败拒绝覆盖），`applyTrust` 与 CLI `applyTrustCommand` 均已切换。
- **P1-3（`addServer` 校验前提前写信任）**：已修复。`addServer` 已调整为校验与受管 yml 写盘成功后再调用 `applyTrust`。
- **P2 & P3 同步收口**：
  - `cmdStatus` 改为按 `DSH_MCP_PROJECT_TRUST` 动态输出模式；`dsh-mcp untrust` / `trust` 在宿主未运行时同步对齐工作区诊断（`alignTrustDiag`），对未在表内目录不再打印「已取消信任」。
  - `statConfigFile` 区分 `missing`（`ENOENT`/`ENOTDIR`）与 `unreadable`（如 `EACCES`），权限错误不误删诊断、指纹跳过不忽略 `unreadable`。
  - 管理页新增工具栏「取消信任」按钮与确认弹窗（`trustChrome`、`locales.ts`、`McpPanel.tsx`）。
  - `test/test-trust.mjs` 扩充至 15 项（覆盖锁内并发写、损坏拒绝、空配置/`disabled`/解析失败/仅 `.mcp.json`/`DSH_MCP_IGNORE_MCP_JSON=1`/`EACCES`/`inherit` 启动清理、`addServer` 门控、CLI 离线对齐）；`test-ui-display.mjs` 与 `test-ui-lifecycle.mjs` 补齐取消信任用例。
  - 文档已同步修正 `service.md`、`service.zh.md`、`settings-ui.md` / `.zh.md`、`cli.md` / `.zh.md`、`trust.md` / `.zh.md`、`how-it-works` / `layers` 交叉引用、`AGENTS.md`、`README` 与 `CHANGELOG.md`。
- **全量复验**：`pnpm test`（含 `build:core`、UI 构建与全部 25 个测试脚本）与 `npx tsc --noEmit` 均全部通过。
