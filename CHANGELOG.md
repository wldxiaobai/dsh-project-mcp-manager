# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[unreleased]: https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wldxiaobai/dsh-project-mcp-manager/releases/tag/v0.1.0
