# dsh-project-mcp-manager

English | [中文](docs/README.zh.md)

A project-level MCP auto-loading plugin for DSH: write MCP server configs in
`<projectRoot>/.dsh/mcp.yml` or `.dsh/mcp.json` and they are mounted
automatically (via the official `@deepseek-ai/dsh-mcp-client`) whenever a dsh
session opens in that project. Changes to the file hot-reload into the running
dsh process, and tool visibility follows the session's original project
(`session.header.cwd`). The default
`dsh-project-mcp-manager` bundle includes the loader and the companion
`dsh-project-mcp-ui` MCP Manager page for the web and desktop apps (three
entries — main sidebar, settings sidebar, and a Built-in plugins settings tab — all
opening the same panel). The UI is
enabled by default and can be disabled independently; the loader keeps working.

**Eager capability boundary** (dsh ≥ 0.2.2-rc.1): the official client owns the
protocol, reconnect, tool names, resources, and server instructions. Shipped
profiles already mount shared MCP resource tools. Official configuration is
a profile-layer Cordis patch (with that layer's own HMR) plus
`plugin_manager`. This plugin still owns what the host does not:

1. Project-level discovery of `<projectRoot>/.dsh/mcp.yml`, `.dsh/mcp.json`,
   and the read-only legacy `.mcp.json`.
2. Tool visibility isolated by the session's original project
   (`session.header.cwd`). `working_directory` does not retarget it.
3. The MCP file format, the `dsh-mcp` CLI, and the MCP Manager page.

Project-file hot reload is this plugin's file watcher. It does not replace
official profile HMR. **Transport types are decided by the official client.**

**Supported dsh versions:**

| Plugin | dsh |
|---|---|
| v0.11.x – v0.12.x | `0.2` line, from `0.2.2-rc.1` (`engines.dsh`: `^0.2.2-rc.1`) |
| v0.10.x | `0.2.1-rc.2` – `0.2.1-rc.5` |
| v0.7.x – v0.8.x | `0.2.0` line, from `0.2.0-rc.2` |
| v0.6.0 | `0.1.5` |

If this plugin is useful, a GitHub
[star](https://github.com/wldxiaobai/dsh-project-mcp-manager) is appreciated.
Bugs, host mismatches, or ideas belong in
[Issues](https://github.com/wldxiaobai/dsh-project-mcp-manager/issues) — even a
short report helps.

## Lazy loading on DSH 0.2.2-rc.1

Choose **Lazy** for a server in MCP Manager, or add `"mode": "lazy"` to
its entry under `mcpServers` in `.dsh/mcp.json`. In a managed `mcp.yml`
row, use `config.mode: lazy`. The default is `eager`.

Lazy supports stdio and Streamable HTTP. Use `mcp_search` to find a tool,
`mcp_describe` for its schemas, and `mcp_call` to run it. Search connects
to the visible Lazy servers to discover their tools. Pass `server` to
limit discovery to one. Each connection caches its tool list and closes
when the session ends or the row is unloaded. Tool allow and deny
rules apply to all three proxies.

Use Eager for servers that need DSH resource integration, server
instructions, or host policies targeting individual registered tools.
Lazy handles MCP tool calls, with DSH's MCP result adapter for text and
images. A failed connection can be retried on the next request.

## Installation (mount into a profile)

Install only `dsh-project-mcp-manager`; it brings the core loader and the MCP
Manager page. How the bundle is laid out: [install](docs/guide/settings-ui.md#install).

**Prerequisite: install dsh itself** (skip if you already have it). Download
DeepSeek Harness from the official page:
<https://www.deepseek.com/harness/>. To install it from npm or GitHub instead:

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
manager/UI release described above, and pick the plugin release that matches
your dsh version — see the compatibility table above.

If you installed `dsh-project-mcp-ui` separately before, see
[migrating from a separately installed UI](docs/guide/settings-ui.md#migrating-from-a-separately-installed-ui).

### MCP Manager entries

After you install the manager, the web and desktop apps have an MCP Manager
page. These three entries open the same page:

- **MCP Manager** in the main sidebar
- **MCP Manager** in the Settings sidebar
- **Settings → Built-in plugins → Plugin: MCP Manager**

A headless profile has no page; the loader works the same. For how to use the
page, see [MCP Manager page](docs/guide/settings-ui.md).

### MCP Manager entry settings

Go to **Settings → General → MCP management page entries**, choose
**Configure…**, and tick the entries you want. You can turn off all three; this
row always stays, so you can turn them back on. The same row is on the main
sidebar's **Plugins → `dsh-project-mcp-manager`** page, and both places change
the same setting.

To remove the page but keep the loader, turn off only the `mcp-project-ui`
component in the plugin manager.

## Build & test

```powershell
pnpm install
pnpm run build     # core: tsc → lib/; then UI: tsc + browser bundle → packages/ui/lib/
pnpm test          # node test/*.mjs (loader, CLI, and page helpers)
```

## How it works

The loader finds a session's project by walking up from its
`session.header.cwd` to the nearest `.git` ancestor. It mounts each project
server once through `@deepseek-ai/dsh-mcp-client`, and uses
`tools.restrict({ deny })` so a session sees only its own project's servers.
User-layer rows mount once for the whole host. Edits to the config files
hot-reload after a 150 ms debounce. Details: [how it works](docs/guide/how-it-works.md).

Other plugins and the bundled UI read mount state from `ctx.projectMcp`;
see [query surface](docs/guide/service.md).

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

The MCP Manager page writes the same managed files, so adding a local-command
server there spawns that command on the host. Its routes
(`/api/project-mcp/*`) are served on the dsh connection: whoever can use the
dsh web GUI can add and start servers through it.

## Coexistence with other MCP manager plugins

`@wingsky-1/dsh-mcp-manager` also reads `<projectRoot>/.dsh/mcp.json`, but in
a different format, and the two plugins can start the same server twice. Use
one plugin per project, or keep this plugin on `.dsh/mcp.yml`. Details:
[coexistence with `@wingsky-1/dsh-mcp-manager`](docs/guide/layers.md#coexistence-with-wingsky-1dsh-mcp-manager).

## Documentation

Feature documentation lives in `docs/`, English and Chinese side by side:

- [Configuration format](docs/guide/format.md) — native YAML managed
  block, JSON dialect, divergences from the cordis dialect.
- [MCP Manager page](docs/guide/settings-ui.md) — use the bundled UI, read
  the server list, add servers (with fill from clipboard), switch, remove, and
  manage tools.
- [Configuration sources and layers](docs/guide/layers.md) — the
  seven-layer source model, shadow priority, global vs project mounting, and the
  read-only legacy Claude Code layer.
- [`${VAR}` expansion](docs/guide/env-expansion.md) — mount-time interpolation and
  its diagnostics.
- [CLI `dsh-mcp`](docs/guide/cli.md) — scopes, write formats, ownership contract.
- [How it works](docs/guide/how-it-works.md) — project discovery, mounting,
  hot reload, effective names, and session visibility.
- [Query surface](docs/guide/service.md) — `ctx.projectMcp`, the
  `projectMcp/updated` event, exported view types, and the semver contract for
  the companion UI.

Design, release, code review, and testing records: [records](docs/records.md).

## Contributing

Pull requests target `dev`. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
the checklist, and commit conventions.

## Acknowledgments

Thanks to everyone who has contributed code to this project:

- [@yangjh0127](https://github.com/yangjh0127): per-server Lazy loading mode
  and its MCP Manager switch
  ([#30](https://github.com/wldxiaobai/dsh-project-mcp-manager/pull/30)).
- [@yangjh0127](https://github.com/yangjh0127): persistent workspace MCP
  mounts with per-session tool, instruction, and resource isolation, plus
  per-session Lazy activation
  ([#32](https://github.com/wldxiaobai/dsh-project-mcp-manager/pull/32)).