# dsh-project-mcp-manager

English | [中文](docs/README.zh.md)

A project-level MCP auto-loading plugin for DSH: write MCP server configs in
`<projectRoot>/.dsh/mcp.yml` and they are mounted automatically (via the
official `@deepseek-ai/dsh-mcp-client`) whenever a dsh session opens in that
project. Changes to the file hot-reload into the running dsh process, and tool
visibility is scoped per session cwd. No UI — core functionality only.

## Installation (mount into a profile)

The plugin is mounted through a **bundle patch**: once the package is added to
`dsh.profile.bundles`, dsh synthesizes each bundle's patch (the
`cordis.patch.yml` pointed to by `dsh.bundle.patch`) into plugin lines at
startup, in order.

**Prerequisite: install dsh itself** (for users who don't have dsh yet):

```powershell
npm install -g @deepseek-ai/dsh        # official npm package
npm install -g deepseek-ai/dsh         # or install from the GitHub source
```

**Option 1: the dsh plugin command (recommended)** — `dsh plugin` forwards
pnpm inside the profile directory and handles installing/upgrading
dependencies:

```powershell
# Install the latest version (web profile shown as an example;
# substitute the name of any other profile, e.g. headless)
dsh plugin --profile web add dsh-project-mcp-manager@latest

# Install a specific version (check available versions with
# npm view dsh-project-mcp-manager versions)
dsh plugin --profile web add dsh-project-mcp-manager@0.2.0
```

**Option 2: install directly with pnpm** (equivalent to option 1):

```powershell
# dshHome defaults to %USERPROFILE%\.dsh (uses $DSH_HOME if set)
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add dsh-project-mcp-manager@latest
```

**Option 3: local development install** (a junction that live-syncs your
source, so code changes take effect immediately):

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add link:<path-to-your-dsh-mcp-project-source>   # e.g. D:\dev\dsh-mcp-project
```

> **dsh ≥ 0.1.2 note**: whether the plugin loads depends on the profile's
> `dsh.profile.bundles` list, and a plain `pnpm add link:` does **not** add the
> package to it. Options 1 and 2 reconcile it automatically; if you ran pnpm by
> hand, run any `dsh plugin --profile web list` once (or check
> `dsh --profile web --dump-config` for a `dsh-project-mcp-manager` row) to
> trigger the bundle reconcile.

**Upgrading / pinning versions**: re-run the `add` command from option 1 with
the desired version suffix — `@latest` upgrades to the newest release, `@0.2.0`
pins to a specific version.

## Build & test

```powershell
npm install
npm run build     # tsc → lib/
npm test          # node test/test-model.mjs / test-mcp-file / test-cc-file / test-registry / test-cli
```

## Configuration format

`<projectRoot>/.dsh/mcp.yml` uses the same managed-block format as the profile
`cordis.patch.yml` (a YAML `insert` list between begin/end markers), with one
MCP server per line:

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
which are interpolated at mount time (see `${VAR}` expansion below);
`disabled` must be `true`/`false`. The project file is otherwise a superset
grammar: `env`/`headers` accept `KEY: null` to delete a key (stripped at
mount), which the official mcp-client schema rejects — such lines would fail
if moved back to `cordis.patch.yml`.

## Configuration sources and layers (six layers)

The plugin reads six sources and merges them **first-come-first-served**. The
first three are **project layers** (mounted per project, isolated per session);
the last three are **user layers** (host-level **global mounting**):

| # | Source | Path | Semantics |
|---|---|---|---|
| 1 | `dsh-project` | `<projectRoot>/.dsh/mcp.yml` | project layer (native managed block, the CLI's default target) |
| 2 | `dsh-project-json` | `<projectRoot>/.dsh/mcp.json` | project layer (JSON dialect) |
| 3 | `cc-project` | `<projectRoot>/.mcp.json` | project layer, **legacy read-only** (Claude Code project file) |
| 4 | `dsh-profile-user` | `~/.dsh/profiles/<active profile>/mcp.json` | **global** (when the running profile name can be resolved) |
| 5 | `dsh-user-yml` | `~/.dsh/mcp.yml` | **global** (native user layer) |
| 6 | `dsh-user` | `~/.dsh/mcp.json` | **global** (JSON user layer) |

The **JSON dialect** follows the ecosystem (Cursor / Claude Code's
`mcpServers` shape):

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
  time, see below).

**Global mounting vs project mounting**:

- Project-layer rows: each project mounts its own `mcp-client` instance, made
  visible only to sessions whose cwd is that project via
  `tools.restrict({ deny })`.
- User-layer rows: **exactly one connection at the host level**, independent of
  the number of projects, visible to every session; no more per-project
  fan-out. An empty `cwd` inherits the host working directory (an empty
  project-layer `cwd` means the project root).
- **Project-side suppression**: when a project's own rows (same name,
  normalized name, or service identity) shadow a user-layer row, **that
  project's sessions** deny the global server's tools while every other project
  still sees them; the global instance stays single.
- When the name collides with a global mcp-client server in a profile patch
  line, the user-layer row is **skipped** and recorded as
  `skipReason: "name-taken"` in the snapshot (no renaming, to avoid
  `serverName` reservation conflicts).

**Shadow priority** — layers merge first-come-first-served (1 → 6 above), and
a row is shadowed when it collides with an earlier row on **any** of three
keys: the exact `serverName`; the *normalized name* (lowercased with
non-alphanumerics stripped — `unityMCP` and `unity-mcp` are one service
written two ways); or the *service identity* (`stdio`: command + args,
path-case-insensitive on Windows; `streamable-http`: the url). Rows without a
command/url register no identity key — `node a.js` and `node b.js` stay
different services — while `disabled` placeholder rows hold all three keys
without mounting anything. Identity is compared on the **raw strings as
written in the file, before `${VAR}` expansion**, and `env`, `headers`, `cwd`
are *not* part of the key: two genuinely different servers sharing one command
line (but e.g. different env) still collapse to the winner, while the same
server written once with a `${VAR}` and once as a literal does not match. If a
drop was unintended, rename the loser (past normalization) or adjust its
command line. Losers are reported in `.dsh/.mcp-diag.json`
(`shadowedByYml` / `shadowedByProject` / `shadowedIdentity`) and every
identity/normalized-name drop warns in the host log ("skipping duplicate
service definition"). User-layer row diagnostics are written to
`~/.dsh/.mcp-diag.json`.

When a project-layer row and a user-layer row collide on the same name, the
project row is renamed to `p<hash>_<name>` per the effective-name rules while
the global row keeps its original name; that project's sessions also deny the
global row's tools (project-side suppression).

### Legacy Claude Code layer (read-only)

- `<projectRoot>/.mcp.json` is still read (layer 3, lowest project priority),
  so CC users need not migrate; `DSH_MCP_IGNORE_MCP_JSON=1` disables the whole
  layer.
- `~/.claude.json` is **no longer read** (as of v0.4.0): it is Claude's
  user-state monolith, mixing credentials with project history. Migrate its
  servers to `~/.dsh/mcp.json` or `~/.dsh/profiles/<name>/mcp.json`. The old
  switches `DSH_MCP_READ_CLAUDE_USER` and `DSH_MCP_IGNORE_CLAUDE_JSON` have
  been removed (setting them no longer has any effect).
- **No `local` scope.** CC's `claude mcp add` defaults to a per-project section
  inside `~/.claude.json` (`projects.<cwd>.mcpServers`, the local layer); this
  plugin does not read that layer. Use `dsh-mcp add --scope user` or the
  project files.
- `type: "sse"` entries are rejected with a per-entry diagnostic — the mount
  backend (`dsh-mcp-client`) only speaks `stdio` and `streamable-http`. CC's
  `type: "http"` and an explicit `type: "streamable-http"` both map to
  `streamable-http`; with `type` omitted, an entry that has only `url` (no
  `command`) is treated as http, everything else as stdio.
- Broken files/entries never take down the valid ones, and they fail **per
  source**: an unreadable `.mcp.json` cannot unmount the same project's yml
  rows (and vice versa). Entry errors land in `.dsh/.mcp-diag.json` and the
  host log (diagnostics never carry file content).
- CC-side `enabled: false` and `disabled: true` are both skipped silently and
  hold **no name**; `disabled: true` in native yml/json still **holds its
  shadow keys** (disabled means "this name must not run", not "let another copy
  through"). To suppress a server across all layers, keep a `disabled: true`
  placeholder row in `.dsh/mcp.yml`.

## `${VAR}` expansion

`${VAR}` references (matching `\$\{[A-Za-z_][A-Za-z0-9_]*\}` anywhere in the
string) in `command`, `args[*]`, `env[*]`, `cwd`, `url` and `headers[*]` — from
**any** of the sources above — are **interpolated** from the dsh host
process environment at mount time (same semantics as Claude Code, so
`"Authorization": "Bearer ${TOKEN}"` works). An unset or empty variable makes
the row skip with an `env-missing` diagnostic naming the variable (never its
value); a literal `${NAME}` that must survive unexpanded is not expressible.
A `url` containing a reference is accepted by the pre-mount schema in any
position — including the host part, e.g. `https://${HOST}/mcp` — because
validity is judged only after expansion: expanded inputs are re-validated
against the mount schema before spawn, and a malformed result (e.g. a non-URL
`${GATEWAY}/mcp`) skips the row with an `env-invalid` diagnostic instead of
reaching the mount backend. In the snapshot/row views, `fiberPhase` stays on
the mount-lifecycle vocabulary (`pending` for a row that never mounted) and
the reason rides on a separate `skipReason` field (`env-missing` /
`env-invalid` / `config-invalid` / `plugin-throw`). Values are never
persisted anywhere by the plugin; the CLI writes `${VAR}` through literally,
so secrets can live in the environment while configs live in git.

## CLI: `dsh-mcp`

Command-line management for the **native** config files (writes only
`.dsh/mcp.yml` or `.dsh/mcp.json` — never the legacy `.mcp.json`; it does not
connect to a running dsh host, which converges via the file watchers):

```powershell
dsh-mcp add gitlab npx -y @modelcontextprotocol/server-gitlab -e GITLAB_TOKEN=${GITLAB_TOKEN}
dsh-mcp add --transport http sentry https://mcp.sentry.dev/mcp -H "Authorization: Bearer ${SENTRY_TOKEN}"
dsh-mcp add --scope user shared node ./tools/shared.js        # writes ~/.dsh/mcp.yml
dsh-mcp add --format json jsonproj node ./tools/p.js          # writes <projectRoot>/.dsh/mcp.json
dsh-mcp add --scope profile --profile web shared node ./s.js   # writes ~/.dsh/profiles/web/mcp.json
dsh-mcp list          # all source layers, with shadow annotations
dsh-mcp get gitlab    # winning-layer entry; secret values shown as key names only
dsh-mcp remove gitlab # searches yml then json in priority order and deletes; read-only layers get edit guidance
```

Scopes: `--scope project` (default; writes `<projectRoot>/.dsh/mcp.yml` under
the nearest `.git` ancestor), `--scope user` (writes `~/.dsh/mcp.yml`) and
`--scope profile` (requires `--profile <name>`; writes
`~/.dsh/profiles/<name>/mcp.json`, JSON only).
**Write format**: `--format yml|json` takes precedence over the
`DSH_MCP_CLI_FORMAT` environment variable (`yml`|`json`, default `yml`); with
`--format json`, project and user scopes write `.dsh/mcp.json` and
`~/.dsh/mcp.json` respectively. `add`'s default `cwd` follows the scope: `"."`
(the project root) for project, `""` (the host directory) for user/profile;
`-c` overrides it explicitly.
There is no `local` scope — `--scope local`
fails with an explanation. `--transport` accepts `stdio` (default) and `http`;
`sse` is refused (unsupported by the backend).

## How it works

- **Project discovery**: the `session.header.cwd` of an active agent session,
  plus the dsh process start directory → walk up to the nearest ancestor
  containing `.git` as the project root (falls back to the directory itself
  when there is no `.git`).
- **Mounting**: each `(project, serverName)` pair in the project layers mounts
  one `@deepseek-ai/dsh-mcp-client` instance (`ctx.plugin`) on the host ctx and
  registers it into the global tool layer; multiple sessions inside the same
  project share a single connection. **Every user-layer row mounts exactly one
  instance** (global, independent of the number of projects).
- **Hot reload**: chokidar watches each project root (depth 2, ignoring
  node_modules/.git/.hg/.svn), but only edits to the **exact** config files of
  known project roots — `<projectRoot>/.dsh/mcp.yml`,
  `<projectRoot>/.dsh/mcp.json` and `<projectRoot>/.mcp.json` — trigger a full
  reconciliation after a 150 ms debounce: added rows are mounted, removed rows
  are unmounted, and config changes are remounted. A second watcher covers the
  user layer as three **exact file paths** — `~/.dsh/mcp.yml`,
  `~/.dsh/mcp.json` and `~/.dsh/profiles/<active profile>/mcp.json` (chokidar
  v5 can deliver an event for a watched missing file when it is created, as
  long as its parent directory exists) — never the home directory at large.
- **Profile name resolution**: derived from the loader root include's
  `config.path` (`~/.dsh/profiles/<name>/cordis.yml`) or `ctx.baseUrl`, and
  overridable with `DSH_MCP_PROFILE=<name>`; when it cannot be resolved the
  profile layer is not read (the other layers still are).
- **Effective names**: when the original `serverName` is unique across the
  whole catalog (host global rows + all project rows) it keeps its name; on a
  conflict **project rows** are renamed to `p<first 6 hex chars of
  sha256(project root)>_<original name>` (truncated to 32 characters,
  deterministic and independent of mount order) to avoid the serverName
  reservation conflicts that `dsh-mcp-client` makes per process root. Global
  rows (profile patch lines and user-layer rows) participate in occupancy
  determination but are never renamed. Model-visible tool names are built from
  the **effective** server name and the MCP tool's own name
  (`mcp__<effectiveServerName>__<toolName>`), which may differ from the
  `serverName` written in the file.
- **Session visibility**: when an agent is created, its session cwd resolves to
  a project, and `tools.restrict({ deny })` is applied to that agent to deny
  every project server except those of the session's own project, plus the
  global servers suppressed by the project's own rows; a session without a cwd
  falls back to the owner project (subagents), then to the project containing
  the dsh process cwd. Released when the session is destroyed.

## Security boundary

`stdio` lines in `.dsh/mcp.yml`, `.dsh/mcp.json` and `.mcp.json` spawn their
`command` inside the dsh host process — config files are **executable code
carriers**, so only add them in projects you trust. The user layers
(`~/.dsh/mcp.yml`, `~/.dsh/mcp.json`, the profile json) are executable code
carriers too, they just belong to your own machine: user-layer rows mount
**globally** (one host-level connection, visible to every project) and are no
longer fanned out per project. Lines that fail to mount or are invalid are
skipped with a warning and do not affect other servers. Claude user-state
monoliths such as `~/.claude.json` (mixing credentials with project history)
are **no longer read at all** as of v0.4.0.
