# 发布说明 v0.4.0（自 v0.3.1 以来的累积变化）

**发布日期**：2026-09-09 ｜ **区间**：`v0.3.1 → v0.4.0`
**规模**：11 commits；源码 7 文件 +1043 / −525（全量 22 文件 +3702 / −3109，含删除约 3000 行的陈旧
`package-lock.json`）；新增源码模块 2 个（`src/json-file.ts`、`src/json-write.ts`）；测试套件 6 套

v0.4.0 把插件的定位从「Claude 兼容层」改成「**DSH 自有配置层**」：不再读取任何 Claude
用户态文件，新增与生态一致的 JSON 配置位置，并把用户层从「按项目扇出」改为「宿主级
**全局装载**」；同时把依赖对齐到 dsh 0.1.2-rc.1。

---

## 亮点速览

| 主题 | 一句话 |
|---|---|
| DSH 自有 JSON 配置层 | `.dsh/mcp.json`、`~/.dsh/mcp.json`、`~/.dsh/profiles/<name>/mcp.json`，`{"mcpServers":{…}}` 方言 |
| ⚠️ 用户层改全局装载 | 宿主级一条连接，不再按项目各挂一份 |
| 项目侧压制 | 项目行遮蔽全局行时，只对该项目的会话 deny 全局工具 |
| CLI 双格式 + profile 作用域 | `--format yml\|json`、`DSH_MCP_CLI_FORMAT`、`--scope profile --profile <name>` |
| ⚠️ 移除 Claude 用户态读取 | `~/.claude.json` 不再读取，两个开关与哈希门删除 |
| 依赖对齐宿主 | `dsh-mcp-client 0.1.2-rc.1` + 同版 peer；改用 pnpm 锁文件 |
| 实机修复 | 家目录即项目根时不再重复装载用户层 |

---

## 新功能

### DSH 自有 JSON 配置层（`src/json-file.ts`、`src/json-write.ts`）

- 三个位置：`<projectRoot>/.dsh/mcp.json`（项目层）、`~/.dsh/mcp.json`（通用用户层）、
  `~/.dsh/profiles/<当前 profile>/mcp.json`（profile 用户层）。
- 方言与生态一致（Cursor / Claude Code 的 `mcpServers` 写法）：stdio 用
  `command`/`args`/`env`/`cwd`，远程用 `url`/`headers`；可选 `type`
  （`stdio`|`http`|`streamable-http`，`sse` 逐条拒绝）、DSH 透传键
  `toolCallTimeoutMs`/`failOnStartupError`/`reconnect`、`enabled:false`（静默跳过、不占名）
  与 `disabled:true`（占名但不装载）。未知键容忍、名字须匹配 `[A-Za-z0-9_-]{1,32}`、
  坏条目逐条报错不影响其余；`${VAR}` 与其他来源同语义，装载时展开。
- **JSON 文件由 `dsh-mcp` CLI 独占**：写入保留其他顶层键与键序，但 JSON 没有注释，
  排版/注释不被保留；解析失败拒绝覆盖（错误消息不含文件内容）；锁内读-改-写 + 原子写。
  插件侧只读，宿主永不写配置文件。

### CLI：`--format` / `DSH_MCP_CLI_FORMAT` / `--scope profile`

- `--format yml|json` 优先于环境变量 `DSH_MCP_CLI_FORMAT`（缺省 `yml`）；`--format json`
  时 project/user 分别写 `.dsh/mcp.json` 与 `~/.dsh/mcp.json`。
- `--scope profile --profile <name>` 写 `~/.dsh/profiles/<name>/mcp.json`（只支持 JSON；
  缺 `--profile` 或 profile 不存在时报错并列出可用 profile）。
- `remove` 按优先序在 yml/json 两个文件中查找命中项；只读层命中仍给编辑指引。

### profile 名解析

- `DSH_MCP_PROFILE=<name>` 显式覆盖；否则从 loader 根 include 的 `config.path`
  （`~/.dsh/profiles/<name>/cordis.yml`）或 `ctx.baseUrl` 推导；解析不出时不读 profile 层
  （其余层照常），不报错。

---

## 行为与边界变更

### ⚠️ 破坏性一：用户层改为全局装载

`~/.dsh/mcp.yml`、`~/.dsh/mcp.json`、`~/.dsh/profiles/<name>/mcp.json` 现在**宿主级只挂
一条连接**，与项目数量无关、对所有会话可见，不再按项目 fan-out（此前 N 个项目 = N 条
连接/进程）。

- **项目侧压制**：某个项目的自身行（精确同名、归一化同名或同服务身份）遮蔽了某条用户层
  行时，**该项目的会话**会 deny 掉那条全局服务器的工具，其他项目照常可见；全局实例不卸载。
- 与 profile patch 行里的全局 mcp-client 服务器同名时，用户层行**跳过**并记
  `skipReason: "name-taken"`（不改名，避免 `serverName` 预留冲突）。
- 全局行**保持原名**；只有项目行在同名冲突时改名 `p<sha256(项目根)前6位>_<原名>`。

### ⚠️ 破坏性二：分层来源名 DSH 化

六层读取顺序（逐行先到先得，同名/同服务只装高优先级一条）：

| 序 | 来源 | 路径 | 语义 |
|---|---|---|---|
| 1 | `dsh-project` | `<projectRoot>/.dsh/mcp.yml` | 项目层 |
| 2 | `dsh-project-json` | `<projectRoot>/.dsh/mcp.json` | 项目层 |
| 3 | `cc-project` | `<projectRoot>/.mcp.json` | 项目层，遗留只读 |
| 4 | `dsh-profile-user` | `~/.dsh/profiles/<当前 profile>/mcp.json` | 全局 |
| 5 | `dsh-user-yml` | `~/.dsh/mcp.yml` | 全局 |
| 6 | `dsh-user` | `~/.dsh/mcp.json` | 全局 |

旧名 `yml` / `user-yml` 已废弃；诊断、快照与 CLI 标签均报新名（`cc-project` 保持原名，
因为它就是 Claude 的文件）。

### ⚠️ 破坏性三：不再读取 `~/.claude.json`

cc-user 层、`DSH_MCP_READ_CLAUDE_USER`、`DSH_MCP_IGNORE_CLAUDE_JSON` 与
`mcpServers` 子树内容哈希门全部移除；`DSH_MCP_IGNORE_MCP_JSON=1` 仍可停用遗留的项目
`.mcp.json` 层。`<projectRoot>/.mcp.json` 继续被读取（层 3，低优先级），CC 用户无需迁移。

### 诊断与状态

- 项目诊断仍在 `<projectRoot>/.dsh/.mcp-diag.json`；**全局层诊断移到
  `$DSH_HOME/.mcp-diag.json`**（保留最近 30 条、原子写、串行于对账链）。
- 快照的全局分区补齐 `fiberPhase`/`toolCount`/`skipReason`；新增 `skipReason: "name-taken"`。

---

## 修复

- **家目录即项目根时重复装载用户层**（`6d4b173`）：宿主 cwd 为家目录时，该目录被当作
  已知项目，`<home>/.dsh/mcp.yml|json` 同时是用户层文件与该项目层的文件，同一行被挂两次
  （全局一条 + `p<hash>_` 一条）并多出一个子进程。现在项目层读取、行查找与快照分区都比对
  用户层路径，命中即跳过项目层。
- `npm run build` 现在先清空 `lib/` 再编译，删除的模块不再残留为陈旧产物。

---

## 依赖与工具链

- `@deepseek-ai/dsh-mcp-client` `^0.1.1-rc.2` → **`^0.1.2-rc.1`**：旧范围**不会**升级到
  0.1.2-rc.1（npm semver 要求 prerelease 候选与比较符的 major.minor.patch 元组一致），
  插件此前在 0.1.2-rc.1 宿主里加载自带的 0.1.1-rc.2 副本及其 0.1.1-rc.2 peer。升级后
  mcp-client 与全部 peer（`dsh-scope` 取代 `dsh-invariants`）解析到 0.1.2-rc.1。
- 开发依赖 `@deepseek-ai/cordis` → `^4.0.2`（仅类型，编译产物无 cordis 运行时 import）。
- 包管理器统一为 pnpm：提交 `pnpm-lock.yaml`，删除停留在 v0.1.1 的 `package-lock.json`，
  `package.json` 声明 `packageManager: pnpm@12.3.4`。

---

## 实机验证（dsh 0.1.2-rc.1）

| 场景 | 结果 |
|---|---|
| 项目 `.dsh/mcp.json` 热装载 + 工具调用 | `scan ok:true` → `attempt` → `active`；`mcp__<probe>__probe` → `pong` |
| 全局 `~/.dsh/mcp.json` | 只挂一条（无 `p<hash>_` 重复）；工具可调用 |
| profile `~/.dsh/profiles/web/mcp.json` | profile 名解析为 `web`，全局挂载并可调用 |
| 项目侧压制 | 项目同名行改名 `p0b0ea5_<名>` 可调用；全局同名工具对该会话返回 unknown tool |
| 配置热重载 | 改动 args 后 `attempt`→`active` 重挂，进程数不增 |
| 卸载与清理 | 删除行后进程数回到 1，无残留 |
| headless 宿主 | 同上（含 cwd=家目录场景，验证重复挂载修复） |

---

## 升级指引

1. **用户层语义变化**：若你依赖「用户层按项目各挂一条」，请改为依赖全局单实例；需要
   在某个项目里屏蔽某台全局服务器时，在该项目 `.dsh/mcp.yml` 写同名/同服务行即可
   （只影响该项目的会话）。
2. **`~/.claude.json` 迁移**：把顶层 `mcpServers` 里的条目搬到 `~/.dsh/mcp.json`（或
   `~/.dsh/profiles/<name>/mcp.json`）；旧开关已失效。
3. **依赖**：`pnpm install`（锁文件已提交）。
4. **插件激活**（dsh ≥ 0.1.2）：`dsh plugin --profile <p> add link:<本仓库>`，或先
   `pnpm link` 再跑一次任意 `dsh plugin --profile <p> <子命令>` 触发 bundle reconcile；
   之后重启宿主。

## 组件版本

- `dsh-project-mcp-manager` v0.4.0 ｜ 依赖 `@deepseek-ai/dsh-mcp-client ^0.1.2-rc.1`、
  `chokidar ^5`、`yaml ^2`、`zod ^4`（开发：`@deepseek-ai/cordis ^4.0.2`、`typescript ^7`）
- 实测宿主：`@deepseek-ai/dsh@0.1.2-rc.1`

**Full Changelog**：https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.3.1...v0.4.0
