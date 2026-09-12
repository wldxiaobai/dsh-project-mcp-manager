# dsh-project-mcp-manager

English | [中文](docs/README.zh.md)

A project-level MCP auto-loading plugin for DSH: write MCP server configs in
`<projectRoot>/.dsh/mcp.yml` and they are mounted automatically (via the
official `@deepseek-ai/dsh-mcp-client`) whenever a dsh session opens in that
project. Changes to the file hot-reload into the running dsh process, and tool
visibility is scoped per session cwd. No UI — core functionality only.

**Capability boundary**: this plugin = official `@deepseek-ai/dsh-mcp-client`
transports + six-layer source governance + per-session isolation.
**Transport types are decided by the official client**; this plugin does not
implement MCP transports.

## Documentation

Feature documentation lives in `docs/`, English and Chinese side by side:

- [Configuration format](docs/guide/format.md) — native YAML managed
  block, JSON dialect, divergences from the cordis dialect.
- [Configuration sources and layers](docs/guide/layers.md) — the
  six-layer source model, shadow priority, global vs project mounting, and the
  read-only legacy Claude Code layer.
- [`${VAR}` expansion](docs/guide/env-expansion.md) — mount-time interpolation and
  its diagnostics.
- [CLI `dsh-mcp`](docs/guide/cli.md) — scopes, write formats, ownership contract.

Design and release records (Chinese): [dsh 0.1.5-rc.2 adaptation](docs/design/adaptation-dsh-0.1.5-rc2.md) ·
[dsh 0.1.5-rc.1 adaptation](docs/design/adaptation-dsh-0.1.5-rc1.md) ·
[dsh 0.1.2-rc.1 adaptation](docs/design/adaptation-dsh-0.1.2-rc1.md) ·
[JSON config layer proposal](docs/design/proposal-json-mcp-config.md) ·
[Runtime robustness & JSON interop proposal](docs/design/proposal-runtime-robustness-and-json-interop.md) ·
[v0.6.0 release notes](docs/releases/v0.6.0.md) ·
[v0.4.3 release notes](docs/releases/v0.4.3.md) ·
[v0.4.2 release notes](docs/releases/v0.4.2.md) ·
[v0.4.1 release notes](docs/releases/v0.4.1.md) ·
[v0.4.0 release notes](docs/releases/v0.4.0.md) ·
[v0.3.1 release notes](docs/releases/v0.3.1.md).

Code review records (Chinese): [TypeScript changes since v0.3.1](docs/code-review/ts-review-since-v0.3.1.zh.md).

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
dsh plugin --profile web add dsh-project-mcp-manager@0.6.0
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
the desired version suffix — `@latest` upgrades to the newest release, `@0.6.0`
pins to a specific version.

## Build & test

```powershell
pnpm install
pnpm run build     # tsc → lib/
pnpm test          # node test/test-model.mjs / test-mcp-file / test-json-file / test-json-write / test-registry / test-cli
```

## How it works

- **Project discovery**: the `session.header.cwd` of an active agent session,
  plus the dsh process start directory → walk up to the nearest ancestor
  containing `.git` as the project root (falls back to the directory itself
  when there is no `.git`).
- **Mounting**: each `(project, serverName)` pair in the project layers mounts
  one `@deepseek-ai/dsh-mcp-client` instance (`ctx.plugin`) on the host ctx and
  registers it into the global tool layer; multiple sessions inside the same
  project share a single connection. **Project-layer fibers are created only
  for projects with a live session or the process cwd**; after the last
  session leaves (and the project is not cwd) servers unmount following a
  5 minute grace while the catalog entry and watcher remain. **Every
  user-layer row mounts exactly one instance** (global, independent of the
  number of projects) — see
  [configuration sources and layers](docs/guide/layers.md).
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

## Coexistence with other MCP manager plugins

This plugin and `@wingsky-1/dsh-mcp-manager` both auto-load per-project MCP
servers, but they do **not** share a file format:

1. **Project files are mutually incompatible.** This plugin reads
   `{ mcpServers: { … } }` in `<projectRoot>/.dsh/mcp.json`. The other plugin
   stores `{ version, servers: [] }` at the same path. A missing `mcpServers`
   key is a legal empty layer here, so the other format would otherwise look
   like "I configured it but nothing happens". The loader now writes a
   diagnostic naming that format and suggesting `mcpServers` or
   `.dsh/mcp.yml`. The same hint applies to `~/.dsh/dsh-mcp.json`.
2. **The same `serverName` can be started twice** (once by each plugin).
   stdio servers may contend for ports or exclusive resources.
3. **Prefer one plugin per project**, or keep this plugin on `.dsh/mcp.yml`
   and the other on `.dsh/mcp.json`.

`globalNames()` only sees official loader patch rows, not tools registered by
the other plugin at runtime, so rename-to-avoid-collision does **not** cover
that other instance.
