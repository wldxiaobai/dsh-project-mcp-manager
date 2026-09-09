# 适配记录：dsh v0.1.2-rc.1

**记录日期**：2026-09-09 ｜ **被测插件**：`dsh-project-mcp-manager` v0.3.1
**宿主**：`@deepseek-ai/dsh@0.1.2-rc.1`（自带 `dsh-mcp-client@0.1.2-rc.1`、cordis 4.0.2、
cordis-plugin-loader 1.0.3、cordis-plugin-include 1.0.7）

**结论**：功能可用，无 API 断裂。装载、生效名、工具注册与调用、诊断在 0.1.2-rc.1 上
全部实测通过；需要处理的是**安装/激活流程**与**依赖版本漂移**两件事。

> **状态更新（v0.4.0）**：1.1 的安装/激活流程已写入 `README.md`、`docs/README.zh.md`
> 与 `AGENTS.md`（dsh ≥ 0.1.2 只把 `dsh.profile.bundles` 里的包当 profile 层，纯
> `pnpm link` 不会激活）。**1.2 的依赖漂移已解决**（commit `55bd07f`：
> `@deepseek-ai/dsh-mcp-client` 升到 `^0.1.2-rc.1`，其 peer 全部解析到 0.1.2-rc.1，
> `dsh-scope` 取代 `dsh-invariants`；另以 `pnpm-lock.yaml` 取代陈旧 `package-lock.json`）。
> 1.3 的首轮可见性未改动。

---

## 1. 待处理事项（本次记录的重点）

### 1.1 ⚠️ 安装流程：`pnpm link` 不再自动激活插件

**现象**：在 profile 目录执行 `pnpm link <本仓库>` 后，`dsh --profile headless
--dump-config` 的合成配置里**没有** `mcp-project` 行；插件处于「装了但没激活」状态。

**原因**：0.1.2 的装载栈只认 `dsh.profile.bundles`（`dsh-app-boot` 的
`loadProfile` 按该列表合成 bundle patch）。把包写成 profile 的 `dependencies`
**不会**自动加入 `bundles`——只有 `dsh plugin --profile <p> <pnpm 子命令>` 这条路径
会跑 reconcile，把「声明了 `dsh.bundle` 的依赖」补进 `bundles`。

**处置**：

```powershell
# 方式一（推荐）：dsh plugin 一次性完成安装 + 注册
dsh plugin --profile <p> add dsh-project-mcp-manager@latest

# 方式二：已用 pnpm link/add 装好包后，补跑一次任意 dsh plugin 子命令触发 reconcile
dsh plugin --profile <p> list --depth 0
```

**待改**：`README.md` / `docs/README.zh.md` 的「方式二/方式三（本地开发安装）」需要
补上「link 后必须再跑一次 `dsh plugin` 子命令」这一步；`AGENTS.md`「本地联调」一节
目前只写了 `pnpm add link:<路径>`，同样需要补。

**当前机器上的实际状态**：`headless` profile 已 link **且已注册**（可用）；
`web` profile 只有 junction、`bundles` 里**没有**插件——即当前 GUI 宿主并未装载本插件
（本会话看不到任何 `mcp__` 工具正是这个原因）。

### 1.2 依赖版本漂移：插件仍在跑 mcp-client 0.1.1-rc.2 —— 已解决

**现象**：`package.json` 声明 `@deepseek-ai/dsh-mcp-client@^0.1.1-rc.2`，仓库
`node_modules` 实际解析到 **0.1.1-rc.2**（连带 `dsh-agent` / `dsh-tools` / `dsh-session`
等副本同为 0.1.1-rc.2），而宿主是 0.1.2-rc.1 → 同一进程内存在两份 dsh-* 代码。

**关键更正**：`^0.1.1-rc.2` 这个范围**不会**升级到 0.1.2-rc.1——npm semver 要求
带 prerelease 的候选版本与比较符的 major.minor.patch 元组相同，实测
`npm view "@deepseek-ai/dsh-mcp-client@^0.1.1-rc.2" version` 只解析出 `0.1.1-rc.2`。
所以必须显式改范围。

**处置（已完成，commit `55bd07f`）**：升到 `^0.1.2-rc.1` 后重装，插件侧
`dsh-mcp-client` 与其全部 peer（`dsh-attachment`/`dsh-llm`/`dsh-scope`/
`dsh-subprocess`/`dsh-timeout`/`dsh-tools`）解析到 **0.1.2-rc.1**，cordis 4.0.2，
与宿主同版；`dsh-scope` 取代 0.1.1 线的 `dsh-invariants`。同批还以
`pnpm-lock.yaml` 取代了停留在 v0.1.1 的 `package-lock.json`（commit `dcbe846`），
安装可复现。重装后 `pnpm test` 六套全绿，headless 实机复验
`mcp__deps-probe__probe` → `pong:deps-probe`。

### 1.3 可选修复：交互会话首轮看不到项目 MCP

**现象**：单步 headless 任务里模型答 `NO_MCP_TOOL`；两步任务（先跑一次工具再列）里
模型看到并成功调用 `mcp__link-probe__probe`。

**时间线证据**（`.dsh/.mcp-diag.json`，同一次运行）：进程启动 `21:16:18.96` →
`attempt 21:16:21` → `active 21:16:21`（74 ms 内 settle）。首轮模型请求在 mount
settle 之前发出，靠下一次 sweep 才补上——与 `src/registry.ts:968` 的既有设计一致，
交互会话从第二条消息起正常。

**若要去掉这个空窗**：`src/registry.ts:854` 的 `ctx.plugin(...)` 已持有 fiber，可在
`agent/session-start` 的对账里 await 其 settle 后再返回（或让 agent 首轮等待该
对账链）。属行为变更，需先确认是否接受「首轮更慢但必可见」的取舍。

---

## 2. 兼容性核对结果（静态）

| 插件依赖点 | 0.1.2-rc.1 现状 |
|---|---|
| `tools.restrict({ deny })`、`ToolRestriction{allow,deny}`、`tools.schemas(scope?)` | 逐行一致，无变化 |
| `agents` 服务名、`list()`、`isOwnedBy(id, owner)` | 均未变；`inject = ["tools","agents"]` 仍可满足 |
| cordis 4.0.1 → 4.0.2 | 9 个 `.d.ts` 零 diff；插件编译产物里唯一的宿主运行时 import 仍是 `@deepseek-ai/dsh-mcp-client`（cordis 为纯类型 import，已擦除） |
| mcp-client `Config` | 字段无增删（`serverName`/`transport`/`command`/`args`/`env`/`cwd`/`toolCallTimeoutMs`/`failOnStartupError`/`reconnect`），仅入参类型放宽 |
| `serverName` 约束 `[A-Za-z0-9_-]{1,32}` | 未变 → `effectiveServerNames()` 截 32 仍安全 |
| `reconnect` 语义 | `connection.d.ts` 零 diff |
| 工具命名 `mcp__<serverName>__<rawName>` | 未变 |
| `MAX_TIMER_DELAY_MS` 镜像（`src/model.ts:49`） | 与宿主 dsh-timeout 的 `2147483647` 仍一致 |
| `globalNames()` 读 `entry.config.patches`（`src/index.ts:31`） | include 1.0.7 仍有 `patches?: PatchOptions[]` 与 `insert` 行格式 |

`npm test` 全绿（model 25 / mcp-file 6 / cc-file 9 / registry 29 / cli 14）。

## 3. 实测方法与结果（复现步骤）

1. `cd $env:USERPROFILE\.dsh\profiles\headless && pnpm link <本仓库>` → junction 建立，
   `dump-config` 无插件行（见 1.1）。
2. `dsh plugin --profile headless list --depth 0` → `bundles` 补入
   `dsh-project-mcp-manager`，`dump-config` 出现 `# == dsh-project-mcp-manager` /
   `- id: mcp-project`。
3. 在项目 `.dsh/mcp.yml` 写入一个最小 stdio MCP 服务器（`link-probe`），
   在项目根执行 `dsh --profile headless "<任务>"`：
   - 单步任务 → `NO_MCP_TOOL`；
   - 两步任务 → 模型列出并调用 `mcp__link-probe__probe`，raw 输出 `pong`；
   - diag 记录 `scan ok:true rows:[link-probe]` → `attempt` → `active`。

**未覆盖**：热重载（文件改动的 watcher 收敛）与按会话 deny 隔离未在 0.1.2-rc.1 实跑
验证（需要常驻会话，且当前 GUI 宿主的 web profile 未激活插件）；既有单测覆盖的是
0.1.1-rc.2 依赖下的行为。
