# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- CC entries with `"disabled": true` are treated exactly like `"enabled": false`
  — skipped silently, and (unlike a native-yml `disabled: true` row) without
  occupying the name in the shadow chain.
- `${VAR}` references in stdio `cwd` are now expanded like every other string
  field, and a `url` containing a reference passes the pre-mount schema in any
  position — including the host part (`https://${HOST}/mcp`); validity is
  judged only on the expanded value (`env-invalid` skip when it fails).
- Registry scenarios for the post-release fixes (project-vs-user empty `cwd`,
  exact-config-file watcher kicks) and CLI tests for the
  `DSH_MCP_IGNORE_CLAUDE_JSON` listing gate and real project-root fallback.

### Changed

- The user-layer watcher watches the two exact file paths `~/.dsh/mcp.yml` and
  `~/.claude.json` instead of the `~/.dsh` directory, and `~/.claude.json`
  events are arbitrated by the canonical-JSON content hash alone — the
  size/mtime fast path is gone, since same-instant, same-length rewrites with
  different content must not be swallowed.
- Snapshot/row views keep `fiberPhase` on the strict mount-lifecycle vocabulary
  (`pending` for a row that never mounted) and report the concrete reason on a
  separate `skipReason` field (`env-missing` / `env-invalid` / `config-invalid`
  / `plugin-throw`).
- Dead export `ENV_REF_RE` removed from `src/model.ts` (superseded by the
  embedded-reference scan).

### Fixed

- An empty stdio `cwd` now resolves **per source**: project-layer rows
  (`.dsh/mcp.yml`, `.mcp.json`) get the project root, while user-layer rows
  (`~/.dsh/mcp.yml`, `~/.claude.json`) keep inheriting the dsh host's working
  directory — previously every empty `cwd` was resolved against the project
  root of whichever project mounted the row.
- The project watcher kick now matches the exact config-file paths of known
  project roots; a stray `<root>/**/.dsh/mcp.yml` deeper in the tree no longer
  triggers a reconciliation.
- `.dsh/.mcp-diag.json` is written atomically (temp file + rename), so
  concurrent readers (snapshot tooling, tests) can no longer observe
  half-written JSON; stale skip-reason marks for deleted unmounted rows are
  pruned during reconciliation.

## [0.2.0] - 2026-09-01

### Added

- Claude Code read-only compatibility layer (`src/cc-file.ts`): the plugin now
  loads `<projectRoot>/.mcp.json` and the **top-level `mcpServers` allowlist** of
  `~/.claude.json` (CC's monolithic state file — nothing else in it is read, written,
  logged, or echoed). Shadow priority: project `.dsh/mcp.yml` > project `.mcp.json` >
  `~/.dsh/mcp.yml` > `~/.claude.json`, with shadowed names recorded in
  `.dsh/.mcp-diag.json` (`shadowedByYml` / `shadowedByProject`). `type: "sse"` entries
  are rejected per entry (the mount backend only speaks stdio and streamable-http);
  unknown CC keys are tolerated; `enabled: false` skips an entry silently;
  `type: "http"` and explicit `"streamable-http"` map to `streamable-http`, and a
  url-only entry (no `type`/`command`) is inferred as http; project-layer stdio `cwd`
  defaults to the project root while user-layer rows resolve against the host working
  directory. The `~/.claude.json` watcher gates on a canonical-JSON
  hash of the `mcpServers` subtree, so CC's routine state rewrites do not trigger
  reconciles; `DSH_MCP_IGNORE_CLAUDE_JSON=1` disables reading and watching the file
  entirely. There is deliberately no `local` scope (CC's `claude mcp add` default
  location is explained wherever a user would expect it).
- `${VAR}` runtime expansion (`src/model.ts` `expandEnvRefs`): `${NAME}` references
  (`\$\{[A-Za-z_][A-Za-z0-9_]*\}`, allowed anywhere in the string — same semantics as
  Claude Code, so `"Bearer ${TOKEN}"` works) in `command`, `args[*]`, `env[*]`, `url`,
  and `headers[*]` are interpolated against the dsh host environment at mount time for
  every configuration source. An unset **or empty** variable skips the row with an
  `env-missing` diagnostic naming the variable only; expanded inputs are re-validated
  against the mount schema and a malformed result is skipped with `env-invalid`.
  Values are never persisted by the plugin, so
  configs can live in git while secrets stay in the environment.
- `dsh-mcp` CLI (`src/cli.ts`, new `bin` entry): `add` / `list` / `get` / `remove` with
  `--scope project|user` (default project) and `--transport stdio|http`, mirroring CC
  ergonomics. Writes land exclusively in native `.dsh/mcp.yml` files (project root or
  `~/.dsh/mcp.yml`) through the locked atomic writer; `.mcp.json` / `~/.claude.json`
  stay read-only and `remove` on a name that only exists there prints editing
  guidance. `list`/`get` show all four layers with shadow annotations; secret values
  render as key names only. No new runtime dependencies (hand-rolled argv parsing);
  `runCli(argv, io, deps)` is importable for tests.
- Tests: `test/test-cc-file.mjs` (dialect mapping, allowlist, hash stability,
  content-free errors), `test/test-cli.mjs` (add/list/get/remove incl. `--` passthrough
  and scope routing), and registry scenarios for multi-source shadowing, user-layer hot
  mounting, the `~/.claude.json` hash gate, and `${VAR}` skip-then-mount.
- Managed-block reader regression tests (`test/test-mcp-file.mjs`): literal rows load;
  `!!js` in `env` or `disabled` and any other unresolved YAML tag inside the managed block
  fail the file with an explicit error; tags outside the markers do not affect reading, and
  panel writes preserve out-of-marker content byte-for-byte.
- Registry regression scenario: a hot-reloaded file whose managed block becomes invalid is
  unmounted (previously mounted servers disposed) without a remount attempt; the snapshot
  reports the file error and the diagnostic file keeps the reason.
- README and `docs/README.zh.md`: a "Divergences from the native cordis dialect" section
  (`!!js` unsupported, `env`/`headers` `KEY: null` superset semantics), and a note that
  model-visible tool names are built from the effective (possibly renamed) server name.
- Repository guidance `AGENTS.md`: authoritative project overview, key behavior contracts,
  and — as the single home the git skills point to — the Git commit cadence and branch
  policy (features and fixes commit directly to `dev`; `main` only advances through
  user-initiated PR/MR).

### Changed

- `snapshot()` partitions now carry a `source` tag (`yml` / `cc-project` / `user-yml` /
  `cc-user`) and an optional `kind` (`workspace` projects, new `global` user-layer
  partitions); each project additionally reports a `.mcp.json` partition (with
  `entryErrors` for broken CC entries) when it has one, and per-server views gained
  `source`. Absent a project `.dsh/mcp.yml`, the yml partition is skipped when no
  yml-sourced server is mounted (user-layer mounts no longer look like "file deleted
  under a live mount").
- `${VAR}` references now interpolate inside strings at mount time for **all**
  sources, including native `.dsh/mcp.yml` rows — previously documented as
  literal-only. The expansion never rewrites files; nothing matches "mixed
  forms" anymore because any embedded `${NAME}` interpolates (unset or empty →
  `env-missing` skip).
- The reconcile pipeline additionally reads the user layer (`~/.dsh/mcp.yml` and,
  unless disabled, `~/.claude.json`), watching the `~/.dsh` directory and the
  `~/.claude.json` file itself (never the home directory at large); the
  zero-config "leave no trace" rule still holds — user-layer rows falling into a
  project never create that project's diag file by themselves.
- A project whose managed block fails to parse no longer takes down the whole snapshot: the
  error is reported per file (`ok: false` plus the message) and that project's section is
  empty, while every other project still reports its servers.
- `reconnect.initialDelayMs` and `reconnect.maxDelayMs` are now bounded by 2147483647
  (`MAX_TIMER_DELAY_MS`, mirroring `@deepseek-ai/dsh-mcp-client`'s timer ceiling), and
  `reconnect.maxAttempts` by `Number.MAX_SAFE_INTEGER`. Out-of-range values are rejected at
  config load instead of surfacing later as a plugin-mount failure.

### Fixed

- Diagnostics from async fiber callbacks (`active`/`failed` mount-phase events) are now
  serialized through the reconcile chain instead of firing raw read-modify-write
  appends that could clobber concurrently written scan lines out of
  `.dsh/.mcp-diag.json`.
- Native cordis `!!js` tags (js-yaml expressions the profile loader evaluates) inside the
  managed block no longer load silently as literal strings. An unresolved tag now fails the
  file with an explicit error naming the offending position, logged and written to
  `.dsh/.mcp-diag.json` — previously such a line mounted with e.g.
  `TOKEN: "process.env.GITHUB_TOKEN"` verbatim, or an expression-disabled line mounted as
  enabled.
- An unknown `transport` value is rejected with a clear "must be stdio or streamable-http"
  error instead of falling into the stdio branch and reporting a misleading missing-`command`
  error.

## [0.1.1] - 2026-08-28

### Added

- Chinese documentation `docs/README.zh.md` (full translation of the plugin guide).
- Language switch links at the top of `README.md` and `docs/README.zh.md`.
- Project-local git skills under `.dsh/skills/` (`git-commits`, `git-history-safety`);
  `.dsh/` is now git-ignored, so these stay out of the repository.
- Registry regression tests: a project with a `.dsh/` directory but no `mcp.yml` produces no
  diagnostic file and is not treated as a known project; a config file deleted while its server
  is still mounted is still reported as a scan error and unmounted.

### Changed

- Installation section rewritten: npm-based installation is the primary method, with
  three documented options — `dsh plugin --profile <name> add dsh-project-mcp-manager@latest`
  (or `@<version>` to pin), plain `pnpm add` inside the profile directory, and
  `pnpm add link:<path>` for a live local-development mount.
- Documented bundle-patch mounting (`dsh.bundle.patch` → `cordis.patch.yml`) as the way the
  plugin is synthesized into profile plugin lines at startup, and added a warning against
  duplicating the loader entry id.
- Replaced machine-specific absolute paths with generic `dshHome` placeholders
  (`%USERPROFILE%\.dsh`, `$DSH_HOME`).
- Added a prerequisite note for installing dsh itself
  (`@deepseek-ai/dsh` from npm, or from source).
- `package.json` now ships `docs/` in the published `files` list.

### Fixed

- Projects without a `<projectRoot>/.dsh/mcp.yml` no longer get a stray
  `.dsh/.mcp-diag.json` written into them. A missing config file is now reported as an error
  only when the project has live mounts (i.e. the file vanished underneath a running server);
  clean scans that parse zero rows no longer append diagnostic records at all.
- The false positive came from the `this.projects.has(key)` ENOENT-suppression guard, which was
  always true because a project entry got registered even with zero servers. Project entries are
  now created only for projects that actually have rows to mount, so directories merely visited
  by a session — including the dsh process start directory (e.g. the user home) — stop
  accumulating as known projects.
- Diagnostic writes create the `.dsh` directory when needed (`mkdir -p` semantics), so a genuine
  mount failure is no longer lost silently when the directory does not exist yet.

## [0.1.0] - 2026-08-23

### Added

- Core plugin: per-project MCP server loading. Server lines written in
  `<projectRoot>/.dsh/mcp.yml` are mounted automatically whenever a dsh session opens
  in that project — no UI, core functionality only.
- Managed-block configuration reader (`src/mcp-file.ts`): a YAML `insert` list between
  `# >>> dsh-project-mcp-manager:mcp:begin` / `# <<< ...:mcp:end` markers, one MCP server
  per line, with content outside the markers preserved byte-for-byte.
- Configuration model and validation (`src/model.ts`, zod schemas) for `stdio`
  (command/args/env/cwd) and `streamable-http` (url/headers) transports, plus
  `toolCallTimeoutMs`, `failOnStartupError`, `reconnect` options and `disabled: true`
  to deactivate a line.
- Mounting registry (`src/registry.ts`): each `(project, serverName)` pair mounts one
  `@deepseek-ai/dsh-mcp-client` instance via `ctx.plugin` on the host ctx and registers it
  in the global tool layer; sessions in the same project share a single connection.
- Hot reload with chokidar: each project root is watched (depth 2, ignoring
  `node_modules`, `.git`, `.hg`, `.svn`); edits to `.dsh/mcp.yml` trigger a full
  reconciliation after a 150 ms debounce — added lines mounted, removed lines unmounted,
  changed lines remounted.
- Deterministic effective server names: unique names are kept; on a collision across the
  whole catalog, project lines are renamed to
  `p<first 6 chars of sha256(projectRoot)>_<original name>` (truncated to 32 characters,
  independent of mount order) to avoid per-process-root `serverName` reservation conflicts.
  Global lines participate in occupancy determination but are never renamed.
- Per-session tool visibility scoping (`src/index.ts`, `src/status.ts`): on agent creation the
  session cwd resolves to a project and `tools.restrict({ deny })` denies every project
  server except those of that session's own project; a session without a cwd falls back to the
  owner project (subagents), then to the project containing the dsh process cwd. Restrictions
  are released when the session is destroyed.
- Project-root discovery (`src/project-root.ts`): walks up from `session.header.cwd` and the
  dsh process start directory to the nearest ancestor containing `.git`, falling back to the
  directory itself when there is no repository.
- Bundle patch `cordis.patch.yml` so the plugin mounts automatically once the package is in
  `dsh.profile.bundles`, without manual `cordis.patch.yml` editing.
- Tests: `test/test-model.mjs` (config model/parsing) and `test/test-registry.mjs`
  (registry reconciliation), plus the TypeScript build pipeline (`npm run build` → `lib/`).
- Project scaffolding: `package.json` (ESM, `main: lib/index.js`), `tsconfig.json`,
  `.gitignore`, MIT `LICENSE`, and `README.md`.

### Changed

- Package and plugin renamed from the working name `dsh-mcp-project` to
  `dsh-project-mcp-manager` across `package.json`, `cordis.patch.yml`, sources, tests and
  docs — the published v0.1.0 ships under the new name.

Security note: `stdio` lines in `.dsh/mcp.yml` spawn their `command` inside the dsh host
process, so project files are executable-code carriers — add them only in trusted projects.

[unreleased]: https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wldxiaobai/dsh-project-mcp-manager/releases/tag/v0.1.0
