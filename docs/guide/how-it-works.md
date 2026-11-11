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
  target. Before the first model request, DSH waits up to 20 seconds for
  visible Eager servers still loading. Newly discovered workspace collisions
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
  the dsh process cwd. The same scope filters server instructions and resource
  discovery, and resource calls are checked per session. Tool restrictions are
  released when the session is destroyed.
