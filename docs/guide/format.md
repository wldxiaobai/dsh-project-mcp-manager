# Configuration format

English | [中文](format.zh.md)

[← README](../../README.md) ｜ Related: [configuration sources and layers](layers.md) · [`${VAR}` expansion](env-expansion.md) · [CLI `dsh-mcp`](cli.md)

Two dialects are read by the plugin: the **native YAML managed block**
(`<projectRoot>/.dsh/mcp.yml`) and the **JSON dialect** (`<projectRoot>/.dsh/mcp.json`,
`~/.dsh/mcp.json`, `~/.dsh/profiles/<name>/mcp.json`, plus the read-only legacy
Claude Code project file `<projectRoot>/.mcp.json`). Which file belongs to which
layer is described in [configuration sources and layers](layers.md).

## Native YAML: `<projectRoot>/.dsh/mcp.yml`

Uses the same managed-block format as the profile `cordis.patch.yml` (a YAML
`insert` list between begin/end markers), with one MCP server per line:

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
        cwd: .            # resolved relative to the project root
        toolCallTimeoutMs: 60000
        failOnStartupError: false
        reconnect:
          enabled: true
          initialDelayMs: 500
          maxDelayMs: 30000
          maxAttempts: 10
# <<< dsh-project-mcp-manager:mcp:end
```

`transport` supports `stdio` (command/args/env/cwd) and `streamable-http`
(url/headers). Add `disabled: true` to a line to deactivate it. Content outside
the markers is preserved byte-for-byte.

Per-entry tool visibility (stripped before `ctx.plugin`; deny wins):

```yaml
        tools:
          allow: ["read_*"]
          deny: ["read_secret", "mcp__gitlab__delete_*"]
```

Patterns are globs (`*`, `**`, `?`, `[…]`) and match either the bare tool name
or a full `mcp__<effectiveName>__<tool>` id. JSON also accepts Gemini's
`includeTools` → `allow` and `excludeTools` → `deny`; if both the DSH `tools`
object and those keys are present, `tools.allow` / `tools.deny` win.

**Divergences from the native cordis dialect**: the `!!js` tag (a js-yaml
expression evaluated by the profile loader, e.g. the official README's
`env: { TOKEN: !!js process.env.GITHUB_TOKEN }`) is **not supported** in
project files — an unresolved tag inside the managed block makes the whole
file fail with an explicit error (logged and written to `.dsh/.mcp-diag.json`)
instead of silently mounting the expression text as a literal string. Values
in `env`/`headers` are otherwise literal, except for `${VAR}` references
which are interpolated at mount time (see [`${VAR}` expansion](env-expansion.md));
`disabled` must be `true`/`false`. The project file is otherwise a superset
grammar: `env`/`headers` accept `KEY: null` to delete a key (stripped at
mount), which the official mcp-client schema rejects — such lines would fail
if moved back to `cordis.patch.yml`.

## JSON dialect

Follows the ecosystem (Cursor / Claude Code's `mcpServers` shape):

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

- `command`/`args`/`env`/`cwd` are stdio; `url`/`headers` are streamable-http;
  an optional `type` (`stdio`|`http`|`streamable-http`). `type: "sse"` is the
  **MCP SSE endpoint transport** (protocol version 2024-11-05) and is rejected
  per entry with an actionable diagnostic: the mount backend
  (`dsh-mcp-client`) only speaks `stdio` and streamable-http — if the server
  already speaks Streamable HTTP, change `type` to `"http"`; or drop `type`
  and keep `url` (this plugin infers streamable-http). There is no implicit
  fallback. The DSH passthrough keys
  `toolCallTimeoutMs`/`failOnStartupError`/`reconnect`, `enabled: false`
  (silently skipped, claims no name) and `disabled: true` (claims its name but
  is not mounted).
- Unknown keys are tolerated and ignored; names must match
  `[A-Za-z0-9_-]{1,32}`; bad entries error per entry and do not affect the
  rest.
- **JSON files are owned exclusively by the `dsh-mcp` CLI**: writes preserve
  other top-level keys and key order, but JSON has no comments, so formatting
  and comments are not preserved. The plugin itself is **read-only** — the host
  never writes these files.
- `${VAR}` has the same semantics as every other source (expanded at mount
  time, see [`${VAR}` expansion](env-expansion.md)).

### `httpUrl`, `transport`, and `url` inference

- Gemini CLI writes `httpUrl` for Streamable HTTP. This plugin accepts it as
  an explicit streamable-http URL. If both `url` and `httpUrl` are present
  with **different** values, the entry errors (the message does not echo the
  URLs). Identical values are tolerated.
- Native YAML uses `transport: stdio | streamable-http`. The JSON dialect
  accepts the same `transport` key. When both `transport` and `type` are set
  and they map to different official transports, the entry errors;
  `transport` is preferred when they agree (native dialect wins).
- **`url` without `type`/`transport` is Streamable HTTP here**, which is the
  **opposite** of Gemini CLI (`url` = MCP SSE endpoint transport, `httpUrl` =
  Streamable HTTP). To copy a Gemini `mcpServers` block into `.dsh/mcp.json`:
  keep `httpUrl` as-is (loaded as streamable-http); convert Gemini `url`
  (SSE) by either pointing the server at a Streamable HTTP endpoint and
  renaming the field to `httpUrl` / `type: "http"`, or leaving it as
  `type: "sse"` and reading the actionable diagnostic.
- This plugin does **not** treat a bare `url` as MCP SSE. That inference is
  documented so a file that works in Gemini is not silently given the
  opposite meaning.
