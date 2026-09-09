# Configuration sources and layers (six layers)

English | [中文](layers.zh.md)

[← README](../../README.md) ｜ Related: [configuration format](format.md) · [`${VAR}` expansion](env-expansion.md) · [CLI `dsh-mcp`](cli.md)

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

Layer 4 is dynamic: the profile name is resolved at runtime, so no profile name
is ever hardcoded. The file syntax of layers 1/2 and of the JSON user layers is
described in [configuration format](format.md).

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

## Legacy Claude Code layer (read-only)

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
