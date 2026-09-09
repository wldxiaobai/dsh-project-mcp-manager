# Configuration format

English | [中文](configuration-format.zh.md)

[← README](../README.md) ｜ Related: [configuration sources and layers](configuration-layers.md) · [`${VAR}` expansion](env-expansion.md) · [CLI `dsh-mcp`](cli.md)

Two dialects are read by the plugin: the **native YAML managed block**
(`<projectRoot>/.dsh/mcp.yml`) and the **JSON dialect** (`<projectRoot>/.dsh/mcp.json`,
`~/.dsh/mcp.json`, `~/.dsh/profiles/<name>/mcp.json`, plus the read-only legacy
Claude Code project file `<projectRoot>/.mcp.json`). Which file belongs to which
layer is described in [configuration sources and layers](configuration-layers.md).

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
  an optional `type` (`stdio`|`http`|`streamable-http`; `sse` is rejected per
  entry), the DSH passthrough keys
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
