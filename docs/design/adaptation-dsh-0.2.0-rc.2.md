# 适配记录：dsh v0.2.0-rc.2

[← 返回 README](../README.zh.md) ｜ 相关：[dsh 0.1.6-alpha.2 适配方案](adaptation-dsh-0.1.6-alpha.2.md) ·
[dsh 0.1.5-rc.2 适配记录](adaptation-dsh-0.1.5-rc2.md) ·
[v0.7.0 发布说明](../releases/v0.7.0.md)

**记录日期**：2026-09-30 ｜ **插件**：`dsh-project-mcp-manager` v0.7.0
**宿主**：本机 `dsh` 0.2.0-rc.2（`dsh --version`）。对照源码
`D:\Projects\Agent\deepseek-harness`，标签 `dsh-v0.1.5-rc.2` → `dsh-v0.2.0-rc.2`
（发布包 `@deepseek-ai/dsh-mcp-client@0.2.0-rc.2`、cordis 4.0.4、
cordis-plugin-include 1.0.9、cordis-plugin-loader 1.0.5）。
实机只用 **headless** profile（`~/.dsh/profiles/headless` 以 junction 链到本仓库）。

**结论**：官方没有接过本插件的项目级发现、按会话 cwd 隔离和 `dsh-mcp` CLI。
v0.6.0 的依赖范围解析不到 0.2.0 的 client，且 `agent/session-start` 已删除、
`maxInstructionBytes` 会被静默丢掉。v0.7.0 按这三处对齐后，headless 实机可以
装载探针并调用 `mcp__compatprobe__probe`。

---

## 1. 官方已经覆盖、本插件不再独占的能力

对照 `packages/mcp` 与 profile 装配（0.1.5-rc.2 之后、0.2.0-rc.2 之前落地，
0.2.0-rc.2 相对 0.1.6-alpha.2 的 client 源码几乎只剩类型收紧）：

| 能力 | 官方现状 | 本插件 |
|---|---|---|
| 全局 / 每 profile 声明 MCP | `$DSH_HOME` 与 profile 的 Cordis patch，一行一个 `dsh-mcp-client` | 用户层 yml/json 仍是更短的写法，挂载后仍是官方 client |
| profile 配置热重载 | 官方 HMR，作用在 profile 配置层 | 不替代。项目文件仍由本插件 chokidar 监听 |
| 运行时加服务器 | `plugin_manager` 与 configuration-only bundle | 不替代 |
| 协议、分页、重连、instructions | client 内建；SDK `@modelcontextprotocol/client@2.0.0` | 不碰协议 |
| MCP resources 与服务器提示节 | `mcp-resources` 进 base bundle；client 经 `registerServerContext` 登记 | 升级到同一份 client 后，本插件挂上的服务器自动出现在资源工具里 |
| 工具名 | 干净时仍是 `mcp__<serverName>__<rawName>`；不合函数名契约时追加 12 hex | deny 展开仍用已注册的精确名 |

源码与文档里没有 `<projectRoot>/.dsh/mcp.yml`、`.dsh/mcp.json` 或项目级
`.mcp.json` 的装载器。`docs/user/guide/mcp-memory.md` 仍是 profile overlay。
会话 cwd 只用于文件工具和工作区指令，没有「cwd → 该项目 MCP 工具可见性」的映射。

本插件继续留下的三件事：

1. 项目级配置发现（含只读遗留 `.mcp.json`）与六层影子合并。
2. 按会话 cwd 的 `tools.restrict({ deny })`。
3. MCP 专用格式与 `dsh-mcp` CLI。

---

## 2. 对插件有影响的破坏性变更

| 点 | 0.1.5-rc.2 → 0.2.0-rc.2 | 处置 |
|---|---|---|
| 依赖范围 | `^0.1.5-rc.1` 解析不到 `0.2.0-rc.2`（预发布必须同一 major.minor.patch 元组） | 下限改为 `^0.2.0-rc.2`。0.1.5 用户留在 v0.6.0 |
| `agent/session-start` | 事件删除。`agent/created` 变为 `{ agent, source: 'startup'\|'resume'\|'clear'\|'compact', signal? }`，`ctx.serial` 派发 | 删除该监听。现有 `agent/created` 只解构 `agent`，仍然成立。构造时 `liveAgents()` 补扫保留 |
| Config | 两个传输各增加可选 `maxInstructionBytes`（int ≥ 1，默认 32768）。超限拒绝这一次连接 | schema / `toOfficialConfig` / JSON 透传。缺省不写键。CLI 不加参数 |
| cordis | 4.0.2 → 4.0.4。include 1.0.7 → 1.0.9，loader 1.0.3 → 1.0.5 | 开发依赖 `^4.0.4`。`ctx.plugin` / `ctx.on` / `ctx.provide` / `config.patches` 仍在 |
| client peer | 发布包 peer 钉死 `0.2.0-rc.2`（tools、scope、timeout、attachment、llm、subprocess；resources 与 system-prompt 可选）。直接依赖换成 schemastery、`dsh-util-values`、MCP client SDK 2.0.0 | 锁文件跟着解析。pnpm 12 把这批 rc 写入 `minimumReleaseAgeExclude` |
| stdio 环境 | 子进程环境 = 清洗后的父环境 + 配置 `env`。名字匹配凭据或 `DSH_*` 的环境变量不继承 | 文档说明。本插件展开进 `env` 的值仍是显式配置 |
| 结果形状 | 不再接受 legacy `toolResult`；无 tools capability 的服务器保持连接、工具集为空 | 不改装载逻辑。调用期错误仍不经过本插件 |
| `apply` | 等待初次连接。`failOnStartupError: false` 时失败只打日志并进入官方重连，fiber 仍 resolve | 与现有 `trackMount` 一致：fiber resolve 即 `active`，0 工具的首连交给官方重连 |
| `tools.restrict` / `schemas()` | 仍要求 agent 作用域上的精确工具名；`schemas()` 多了可选 `deferLoading` | 本插件本来就走 `agent.ctx.tools.restrict` 并按 `name` 读 schema |
| `session.header.cwd` | 仍在 | 项目发现路径不变 |
| 传输集合 / serverName / `MAX_TIMER_DELAY_MS` | 仍是 `stdio` \| `streamable-http`，`[A-Za-z0-9_-]{1,32}`，`2147483647` | 常量注释改为 0.2.0-rc.2，值未改 |

0.2.0-rc.1 → 0.2.0-rc.2 的 client 源码差异是一处类型断言，没有新的配置字段。

---

## 3. 实机（headless profile）

`dsh --profile headless --dump-config` 合成树含 `# == dsh-project-mcp-manager` /
`- id: mcp-project`。插件包是 junction：`link:D:/Projects/Agent/dsh-mcp-project`。

临时 git 仓库 `compatprobe`（stdio 探针，`initialize` 带回 `instructions: "hello from probe"`，工具 `probe` → `pong:compat-020`）：

| 检查 | 结果 |
|---|---|
| `maxInstructionBytes: 16` | 子进程收到 `initialize` 与 `notifications/initialized`，**没有** `tools/list`（超限发生在同步工具之前）。`failOnStartupError` 默认 false，诊断仍记 `active` |
| `maxInstructionBytes: 65536` | 收到 `tools/list`。模型调用 `mcp__compatprobe__probe` → `pong:compat-020` |
| mcp-resources 协同 | 同一轮里 `list_mcp_resources` 的 `server` 参数接受 `compatprobe`（共享资源工具能看见本插件挂上的服务器） |
| 单测 | `pnpm test` 六套全绿 |

未改本机 `~/.dsh` 的模型设置。headless 使用当前默认模型完成了上述调用。

---

## 4. 代码改动

- `package.json`：`dsh-mcp-client` `^0.2.0-rc.2`，`cordis` `^4.0.4`，版本 0.7.0。
- `src/registry.ts`：去掉 `agent/session-start`。
- `src/model.ts`、`src/json-file.ts`、`src/json-write.ts`：透传 `maxInstructionBytes`。
