# Query surface (`projectMcp`)

English | [中文](service.zh.md)

[← README](../../README.md) ｜ Related: [configuration sources and layers](layers.md) · [CLI `dsh-mcp`](cli.md)

Other plugins and the companion UI read mount state through the cordis service
`ctx.projectMcp`. This package stays in-process: it emits one event when a
reconcile finishes. The browser still uses the SSE channel the companion UI
builds itself.

## Methods

| Method | Behavior |
|---|---|
| `snapshot()` | In-memory partitions from the previous reconcile (project files and the user layer). Joins the reconcile queue, does not read disk, and does not start a reconcile. |
| `serverView(projectRoot, rawName)` | One row's in-memory view. Same queue rules as `snapshot()`. |
| `globalState(rawName)` | Live global-layer state for that raw name, or `undefined` for a project row. |
| `reload()` | One full reconcile (`reconcileNow`). |
| `writeTargets()` | Managed yml locations the add dialog can write: the current workspace, the user layer, and the active profile. |
| `addServer(source, projectRoot, draft)` | Appends one managed yml row from the form (creating the file when it is missing) and schedules a reconcile. Rejects a name already in that file and leaves the file unchanged. |

`snapshot()` / `serverView()` / `globalState()` do not emit.

## Event

After every **successful** `reconcileAll` — including a fingerprint hit that
still runs the health check, session deny sweep, tool budget, and summary —
the registry emits:

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

## Semver for the companion UI

`projectMcp`'s methods, the `projectMcp/updated` event, and the view types
exported above follow semantic versioning **for the companion UI**:

| Bump | What it means for this surface |
|---|---|
| patch | Fixes that keep the methods, the event, and the view shape. |
| minor | Additive fields, methods, or events. |
| major | Removals, renames, or a change in meaning. |

The companion UI lists this package as a peer dependency pinned to the **same
exact version** (no `^` or `~`). When the surface and the UI move, they move
together:

```json
{
  "peerDependencies": {
    "dsh-project-mcp-manager": "<exact version of this package>"
  }
}
```

Replace the placeholder with the version in this package's `package.json` at
the release the UI is built against.
