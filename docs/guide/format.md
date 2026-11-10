# Configuration format

English | [中文](format.zh.md)

[← README](../../README.md) ｜ Related: [configuration sources and layers](layers.md) · [`${VAR}` expansion](env-expansion.md) · [CLI `dsh-mcp`](cli.md) · [Lazy mode design record (Chinese)](../design/lazy-mcp.md)

Two dialects are read by the plugin: the **native YAML managed block**
(`<projectRoot>/.dsh/mcp.yml`, `~/.dsh/mcp.yml`, `~/.dsh/profiles/<name>/mcp.yml`)
and the **JSON dialect** (`<projectRoot>/.dsh/mcp.json`, `~/.dsh/mcp.json`,
`~/.dsh/profiles/<name>/mcp.json`, plus the read-only legacy Claude Code project
file `<projectRoot>/.mcp.json`). Which file belongs to which layer is described
in [configuration sources and layers](layers.md). The
[settings page](settings-ui.md) writes only the managed yml files, through the
same managed block and lock as the CLI.

## Loading mode

`mode` is an optional per-row field: `eager` (default) or `lazy`. Omit it for
Eager. In native YAML it lives inside the row's `config`; in the JSON dialect
it is a top-level entry key:

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

`mode` is read by this plugin and is never passed to
`@deepseek-ai/dsh-mcp-client`. `dsh-mcp` has no `--mode` flag; write the key in
the file or use the [settings page](settings-ui.md#loading-mode). If the target
row has no valid connection config (for example a hand-written disabled
placeholder with only an id), changing `mode` is rejected and the file is left
unchanged.

| Aspect | `eager` | `lazy` |
|---|---|---|
| Connection at mount | yes | no; first proxy call |
| Tool registration | every tool as `mcp__<effective>__<tool>` | no remote tools; the global `mcp_search` / `mcp_describe` / `mcp_call` proxies |
| Server instructions / DSH Resources | yes | no; use Eager |
| Host policies keyed by an individual registered tool name | yes | no; only the row's `tools.allow` / `deny` |
| `reconnect` / `failOnStartupError` | official policy | not used; the next request retries |
| `maxInstructionBytes` | enforced by the official client | ignored (instructions are not read) |
| `toolCallTimeoutMs` | per tool call | per tool call; connection and listing use a fixed 30s discovery timeout, independent of this value |
| Idle | connection stays | closes five minutes after the last request; a cancelled last waiter starts closing, and new opens wait for that barrier |

A Lazy row makes no connection at mount. The first `mcp_search`,
`mcp_describe`, or `mcp_call` connects it. A `mcp_search` without `server`
connects every visible Lazy server in the session, so the first search can be
slow and can start several processes at once; pass `server` to limit it to one.
Concurrent requests share one connection; cancel affects only the caller that
aborted, and other in-flight callers keep it. The last waiter's cancellation
closes that generation, and closing/opening is serialized so it cannot race the
next request. The tool list is cached per connection and invalidated on
`list_changed`. The connection closes after five idle minutes, when the row is
unloaded, when the mode changes, or when the plugin is disposed; the next
request reconnects. A failed connection is retried on the next request and is
reported as a generic `Unable to connect to the MCP server`, without transport
details. The `server` argument of `mcp_search` is the **effective
name** (the `server` field in results); a renamed project row may be
`p<hash>_<original>`, not the `serverName` written in the file.

The three proxies are registered only when at least one enabled Lazy row
exists; a session with no visible Lazy mount denies them, so an Eager-only
session sees no extra tools.

Lazy applies the row's `tools.allow` / `deny` before search, describe, and call.
Full `mcp__<effective>__<tool>` patterns use the same normalization as Eager
(64-character limit, invalid characters replaced, a 12-hex hash when
normalization is lossy), so one filter means the same thing in both modes. Use
Eager when you need server instructions, DSH Resources, or host policies that
target individual registered tool names.

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
(url/headers). Add `disabled: true` to a line to deactivate it. A line may also
set `config.mode`; see [Loading mode](#loading-mode). Content outside
the markers is preserved byte-for-byte.

Per-entry tool visibility (stripped before `ctx.plugin`; deny wins):

```yaml
        tools:
          allow: ["read_*"]
          deny: ["read_secret", "mcp__gitlab__delete_*"]
```

Patterns are globs (`*`, `**`, `?`, `[…]`) and match either the bare tool name
or a full `mcp__<effectiveName>__<tool>` id. A full-id pattern is compared
against the **effective** name the loader actually registered (`mcp__<effective>__…`),
not the `serverName` written in the file. Project rows that were renamed
(`p<hash>_…`) therefore do **not** match `mcp__<originalName>__foo`; use the
bare tool name, or look up the effective name in `dsh-mcp get` / a snapshot.
Illegal character classes (for example `[z-a]`) warn once per entry and never
match, instead of failing silently. JSON also accepts Gemini's
`includeTools` → `allow` and `excludeTools` → `deny`; if both the DSH `tools`
object and those keys are present, `tools.allow` / `tools.deny` win. Lazy rows
use the same rules for their on-demand catalog; full-name matching uses the
same effective name and normalization as [Loading mode](#loading-mode).

**Divergences from the native cordis dialect**: the `!!js` tag (a js-yaml
expression evaluated by the profile loader, e.g. the official README's
`env: { TOKEN: !!js process.env.GITHUB_TOKEN }`) is **not supported** in
project files — an unresolved tag inside the managed block makes the whole
file fail with an explicit error (logged and written to `$DSH_HOME/mcp-diag/<hash>.json`)
instead of silently mounting the expression text as a literal string. Values
in `env`/`headers` are otherwise literal, except for `${VAR}` references
which are interpolated at mount time (see [`${VAR}` expansion](env-expansion.md));
`disabled` must be `true`/`false`. Optional `maxInstructionBytes` (integer ≥ 1)
is the official cap on attributed server instructions, default 32768 when the
key is omitted. An oversized instruction rejects that connection inside
`dsh-mcp-client` (the row still activates when `failOnStartupError` is false,
then follows the official reconnect loop). `dsh-mcp` has no flag for this
field; write it in the file. These instruction behaviors apply to Eager only;
Lazy does not read instructions and does not enforce this cap (see
[Loading mode](#loading-mode)). The project file is otherwise a superset
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
  an optional `type` (`stdio`|`http`|`streamable-http`). An entry that gives
  both `command` and `url`/`httpUrl` without `type`/`transport` fails per
  entry instead of silently loading as stdio — spell the transport. `type: "sse"` is the
  **MCP SSE endpoint transport** (protocol version 2024-11-05) and is rejected
  per entry with an actionable diagnostic: the mount backend
  (`dsh-mcp-client`) only speaks `stdio` and streamable-http — if the server
  already speaks Streamable HTTP, change `type` to `"http"`; or drop `type`
  and keep `url` (this plugin infers streamable-http). There is no implicit
  fallback. The DSH passthrough keys
  `mode`/`toolCallTimeoutMs`/`failOnStartupError`/`maxInstructionBytes`/`reconnect`, `enabled: false`
  (silently skipped, claims no name) and `disabled: true` (claims its name but
  is not mounted). `mode` is `eager`/`lazy`, omitted means `eager`; see
  [Loading mode](#loading-mode).
- Unknown keys are tolerated and ignored; names must match
  `[A-Za-z0-9_-]{1,32}`; bad entries error per entry and do not affect the
  rest.
- **JSON files are owned exclusively by the `dsh-mcp` CLI**: writes preserve
  other top-level keys and key order, but JSON has no comments, so formatting
  and comments are not preserved. The host side (the loader and the settings
  page) is **read-only** for JSON and never writes these files; editing a
  JSON-sourced row in the settings page (including a loading-mode change)
  writes the managed yml of the same scope instead.
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
