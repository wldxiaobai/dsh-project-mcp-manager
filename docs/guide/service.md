# Query surface (`projectMcp`)

English | [中文](service.zh.md)

[← README](../../README.md) ｜ Related: [configuration sources and layers](layers.md) · [CLI `dsh-mcp`](cli.md) · [settings page](settings-ui.md) · [Lazy mode design record (Chinese)](../design/lazy-mcp.md)

Other plugins and the companion UI read mount state through the cordis service
`ctx.projectMcp`. The core service stays in-process: it emits when a reconcile
finishes, and once more if a mount settles only after that. The browser uses
the SSE channel provided by the bundled companion UI.

## Methods

| Method | Behavior |
|---|---|
| `snapshot()` | In-memory partitions from the previous reconcile (project files and the user layer). Joins the reconcile queue, does not read disk, and does not start a reconcile. |
| `serverView(projectRoot, rawName)` | One row's in-memory view. Same queue rules as `snapshot()`. |
| `globalState(rawName)` | Live global-layer state for that raw name, or `undefined` for a project row. |
| `contextCost(sessionId?)` | How much context that session's visible MCP tool definitions take. Synchronous, memory-only. Without `sessionId` it picks the session in the focused workspace. |
| `reload()` | One full reconcile (`reconcileNow`). |
| `writeTargets()` | Managed yml locations the add dialog can write: the current workspace, the user layer, and the active profile. |
| `addServer(source, projectRoot, draft)` | Appends one managed yml row from the form (creating the file when it is missing) and schedules a reconcile. Rejects a name already in that file and leaves the file unchanged. |
| `setServerEnabled(source, projectRoot, rawName, enabled)` | Flips `disabled` on the managed yml row. For a row from another source, writes a full copy (enable) or a `disabled: true` placeholder (disable) to the managed yml of that scope. |
| `setLoadingMode(source, projectRoot, rawName, mode)` | Writes `mode` (`eager` or `lazy`) into the managed yml row of that scope. A row from another source is copied in full when no managed row exists yet; the original JSON / `.mcp.json` file is not touched. `disabled` is preserved. Rejects a placeholder without a valid connection config and leaves the file unchanged. Schedules a reconcile and returns the path; it does not wait for that reconcile. |
| `removeServer(source, projectRoot, rawName)` | Deletes the managed yml row, or leaves a `disabled: true` placeholder when a lower layer still has the same name or service identity. A row from another source gets a placeholder. |
| `setToolEnabled(source, projectRoot, rawName, tool, enabled)` | Writes one exact tool name into the managed row's `tools.allow` / `tools.deny`. Glob characters are rejected. |
| `toolStates(projectRoot, rawName)` | Registered tools (short names) and whether each is visible. Empty when the server is not active. |
| `managedPathFor(source, projectRoot)` | The managed yml a row of that source writes to, or `undefined` when no profile name resolves. |
| `prepareManagedYml(source, projectRoot)` | Creates that managed yml as an empty YAML list (`[]`) when missing and returns its absolute path; the first server write creates the managed block. |
| `openConfigFile(source, projectRoot)` | Opens the managed yml through the host-provided opener. |
| `subscribeUpdated(listener)` | Subscribes to the update signal described below; returns an unsubscribe function. |

The server/tool mutation methods (`addServer`, `setServerEnabled`,
`setLoadingMode`, `removeServer`, `setToolEnabled`) only touch the three managed
yml files (workspace `.dsh/mcp.yml`, `~/.dsh/mcp.yml`,
`~/.dsh/profiles/<active>/mcp.yml`), validate the allowed target, and reject
non-focused workspaces before any file changes. `setLoadingMode` also re-parses
the selected row as a server input first; a placeholder without a valid
connection config is rejected before the write. Each mutation schedules a
reconcile after the file write; the method returns before that reconcile
necessarily finishes. Call `reload()` when the next read must see the settled
result. Path lookup and file preparation/opening do not imply those mutation checks or
trigger a reconcile. JSON files and `.mcp.json` are never written.

`snapshot()` / `serverView()` / `globalState()` / `contextCost()` do not emit.

### Context cost

`contextCost()` reads the tool schemas the **session scope** already exposes — the
ones its `tools.restrict({ deny })` and the row `tools.allow` / `tools.deny`
filters leave visible — and prices every `mcp__<effective>__<tool>` entry:

```text
estTokens = ceil(JSON.stringify(tools).length / 4) + 4
```

That is the same heuristic `@deepseek-ai/dsh-token-meter` uses for tool schemas,
so the number lines up with the host's own context breakdown for the MCP share.
It is an **estimate**, not a provider count, and it excludes server
`instructions` (those ride the system prompt, not the tool list). Tools marked
`deferLoading` are skipped because they are not in the next request.

`sessionId` is `null` when no session exists yet, which is how a caller tells
"no session" from "a session with no MCP tools". Per-server totals are priced
independently, so they can differ from the session total by a few tokens. The
result carries `level` (`ok` below `warnTokens`, `warn` from 5,000, `alert` from
10,000) so a consumer does not re-implement the thresholds.

The registry re-emits `projectMcp/updated` when the occupancy signature changes
after a `request/header` or `request/context` event, so a page that re-reads on
that event sees a fresh number without polling.

## Loading mode

`McpLoadingMode` is `"eager" | "lazy"`. The field is optional everywhere;
absent means Eager. `McpServerView.mode` is present only when the row sets
`lazy` or `eager`; `McpAddDraft.mode` is optional and the add form sends it only
for Lazy; `snapshot()` and `serverView()` expose it.

`setLoadingMode()` only writes the managed yml. If the managed row exists, it
replaces `config.mode`; if the row comes from JSON / `.mcp.json` and no managed
row exists yet, it copies the full row into the managed yml and then writes
`mode`, leaving the original file untouched. Before that write it re-parses the
selected row as a server input; a placeholder without a valid connection config
(for example a hand-written disabled row with only an id) is rejected and the
file is left unchanged. It does not change `disabled`: a disabled row stays
disabled. The target must be in `writeTargets()` — the current workspace, the
user layer, or the active profile; another workspace is rejected before the
write.

The write schedules one `reconcileAll`, but the method itself does not wait for
it. Call `reload()` when the next read must see the settled result. Runtime
differences, session connection lifetime, search fan-out, and limitations are in
[configuration format](format.md#loading-mode) and the
[Lazy mode design record (Chinese)](../design/lazy-mcp.md).

## Event

After every **successful** `reconcileAll` — including a fingerprint hit that
still runs the health check, session deny sweep, tool budget, and summary —
the registry emits. If a mount fiber becomes active or failed only **after**
that reconcile returns, it emits once more: `fiberPhase` and `toolCount` are
not final until the connection settles, and without the extra event the
settings page stays on "Starting" until it is closed and opened again. A fiber
that settles while reconcile is still running does not emit on its own; the
emit at the end of that reconcile already sees the new phase. The registry emits:

```ts
ctx.on("projectMcp/updated", async () => {
  const snapshot = await ctx.projectMcp.snapshot();
});
```

The event name is `PROJECT_MCP_UPDATED_EVENT` (`"projectMcp/updated"`). There
is no payload and no diff. Dispatch is synchronous and does not await a
listener's promise. The listener reads `snapshot()` or `serverView()` and
compares with what it last pushed. An early return (`disposed`) or a throw
inside reconcile does not emit. A listener that throws is logged
(`项目 MCP 变更事件投递失败：…`) and does not fail the reconcile.

## Types

Named view types are exported from the package entry. The `exports` map does
not allow a deep import of `lib/registry.js`.

```ts
import {
  PROJECT_MCP_SERVICE,
  PROJECT_MCP_UPDATED_EVENT,
  type FiberPhaseView,
  type McpAddDraft,
  type McpLoadingMode,
  type McpRowSource,
  type McpScopeInfo,
  type McpServerRuntimeView,
  type McpServerView,
  type McpTransport,
  type PatchRow,
  type ProjectFileState,
  type ProjectMcpService,
  type ProjectServerPhase,
  type ProjectServerState,
  type ReconnectConfig,
  type ToolFilter,
} from "dsh-project-mcp-manager";
```

`ProjectFileState` is what `snapshot()` returns. Each row is an
`McpServerRuntimeView` (`McpServerView` plus `source`, `fiberPhase`,
`skipReason`, and `toolCount`). `globalState()` returns `ProjectServerState`.
`McpServerView.mode` is optional; absent means Eager. `McpAddDraft.mode` is also
optional; the add form sends it only for Lazy.

## Semver for the companion UI

`projectMcp`'s methods, the `projectMcp/updated` event, and the view types
exported above follow semantic versioning **for the companion UI**:

| Bump | What it means for this surface |
|---|---|
| patch | Fixes that keep the methods, the event, and the view shape. |
| minor | Additive fields, methods, or events. |
| major | Removals, renames, or a change in meaning. |

`setLoadingMode` is a new method, and `McpLoadingMode`, `McpAddDraft.mode`, and
`McpServerView.mode` are new types/fields: all are additive **minor** changes.
An older UI still works and ignores `mode`; a newer UI that calls
`setLoadingMode` requires the matching core, so an old core cannot be paired
with the new UI. Both packages must be bumped and released together, never one
alone. This source change does not bump the version; the release step performs
the minor bump for both packages.

The manager lists `dsh-project-mcp-ui` as a runtime dependency pinned to the
**same exact version**. The UI keeps this package as a peer dependency at that
exact version. Neither published contract uses `^` or `~`; both packages must
be versioned and released together. Users install only the manager, whose
default bundle owns the core and UI rows; the UI is no longer a standalone
`dsh.bundle` ([installation and migration](settings-ui.md#install)).

The manager's published dependency contract is:

```json
{
  "dependencies": {
    "dsh-project-mcp-ui": "<exact version of this package>"
  }
}
```

The UI's matching peer contract is:

```json
{
  "peerDependencies": {
    "dsh-project-mcp-manager": "<exact version of this package>"
  }
}
```

Replace both placeholders with the manager/UI release version. In the source
workspace the manager uses `workspace:<exact version>`; `pnpm pack` replaces
that specifier with the exact version above. Do not use `npm pack` directly on
the workspace manifest. Root `pnpm run build` compiles the core before building
the UI, so the UI consumes the current core declarations; the UI build first
cleans its output directory.

For a future authorized release, publish the vetted UI and manager tarballs
under a non-`latest` staging tag, then promote both only after a fresh-consumer
install smoke check. This is release guidance, not a claim that publication
or that check has already happened.
