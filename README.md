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

## Claude Code compatibility (read-only)

To fit the habits of Claude Code users, two CC locations are **loaded** but
never written by this plugin:

- `<projectRoot>/.mcp.json` — the CC project file (`{ "mcpServers": { … } }`).
- `~/.claude.json` — only the **top-level `mcpServers`** subtree is read
  (strict allowlist: this file is CC's monolithic state store — oauth
  credentials, per-project history and UI state in it are never touched,
  logged or displayed).

Notes and limits:

- **No `local` scope.** CC's `claude mcp add` defaults to a per-project
  section inside `~/.claude.json` (`projects.<cwd>.mcpServers`); this plugin
  does not read it. Use `dsh-mcp add --scope user` or the project files.
- `type: "sse"` entries are rejected with a per-entry diagnostic — the mount
  backend (`dsh-mcp-client`) only speaks `stdio` and `streamable-http`.
  CC's `type: "http"` and an explicit `type: "streamable-http"` both map to
  `streamable-http`; with `type` omitted, an entry that has only `url` (no
  `command`) is treated as http, everything else as stdio.
- stdio `cwd`: for project-layer rows an empty `cwd` resolves to the project
  root; for user-layer rows (both `~/.dsh/mcp.yml` and `~/.claude.json`) it
  resolves to the dsh host's working directory. Note what "user layer" does
  *not* mean: user rows still mount **one process per known project** (a
  session in two projects gets two fibers, renamed `p<hash>_…` per the
  effective-name rules) — only their `cwd` is shared, not the connection.
- Unknown CC keys are ignored per entry. `enabled: false` — and, as an alias,
  `disabled: true` — skips the row silently (no diagnostic, and no name
  occupancy — see below).
- A `disabled: true` row in a **native yml** still occupies its name in the
  shadow chain: same-name rows in lower layers are shadowed too and stay
  unmounted — disabled means "this name must not run", not "let the CC copy
  through". CC-side `enabled: false` has no placeholder effect. Consequence:
  switching off a `.mcp.json` entry without deleting it lets a **same-named
  user-layer row surface** in that project; to suppress the name across all
  layers, keep a `disabled: true` placeholder row in `.dsh/mcp.yml`.
- Broken files/entries never take down the valid ones; each source fails
  independently, so an unreadable `.mcp.json` cannot unmount the project's
  yml rows (and vice versa). Entry errors land in `.dsh/.mcp-diag.json` and
  the host log (file content is never echoed). A project whose only MCP
  config is `.mcp.json` still gets a `.dsh/` directory as soon as there is
  anything worth reporting there.
- `~/.claude.json` is rewritten by CC on every session; the watcher re-reads
  it but only triggers reconciliation when the `mcpServers` subtree actually
  changed (canonical-JSON hash gate).
- Escape hatch: set `DSH_MCP_IGNORE_CLAUDE_JSON=1` in the dsh host environment
  to disable reading and watching `~/.claude.json` entirely.

**Shadow priority** when the same `serverName` appears in several layers
(first wins, losers reported in `.dsh/.mcp-diag.json` as `shadowedByYml` /
`shadowedByProject`):

1. `<projectRoot>/.dsh/mcp.yml` (native, panel/CLI-managed)
2. `<projectRoot>/.mcp.json` (CC project)
3. `~/.dsh/mcp.yml` (native user layer — see CLI)
4. `~/.claude.json` top-level `mcpServers` (CC user)

User-layer rows apply to every known project, so a name defined both in one
project and in a user layer (or in two projects) participates in the regular
effective-name conflict renaming (see How it works).

## `${VAR}` expansion

`${VAR}` references (matching `\$\{[A-Za-z_][A-Za-z0-9_]*\}` anywhere in the
string) in `command`, `args[*]`, `env[*]`, `cwd`, `url` and `headers[*]` — from
**any** of the four sources above — are **interpolated** from the dsh host
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

CC-style command-line management for the **native** files (writes only
`.dsh/mcp.yml` — never `.mcp.json` / `~/.claude.json`; running hosts
converge via the file watchers, no dsh connection needed):

```powershell
dsh-mcp add gitlab npx -y @modelcontextprotocol/server-gitlab -e GITLAB_TOKEN=${GITLAB_TOKEN}
dsh-mcp add --transport http sentry https://mcp.sentry.dev/mcp -H "Authorization: Bearer ${SENTRY_TOKEN}"
dsh-mcp add --scope user shared node ./tools/shared.js   # writes ~/.dsh/mcp.yml
dsh-mcp list          # all four layers, with shadow annotations
dsh-mcp get gitlab    # winning entry, secret values shown as key names only
dsh-mcp remove gitlab # native yml only; read-only layers get guidance
```

Scopes: `--scope project` (default; writes `<projectRoot>/.dsh/mcp.yml` under
the nearest `.git` ancestor) and `--scope user` (writes `~/.dsh/mcp.yml`,
mounted into every project). `add` defaults `cwd` to `"."` (project root) for
project scope and `""` (host directory) for user scope; `-c` overrides.
There is no `local` scope — `--scope local`
fails with an explanation. `--transport` accepts `stdio` (default) and `http`;
`sse` is refused (unsupported by the backend).

## How it works

- **Project discovery**: the `session.header.cwd` of an active agent session,
  plus the dsh process start directory → walk up to the nearest ancestor
  containing `.git` as the project root (falls back to the directory itself
  when there is no `.git`).
- **Mounting**: each `(project, serverName)` pair mounts one
  `@deepseek-ai/dsh-mcp-client` instance (`ctx.plugin`) on the host ctx and
  registers it into the global tool layer. Multiple sessions inside the same
  project share a single connection.
- **Hot reload**: chokidar watches each project root (depth 2, ignoring
  node_modules/.git/.hg/.svn), but only edits to the **exact** config files of
  known project roots — `<projectRoot>/.dsh/mcp.yml` and
  `<projectRoot>/.mcp.json` — trigger a full reconciliation after a 150 ms
  debounce: added lines are mounted, removed lines are unmounted, and config
  changes are remounted. A second watcher covers the user layer as two
  **exact file paths** — `~/.dsh/mcp.yml` and `~/.claude.json` (chokidar v5
  notices a watched file being created as long as its parent directory
  exists) — never the home directory at large. `~/.claude.json` events are
  arbitrated by the canonical-JSON content hash alone (no size/mtime fast
  path: same-instant, same-length rewrites with different content must not be
  swallowed).
- **Effective names**: when the original `serverName` is unique across the
  whole catalog (global lines + all project lines, where each project's
  merged rows include the user-layer rows that survived shadowing) it keeps
  its name; on a conflict both sides are renamed to
  `p<first 6 chars of sha256(projectRoot)>_<original name>` (truncated to 32
  characters, deterministic and independent of mount order) to avoid the
  serverName reservation conflicts that `dsh-mcp-client` makes per process
  root. Global lines (profile `cordis.patch.yml` / mcp-client lines already
  mounted at the bundle level) participate in occupancy determination but are
  never renamed. Model-visible tool names are built from the **effective**
  server name and the MCP tool's own name (`mcp__<effectiveServerName>__<toolName>`),
  which may differ from the `serverName` written in the file.
- **Session visibility**: when an agent is created, its session cwd resolves
  to a project, and `tools.restrict({ deny })` is applied to that agent to deny
  every project server except those of the session's own project; a session
  without a cwd falls back to the owner project (subagents), then to the
  project containing the dsh process cwd. Released when the session is
  destroyed.

## Security boundary

`stdio` lines in `.dsh/mcp.yml` (and `.mcp.json` rows mounted from it) spawn
their `command` inside the dsh host process — project files are **executable
code carriers**, so only add them in projects you trust. Lines that fail to
mount or are invalid are skipped with a warning and do not affect other
servers. The read-only `~/.claude.json` allowlist exists precisely because
that file also holds credentials: nothing from it is ever written out, echoed
into diagnostics, or printed by the CLI.
