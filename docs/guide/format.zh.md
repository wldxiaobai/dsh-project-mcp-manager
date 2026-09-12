# 配置格式

[English](format.md) | 中文

[← 返回 README](../README.zh.md) ｜ 相关：[配置来源与分层](layers.zh.md) · [`${VAR}` 展开](env-expansion.zh.md) · [CLI `dsh-mcp`](cli.zh.md)

插件读取两种方言：**原生 YAML 受管块**（`<projectRoot>/.dsh/mcp.yml`）与
**JSON 方言**（`<projectRoot>/.dsh/mcp.json`、`~/.dsh/mcp.json`、
`~/.dsh/profiles/<name>/mcp.json`，以及只读的遗留 Claude Code 项目文件
`<projectRoot>/.mcp.json`）。哪个文件属于哪一层见
[配置来源与分层](layers.zh.md)。

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
（url/headers）。行加 `disabled: true` 即停用。标记之外的内容逐字节保留。

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
`tools.deny` 为准。

**与原生 cordis 方言的差异**：`!!js` 标签（profile 的 `cordis.patch.yml` 由
Loader 求值的 js-yaml 表达式，如官方 README 示例 `env: { TOKEN: !!js
process.env.GITHUB_TOKEN }`）在项目文件里**不支持**——受管块内出现未解析
标签会使该文件整体报错跳过（写入 `.dsh/.mcp-diag.json` 并打日志），不会把
表达式当字面量字符串静默装载。`env`/`headers` 的值其余情况下是字面量，仅
`${VAR}` 引用会在装载时做串内插值（见 [`${VAR}` 展开](env-expansion.zh.md)）；
`disabled` 只能是 `true`/`false`。反之项目文件是超集语法：`env`/`headers`
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
  `toolCallTimeoutMs`/`failOnStartupError`/`reconnect`、`enabled: false`
  （静默跳过、不占名）与 `disabled: true`（占名但不装载）。
- 未知键容忍忽略；名字须匹配 `[A-Za-z0-9_-]{1,32}`；坏条目逐条报错、不影响其余。
- **JSON 文件由 `dsh-mcp` CLI 独占**：写入保留其他顶层键与键序，但 JSON 没有注释，
  排版与注释不被保留。插件本身**只读**，宿主永不写这些文件。
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
