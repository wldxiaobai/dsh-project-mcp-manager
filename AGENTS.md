# AGENTS.md

## 项目概览

`dsh-project-mcp-manager`（v0.2.0）是一个 **DSH 插件**（无 UI）：为每个项目自动装载 MCP 服务器。在项目根放 `<projectRoot>/.dsh/mcp.yml`，dsh 会话在该项目开启时自动经 `@deepseek-ai/dsh-mcp-client` 装载其中的 MCP 服务器，文件改动热重载，工具可见性按会话 cwd 隔离。另提供 Claude Code 只读兼容层（`<projectRoot>/.mcp.json` 与 `~/.claude.json` 顶层 `mcpServers` 白名单）和 `dsh-mcp` CLI（只管原生 yml）。

- 语言：TypeScript（ESM，`"type": "module"`），`target ES2022` / `module NodeNext`，`strict: true`（`noImplicitAny: false`）。
- 编译产物：`src/` → `lib/`（`main: lib/index.js`）。
- 宿主框架：cordis（`@deepseek-ai/cordis`，devDependency）；插件入口声明 `inject = ["tools", "agents"]`（agents 为硬依赖，保证构造时补扫能看到已恢复会话）。
- 运行时依赖：`@deepseek-ai/dsh-mcp-client`、`chokidar@^5`、`yaml@^2`、`zod@^4`。

## 目录结构

- `src/index.ts`：插件入口。`apply(ctx)` 构造 `ProjectMcpRegistry`，并提供 `globalNames()`（从 loader entries 的 `config.patches` 提取全局已装载 mcp-client 行的 serverName，供冲突判定）。
- `src/registry.ts`：核心。`ProjectMcpRegistry` 类——项目发现、chokidar 文件监听（150ms 防抖；项目 `.dsh/mcp.yml` + `.mcp.json` 精确路径 kick，用户层 watcher 盯 `~/.dsh` 目录与 `~/.claude.json`，后者带 mtime/stat 快路径 + canonical-JSON hash 门）、`reconcileAll()` 全量对账（四层 shadow 合并 `mergeSourcedRows`：project yml > project `.mcp.json` > user yml > `.claude.json` 白名单；yml `disabled: true` 占名遮蔽，CC `enabled:false` 静默跳过）、装载/卸载（`ctx.plugin`，挂载时 `expandEnvRefs` 做 `${VAR}` 串内插值，未定义/空串→`env-missing`，展开后复验失败→`env-invalid`）、按会话 `tools.restrict({ deny })`、`snapshot()`/`serverView()` 状态查询（snapshot 按 source 分区，含 skip 原因）。纯函数 `planProjectChanges()` 计算 toMount/toUnmount。
- `src/model.ts`：配置模型（纯函数 + zod schema）。`effectiveServerNames()`（全局目录内唯一则保持原名，冲突改 `p<sha256(projectKey)前6hex>_<原名>`，截 32 字符）、`denySetFor()`、`toOfficialConfig()`、`toPatchRow()`、`patchRowToView()`（脱敏）、`inputFromPatchRow()`、`expandEnvRefs(input, env)`（`${NAME}` 串内插值，EMBEDDED_ENV_REF_RE；空串按缺失）、`ccServerEntrySchema`（looseObject，容忍 CC 未知键）。
- `src/cc-file.ts`：CC 只读兼容读取器。`readMcpJsonFile(path, projectRoot)` 解析 `<projectRoot>/.mcp.json`（project 行 cwd=项目根），`readClaudeUserFile(path)` 只取 `~/.claude.json` 顶层 `mcpServers` 白名单（user 行 cwd=""，JSON 错误脱敏、绝不回显文件内容）；`canonicalJsonString`/`mcpServersHash` 支撑 hash 门；`McpRowSource = "yml"|"cc-project"|"user-yml"|"cc-user"`、`SourcedRow`、`CcReadResult{rows,entryErrors,fileError?,serversHash?}`。kill switch：env `DSH_MCP_IGNORE_CLAUDE_JSON=1`。
- `src/cli.ts`：`dsh-mcp` CLI（package.json `bin`）。`add`/`list`/`get`/`remove`，`--scope project|user`，只写原生 `.dsh/mcp.yml`（走 `writeManagedRows`），`runCli(argv, io, deps)` 供进程内测试；手搓 argv 解析，不识别的 `-x` 视为服务器参数（positional），`--` 透传。
- `src/mcp-file.ts`：`.dsh/mcp.yml` 读写。受管块 begin/end 标记（`# >>> dsh-project-mcp-manager:mcp:begin` / `# <<< ...:end`）之间的 YAML insert 列表；标记外内容逐字节保留；原子写（临时文件+rename）+ 锁文件（`<path>.mcp-project.lock`，30s 陈旧锁）。
- `src/project-root.ts`：`findProjectRoot(cwd)` —— 向上找最近含 `.git` 的祖先目录，找不到退回 cwd（与 dsh 官方 skills 发现规则一致）。
- `src/status.ts`：`mcpToolCount(ctx, serverName)`，按 `mcp__<serverName>__` 前缀数全局工具层里的注册数。
- `test/`：`test-model.mjs`、`test-mcp-file.mjs`、`test-cc-file.mjs`、`test-registry.mjs`、`test-cli.mjs`（node 直接跑，无测试框架）。
- `README.md` / `docs/README.zh.md` / `CHANGELOG.md`：装载模型与配置格式的权威说明。

## 常用命令

```bash
npm install
npm run build        # tsc -p tsconfig.json → lib/
npm test             # 依次 node 跑 test/ 下五个 .mjs（pretest 先 build）
npx tsc --noEmit     # 仅类型检查
```

本地联调：`pnpm add link:<本仓库路径>` 装进 profile 目录（如 `%USERPROFILE%\.dsh\profiles\web`），junction 实时同步源码。

## 关键行为约定（改动前必读）

- **生效名 vs 原名**：装载与工具隔离一律用 effectiveServerName（可能与文件里写的 serverName 不同）；模型可见工具名为 `mcp__<生效名>__<tool>`。
- **会话隔离**：deny 传的是**精确工具名**（tools.restrict 对 unknown names 报错），必须先把 serverName 展开成当前注册的工具名再 deny；装载未 settle 时会失败，靠下一次 sweep 补上——不要改成一次性应用。
- **同名重装载**：必须先 unmount（释放 serverName 预留）再 mount，顺序在 `reconcileProject` 里已保证。
- **零配置项目不留痕**：无配置行的项目不建 projects 条目、不写 `.dsh/.mcp-diag.json`（诊断只在有异常或有行时写，保留最近 30 条）。
- **`!!js` 标签不支持**：受管块内出现未解析 YAML 标签必须显式报错（否则值静默降级为字面量字符串），env/headers/disabled 只能写字面值。
- **reconnect 上限镜像**：`MAX_TIMER_DELAY_MS = 2147483647` 必须与 dsh-mcp-client 保持一致，越界值要在本地 zod 校验拦下而非留到 ctx.plugin 爆 plugin-throw。
- **Windows 路径键**：Map 键一律经 `projectKeyOf()`（win32 下小写规范化），不要直接拿路径字符串比较。
- **文件写**：改 `.dsh/mcp.yml` 必须走 `writeManagedRows()`（锁 + 校验 + 原子写），不要裸 writeFile。

## 安全边界

`stdio` 行会在 dsh 宿主进程里 spawn `command` —— 项目配置文件是**可执行代码载体**，只用于可信项目。装载失败/无效的行跳过并告警，不影响其他服务器。

## Git 提交节奏

- 每完成一个**可独立验收的最小改动**立即 commit，禁止积攒多个功能点后合并提交；一个 commit 应能独立 review、revert、cherry-pick，且提交后项目保持可编译、逻辑完整。
- 改动边界模糊或混有无关改动时，先列出改动向用户确认范围；不得覆盖或顺带提交用户的无关改动。
- 互不相关的功能按「基础/设施 → 逻辑 → 表现与集成」的依赖顺序拆分提交。
- 推送（push）仅在用户明确要求时执行，提交不等于推送。

## 分支管理

- `dev` 是日常开发线：**功能与修复提交直接落在 dev**（仓库既有实践即如此）。
- `main` 是发布线：**只接收 dev → main 的 PR/MR 合并，且仅在用户明确要求时发起或执行**；agent 不得直接向 main 提交、合并或推送 main。
- 实验性、风险较高的改动可基于 dev 建短分支，验收后合回 dev，不在 dev 之外遗留长期分支。

## 提交约定

- commit 信息遵循仓库现有 git 历史风格；格式细则（Conventional Commits、中文 subject、暂存安全）见 `.dsh/skills/git-commits` skill，本文件不复述。
- 版本号变更同步 `package.json` 与 `CHANGELOG.md`。
- 规则冲突时的裁决顺序：**用户显式指令 > 本文件（AGENTS.md）> git-commits skill 通用默认 > 仓库惯例**；本文件缺位且与惯例冲突时向用户披露并请裁决，不静默选择。
