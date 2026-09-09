# 设计提案：DSH 自有 JSON 配置层（替代 Claude 兼容层）

**状态**：已裁决并实现（v0.4.0） ｜ **提出日期**：2026-09-09 ｜ **目标版本**：v0.4.0（破坏性）
**关联**：`docs/adaptation-dsh-0.1.2-rc1.md`（宿主适配记录）、`AGENTS.md`（装载模型）、`CHANGELOG.md`（0.4.0）

## 0. 裁决结果（2026-09-09）

| 待决问题 | 裁决 |
|---|---|
| §4.1 用户层语义 | **全局装载**（宿主级一条连接，不扇出），含遗留 `~/.dsh/mcp.yml` |
| §4.2 JSON 写入策略 | **CLI 独占整个文件**（保留其他顶层键与键序，不保留注释/排版） |
| §4.3 yml 与 json 优先序 | **yml 优先**，CLI 默认写 yml（JSON 为显式 opt-in） |
| §3.5 profile 名 | 层名用动态 `dsh-profile-user`；从 loader 根 include 的 `config.path`/`ctx.baseUrl` 推导，`DSH_MCP_PROFILE` 可覆盖，解析不出则跳过该层 |
| §3.3 遗留项目 `.mcp.json` | **保留**为独立低优先级只读层（`cc-project`） |
| 项目侧压制 | **支持**：项目行遮蔽全局行时，只对该项目的会话 deny 全局工具 |

文件命名最终取 **`mcp.json`（无前导点）**：`.dsh/mcp.json`、`~/.dsh/mcp.json`、
`~/.dsh/profiles/<name>/mcp.json`。

## 1. 背景与动机

现状（v0.3.1）的"Claude 风格"支持由两部分组成：

- **项目层**：`<projectRoot>/.mcp.json`（CC project scope，只读）；
- **用户层**：`~/.claude.json` 顶层 `mcpServers`（CC user scope，只读、默认关闭、
  需 `DSH_MCP_READ_CLAUDE_USER=1`）。

`~/.claude.json` 是 CC 的单体状态文件，混存 OAuth 凭据、onboarding 状态、逐项目
会话历史（见 `src/cc-file.ts:1-23`）。读取它带来三类问题：

1. **风险面**：为拿 MCP 配置不得不打开一个含凭据的文件，靠 allowlist 摘取子树；
2. **扇出事故**：机器级配置会被并入**每个已知项目**各挂一条连接（见 §4.1 扇出语义）；
3. **复杂度**：CC 每次会话重写整个文件，watcher 必须用 `mcpServers` 子树内容哈希
   门控（`src/registry.ts:643-661`），否则空转对账。

**本提案的定位转变**：插件从"Claude 兼容层"转为"**DSH 自有 JSON 配置层**"——
读 DSH 自己的 JSON 文件（方言沿用生态通行的 `mcpServers` 写法），CC 的
`<projectRoot>/.mcp.json` 降级为遗留只读来源，`~/.claude.json` 不再读取。

## 2. 生态调研（2026-09）

| 工具 | 项目级 | 用户级 | 方言 | 关键做法 |
|---|---|---|---|---|
| **Cursor** | `.cursor/mcp.json`（提交进 git） | `~/.cursor/mcp.json` | `{"mcpServers":{…}}`，stdio `command`/`args`/`env`；远程 `url`/`headers`（无 `type`） | **两者合并、项目级优先**；无 profile 概念 |
| **Codex** | 未落地（[#2554](https://github.com/openai/codex/issues/2554)、[#23487](https://github.com/openai/codex/issues/23487)、[PR #3864](https://github.com/openai/codex/pull/3864)） | `~/.codex/config.toml` | TOML `[mcp_servers.<name>]`：`command`/`args`/`env`/`url`/`bearer_token_env_var`/`enabled` | 有 `codex mcp add/list/get/remove` 子命令；`[profiles.*]` 配置档（[#2800](https://github.com/openai/codex/issues/2800) 申请 `mcp --profile`） |
| **opencode** | `opencode.json(c)`（项目根） | `~/.config/opencode/opencode.json` | 主配置 `mcp` 键：`type: local\|remote`、`command` 数组、`environment`、`enabled` | 优先序：远程 → 全局 → `OPENCODE_CONFIG` → 项目 → `.opencode/` → `OPENCODE_CONFIG_CONTENT`；支持 `{env:VAR}`/`{file:…}` |
| **Claude Code** | `.mcp.json`（项目根） | `~/.claude.json`（单体状态文件） | `mcpServers`，含 `type: sse/http` | 另有 local scope `projects.<cwd>.mcpServers` |

来源：[Cursor MCP](https://cursor.com/help/customization/mcp.md)、
[Codex MCP Servers](https://mintlify.wiki/openai/codex/configuration/mcp-servers)、
[opencode MCP Servers](https://mintlify.wiki/anomalyco/opencode/mcp-servers)、
[opencode Config](https://mintlify.wiki/anomalyco/opencode/config)。

**结论**：Cursor 的"工具自有目录里的 `mcp.json` + 家目录同名文件、项目级优先"就是
本提案的目标形态；**没有任何一家读别的工具的状态文件**；**没有任何一家做 profile
级 MCP 文件**（Codex 的 `[profiles.*]` 最接近）。

## 3. 提案内容与评估

### 3.1 不读 `~/.claude.json` —— 采纳

- 生态一致；同时可**删除** `serversHash` 哈希门、`claudeUserLayerConflict` 冲突闩与
  两个开关（`DSH_MCP_READ_CLAUDE_USER`、`DSH_MCP_IGNORE_CLAUDE_JSON`），
  兑现 `src/cc-file.ts:35-36` 的 `TODO(v0.4)`。
- 用户层的风险从"读外来凭据文件"降为"读 DSH 自有文件"。

### 3.2 JSON 写入 DSH 自有位置 —— 采纳，但两处需修正

**修正 A：文件命名去掉前导点。** 建议 `<projectRoot>/.dsh/mcp.json`、`~/.dsh/mcp.json`、
`~/.dsh/profiles/<name>/mcp.json`：

- Cursor 先例是目录带点、文件不带点（`.cursor/mcp.json`）；
- 与同目录 `mcp.yml` 命名对称；
- 避免与项目根遗留 `.mcp.json` 在文档/报错中混淆。

**修正 B：JSON 没有注释，现有"受管块"机制失效（见 §4.2）。** 必须先定写入策略。

**实现利好**：JSON 是 YAML 1.2 的子集，现有 `yaml` 依赖（`parseDocument`）可直接
解析 `.json`，报错定位、`!!js` 标签拒绝、`KEY: null` 删除语义等既有能力可复用。

### 3.3 项目根 `.mcp.json` 降为次级读取 —— 采纳，但保留独立层名

保留为**独立层**（`cc-project` 或改名 `legacy-project`），不要与新 DSH 项目层合并：
`dsh-mcp list`、`.dsh/.mcp-diag.json` 的 `shadowedByYml`/`shadowedByProject` 与告警
都靠 `source` 归因。`DSH_MCP_IGNORE_MCP_JSON=1` 继续只管这一个遗留文件。

### 3.4 CLI 增加写入格式开关 —— 采纳，建议 `flag > env > 自动探测`

- 环境变量：`DSH_MCP_CLI_FORMAT=yml|json`（与 `DSH_MCP_*` 命名一致）；
- 显式覆盖：`--format yml|json`；
- **自动探测**：目标项目已有哪个文件就写哪个；两个都存在 → 报错要求显式 `--format`
  （否则极易产生"yml 一条、json 一条"的双真相）；
- `--scope user` 需明确写 `~/.dsh/mcp.yml` 还是 `~/.dsh/mcp.json`；
- 文档位置：`README.md` CLI 小节、`docs/README.zh.md` 对应段落、`dsh-mcp --help`
  打印当前生效值。

### 3.5 层名 cc-* → dsh-* —— 采纳，但**不得硬编码 web/headless**

- profile 名用户自定义（`tui`、`acp`、自建 profile 均合法），固定 `dsh-web-user`/
  `dsh-headless-user` 会让其他 profile 的配置被静默忽略；
- 建议层名 **`dsh-profile-user`**（诊断附 `profile: <name>` 属性），路径
  `~/.dsh/profiles/<name>/mcp.json`（注意 **profiles 复数**）。

**profile 名可发现性（已核查）**：

- 宿主环境**没有** `DSH_PROFILE`（实测宿主进程仅 `DSH_HOME`/`DSH_SESSION_ID`/
  `DSH_SESSION_JSONL`/`DSH_SHELL`/`DSH_WEB_URL`）；
- 但可推导：`dsh-app-boot` 的 `boot()` 设 `ctx.baseUrl = dirname(absoluteConfigPath)`，
  profile 根配置固定为 `~/.dsh/profiles/<name>/cordis.yml`
  （源码常量 `PROFILE_ROOT_FILENAME = "cordis.yml"`），根 include entry 的
  `config.path` 亦指向它；宿主另有 `ctx.provide("dshHomePath", …)` 服务；
- **属宿主内部细节**：按此实现并保留"取不到 profile 名则只用通用用户层"的降级路径，
  同时向 dsh 提 issue 要一等公民的 `DSH_PROFILE` 或 profile 服务。

## 4. 两个必须先定的语义决策

### 4.1 用户层/Profile 层：扇出（fan-out）还是全局（global）？

| | 扇出 | 全局 |
|---|---|---|
| 装载 | 每条用户行并入**每个已知项目**，各挂一个 mcp-client 实例 | 宿主级只挂一个实例（profile patch 行 / bundle 层） |
| 进程 | N 个项目 = N 个 stdio 子进程 / N 条 HTTP 连接 | 1 个，所有会话共享 |
| cwd | 项目行=项目根；用户行=宿主 cwd（`src/registry.ts:839-841`） | 由全局行配置决定 |
| 会话可见性 | 经 `denySetFor` 按会话项目 deny 其他项目 | 全局可见，无按项目隔离 |
| 热重载 | 文件改动即收敛 | 需改 profile patch 并重启（`patchReload: startup`） |
| 现状 | `user-yml`、`cc-user` 是此语义（`src/registry.ts:677-684` 扇出告警） | `globalNames()`（`src/index.ts:25-46`）只做冲突判定，**不装载** |

**提案默认**：`dsh-user` / `dsh-profile-user` 采用**扇出**语义（与现有用户层一致、
改动最小），保留一次性扇出告警。若希望"profile 级 = 只挂一次"，需要单独实现全局
装载与工具可见性，并改名为 `dsh-<profile>-global` 之类以消除歧义。

### 4.2 JSON 文件的写入策略（受管块替代方案）

现有 `src/mcp-file.ts` 的契约是 begin/end 注释标记之间为受管 YAML 列表、**标记外
逐字节保留** + 锁 + 原子写。JSON 无注释，三选一：

| 方案 | 代价 | 建议 |
|---|---|---|
| **CLI 独占整个文件**：只认 `mcpServers` 键，写入时保留其他顶层键、格式归一化 | 手写格式/注释丢失 | ✅ v0.4 起步方案 |
| **JSONC + 注释保留式编辑**（`jsonc-parser` 的 `modify`/`applyEdits`） | 新增依赖（与 CLI 零依赖现状冲突） | 若要保住"块外逐字节保留"承诺时 |
| 受管键 + 用户键分离 | 语义混乱 | ✗ |

### 4.3 同项目两份原生文件的优先序

`.dsh/mcp.yml`（CLI 默认写入）与 `.dsh/mcp.json`（"推荐读取路径"）并存会制造两个
真相源。二选一并在文档中固定：

- **A（推荐 v0.4）**：`mcp.yml` > `mcp.json`，与"默认写入 yml"一致；
- **B**：`mcp.json` > `mcp.yml`，并把 CLI 默认写入目标也改为 json。

## 5. 建议层序（待裁决）

```
1. <projectRoot>/.dsh/mcp.yml                       原生 YAML（CLI 默认写入；面板兼容）
2. <projectRoot>/.dsh/mcp.json                      原生 JSON（dsh-project，推荐读取路径）
3. <projectRoot>/.mcp.json                          遗留 CC 项目文件（只读；cc-project/legacy-project）
4. ~/.dsh/profiles/<当前 profile>/mcp.json          用户层（dsh-profile-user，扇出）
5. ~/.dsh/mcp.yml                                   原生用户层（legacy user-yml）
6. ~/.dsh/mcp.json                                  通用用户层（dsh-user，扇出）
```

三键影子去重（精确名 / 归一名 / 服务身份，`src/registry.ts:272-293`）可吸收跨层
重复；层数增加不改变"同服务只装高优先级一条"的既有规则，但 `dsh-mcp list` 与诊断
必须展示新层名与路径。

## 6. 落地清单

| 项 | 内容 |
|---|---|
| 版本 | v0.4.0（破坏性：层名、`source` 值、两个开关移除） |
| 代码 | `cc-file.ts` 拆为 `json-file.ts`（通用 JSON 读取）+ 遗留 CC 读取；`model.ts` 增 JSON 方言 schema（`mcpServers`）；`cli.ts` 增 `--format`/`DSH_MCP_CLI_FORMAT` 与 JSON 写入器；`registry.ts` 删哈希门、扩层、改 `SOURCE_RANK`/`McpRowSource` |
| 写入 | 先定 §4.2 策略，再实现原子写 + 锁（复用 `writeFileAtomic`/`withPatchLock`） |
| 测试 | `test-cc-file.mjs` 拆为 JSON 读取 / 遗留 CC / 优先序 / 写入器；新增 profile 名推导与降级用例 |
| 文档 | README + `docs/README.zh.md` 层序表与 env 变量；`AGENTS.md` 目录结构与关键行为约定同步 |
| 安全 | 新 JSON 文件同样只落 `${VAR}` 字面量、装载时展开；stdio 行仍是可执行代码载体；用户层保留扇出告警 |
| 建议 | 本仓库 `.gitignore` 改为只忽略 `.dsh/.mcp-diag.json`，让 `mcp.yml`/`mcp.json` 可提交 |

## 7. 兼容与迁移

- 依赖 cc-user 层的用户：v0.4 起该层不存在，需把条目迁到 `~/.dsh/mcp.json` 或
  `~/.dsh/profiles/<name>/mcp.json`（迁移脚本可作为 v0.4 的可选项）。
- 只写 `.mcp.json` 的项目：继续被读取（层 3），无动作。
- 诊断字段 `shadowedByYml`/`shadowedByProject`/`shadowedIdentity` 结构不变，`source`
  枚举值变化；建议 v0.4 的诊断/CLI 同时接受旧值一个版本，便于脚本过渡。

## 8. 待决问题清单

1. §4.1：`dsh-profile-user` 取扇出还是全局？
2. §4.2：JSON 写入采用 CLI 独占、还是引入 JSONC 注释保留编辑？
3. §4.3：`mcp.yml` 与 `mcp.json` 谁优先（是否同时改默认写入目标）？
4. §3.5：是否接受"从 `ctx.baseUrl`/根 include 路径推导 profile 名"，还是先向 dsh
   要 `DSH_PROFILE`？
5. 是否保留 `<projectRoot>/.mcp.json` 的读取（本案默认保留为层 3）？
