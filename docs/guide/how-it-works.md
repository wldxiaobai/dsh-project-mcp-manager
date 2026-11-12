# How it works

English | [中文](how-it-works.zh.md)

[← README](../../README.md) ｜ Related: [configuration sources and layers](layers.md) · [configuration format](format.md) · [query surface](service.md)

- **Project discovery**: the `session.header.cwd` of an active agent session,
  plus the dsh process start directory → walk up to the nearest ancestor
  containing `.git` as the project root (falls back to the directory itself
  when there is no `.git`).
- **Mounting**: each `(project, serverName)` pair in the project layers mounts
  one `@deepseek-ai/dsh-mcp-client` instance (`ctx.plugin`) on the host ctx and
  registers it into the global tool layer; multiple sessions inside the same
  project share a single connection. At startup, restored sessions and the
  process start directory supply the initial workspaces. Workspaces with MCP
  configuration stay mounted once discovered. Session focus updates the settings
  target. Creating a session waits up to 20 seconds for its visible Eager
  servers to finish mounting, so the first model request sees them; sessions
  restored at startup skip the wait. Newly discovered workspace collisions
  preserve existing Eager names and connections. Lazy still connects on demand.
  **Every user-layer row mounts exactly one instance** (global, independent of
  the number of projects) — see
  [configuration sources and layers](layers.md).
- **Hot reload**: chokidar watches each known project root and its `.dsh`
  directory (depth 1). The allow-list is that root, `.dsh`, and the three
  config files; every other path is ignored, so the watcher does not open
  `lib/`, `src/`, or `build/` and a Windows build can delete those directories
  while dsh is running. Edits to the **exact** config files of known project
  roots — `<projectRoot>/.dsh/mcp.yml`, `<projectRoot>/.dsh/mcp.json` and
  `<projectRoot>/.mcp.json` — trigger a full reconciliation after a 150 ms
  debounce: added rows are mounted, removed rows are unmounted, and config
  changes are remounted. A second watcher covers the
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
  sha256(project root)>_<original name>` (truncated to 32 characters) to avoid
  the serverName reservation conflicts that `dsh-mcp-client` makes per process
  root. Already-mounted Eager names are retained first (unless a host global
  name takes them), so a newly discovered workspace collision renames only the
  newcomer and never remounts the online instance; effective names therefore
  depend on mount history, and a retained prefixed name persists until unmount
  even after the collision disappears. If a generated name collides with a
  literal or truncated name, a deterministic hash suffix
  (`<first 23 chars>_<8 hex>`) is appended. Global rows (profile patch lines and
  user-layer rows) participate in occupancy determination but are never
  renamed. Model-visible tool names are built from
  the **effective** server name and the MCP tool's own name
  (`mcp__<effectiveServerName>__<toolName>`), which may differ from the
  `serverName` written in the file.
- **Session visibility**: when an agent is created, its session cwd resolves to
  a project, and `tools.restrict({ deny })` is applied to that agent to deny
  every project server except those of the session's own project, plus the
  global servers suppressed by the project's own rows; a session without a cwd
  falls back to the owner project (subagents), then to the project containing
  the dsh process cwd. The same scope filters server instructions and resource
  discovery, and resource calls are checked per session. Tool restrictions are
  released when the session is destroyed.
- **Context cost**: `contextCost()` prices the MCP tool definitions visible to
  a session; `resultCost()` prices every retained `tool/result` message whose
  originating call is an MCP tool, read from `session.deriveMessages()` so
  pruned or compacted results drop out. Lazy proxy definitions count once as
  shared overhead, and Lazy results are attributed by the proxy's `server`
  argument. Both use the token-meter heuristic and are estimates; the registry
  re-emits `projectMcp/updated` after request headers, tool results, or a
  compaction surface replacement changes the figure. See
  [query surface](service.md#tool-result-cost).
