# MCP Manager page

English | [中文](settings-ui.zh.md)

[← README](../../README.md) ｜ Related: [configuration sources and layers](layers.md) · [configuration format](format.md) · [`${VAR}` expansion](env-expansion.md)

The companion package `dsh-project-mcp-ui`, included in the default
`dsh-project-mcp-manager` bundle, adds an **MCP Manager** page with three entries —
main sidebar, settings sidebar, and a Built-in plugins settings tab. It lists the servers
the loader will run, shows whether each one is running, and lets you add,
switch, and remove servers or single tools. Every change is written to a
**managed `mcp.yml`**; the page never edits JSON files or the legacy
`.mcp.json`. The loader does the rest through its normal file watch, so the page
and the [CLI](cli.md) can be used side by side.

## Install

Install **only the manager** into the profile you use:

```powershell
dsh plugin --profile web add dsh-project-mcp-manager@latest
dsh plugin --profile desktop add dsh-project-mcp-manager@latest
```

The manager depends on `dsh-project-mcp-ui` at the **same exact version**, so
the UI is installed automatically. Its default bundle contains `mcp-project`
(core) and `mcp-project-ui` (UI), both enabled. The UI package keeps its exact
manager peer dependency but no longer declares a standalone `dsh.bundle`;
do not select it as a separate bundle. The two packages must be released
together ([version contract](service.md#semver-for-the-companion-ui)). This
layout is included in source version **0.8.0**; the npm examples apply after
both 0.8.0 packages are published. A Git tag does not publish to npm.

For local development, run these commands in the source checkout and link
only the root manager package:

```powershell
pnpm install
pnpm run build     # builds core first, then UI host code and browser bundle
dsh plugin --profile web add link:<source>
# Use --profile desktop for the desktop app; no separate packages/ui link
```

Rebuild after source changes to update the compiled output used by the link.

A headless profile can use the same manager bundle. Without a browser runtime
there is no page. Without the dsh `connection` service, the UI
registers no routes; only its connection-scoped integration waits,
not the core loader or MCP mounting. The UI row can be active independently.
Connection arrival registers that integration, and connection disposal cleans
it up.

There are three entries, all opening the same page:

- **MCP Manager** in the left sidebar (中文界面：左侧栏「MCP 管理」). While the
  sidebar is collapsed to the 56px rail only the icon shows; hover or keyboard
  focus reveals the name. On narrow layouts or a collapsed macOS sidebar, expand
  the sidebar first. This entry replaces the conversation column, so its title
  row carries a **Back to current workspace** button; it returns to the
  conversation surface without changing the current session.
- **Settings → MCP Manager** in the settings sidebar (中文界面：设置 →「MCP 管理」).
  The settings panel floats over the session, so closing it returns you to where
  you were — handy mid-conversation.
- **Settings → Built-in plugins → Plugin: MCP Manager** (中文界面：设置 → 内置插件 →
  插件：MCP 管理). Older hosts may label the middle item Plugins.

**Choosing which entries appear.** On the **Settings → General** page, the
**MCP management page entries** row has a **Configure…** button. Its dialog has
one checkbox per entry: main sidebar, settings sidebar, and the Built-in plugins tab.
Changes are drafted locally and saved together by **Done**; **Cancel** discards
them. Another browser's changes sync in as well. All three can be switched off —
the General row is not one of them and always stays as the way back. When the
page has no write permission (for example a remote browser), the checkboxes are
disabled and the dialog says so.

The same row also appears on the manager bundle's page in the plugin manager
(main sidebar **Plugins → `dsh-project-mcp-manager`**). Both places edit the
same configuration, so a change saved in one is immediately reflected in the
other.

To hide the whole page, open the manager bundle's contained components in the
plugin manager and switch off only `mcp-project-ui`, leaving `mcp-project`
enabled. Alternatively, disable the UI row by its id in a profile patch
override. This stops all three entries without stopping the loader; it does not
remove the UI dependency.

### Migrating from a separately installed UI

1. Install or upgrade the manager bundle first.
2. Remove `dsh-project-mcp-ui` from the profile's bundle selection
   (`dsh.profile.bundles`), keeping `dsh-project-mcp-manager` selected. The
   manager now supplies the UI row; selecting the old UI bundle as well is not
   part of this layout.
3. Optionally remove the old **direct** UI dependency after step 1:

   ```powershell
   dsh plugin --profile web remove dsh-project-mcp-ui
   # Or use --profile desktop for the desktop profile
   ```

   The UI remains installed through the manager's dependency. An old direct
   UI version can take precedence over the transitive package resolution:
   remove it (recommended), or align it to the manager's exact version,
   **before running the new bundle**. Do not assume either the old selection
   or direct dependency is cleaned up automatically.

If the old standalone UI bundle was disabled, preserve that intent **before
loading the new manager bundle** with this profile patch row override:

```yaml
- id: mcp-project-ui
  disabled: true
```

Disabling the old standalone bundle alone does not disable the manager's new
UI component; without that override the default UI is enabled.

## Current workspace

All three entries render the same panel, so all three open with the same
**Current workspace** header. It answers "which workspace am I looking at?":

- the **Current workspace** label;
- the workspace name (the last path segment) and the full path on one line,
  with the path ellipsized when long and shown in full on hover;
- a status line — `N servers · M running · K waiting for a session · J disabled`
  — with only the non-zero parts;
- the note "Automatically loads the MCP servers of the workspace you are in."

When the host cannot tell yet (several workspaces and no session focus), the
name reads **Current workspace not determined**, the path is hidden, and the
note becomes "Open a session or send a message to determine it." The counts
cover only rows in that workspace; starting, failed, and other states are not
listed separately but still count in the total.

Workspace groups follow the same focus. The current group moves to the top and
gets a **Current** tag; other groups that still have a row waiting for a
session get an **Idle** tag and the sentence "Loads when you switch to this
workspace." A row skipped for a more specific reason (a missing environment
variable, a taken name, and so on) does not add the Idle tag.

## What the list shows

Servers are grouped into sections:

| Section | Files |
|---|---|
| Workspace | `<projectRoot>/.dsh/mcp.yml`, `.dsh/mcp.json`, `.mcp.json` of each known project |
| Profile: Desktop / Web / `<name>` | `~/.dsh/profiles/<active profile>/mcp.yml` and `mcp.json` |
| User | `~/.dsh/mcp.yml`, `~/.dsh/mcp.json` |

User and profile paths are shown from `~`; workspace paths stay absolute.

**One card per server the loader will run.** Rows are merged with the same
shadow rules as the loader (exact name, normalized name, service identity; see
[configuration sources and layers](layers.md)):

- A same-name row in a lower-priority file stays on the winning card as an
  "overridden" note.
- A row with a different name but the same command and arguments (or the same
  URL) is noted on the winning card when it comes from a yml file, and left
  off the list when it comes from a JSON file, because the loader never starts
  it.

The tag beside the name shows the source file. A yellow `<file> · unmanaged`
tag means the row comes from a JSON file or `.mcp.json`; changes to it go
through a confirmation (see below).

**Status line**:

| Status | Meaning |
|---|---|
| Running · N tools | Connected, tools registered. Green switch. |
| Enabled · waiting for a session | Switched on but not mounted, e.g. no session in that workspace yet, or unmounted after the idle grace. White switch. |
| Starting | Mount in progress. The page keeps refreshing until it settles. |
| Failed to start | The connection failed. |
| Not started · name in use / missing environment variable / invalid after variable expansion / invalid config / retries stopped | The loader skipped the row. The full reason is on the next line. |
| Disabled | The row is switched off (`disabled: true`). |

The page updates on its own after every reconcile (server-sent events, with a
polling fallback), so edits from an editor or the CLI show up too.

## Add a server

Choose **Add MCP**:

1. **Save to**: Workspace (the current workspace's `.dsh/mcp.yml`), User
   (`~/.dsh/mcp.yml`), or Profile (`~/.dsh/profiles/<active>/mcp.yml`). The
   target path is shown under the switch. Workspace is unavailable until a
   session is open in a workspace; Profile is unavailable when the active
   profile cannot be resolved.
2. **Name**: 1–32 letters, digits, `_` or `-`. A name already in that file is
   rejected and the file is left unchanged.
3. **Type**: Local command (stdio) or Remote URL (Streamable HTTP).
4. Local command: command, arguments (one per line), environment variables
   (one `KEY=value` per line). Remote URL: URL, headers (one `Name: value` per
   line). `${VAR}` references are written through literally and expanded at
   mount time ([`${VAR}` expansion](env-expansion.md)).

**Add** writes one managed row and starts a reconcile. A stdio row in the
workspace gets `cwd: .` (the project root); user and profile rows inherit the
host directory.

**Fill from clipboard** reads JSON or YAML from the clipboard and fills the
fields. It accepts an `mcpServers` or `servers` map, a single entry, or a
managed yml row. With several servers it fills the first and says how many were
left out. `enabled: false` entries are skipped, and an SSE (`type: "sse"`)
entry is refused because the loader cannot mount it. The browser may ask for
clipboard permission. The save location stays whatever is selected.

The form does not cover `tools.allow`/`deny` patterns, `reconnect`,
timeouts, or `maxInstructionBytes`. Use **MCP config** for those.

## MCP config

The menu beside Add MCP opens a managed `mcp.yml` in the system's default
editor: the user file, the active profile file, and one per known workspace.
A missing file is initialized as an empty YAML list (`[]`); the managed block
is created on the first server write. On Windows the
file is also selected in Explorer. Syntax is in [configuration format](format.md).

## Switch, remove, and tools

- **Switch**: on a managed yml row, flips `disabled` in place.
- **Remove**: asks first. On a managed yml row it deletes the row. If a
  lower-priority file still has the same name or the same command, a
  `disabled: true` placeholder is kept instead, so that copy does not start.
- **Manage tools**: lists the tools the running server registered, with one
  switch each. Switching writes the exact tool name into that row's
  `tools.allow` / `tools.deny`. A server that is not running shows no tools.

**Rows from JSON files or `.mcp.json`** are not edited in place. Every change
first shows a confirmation, then writes a higher-priority row to the managed
yml of the same scope, and the original file stays unchanged:

| Card source | Written to |
|---|---|
| `.dsh/mcp.json`, `.mcp.json` | that workspace's `.dsh/mcp.yml` |
| profile `mcp.json` | profile `mcp.yml` |
| `~/.dsh/mcp.json` | `~/.dsh/mcp.yml` |

Enabling copies the whole entry; disabling or removing writes a
`disabled: true` placeholder that holds the name (see
[configuration sources and layers](layers.md) for how `disabled` shadows lower
layers).

**Workspace cards can only be changed for the current workspace.** Cards of
other workspaces are greyed out ("This workspace cannot be edited right now").
User and profile cards are always editable.

## Security

Adding a local-command server from this page is the same as writing a `stdio`
row by hand: the dsh host spawns that command. The page's routes
(`/api/project-mcp/*`) are served on the dsh connection, so anyone who can use
this dsh web GUI can add and start servers through it. Treat access to the GUI
as access to the managed config files.
