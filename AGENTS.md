# AGENTS.md

## 项目概览

`dsh-project-mcp-manager`（v0.6.0）是一个 **DSH 插件**（无 UI）：为每个项目自动装载 MCP 服务器。项目配置放 `<projectRoot>/.dsh/mcp.yml`（原生受管块）或 `<projectRoot>/.dsh/mcp.json`（JSON 方言），dsh 会话在该项目开启时自动经 `@deepseek-ai/dsh-mcp-client` 装载，文件改动热重载，工具可见性按会话 cwd 隔离。用户层（`~/.dsh/mcp.yml`、`~/.dsh/mcp.json`、`~/.dsh/profiles/<name>/mcp.json`）为**全局装载**（宿主级一条连接）。遗留 Claude Code 项目文件 `<projectRoot>/.mcp.json` 只读兼容；`~/.claude.json` 自 v0.4.0 起不再读取。`dsh-mcp` CLI 可写原生 yml 或 DSH JSON。

- 语言：TypeScript（ESM，`"type": "module"`），`target ES2022` / `module NodeNext`，`strict: true`（`noImplicitAny: false`）。
- 编译产物：`src/` → `lib/`（`main: lib/index.js`）。
- 宿主框架：cordis（`@deepseek-ai/cordis`，devDependency）；插件入口声明 `inject = ["tools", "agents"]`（agents 为硬依赖，保证构造时补扫能看到已恢复会话）。
- 运行时依赖：`@deepseek-ai/dsh-mcp-client`、`chokidar@^5`、`yaml@^2`、`zod@^4`。

## 目录结构

- `src/index.ts`：插件入口。`apply(ctx)` 构造 `ProjectMcpRegistry`，经 `ctx.provide("projectMcp", { snapshot, serverView, globalState, reload })` 暴露查询面（**不承诺稳定 API**；`snapshot`/`serverView`/`globalState` 只读内存态，`reload` = 一次 `reconcileAll`），并提供 `globalNames()`（从 loader entries 的 `config.patches` 提取全局已装载 mcp-client 行的 serverName，供冲突判定）与 `activeProfile()`（`DSH_MCP_PROFILE` 优先，否则从根 include 的 `config.path`/`ctx.baseUrl` 推导 profile 名）。`inject` 仍仅为 `["tools","agents"]`。
- `src/registry.ts`：核心。`ProjectMcpRegistry` 类——项目发现、chokidar 文件监听（150ms 防抖；项目 `.dsh/mcp.yml` + `.dsh/mcp.json` + `.mcp.json` 与用户层三个精确路径均按**精确文件路径** kick，已无 `~/.claude.json` 哈希门）、`reconcileAll()` 全量对账（六层 shadow 合并 `mergeSourcedRows`：dsh-project > dsh-project-json > cc-project > dsh-profile-user > dsh-user-yml > dsh-user；三把先到先得影子键——精确原名、归一化名（小写去非字母数字，`unityMCP`=`unity-mcp`）、服务身份（stdio command+args，Windows 下 command 小写；http url）——跨来源同服务只装高优先级一条，被剔除方进 `shadowedIdentity` 诊断并告警；原生 `disabled: true` 占名行三键全占不装载，JSON `enabled:false` 静默跳过不占名）、装载/卸载（`MountContainer` 抽象：项目层按项目、全局层宿主级一条；挂载时 `expandEnvRefs` 做 `${VAR}` 串内插值，未定义/空串→`env-missing`，展开后复验失败→`env-invalid`）、按会话 `tools.restrict({ deny })`（含项目侧压制全局服务器）、`snapshot()`/`serverView()`/`globalState()` 状态查询（snapshot 按 source 分区；`fiberPhase` 为生命周期枚举，跳过原因走独立 `skipReason`，含 `name-taken` / `idle` / `give-up`）；对账结束把 `summary` 写入 `.mcp-diag.json`（`parseDiagDocument` 兼容旧版纯数组；`rows` 按配置目录而非装载 Map，idle 卸载与 give-up 进 `unhealthy`）；对账尾部健康巡检（当前 fiber 世代 `everHadTools` + 0 工具 → unmount/mount，3 个世代后 `give-up`）与工具预算护栏（超 `DSH_MCP_TOOL_BUDGET_WARN` 告警一次、不裁剪）；入口指纹（`mtimeMs+size`）未变则跳过文件重读。纯函数 `planProjectChanges()` 计算 toMount/toUnmount、`profileNameFromConfigPath()` 解析 profile 名。
- `src/model.ts`：配置模型（纯函数 + zod schema）。`effectiveServerNames()`（全局目录内唯一则保持原名，冲突改 `p<sha256(projectKey)前6hex>_<原名>`，截 32 字符）、`denySetFor()`、`toOfficialConfig()`、`toPatchRow()`、`patchRowToView()`（脱敏）、`inputFromPatchRow()`、`expandEnvRefs(input, env)`（`${NAME}` 串内插值，EMBEDDED_ENV_REF_RE；空串按缺失）、`rowNameOf()`（受管行 id 优先于 `config.serverName`，装载器与 CLI 共用口径）、`byCodeUnit(a, b)`（字符串排序统一比较器：UTF-16 码元序，与 `Array#sort` 默认逐字节等价、不经 locale collator）。
- `src/json-file.ts`：JSON 方言读取器（只读）。`readJsonRows(path, {source, cwdPolicy, projectRoot})` 解析 `{mcpServers:{…}}`；`jsonServerEntrySchema`（looseObject，容忍生态未知键 + DSH 透传键）、`jsonEntryToInput`、`parseJsonServersValue`；`readDshJsonFile`（缺 `mcpServers` = 空层）、`readMcpJsonFile`（遗留 `.mcp.json`，缺 `mcpServers` 报错）；`McpRowSource` 六值枚举、`SourcedRow`、`JsonReadResult`；`mcpJsonLayerEnabled`（`DSH_MCP_IGNORE_MCP_JSON=1` 停用遗留项目 `.mcp.json` 层）。
- `src/json-write.ts`：JSON 写入器（**仅 CLI 用**）。`readJsonDocument`/`readJsonServers`/`updateJsonServers`（锁内读-改-写）/`writeJsonServers`/`toJsonEntry`。CLI 独占契约：只认 `mcpServers`、保留其他顶层键与键序、解析失败拒绝覆盖（错误不含文件内容）、原子写。
- `src/cli.ts`：`dsh-mcp` CLI（package.json `bin`）。`add`/`list`/`get`/`remove`/`status`/`import`，`--scope project|user|profile`、`--format yml|json`（env `DSH_MCP_CLI_FORMAT`，缺省 yml）、`--profile <name>`；`status` 只读各层文件与 `.mcp-diag.json` 摘要（不连接宿主）；`import --from <file|->` 只接受 `{"mcpServers":{...}}`（同名默认跳过且 **skip/overwrite 在锁内判定**，`--overwrite` 覆盖，`--dry-run` 预演不写盘）；`runCli(argv, io, deps)` 供进程内测试；手搓 argv 解析，不识别的 `-x` 视为服务器参数（positional），`--` 透传。
- `src/mcp-file.ts`：`.dsh/mcp.yml` 读写。受管块 begin/end 标记（`# >>> dsh-project-mcp-manager:mcp:begin` / `# <<< ...:end`）之间的 YAML insert 列表；标记外内容逐字节保留；原子写（临时文件+rename）+ 锁文件（`<path>.mcp-project.lock`，30s 陈旧锁）。
- `src/project-root.ts`：`findProjectRoot(cwd)` —— 向上找最近含 `.git` 的祖先目录，找不到退回 cwd（与 dsh 官方 skills 发现规则一致）。
- `src/status.ts`：`mcpToolCount(ctx, serverName)` / `mcpToolBudgetStats`，按 `mcp__<serverName>__` 前缀统计全局工具层注册数与描述/schema 字节；`parseToolBudgetWarn` 读 `DSH_MCP_TOOL_BUDGET_WARN`（缺省 200 工具 / 256KiB）。
- `src/dsh-paths.ts`：dsh 家目录与用户层路径的唯一解析口径（registry 与 CLI 共用）。`dshHomeDir(home, env)`（`DSH_HOME` 非空则 `resolve` 它，否则 `<home>/.dsh`）、`dshHomeFor(home|undefined, env)`（**注入的 home 优先于 env**，测试才能隔离真实用户配置）、`userLayerPathsIn(dshHome)`（`mcp.yml`/`mcp.json`/`profiles`）、`profileMcpJsonFile(profilesDir, profile)`、`isValidProfileName`（`PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/`，显式拒绝 `.`/`..`）、常量 `DSH_HOME_ENV`/`PROFILE_ENV`/`DSH_DIR`/`MCP_YML_FILE`/`DIAG_FILE`。
- `src/service.ts`：`projectMcp` cordis 服务面（`bindProjectMcpService` + Context 模块增强）；不承诺稳定 API。
- `test/`：`test-model.mjs`、`test-mcp-file.mjs`、`test-json-file.mjs`、`test-json-write.mjs`、`test-registry.mjs`、`test-cli.mjs`（node 直接跑，无测试框架）。
- `README.md` / `docs/README.zh.md`：项目介绍、安装/构建、工作原理与安全边界（中英双版，各自链接同语言文档）。
- `docs/`：按用途分目录——`guide/`（功能文档中英双版：`format.md`/`.zh.md` 配置格式、`layers.md`/`.zh.md` 六层来源与影子优先序、`env-expansion.md`/`.zh.md` `${VAR}` 展开、`cli.md`/`.zh.md` `dsh-mcp` CLI）、`releases/`（`v0.3.1.md`、`v0.4.0.md`、`v0.4.1.md`、`v0.4.2.md`、`v0.4.3.md`、`v0.6.0.md` 发布说明）、`design/`（`adaptation-dsh-0.1.5-rc2.md` / `adaptation-dsh-0.1.5-rc1.md` / `adaptation-dsh-0.1.2-rc1.md` 宿主适配记录、`proposal-json-mcp-config.md` JSON 层设计提案、`proposal-runtime-robustness-and-json-interop.md` 运行时稳健性与 JSON 互通提案）；`docs/README.zh.md` 为中文 README。
- `CHANGELOG.md`：版本变更记录（`[Unreleased]` 起累积）。

## 常用命令

```bash
pnpm install           # 包管理器为 pnpm（pnpm-lock.yaml 是唯一锁文件）
pnpm run build         # 先清空 lib 再 tsc -p tsconfig.json → lib/
pnpm test              # 依次 node 跑 test/ 下六个 .mjs（pretest 先 build）
npx tsc --noEmit       # 仅类型检查
```

本地联调：`dsh plugin --profile <p> add link:<本仓库路径>`（或先 `pnpm link` 再跑一次任意 `dsh plugin --profile <p> <子命令>` 触发 bundle reconcile），junction 实时同步源码。dsh ≥ 0.1.2 只把 `dsh.profile.bundles` 里的包当作 profile 层，单纯 pnpm link 不会激活插件。

## 关键行为约定（改动前必读）

- **生效名 vs 原名**：装载与工具隔离一律用 effectiveServerName（可能与文件里写的 serverName 不同）；模型提示里的工具名为 `mcp__<生效名>__<tool>`。**只有项目行会改名**（`p<hash>_`），全局用户层行保持原名。
- **全局 vs 项目**：用户层（profile json / 用户 yml / 用户 json）宿主级只挂一条，与项目数无关、不参与按项目的 deny；项目层按需挂载（有会话或进程 cwd），经 `tools.restrict({ deny })` 隔离。项目行遮蔽全局行时，只对该项目的会话 deny 全局工具（项目侧压制），全局实例不卸载。
- **会话隔离**：deny 传的是**精确工具名**（tools.restrict 对 unknown names 报错），必须先把 serverName 展开成当前注册的工具名再 deny；装载未 settle 时会失败，靠下一次 sweep 补上——不要改成一次性应用。条目 `tools.allow`/`tools.deny`（JSON 亦映射 `includeTools`/`excludeTools`）同样只展开已注册名，glob 匹配，deny 优先，且在 `toOfficialConfig` 时剥掉以免传给 client。
- **同名重装载**：必须先 unmount（释放 serverName 预留）再 mount，顺序在 `reconcileContainer` 里已保证。连接死亡自愈按 **fiber 世代**：这一代曾经有工具、当前 `mcpToolCount===0`、未 `disabled` 才 unmount-then-mount；新一代首连失败交给官方内部重连。连续 3 个世代都是「有过工具再掉到 0」则 `give-up`；JSON `enabled:false` 不在装载集，不会被复活。`snapshot()` 只读内存，不驱动对账。
- **配置指纹跳过重读**：`reconcileAll` 入口比对已知项目的 yml/json/cc 与用户层三路径的 `mtimeMs+size`，以及当前 `resolveActiveProfileName()` 与排序后的 `hostGlobalNames`；全同则跳过文件重读、复用上次期望集，仍跑健康巡检 / deny 重扫 / 工具预算 / 摘要。运行中改 `DSH_MCP_PROFILE` 或宿主全局 patch 名集会让指纹失配并重读。
- **工具预算护栏**：装载/巡检后按生效名统计 `ctx.tools.schemas()` 的数量与描述/schema 字节；超过 `DSH_MCP_TOOL_BUDGET_WARN`（缺省 200 工具 / 256KiB）告警一次并写入 `summary.toolBudget`，**永不裁剪**。
- **按需挂载**：扫描与生效名仍按全量已知项目计算；项目层只装「有活跃会话的项目 ∪ 进程 cwd 所在项目」。最后一次会话离开且该项目不是 cwd 后，宽限 `UNMOUNT_GRACE_MS`（5 分钟）再卸载服务器，保留 `ProjectEntry` 与 watcher，卸下行写 `skipReason: "idle"`（已有更具体的 `env-missing` / `env-invalid` 等不覆盖）。全局用户层仍宿主级常驻。
- **零配置项目不留痕**：无配置行的项目不建 projects 条目、不写 `.dsh/.mcp-diag.json`（诊断只在有异常或有行时写；文件形态 `{ summary?, events }`，events 保留最近 30 条；对账结束刷新 `summary`，`rows` 按配置目录即使当前未挂）；全局层的诊断写 `$DSH_HOME/.mcp-diag.json`。
- **`!!js` 标签不支持**：受管块内出现未解析 YAML 标签必须显式报错（否则值静默降级为字面量字符串），env/headers/disabled 只能写字面值。
- **reconnect 上限镜像**：`MAX_TIMER_DELAY_MS = 2147483647` 必须与 dsh-mcp-client 保持一致，越界值要在本地 zod 校验拦下而非留到 ctx.plugin 爆 plugin-throw。
- **传输值域镜像**：`SUPPORTED_MCP_TRANSPORTS`（`stdio` | `streamable-http`）必须与 dsh-mcp-client 的 `config.transport` 判别联合保持一致。schema、CLI `--transport`、JSON `type` 映射与报错文案全部从它派生；未知/不受支持值（含 MCP SSE 端点传输）在本地给出可执行文案，不留到 `ctx.plugin` 爆 plugin-throw。官方新增传输时：常量加值 + 一条别名映射 + 文档 + 测试，不要再加判定分支。
- **Windows 路径键**：Map 键一律经 `projectKeyOf()`（win32 下小写规范化），不要直接拿路径字符串比较。
- **文件写**：改 `.dsh/mcp.yml` 必须走 `writeManagedRows()`；改 JSON 必须走 `updateJsonServers`/`writeJsonServers`（锁 + 原子写 + 写前自校验）；宿主侧永不写任何配置文件。

## 安全边界

`stdio` 行会在 dsh 宿主进程里 spawn `command` —— 项目与用户层配置文件都是**可执行代码载体**：项目文件只用于可信项目，用户层文件属于本机自己的配置。装载失败/无效的行跳过并告警，不影响其他服务器。

## Git 提交节奏

- 每完成一个**可独立验收的最小改动**立即 commit，禁止积攒多个功能点后合并提交；一个 commit 应能独立 review、revert、cherry-pick，且提交后项目保持可编译、逻辑完整。
- 改动边界模糊或混有无关改动时，先列出改动向用户确认范围；不得覆盖或顺带提交用户的无关改动。
- 互不相关的功能按「基础/设施 → 逻辑 → 表现与集成」的依赖顺序拆分提交。
- 推送（push）仅在用户明确要求时执行，提交不等于推送。

## 分支管理

- `dev` 是开发主线。
- **可直接提交到 `dev`（仅推荐这类）**：文档更新、版本号提升，以及其它不变动代码逻辑的改动。
- **代码新功能（推荐）**：从当前 `dev` 拉出新分支开发，不要直接在 `dev` 上堆功能逻辑。其它会变动代码逻辑的改动（含修复）同样推荐走新分支。是否向远端 `dev` 发 PR，由用户决定；未经用户指示不得自行 push、开 PR 或合入远端 `dev`。
- `main` 是受保护的稳定分支：**仅在用户明确允许时触碰**（含提交、合并、推送、开 PR）。agent 不得自行向 `main` 提交、合并或推送。

## 提交约定

- commit 信息遵循仓库现有 git 历史风格；格式细则（Conventional Commits、中文 subject、暂存安全）见 `.dsh/skills/git-commits` skill，本文件不复述。
- 版本号变更同步 `package.json` 与 `CHANGELOG.md`。
- 规则冲突时的裁决顺序：**用户显式指令 > 本文件（AGENTS.md）> git-commits skill 通用默认 > 仓库惯例**；本文件缺位且与惯例冲突时向用户披露并请裁决，不静默选择。
