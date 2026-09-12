# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `package.json` discovery fields: `repository`, `bugs`, and `homepage` point at
  https://github.com/wldxiaobai/dsh-project-mcp-manager so npm and GitHub can
  surface the source, issues, and README.

### Changed

- Documented compatibility with dsh **0.1.5-rc.2**
  (`docs/design/adaptation-dsh-0.1.5-rc2.md`). Official rc.2 is UI-only relative
  to rc.1; `dsh-mcp-client` / `dsh-tools` `lib/` are byte-identical, so the
  existing `^0.1.5-rc.1` range already covers the new host. No runtime change.

## [0.4.3] - 2026-09-10

Host-alignment release for dsh 0.1.5-rc.1. **No user-visible behaviour
changes** — configuration format, mount semantics, deny isolation and CLI
output are unchanged. The published 0.4.2 range could not resolve the
host's prerelease client.

### Changed

- **Align `@deepseek-ai/dsh-mcp-client` with dsh 0.1.5-rc.1.** Specifier
  `^0.1.2-rc.1` cannot resolve a `0.1.5-rc.*` prerelease (npm semver keeps
  prereleases on the same major.minor.patch tuple), so the plugin was still
  loading its own 0.1.2-rc.1 copy and 0.1.2-rc.1 peers inside a 0.1.5-rc.1
  host. The range is now `^0.1.5-rc.1`. pnpm 12 wrote
  `pnpm-workspace.yaml` `minimumReleaseAgeExclude` for the new rc peers so
  the supply-chain age gate does not block them.

## [0.4.2] - 2026-09-10

Code-quality release: clears all 15 findings that held the PR #7 Sonar gate at
"Reliability Rating on New Code = D". **No user-visible behaviour changes** —
every fix is either an explicit restatement of what the code already did, or an
internal decomposition.

### Fixed

- **Every string sort now passes an explicit comparator.** New
  `byCodeUnit(a, b)` in `src/model.ts` — UTF-16 code-unit order, byte-identical
  to `Array.prototype.sort`'s default and deliberately *not* locale collation
  (`localeCompare` would let the host's locale decide the order of wire-visible
  sequences: diagnostic and snapshot key sets, warning-gate signatures, `list`
  output). Applied at all 15 call sites across `src/registry.ts`, `src/cli.ts`
  and the test suite; ordering is unchanged, so no expectations moved.

### Changed

- **Internal decomposition of `scanProject`** (cognitive-complexity finding):
  the duplicate-service shadow warning with its change gate moved into
  `warnIdentityShadows`, and the scan-diagnostic payload into a pure
  `buildScanDiag` that returns `null` for a clean, config-free project. The
  zero-config-no-trace rule and every warning/diagnostic set are identical.
- `collectLayers` pushes its three trailing layers in a single call (left-to-right
  evaluation keeps the layer precedence unchanged), and one test helper block lost
  its redundant braces.
- **Lockfile metadata**: `pnpm-lock.yaml` now records the `@deepseek-ai/cordis`
  specifier `^4.0.2` that `package.json` has declared since v0.4.1 (resolved
  version was already `4.0.2`); `pnpm` no longer demands a re-lock on every run.

## [0.4.1] - 2026-09-10

Follow-up on the code review of every TypeScript change since v0.3.1
(`docs/code-review/ts-review-since-v0.3.1.zh.md`). No configuration file format
changes; the only observable output change is that CLI-written JSON entries now
carry an explicit `type`.

### Fixed

- **Project-side suppression no longer denies a project its own tools.** A
  `disabled: true` placeholder in a user-layer file, or a user-layer row refused
  because a host global patch row already holds the name, used to enter the
  project's suppression set anyway. Since neither produces a global instance, the
  `mcp__<name>__*` deny prefix hit the project's own server (whose effective name
  was never renamed) or the host patch instance — silently, with the snapshot
  still reporting `fiberPhase: "active"` and no `skipReason`. The user-layer merge
  and the host-taken name set are now computed before the project loop, so
  suppression only ever contains names that really mount globally, and the sweep
  additionally guards on a live global instance.
- **`$DSH_HOME` is honoured everywhere.** The user layer (`mcp.yml`, `mcp.json`,
  `profiles/<name>/mcp.json`), the global diagnostics file and every CLI
  read/write path resolve the dsh home through the new `src/dsh-paths.ts`
  (`dshHomeDir` / `dshHomeFor`). Previously they hard-coded `homedir()/.dsh`, so a
  relocated dsh home made the whole user layer disappear without a word (a
  missing file is a legitimate zero-config state). Injected paths
  (`userLayerPaths`, CLI `deps.home`) still win over the environment variable.
- **`remove` explains a cross-dialect takeover.** Removing a name that exists in
  both `mcp.yml` and `mcp.json` still deletes the first hit only, but now prints
  which file's same-named definition will take over as a result.
- **Malformed `mcpServers` entries survive a write.** `readJsonServers` and
  `updateJsonServers` no longer drop non-object entries, so a hand-written
  `"legacy": "node x.js"` is not silently deleted by an unrelated `add`/`remove`;
  the name it holds is visible to duplicate detection and can be cleared by
  `dsh-mcp remove legacy`.
- **The yml write path is a lock-held read-modify-write.** The new
  `updateManagedRows` replaces the previous "read outside the lock, replace inside
  it" shape, so two concurrent `add`s cannot lose each other's row. `EACCES` and a
  corrupt managed block are no longer swallowed as "missing file":
  `createIfMissing` now only accepts `ENOENT`.
- **`DSH_MCP_PROFILE` is validated before it becomes a path.** A value such as
  `../../somewhere` used to be joined straight into the profiles directory and
  read from outside it. Invalid names (anything not matching
  `^[A-Za-z0-9][A-Za-z0-9._-]*$`, plus an explicit `.` / `..`) now degrade to
  "unresolvable" — the profile layer is skipped — and warn once.
- `serverView` reports user-layer rows with a `global` scope and the layer file
  path instead of `workspace` + project root, matching the snapshot partitions.

### Changed

- **Shadow diagnostics are attributed to the layer that owns the conflict.**
  `IdentityShadow` carries the loser's and winner's source, and a new
  `shadowedGlobal` bucket records same-name shadowing between user layers (which
  previously had no visibility at all). Conflicts confined to the user layer are
  reported once globally, in `<dshHome>/.mcp-diag.json`; the per-project pass only
  keeps entries where at least one side is a project-layer row, so a zero-config
  project is no longer given a `.dsh/.mcp-diag.json` because two user-layer files
  disagree.
- **Repeat warnings are gated on change.** File-level errors, bad entries and the
  `name-taken` set now warn only when the set itself changes, instead of once per
  reconcile per project. `skipReason` is still written every round, so the
  snapshot keeps reporting the cause.
- The `name-taken` warning says "host global patch row (bundle layer or profile
  patch layer)", matching what `globalNames()` actually collects.
- CLI-written JSON entries include an explicit `type` (`stdio` / `http`) so other
  tools that require the key can consume the file; this plugin's own reader still
  infers it.
- `add` now reports, after a successful write, that the new row will not mount
  when a higher-priority layer shadows it (by name or as the same service), and
  notes when the other dialect file in the same scope also holds definitions.
- Non-`ENOENT` JSON read failures carry their errno code (`读取失败（EACCES）`);
  the code never contains file content.
- `rowNameOf` moved to `src/model.ts` and is shared by the loader and the CLI:
  the managed row id wins over `config.serverName`. The CLI previously used the
  reverse precedence, so a row whose id and `config.serverName` disagreed could
  not be removed by the name the loader actually mounted.
- `docs/guide/layers.md` / `.zh.md` document the legacy `.mcp.json` behavior
  changes introduced in v0.4.0 (an explicit entry `cwd` now applies, the DSH
  passthrough keys apply, and `disabled: true` holds the name instead of being a
  silent skip); `docs/guide/cli.md` / `.zh.md` note that `-f` and `-p` are
  reserved short flags.
- Wire note for snapshot consumers (a v0.4.0 change, documented here): in the
  `snapshot()` partitions of the global layers, `project` now carries the
  directory of the layer file itself — the dsh home for `mcp.yml` / `mcp.json`,
  `profiles/<name>` for a profile file — where v0.3.1 reported the parent of
  `.dsh` (the home directory). Consumers such as `dsh-skill-mcp-panel` should
  read it as "the layer's own directory", not as a workspace root.

### Changed (0.4.0 documentation and cleanup, previously unreleased)

- Documentation restructured: the feature write-ups moved out of the READMEs
  into `docs/guide/` as English/Chinese pairs — `format.md`/`.zh.md` (native
  YAML managed block, JSON dialect, divergences from the cordis dialect),
  `layers.md`/`.zh.md` (six-layer sources, shadow priority, global vs project
  mounting, legacy Claude Code layer), `env-expansion.md`/`.zh.md` (`${VAR}`
  expansion) and `cli.md`/`.zh.md` (`dsh-mcp`); release notes live in
  `docs/releases/v<version>.md`, the adaptation and proposal records in
  `docs/design/`. `README.md` and `docs/README.zh.md` keep only the
  introduction, installation/build, how it works and the security boundary,
  each linking to the documentation in its own language; every cross-document
  link, the `AGENTS.md` directory listing and the `src/index.ts` header comment
  follow the new layout.
- Internal cleanup for the SonarCloud new-code review, with no behavior change:
  test fixtures drop their world-writable-path literals (`/tmp/…`; the analyzer
  graded one as a security vulnerability and failed the quality gate) and every
  hand-rolled `sort()` comparator across `src/` and `test/` gives way to the
  default code-unit ordering. Nested ternaries and a nested template literal in
  `cli.ts` / `json-file.ts` become explicit statements, adjacent `Array#push()`
  calls merge into one, `String#replace(/\\/g, …)` becomes `String#replaceAll`,
  and the three over-complex functions are split — `cmdRemove`
  (→ `removeFromTarget`), `ProjectMcpRegistry.mountServer`
  (→ `buildServerConfig` + `trackMount`) and `sweepRestrictions`
  (→ `activeMountGroups` + `registeredToolIds` + `expandToToolNames`).

## [0.4.0] - 2026-09-09

### Added

- **DSH-native JSON configuration** in the ecosystem-standard
  `{"mcpServers": { … }}` dialect (Cursor / Claude Code shape) at
  `<projectRoot>/.dsh/mcp.json`, `~/.dsh/mcp.json` and
  `~/.dsh/profiles/<name>/mcp.json`. Entries accept `command`/`args`/`env`/`cwd`,
  `url`/`headers`, optional `type` (`stdio`|`http`|`streamable-http`; `sse`
  rejected per entry), the DSH passthrough keys `toolCallTimeoutMs` /
  `failOnStartupError` / `reconnect`, `enabled: false` (silent skip, does not
  hold the name) and `disabled: true` (holds the name, not mounted), plus
  `${VAR}` interpolation at mount time.
- `dsh-mcp --format yml|json` with the `DSH_MCP_CLI_FORMAT` default
  (`yml`|`json`, defaults to `yml`); `--scope profile --profile <name>` writes
  `~/.dsh/profiles/<name>/mcp.json` (JSON only); `remove` searches the yml then
  the json file. The JSON file is CLI-owned: writes preserve other top-level
  keys and key order, refuse to overwrite an unparsable file, and run inside the
  existing lock + atomic write.
- `DSH_MCP_PROFILE` overrides the profile name used to locate
  `~/.dsh/profiles/<name>/mcp.json`; otherwise it is derived from the loader
  root include's `config.path` / `ctx.baseUrl`, and the layer is skipped when it
  cannot be resolved.
- `skipReason: "name-taken"` when a user-layer row collides with a
  profile patch-row global server (the row is skipped, not renamed).

### Changed

- **BREAKING** — user layers are now mounted **globally**: one host-wide
  `mcp-client` instance per row instead of one per known project. They are
  visible to every session and no longer take part in per-project visibility.
  A project's own row (same name, normalized name, or service identity) now
  suppresses the global server **for that project's sessions only** (per-session
  `tools.restrict`), while the global instance stays mounted.
- **BREAKING** — source/layer names are DSH-native:
  `yml` → `dsh-project`, `user-yml` → `dsh-user-yml`, plus new
  `dsh-project-json`, `dsh-profile-user`, `dsh-user`; the legacy Claude Code
  project file keeps its `cc-project` name. Diagnostics, snapshots and CLI
  labels report the new names.
- Layer precedence (first wins, per row) is now
  `.dsh/mcp.yml` > `.dsh/mcp.json` > `.mcp.json` > profile json > `~/.dsh/mcp.yml`
  > `~/.dsh/mcp.json`. Project rows keep the `p<hash>_` rename on conflicts;
  global rows never rename.
- User-layer diagnostics moved to `$DSH_HOME/.mcp-diag.json` (project
  diagnostics stay at `<projectRoot>/.dsh/.mcp-diag.json`).

### Removed

- **BREAKING** — `~/.claude.json` is no longer read at all. The cc-user layer,
  `DSH_MCP_READ_CLAUDE_USER`, `DSH_MCP_IGNORE_CLAUDE_JSON`, the
  `mcpServers`-subtree content hash gate and `canonicalJsonString` are gone.
  Migrate those rows to `~/.dsh/mcp.json` or
  `~/.dsh/profiles/<name>/mcp.json`.
- `DSH_MCP_IGNORE_MCP_JSON` still disables the legacy project `.mcp.json` layer
  only.

### Fixed

- `npm run build` now clears `lib/` before compiling, so modules deleted from
  `src/` no longer linger as stale build output.

### Dependencies

- `@deepseek-ai/dsh-mcp-client` `^0.1.1-rc.2` → `^0.1.2-rc.1`: the old
  prerelease range never resolves past the 0.1.1-rc.* line (npm semver requires
  a matching major.minor.patch tuple for prerelease candidates), so the plugin
  loaded its own 0.1.1-rc.2 copy plus 0.1.1-rc.2 peers inside a 0.1.2-rc.1 host.
  It now resolves 0.1.2-rc.1 with the same peers as the host
  (`dsh-scope` replaces `dsh-invariants`).
- Dev dependency `@deepseek-ai/cordis` `^4.0.1` → `^4.0.2` (types only) to
  match the host.
- Package manager is now pnpm: `pnpm-lock.yaml` is committed and the stale
  `package-lock.json` (still pinned at v0.1.1) is removed;
  `package.json` declares `packageManager: pnpm@12.3.4`. Build/test docs use
  `pnpm install`.

## [0.3.1] - 2026-09-04

### Fixed

- The one-shot `DSH_MCP_READ_CLAUDE_USER` / `DSH_MCP_IGNORE_CLAUDE_JSON`
  conflict warning now re-arms when the conflict clears by unsetting the
  legacy switch (the documented remedy). Previously the latch only reset on
  the path where the opt-in itself was removed, so a second conflict went
  silent.
- Identity dedup warnings (`跳过重复服务定义 "x"`) now use a per-project
  shadow-set signature gate: they fire when the set of shadowed rows changes,
  not on every reconcile. Previously any file event caused one warning per
  project per shadowed row per reconcile cycle.
- `dsh-mcp list`/`get` now annotate rows dropped by the registry's
  cross-layer dedup (normalized-name or service identity, not just exact
  name), by running `mergeSourcedRows` over the same four layers — the CLI
  view and what actually mounts no longer disagree.
- `serverView()` no longer hardwires the mount-ownership flag: `fiberPhase`
  and `toolCount` now require the located row's source to own the mounted
  instance (same rule as the partition view), so a row that does not back the
  live mount no longer borrows the winner's phase and tool count.

### Changed

- The identity-dedup warning now carries the remedy ("确属不同服务器请改名或
  调整命令与参数"), and both READMEs document the two identity-key caveats
  that used to be implicit: comparison runs on raw config strings **before**
  `${VAR}` expansion, and `env`/`headers`/`cwd` are not part of the key.
- Legacy `DSH_MCP_IGNORE_CLAUDE_JSON` now has an explicit removal anchor
  (`TODO(v0.4)` at its definition site).

## [0.3.0] - 2026-09-03

### Changed

- **BREAKING** — `~/.claude.json` top-level `mcpServers` (the CC user layer) is
  no longer read by default. It is machine-wide foreign state, and mounting it
  unconditionally fanned every such server into every known project as its own
  process (a zero-config directory silently spawning another workspace's
  servers). Opt in with `DSH_MCP_READ_CLAUDE_USER=1`. The legacy
  `DSH_MCP_IGNORE_CLAUDE_JSON=1` survives one release as a force-off override:
  when both are set the ignore switch wins, with a one-shot warning (the
  legacy switch will be removed later).
- `mergeSourcedRows` now dedups same-service rows across layers by priority,
  not just by exact name: three first-come-first-served shadow keys — exact
  `serverName`, normalized name (lowercase, non-alphanumerics stripped, so
  `unityMCP` and `unity-mcp` are one service), and service identity (`stdio`
  command + args, path-case-insensitive on Windows; `streamable-http` url).
  Rows without a command/url claim no identity key (`node a.js` vs
  `node b.js` stay distinct); `disabled` placeholder rows hold all three keys
  without mounting. Drops are visible: `shadowedIdentity` in the scan
  diagnostics plus a host-log warning per row.

### Added

- `DSH_MCP_IGNORE_MCP_JSON=1` turns the project `.mcp.json` (CC project layer)
  off wholesale — reading, watching, snapshot partitions and CLI views all
  honor it. The layer itself stays on by default as an in-repo declaration.
- When the CC user layer is on, the host logs a one-time fan-out notice
  ("N servers will join M known projects") with the way back (unset the opt-in
  or shadow per project with a `disabled` placeholder row).
- Truth-table tests for the new layer predicates, `mergeSourcedRows` dedup
  unit cases (0.1–0.7), and registry scenarios 25–28 plus CLI scenarios 12–13
  covering the three switches, the conflict arbitration and the incident
  replay (yml twin wins, foreign duplicate stays unmounted, others still fan).

### Fixed

- A project whose mounts all come from the user layer no longer writes false
  `ENOENT` scan diagnostics when `<projectRoot>/.dsh/mcp.yml` is absent — the
  missing-file scan error now only counts project-`yml` live mounts
  (previously `servers.size` counted every source).

## [0.2.1] - 2026-09-01

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

[unreleased]: https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.4.3...HEAD
[0.4.3]: https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wldxiaobai/dsh-project-mcp-manager/releases/tag/v0.1.0
