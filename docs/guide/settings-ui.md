# MCP Manager page

English | [中文](settings-ui.zh.md)

[← README](../../README.md) ｜ Related: [configuration sources and layers](layers.md) · [configuration format](format.md) · [`${VAR}` expansion](env-expansion.md) · [Lazy mode design record (Chinese)](../design/lazy-mcp.md)

The companion package `dsh-project-mcp-ui`, included in the default
`dsh-project-mcp-manager` bundle, adds an **MCP Manager** page with three entries —
main sidebar, settings sidebar, and a Built-in plugins settings tab. It lists the servers
the loader will run, shows whether each one is running, and lets you add,
switch, and remove servers; choose a per-server loading mode; or manage single
tools. Every change is written to a
**managed `mcp.yml`**; the page never edits JSON files or the legacy
`.mcp.json`. The loader does the rest through its normal file watch, so the page
and the [CLI](cli.md) can be used side by side.

## Install

Install **only the manager** into the profile you use:

```powershell
dsh plugin --profile web add dsh-project-mcp-manager@latest
dsh plugin --profile desktop add dsh-project-mcp-manager@latest
```

The plugin is mounted through a **bundle patch**: once the package is in
`dsh.profile.bundles`, dsh turns each bundle's patch (the `cordis.patch.yml`
pointed to by `dsh.bundle.patch`) into plugin rows at startup, in order.

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

## Entries

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

### Entry settings

Go to **Settings → General → MCP management page entries** and choose
**Configure…**. The dialog has one checkbox each for the main sidebar, the
settings sidebar, and the Built-in plugins tab. **Done** saves the dialog's
changes; **Cancel** discards them. Changes made in another browser sync in too.

- A save only writes the checkboxes you touched in this dialog. Settings changed
  in another window at the same time are not rolled back; if you changed
  nothing, **Done** just closes the dialog and writes nothing.
- If the Host refuses the write (usually because another window saved first),
  the dialog keeps your choices and says so. **Done** again retries against the
  revision that just synced in and still writes only the fields you changed;
  when both sides changed one field, the choice you just confirmed wins.
- You can turn off all three entries. The General row is not one of them and
  always stays, so you can turn entries back on.
- The same row is on the main sidebar's **Plugins → `dsh-project-mcp-manager`**
  page, and both places change the same setting. That page's README follows
  the UI language: Chinese shows `docs/README.zh.md`, other languages show the
  root `README.md`.
- When the page has no write permission (for example a remote browser), the
  checkboxes are disabled and the dialog says so.

### Hiding the whole page

Open the manager bundle's contained components in the plugin manager and
switch off only `mcp-project-ui`, leaving `mcp-project` enabled. Alternatively,
disable the UI row by its id in a profile patch override. This removes all
three entries without stopping the loader; it does not remove the UI
dependency.

## Current workspace

All three entries render the same panel, so all three open with the same
**Current workspace** header. It answers "which workspace am I looking at?":

- the **Current workspace** label;
- the workspace name (the last path segment) and the full path on one line,
  with the path ellipsized when long and shown in full on hover;
- the MCP context-cost tag (only with a session that has MCP tools; see below);
- a status line — `N servers · M running · K on standby · J disabled`
  — with only the non-zero parts;
- the note "Automatically loads the MCP servers of the workspace you are in."

### MCP context cost

The header also carries a short tag such as `MCP 3.4k`: roughly how many tokens
of MCP tool definitions the **current session** sends with every request. It
shows only the number; clicking it opens the detail:

- the estimate is `ceil(characters / 4) + 4`, the same heuristic the host uses
  for tool schemas — not a provider count, and it excludes server
  `instructions` and conversation history;
- the detail gives the share of the context window and the three largest
  servers;
- at 5,000 the tag turns to the reminder colour and the detail suggests lazy
  loading; at 10,000 it turns to the warning colour and gains a warning icon.
  The number always stays visible, so colour is never the only signal, and the
  tag's `aria-label` reads the threshold out too.

The tag is absent when there is no session, or when the session has no MCP
tools. It refreshes itself: the host re-emits its update signal whenever the
request header or route changes, and the page re-reads on that event.

When the host cannot tell yet (several workspaces and no session focus), the
name reads **Current workspace not determined**, the path is hidden, and the
note becomes "Open a session or send a message to determine it." The counts
cover only rows in that workspace; user and profile servers never count. Starting,
failed, and other states are not listed separately but still count in the total.
Active Lazy rows count as **on standby**, not running. This is a display
projection: a Lazy row may already have an open on-demand connection; the card
and header do not project connection state, so the standby count is not proof
that no connection exists.

Workspace groups follow the same focus. The current group moves to the top and
gets a **Current** tag; no other group carries a tag.

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
| Available on demand | Enabled Lazy row. Its on-demand connection is not projected and may already be open from a recent call; the next `mcp_search` / `mcp_describe` / `mcp_call` uses it, reconnecting if it was closed. |
| Enabled · waiting to load | Switched on but not mounted yet, e.g. the host has yet to load its configuration. White switch. |
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
3. **Loading mode**: Eager (default) or Lazy; see [Loading mode](#loading-mode).
4. **Type**: Local command (stdio) or Remote URL (Streamable HTTP).
5. Local command: command, arguments (one per line), environment variables
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

## Loading mode

Every server card has a **Loading mode** control: **Eager** (default) or
**Lazy**; the add dialog has the same control. The choice is stored as
`config.mode` in the managed yml; omitting it means Eager, and an explicit
`config.mode: eager` is equivalent.

- **Eager** keeps the existing behavior: the server connects when mounted and
  each tool is registered in DSH. Use it for server instructions, DSH
  Resources, host policies that target individual registered tool names, or the
  **Manage tools** switches.
- **Lazy** connects separately for each session on its first `mcp_search`.
  Without `server`, the search can start several processes at once. An
  activated connection stays open until the session ends or the configuration
  is unloaded or replaced. Lazy rows
  show **Available on demand**; the **Manage tools** button is hidden because
  no per-tool tools are registered. The page does not probe a Lazy server; a
  failure surfaces only on the first search or call. Edit `tools.allow` /
  `deny` in the row's source file, or switch to Eager for per-tool switches.
- A mode change writes only the managed yml and does not enable a disabled row:
  a disabled row stays disabled. If the target row has no valid connection
  config (for example a hand-written disabled placeholder), the change is
  rejected and the file is left unchanged. JSON files and `.mcp.json` are never
  rewritten: the page asks for confirmation and writes a higher-priority
  overlay in the managed yml of the same scope. The existing write-target rules
  still apply (current workspace only; user and profile when resolvable).
- Lazy is not a security boundary: a stdio command still starts on first use,
  and `mcp_call` can invoke any tool that passes the row's `tools.allow` /
  `deny` and is visible to the session. Host policies that target
  `mcp__<server>__<tool>` names do not see Lazy tools; use Eager for those.
- The complete set of differences (connection timing, instructions/Resources,
  `reconnect`, `maxInstructionBytes`, timeouts) is in
  [configuration format](format.md#loading-mode) and the
  [Lazy mode design record (Chinese)](../design/lazy-mcp.md).

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
  The button is hidden for Lazy rows (see [Loading mode](#loading-mode)).

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
layers). Changing the loading mode also writes the overlay and keeps the
`disabled` state.

**Workspace cards can only be changed for the current workspace.** Cards of
other workspaces are greyed out ("This workspace cannot be edited right now").
User and profile cards are always editable.

## Security

Adding a local-command server from this page is the same as writing a `stdio`
row by hand: the dsh host spawns that command. Lazy defers the connection, not
the trust decision: the first search or call still starts the stdio command,
and a search without `server` connects every visible Lazy server. The page's
routes (`/api/project-mcp/*`) are served on the dsh connection, so anyone who
can use this dsh web GUI can add and start servers through it. Treat access to
the GUI as access to the managed config files.
