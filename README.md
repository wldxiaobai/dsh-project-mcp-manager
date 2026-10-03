# dsh-project-mcp-manager

English | [中文](docs/README.zh.md)

A project-level MCP auto-loading plugin for DSH: write MCP server configs in
`<projectRoot>/.dsh/mcp.yml` or `.dsh/mcp.json` and they are mounted
automatically (via the official `@deepseek-ai/dsh-mcp-client`) whenever a dsh
session opens in that project. Changes to the file hot-reload into the running
dsh process, and tool visibility is scoped per session cwd. The default
`dsh-project-mcp-manager` bundle includes the loader and the companion
`dsh-project-mcp-ui` settings page for the web and desktop apps. The UI is
enabled by default and can be disabled independently; the loader keeps working.

**Capability boundary** (dsh ≥ 0.2.0-rc.2): the official client owns the
protocol, reconnect, tool names, resources, and server instructions. Shipped
profiles already mount shared MCP resource tools. Official configuration is
a profile-layer Cordis patch (with that layer's own HMR) plus
`plugin_manager`. This plugin still owns what the host does not:

1. Project-level discovery of `<projectRoot>/.dsh/mcp.yml`, `.dsh/mcp.json`,
   and the read-only legacy `.mcp.json`.
2. Tool visibility isolated by session cwd.
3. The MCP file format, the `dsh-mcp` CLI, and the settings page.

Project-file hot reload is this plugin's file watcher. It does not replace
official profile HMR. **Transport types are decided by the official client.**
v0.7.x targets the dsh `0.2.0` line starting at 0.2.0-rc.2. Hosts still on
dsh 0.1.5 should stay on plugin v0.6.0.

If this plugin is useful, a GitHub
[star](https://github.com/wldxiaobai/dsh-project-mcp-manager) is appreciated.
Bugs, host mismatches, or ideas belong in
[Issues](https://github.com/wldxiaobai/dsh-project-mcp-manager/issues) — even a
short report helps.

## Documentation

Feature documentation lives in `docs/`, English and Chinese side by side:

- [Configuration format](docs/guide/format.md) — native YAML managed
  block, JSON dialect, divergences from the cordis dialect.
- [Settings page](docs/guide/settings-ui.md) — use the bundled UI, read
  the server list, add servers (with fill from clipboard), switch, remove, and
  manage tools.
- [Configuration sources and layers](docs/guide/layers.md) — the
  seven-layer source model, shadow priority, global vs project mounting, and the
  read-only legacy Claude Code layer.
- [`${VAR}` expansion](docs/guide/env-expansion.md) — mount-time interpolation and
  its diagnostics.
- [CLI `dsh-mcp`](docs/guide/cli.md) — scopes, write formats, ownership contract.
- [Query surface](docs/guide/service.md) — `ctx.projectMcp`, the
  `projectMcp/updated` event, exported view types, and the semver contract for
  the companion UI.

Design and release records (Chinese): [dsh 0.2.0-rc.2 adaptation](docs/design/adaptation-dsh-0.2.0-rc.2.md) ·
[dsh 0.1.6-alpha.2 adaptation plan](docs/design/adaptation-dsh-0.1.6-alpha.2.md) ·
[dsh 0.1.5-rc.2 adaptation](docs/design/adaptation-dsh-0.1.5-rc2.md) ·
[dsh 0.1.5-rc.1 adaptation](docs/design/adaptation-dsh-0.1.5-rc1.md) ·
[dsh 0.1.2-rc.1 adaptation](docs/design/adaptation-dsh-0.1.2-rc1.md) ·
[JSON config layer proposal](docs/design/proposal-json-mcp-config.md) ·
[Runtime robustness & JSON interop proposal](docs/design/proposal-runtime-robustness-and-json-interop.md) ·
[v0.7.2 release notes](docs/releases/v0.7.2.md) ·
[v0.7.1 release notes](docs/releases/v0.7.1.md) ·
[v0.7.0 release notes](docs/releases/v0.7.0.md) ·
[v0.6.0 release notes](docs/releases/v0.6.0.md) ·
[v0.4.3 release notes](docs/releases/v0.4.3.md) ·
[v0.4.2 release notes](docs/releases/v0.4.2.md) ·
[v0.4.1 release notes](docs/releases/v0.4.1.md) ·
[v0.4.0 release notes](docs/releases/v0.4.0.md) ·
[v0.3.1 release notes](docs/releases/v0.3.1.md).

Code review records (Chinese): [TypeScript changes since v0.3.1](docs/code-review/ts-review-since-v0.3.1.zh.md) ·
[v0.4.3 to v0.6.0](docs/code-review/ts-review-v0.4.3-to-v0.6.0.zh.md) ·
[7e0088d to 804662f (fix follow-up)](docs/code-review/ts-review-7e0088d-to-804662f.zh.md) ·
[feat/adapt-dsh-0.2.0-rc.2 (v0.7.0)](docs/code-review/review-feat-adapt-dsh-0.2.0-rc.2.zh.md).

## Installation (mount into a profile)

The plugin is mounted through a **bundle patch**: once the package is added to
`dsh.profile.bundles`, dsh synthesizes each bundle's patch (the
`cordis.patch.yml` pointed to by `dsh.bundle.patch`) into plugin lines at
startup, in order. The manager's default bundle contains two rows:
`mcp-project` (core loader) and `mcp-project-ui` (settings page). The manager
installs its same-exact-version UI dependency automatically; the UI package is
not a standalone `dsh.bundle` and should not be selected separately.

> The core-plus-UI bundle is currently an **Unreleased** change. The npm
> examples below provide that layout once the coordinated manager/UI release
> is published; they do not imply it is already available on npm.

**Prerequisite: install dsh itself** (for users who don't have dsh yet):

```powershell
npm install -g @deepseek-ai/dsh        # official npm package
npm install -g deepseek-ai/dsh         # or install from the GitHub source
```

**Option 1: the dsh plugin command (recommended)** — `dsh plugin` forwards
pnpm inside the profile directory and handles installing/upgrading
dependencies:

```powershell
# Install the latest version with the UI included (choose your profile)
dsh plugin --profile web add dsh-project-mcp-manager@latest
dsh plugin --profile desktop add dsh-project-mcp-manager@latest
# For other profiles, e.g. headless, substitute the profile name.

# Pin a release version (check available versions with
# npm view dsh-project-mcp-manager versions; bundled UI needs the coordinated release)
dsh plugin --profile web add dsh-project-mcp-manager@<version>
```

**Option 2: install directly with pnpm** (equivalent to option 1):

```powershell
# dshHome defaults to %USERPROFILE%\.dsh (uses $DSH_HOME if set)
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add dsh-project-mcp-manager@latest
```

**Option 3: local development install** — build the checkout, then link only
its root manager package. The workspace dependency supplies the matching UI;
no separate UI link or bundle selection is needed:

```powershell
# Run in the source checkout
pnpm install
pnpm run build     # core first, then UI (host code + browser bundle)
dsh plugin --profile web add link:<path-to-your-dsh-mcp-project-source>
# e.g. link:D:\dev\dsh-mcp-project; use --profile desktop for the desktop app
```

The link points at the checkout; rebuild after source changes so the host sees
updated compiled output.

> **dsh ≥ 0.1.2 note**: whether the plugin loads depends on the profile's
> `dsh.profile.bundles` list, not just installed dependencies. The recommended
> `dsh plugin ... add` command handles bundle reconcile. If you installed with
> pnpm directly, run `dsh plugin --profile web list` once to trigger it (use
> `desktop` for that profile). In the web or desktop app's Plugins page, inspect
> the manager's two contained components. The desktop profile is managed by
> Electron; do not use a desktop CLI `--dump-config` command to inspect it.
> Select only `dsh-project-mcp-manager`, not its UI dependency.

**Upgrading / pinning versions**: re-run the `add` command from option 1 with
the desired version suffix — `@latest` upgrades to the newest release,
`@<version>` pins a specific release. For the bundled UI, choose the coordinated
manager/UI release described above. v0.7.x needs dsh 0.2.0-rc.2 (the `0.2.0` line).
dsh 0.1.5 keeps working with plugin `@0.6.0`.

**Settings page (included by default)**: the manager install above supplies
the UI automatically in web and desktop profiles. Open Settings → Built-in plugins →
Plugin: MCP Manager. To hide the page without stopping the loader, turn off
only the manager bundle's `mcp-project-ui` component in the plugin manager's
contained-components controls (or disable that row with a profile patch
override). Keep `mcp-project` enabled.

A headless profile installs the same bundle but has no browser page. Without
the dsh `connection` service, the UI registers no routes;
its connection integration waits without blocking the core loader or MCP
mounting.

**Migrating from a separate UI install**: after installing the manager bundle,
remove `dsh-project-mcp-ui` from the profile's bundle selection
(`dsh.profile.bundles`), keeping the manager selected. You may then remove the
direct UI dependency with `dsh plugin --profile web remove dsh-project-mcp-ui`
(use `desktop` for the desktop profile); the manager still supplies its own UI
dependency. Before running the new bundle, remove an old direct UI dependency
(recommended) or align it to the manager's exact version; it can take precedence
over transitive resolution. If the old UI bundle was disabled, transfer that
intent to a `mcp-project-ui` row override with `disabled: true` before loading
the manager. Neither old bundle selection nor direct dependencies are promised
to be removed automatically. Details: [settings page](docs/guide/settings-ui.md#migrating-from-a-separately-installed-ui).

## Build & test

```powershell
pnpm install
pnpm run build     # core: tsc → lib/; then UI: tsc + browser bundle → packages/ui/lib/
pnpm test          # node test/*.mjs (loader, CLI, and settings-page helpers)
```

## How it works

- **Project discovery**: the `session.header.cwd` of an active agent session,
  plus the dsh process start directory → walk up to the nearest ancestor
  containing `.git` as the project root (falls back to the directory itself
  when there is no `.git`).
- **Mounting**: each `(project, serverName)` pair in the project layers mounts
  one `@deepseek-ai/dsh-mcp-client` instance (`ctx.plugin`) on the host ctx and
  registers it into the global tool layer; multiple sessions inside the same
  project share a single connection. Before a workspace is focused,
  project-layer fibers are created only for projects with a live session or
  the process cwd, and they unmount after a 5 minute grace. Once the user
  focuses a workspace, only that project stays mounted and the others
  unmount immediately, so a desktop workspace switch cannot leave another
  project's tools in the global list. The catalog entry and watcher remain.
  **Every
  user-layer row mounts exactly one instance** (global, independent of the
  number of projects) — see
  [configuration sources and layers](docs/guide/layers.md).
- **Hot reload**: chokidar watches each project root (depth 2, ignoring
  node_modules/.git/.hg/.svn), but only edits to the **exact** config files of
  known project roots — `<projectRoot>/.dsh/mcp.yml`,
  `<projectRoot>/.dsh/mcp.json` and `<projectRoot>/.mcp.json` — trigger a full
  reconciliation after a 150 ms debounce: added rows are mounted, removed rows
  are unmounted, and config changes are remounted. A second watcher covers the
  user layer as **exact file paths** — `~/.dsh/mcp.yml`,
  `~/.dsh/mcp.json`, `~/.dsh/profiles/<active profile>/mcp.yml` and
  `mcp.json`, and
  `$DSH_HOME/dsh-mcp.json` (the other plugin's global store; watched only so
  creating it can be diagnosed, never mounted). chokidar v5 can deliver an
  event for a watched missing file when it is created, as long as its parent
  directory exists — never the home directory at large.
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

## Query surface

Other plugins and the companion UI read mount state from `ctx.projectMcp`
(`snapshot`, `serverView`, `globalState`, `reload`). Queries are the previous
reconcile's memory; they do not read disk. A successful reconcile emits
`projectMcp/updated` with no payload. The listener calls `snapshot()` and
diffs. The core loader does not open a browser SSE channel; the bundled UI
owns that channel. The same service has
the write methods the settings page uses (`addServer`, `setServerEnabled`,
`removeServer`, `setToolEnabled`); they only write a managed `mcp.yml`.

That surface — the methods, the event, and the view types re-exported from the
package entry (`ProjectFileState`, `McpServerRuntimeView`, `McpServerView`,
`McpRowSource`, and the types those views name) — follows semantic versioning
for the companion UI. The manager depends on `dsh-project-mcp-ui` at the
**same exact version**, and the UI peer-depends on `dsh-project-mcp-manager`
at that exact version (no `^` or `~` in either published contract). Both packages
must be versioned and released together; users install only the manager.
Details: [query surface](docs/guide/service.md).

## Security boundary

`stdio` lines in `.dsh/mcp.yml`, `.dsh/mcp.json` and `.mcp.json` spawn their
`command` inside the dsh host process — config files are **executable code
carriers**, so only add them in projects you trust. The user layers
(`~/.dsh/mcp.yml`, `~/.dsh/mcp.json`, the profile yml and json) are executable code
carriers too, they just belong to your own machine: user-layer rows mount
**globally** (one host-level connection, visible to every project) and are no
longer fanned out per project. Lines that fail to mount or are invalid are
skipped with a warning and do not affect other servers. Claude user-state
monoliths such as `~/.claude.json` (mixing credentials with project history)
are **no longer read at all** as of v0.4.0.

The settings page writes the same managed files, so adding a local-command
server there spawns that command on the host. Its routes
(`/api/project-mcp/*`) are served on the dsh connection: whoever can use the
dsh web GUI can add and start servers through it.

## Coexistence with other MCP manager plugins

This plugin and `@wingsky-1/dsh-mcp-manager` both auto-load per-project MCP
servers, but they do **not** share a file format:

1. **Project files are mutually incompatible.** This plugin reads
   `{ mcpServers: { … } }` in `<projectRoot>/.dsh/mcp.json`. The other plugin
   stores `{ version, servers: [] }` at the same path. A missing `mcpServers`
   key is a legal empty layer here, so the other format would otherwise look
   like "I configured it but nothing happens". The loader now writes a
   diagnostic naming that format and suggesting `mcpServers` or
   `.dsh/mcp.yml`. The same hint applies to `~/.dsh/dsh-mcp.json`. If that
   file already uses this plugin's `mcpServers` dialect, the diagnostic tells
   you to move the object into `mcp.json` — it is still not loaded from the
   other plugin's filename.
2. **The same `serverName` can be started twice** (once by each plugin).
   stdio servers may contend for ports or exclusive resources.
3. **Prefer one plugin per project**, or keep this plugin on `.dsh/mcp.yml`
   and the other on `.dsh/mcp.json`.

`globalNames()` only sees official loader patch rows, not tools registered by
the other plugin at runtime, so rename-to-avoid-collision does **not** cover
that other instance.
