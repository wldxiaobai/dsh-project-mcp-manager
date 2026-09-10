# 适配记录：dsh v0.1.5-rc.1

[← 返回 README](../README.zh.md) ｜ 相关：[dsh v0.1.2-rc.1 适配记录](adaptation-dsh-0.1.2-rc1.md)

**记录日期**：2026-09-10 ｜ **被测插件**：`dsh-project-mcp-manager` v0.4.2
**宿主**：`@deepseek-ai/dsh@0.1.5-rc.1`（自带 `dsh-mcp-client@0.1.5-rc.1`、cordis 4.0.2、
cordis-plugin-loader 1.0.3、cordis-plugin-include 1.0.7）

**结论**：功能可用，无 API 断裂。装载、生效名、工具注册与调用、`tools.restrict`
在 0.1.5-rc.1 上全部实测通过。**1.1 的依赖漂移已解决**（`@deepseek-ai/dsh-mcp-client`
升到 `^0.1.5-rc.1`，peer 全部解析到 0.1.5-rc.1，与宿主同版）。headless 端到端
LLM 任务被本机 `~/.dsh/settings.yaml` 的 `reasoningEffort: high` 挡住
（qwen3.8-flash 不支持），与插件无关。

---

## 1. 待处理事项

### 1.1 依赖版本漂移：插件仍在跑 mcp-client 0.1.2-rc.1 —— 已解决

**现象**：`package.json` 声明 `@deepseek-ai/dsh-mcp-client@^0.1.2-rc.1`，仓库
`node_modules` 实际解析到 **0.1.2-rc.1**（连带 peer `dsh-tools` / `dsh-scope` /
`dsh-timeout` 同为 0.1.2-rc.1），而宿主是 0.1.5-rc.1 → 同一进程内存在两份
dsh-mcp-client 代码。

**关键更正**：`^0.1.2-rc.1` **不会**升级到 `0.1.5-rc.1`——npm semver 要求带
prerelease 的候选版本与比较符的 major.minor.patch 元组相同，实测
`npm view "@deepseek-ai/dsh-mcp-client@^0.1.2-rc.1" version` 只解析出
`0.1.2-rc.1`。所以必须显式改范围。

**升前实测**：插件自带的 0.1.2-rc.1 客户端对 0.1.5 形态的 `tools.register` /
`restrict` 仍能装载并调用；宿主自带的 0.1.5-rc.1 客户端对同一探针同样成功。
功能上可共存，但进程内双副本与 peer 漂移仍是风险。

**处置（已完成）**：升到 `^0.1.5-rc.1` 后重装，插件侧 `dsh-mcp-client` 与其
全部 peer（`dsh-attachment` / `dsh-llm` / `dsh-scope` / `dsh-subprocess` /
`dsh-timeout` / `dsh-tools`）解析到 **0.1.5-rc.1**，与宿主同版。pnpm 12 为这
批 prerelease 写入 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`（否则
供应链门禁会挡住刚发布的 rc）。升后 `pnpm test` 六套全绿，隔离实机复验
`mcp__compat-probe__probe` → `pong:compat-015`，插件与宿主解析版本对齐。

### 1.2 本机 headless LLM 任务被默认模型设置挡住（非插件）

**现象**：`dsh --profile headless "<任务>"` 立即退出：

```
dsh: UNSUPPORTED_REASONING_EFFORT: provider "qwen-token-plan-cn" model "qwen3.8-flash" does not support reasoning effort "high"
```

来源是 `~/.dsh/settings.yaml` 的 `agent-default-model.reasoningEffort: high`。
dump-config 里合成默认仍是 `deepseek-official` / `deepseek-flash`，被 settings
层覆盖。未改用户设置；改用隔离脚本完成装载/调用验证（见 §3）。

---

## 2. 兼容性核对结果（静态）

| 插件依赖点 | 0.1.5-rc.1 现状 |
|---|---|
| `tools.restrict({ deny })`、`ToolRestriction{allow,deny}`、`tools.schemas(scope?)` | 签名未变；unknown names / 空过滤仍失败 |
| `agents` 服务名、`list()`、`isOwnedBy(id, owner)` | 均未变；`inject = ["tools","agents"]` 仍可满足 |
| `agent/created`、`agent/disposed`、`agent/session-start` | 事件名与 payload `{ agent }` 仍在 |
| cordis 4.0.2 | 与 0.1.2 线相同，无升级 |
| mcp-client `Config` | 字段无增删（`serverName`/`transport`/`command`/`args`/`env`/`cwd`/`url`/`headers`/`toolCallTimeoutMs`/`failOnStartupError`/`reconnect`） |
| `serverName` 约束 `[A-Za-z0-9_-]{1,32}` | 未变 → `effectiveServerNames()` 截 32 仍安全 |
| 工具命名 `mcp__<serverName>__<rawName>` | 未变 |
| `MAX_TIMER_DELAY_MS` | 宿主 `dsh-timeout` 仍是 `2147483647` |
| `globalNames()` 读 `entry.config.patches` | include 1.0.7 仍有 `patches`；`dump-config` 出现 `# == dsh-project-mcp-manager` / `- id: mcp-project` |
| mcp-client `inject` | 仍是 `["tools"]` |
| mcp-client 0.1.2 → 0.1.5 实现 diff | `lib/index.js` 仅 +7/−2：`tools/list` 增加重复 continuation cursor 校验，不影响本插件发出的配置 |

`pnpm test` 全绿（model 27 / mcp-file 7 / json-file 9 / json-write 6 / registry 34 / cli 18）。

---

## 3. 实测方法与结果

### 3.1 安装/激活（headless profile）

`~/.dsh/profiles/headless/package.json` 已是：

```json
"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-project-mcp-manager"]
"dependencies": { "dsh-project-mcp-manager": "link:D:/Projects/Agent/dsh-mcp-project" }
```

`dsh --profile headless --dump-config` 合成树含 `# == dsh-project-mcp-manager` /
`- id: mcp-project`。0.1.2 记录的「必须进 bundles」规则在 0.1.5 上仍然成立。

### 3.2 隔离实机：装载 + 调用（不经 LLM）

在本仓库 `.dsh/`（gitignore）写入最小 stdio 探针 `compat-probe`（`probe` →
`pong:compat-015`），用隔离脚本走插件真实的 `ctx.plugin(mcp-client)` 路径：

升前插件解析 0.1.2-rc.1、升后与宿主对齐 0.1.5-rc.1。升后复验：

| 检查 | 结果 |
|---|---|
| 插件解析到的 mcp-client | 0.1.5-rc.1（与宿主对齐） |
| 宿主自带 mcp-client | 0.1.5-rc.1 |
| 插件客户端 mount + call | `mcp__compat-probe__probe` → `pong:compat-015` |
| 宿主客户端 mount + call | 同上 |
| `restrict({ deny: [精确名] })` / 拒绝 unknown | 通过 |
| `ProjectMcpRegistry` 读项目 `.dsh/mcp.yml` 再 mount/call | `scan` → `attempt` → `active`，调用返回 `pong:compat-015` |

诊断（第二次成功跑）：`scan ok:true rows:[compat-probe]` → `attempt` →
`active`（`effectiveName: compat-probe`，目录内唯一故未改名）。

### 3.3 未覆盖

- headless 经模型的两步任务（本机 settings 的 `reasoningEffort: high` 使进程
  在创建 Agent 前退出；未改用户设置）。
- 热重载 watcher 与跨项目 deny 隔离未在 0.1.5 宿主进程里常驻复跑（单测仍覆盖）。

---

## 4. 建议

1. **升依赖已完成**，无需再改范围。
2. 若要补 headless LLM 路径：先把本机 `agent-default-model.reasoningEffort`
   改成当前模型支持的值（或去掉），再跑两步任务。这是宿主设置问题，不是插件缺陷。
