# 配置格式

[English](format.md) | 中文

[← 返回 README](../README.zh.md) ｜ 相关：[配置来源与分层](layers.zh.md) · [`${VAR}` 展开](env-expansion.zh.md) · [CLI `dsh-mcp`](cli.zh.md) · [Lazy 设计记录](../design/lazy-mcp.md)

插件读取两种方言：**原生 YAML 受管块**（`<projectRoot>/.dsh/mcp.yml`、
`~/.dsh/mcp.yml`、`~/.dsh/profiles/<name>/mcp.yml`）与
**JSON 方言**（`<projectRoot>/.dsh/mcp.json`、`~/.dsh/mcp.json`、
`~/.dsh/profiles/<name>/mcp.json`，以及只读的遗留 Claude Code 项目文件
`<projectRoot>/.mcp.json`）。哪个文件属于哪一层见
[配置来源与分层](layers.zh.md)。[设置页](settings-ui.zh.md)只写受管 yml，
经过与 CLI 相同的受管块和锁。

## 加载模式

`mode` 是每行的可选字段：`eager`（缺省）或 `lazy`；省略即 Eager。原生 YAML 把它写在行的
`config` 里，JSON 方言写在条目顶层：

```yaml
    - id: panel-mcp-gitlab
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: gitlab
        mode: lazy
        transport: stdio
        command: npx
```

```json
{ "mcpServers": { "gitlab": { "mode": "lazy", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-gitlab"] } } }
```

`mode` 只在本插件里生效，不会传给 `@deepseek-ai/dsh-mcp-client`。`dsh-mcp` 没有
`--mode` 参数；在文件里写这个键，或用[设置页](settings-ui.zh.md#加载模式)切换。目标行
没有有效连接配置时（例如手写的、只有 id 的 disabled 占位），切换会被拒绝，文件不动。

| 方面 | `eager` | `lazy` |
|---|---|---|
| 挂载时连接 | 是 | 否，首次代理调用时连接 |
| 工具注册 | 每个工具注册为 `mcp__<生效名>__<工具名>` | 不注册远端工具；用全局代理 `mcp_search` / `mcp_describe` / `mcp_call` |
| 服务器 instructions / DSH Resources | 支持 | 不支持，需要时用 Eager |
| 按单个已注册工具名配置的宿主策略 | 支持 | 不支持；只受行级 `tools.allow` / `deny` 约束 |
| `reconnect` / `failOnStartupError` | 官方重连与启动失败策略 | 不执行，下一次请求重试 |
| `maxInstructionBytes` | 由官方客户端执行 | 忽略（不读取 instructions） |
| `toolCallTimeoutMs` | 单次工具调用 | 单次工具调用；连接与工具列表使用独立的固定 30 秒发现超时 |
| 空闲 | 连接常驻 | 会话激活后连接常驻 |

每个会话首次通过 `mcp_search` 为目标服务器建立自己的连接，之后才可执行
`mcp_describe` 或 `mcp_call`。不带 `server` 的搜索会连接该会话所有可见的 Lazy
服务器，可能同时拉起多个进程。同一会话的请求共享连接和工具目录，目录在
`list_changed` 后失效。连接激活后在空闲或切换工作区时保持，直到会话结束、配置
被卸载或替换、插件退出。传输故障断开后，下一次请求可重连。首次发现尚未完成时，
最后一个等待者取消会先回收旧连接，再允许下一次连接。`mcp_search`的
`server` 参数用**生效名**（搜索结果里的 `server` 字段）；项目行发生命名冲突时可能是
`p<hash>_<原名>`，与文件里的 `serverName` 不同。

只有存在启用的 Lazy 行时，这三个代理才注册；没有可见 Lazy 挂载的会话会 deny 它们，
所以只用 Eager 的会话不会看到额外工具。

Lazy 沿用行级 `tools.allow` / `deny`：规则在搜索、描述和调用之前过滤工具；完整名
`mcp__<生效名>__<工具名>` 的规范化与 Eager 相同（64 字符上限、非法字符替换、损失性
规范化时追加 12 位哈希），所以同一份过滤规则在两种模式下含义一致。需要按单个注册工具
配置宿主策略、读取服务器 instructions 或使用 DSH Resources 时，请用 Eager。

## 原生 YAML：`<projectRoot>/.dsh/mcp.yml`

格式与 profile `cordis.patch.yml` 的受管块一致（begin/end 标记之间的 YAML
insert 列表），每行一个 MCP 服务器：

```yaml
# >>> dsh-project-mcp-manager:mcp:begin
- insert:
    - id: panel-mcp-gitlab
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: gitlab
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-gitlab']
        cwd: .            # 相对项目根解析
        toolCallTimeoutMs: 60000
        failOnStartupError: false
        reconnect:
          enabled: true
          initialDelayMs: 500
          maxDelayMs: 30000
          maxAttempts: 10
# <<< dsh-project-mcp-manager:mcp:end
```

`transport` 支持 `stdio`（command/args/env/cwd）与 `streamable-http`
（url/headers）。行加 `disabled: true` 即停用；行还可写 `config.mode`，见
[加载模式](#加载模式)。标记之外的内容逐字节保留。

条目级工具可见性（装载前从官方配置里剥掉；`deny` 优先）：

```yaml
        tools:
          allow: ["read_*"]
          deny: ["read_secret", "mcp__gitlab__delete_*"]
```

模式为 glob（`*`、`**`、`?`、`[…]`），可写裸工具名或完整
`mcp__<生效名>__<tool>`。完整名按装载器实际注册的**生效名**匹配
（`mcp__<effective>__…`），不是文件里的 `serverName`。项目行被改名
（`p<hash>_…`）后，写死的 `mcp__<原名>__foo` **不会**命中；请改用裸工具名，
或从 `dsh-mcp get` / 快照看生效名。非法字符类（例如 `[z-a]`）按条目告警一次且
永不匹配，不会静默失效。JSON 另接受 Gemini 的 `includeTools` → `allow`、
`excludeTools` → `deny`；与 DSH 的 `tools` 同时出现时以 `tools.allow` /
`tools.deny` 为准。Lazy 行也用同一份规则过滤按需目录，完整名匹配同样按生效名和
[加载模式](#加载模式)里的规范化处理。

**与原生 cordis 方言的差异**：`!!js` 标签（profile 的 `cordis.patch.yml` 由
Loader 求值的 js-yaml 表达式，如官方 README 示例 `env: { TOKEN: !!js
process.env.GITHUB_TOKEN }`）在项目文件里**不支持**——受管块内出现未解析
标签会使该文件整体报错跳过（写入 `$DSH_HOME/mcp-diag/<hash>.json` 并打日志），不会把
表达式当字面量字符串静默装载。`env`/`headers` 的值其余情况下是字面量，仅
`${VAR}` 引用会在装载时做串内插值（见 [`${VAR}` 展开](env-expansion.zh.md)）；
`disabled` 只能是 `true`/`false`。可选 `maxInstructionBytes`（整数 ≥ 1）是官方对
「带归属头的服务器 instructions」的字节上限；省略该键时用官方默认 32768。
超限由 `dsh-mcp-client` 拒绝这一次连接（`failOnStartupError` 为 false 时本插件
仍把 fiber 标成 active，随后走官方重连）。`dsh-mcp` 没有对应参数，直接写进文件。
这些 instructions 行为只适用于 Eager；Lazy 不读取 instructions，也不会执行这个上限
（见[加载模式](#加载模式)）。
反之项目文件是超集语法：`env`/`headers`
允许 `KEY: null` 表示删除该键（装载时被剔除），这在官方 mcp-client 校验里会被
拒绝——把这类行原样挪回 `cordis.patch.yml` 会装载失败。

## JSON 方言

与生态一致（Cursor / Claude Code 的 `mcpServers` 写法）：

```json
{
  "mcpServers": {
    "gitlab": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-gitlab"],
                "env": { "GITLAB_TOKEN": "${GITLAB_TOKEN}" }, "cwd": "." },
    "sentry": { "url": "https://mcp.sentry.dev/mcp",
                "headers": { "Authorization": "Bearer ${SENTRY_TOKEN}" } }
  }
}
```

- `command`/`args`/`env`/`cwd` 为 stdio；`url`/`headers` 为 streamable-http；
  可选 `type`（`stdio`|`http`|`streamable-http`）。同时给出 `command` 与
  `url`/`httpUrl` 却没有 `type`/`transport` 的条目会报错跳过，不会静默当
  stdio 装载——请显式写传输。`type: "sse"` 是 **MCP SSE
  端点传输**（规范 2024-11-05），逐条拒绝并给出可执行诊断：装载后端
  （`dsh-mcp-client`）只支持 `stdio` 与 streamable-http——服务端已支持
  Streamable HTTP 时把 `type` 改为 `"http"`；或删除 `type` 只留 `url`
  （本插件按 streamable-http 推断）。没有隐式回退。DSH 透传键
  `mode`/`toolCallTimeoutMs`/`failOnStartupError`/`maxInstructionBytes`/`reconnect`、`enabled: false`
  （静默跳过、不占名）与 `disabled: true`（占名但不装载）。`mode` 取值 `eager`/`lazy`，
  省略为 `eager`，见[加载模式](#加载模式)。
- 未知键容忍忽略；名字须匹配 `[A-Za-z0-9_-]{1,32}`；坏条目逐条报错、不影响其余。
- **JSON 文件由 `dsh-mcp` CLI 独占**：写入保留其他顶层键与键序，但 JSON 没有注释，
  排版与注释不被保留。宿主侧（装载器与设置页）对 JSON **只读**，从不写这些文件；
  在设置页改 JSON 来源的行（包括切换加载模式），会写到同一作用域的受管 yml。
- `${VAR}` 与其他来源同语义（装载时展开，见 [`${VAR}` 展开](env-expansion.zh.md)）。

### `httpUrl`、`transport` 与 `url` 推断

- Gemini CLI 用 `httpUrl` 表示 Streamable HTTP。本插件把它当作显式的
  streamable-http URL。`url` 与 `httpUrl` 同时出现且**值不同**时报条目级错误
  （消息不回显 URL）；值相同则容忍。
- 原生 yml 用 `transport: stdio | streamable-http`。JSON 方言接受同样的
  `transport` 键。与 `type` 同时给出且映射到不同官方传输时报错；两者一致时
  `transport` 优先（原生方言优先）。
- **`url` 在没有 `type`/`transport` 时本插件按 Streamable HTTP 解释**，与
  Gemini CLI 相反（Gemini：`url` = MCP SSE 端点传输，`httpUrl` = Streamable
  HTTP）。把 Gemini 的 `mcpServers` 抄进 `.dsh/mcp.json` 时：`httpUrl` 可原样
  装载；Gemini 的 `url`（SSE）需要把服务端改到 Streamable HTTP 并把字段改成
  `httpUrl` / `type: "http"`，或保留 `type: "sse"` 阅读可执行诊断。
- 本插件**不会**把裸 `url` 当成 MCP SSE。这一相反语义写进文档，避免同一份
  文件在两处被静默赋予相反含义。
