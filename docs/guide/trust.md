# Workspace trust for the project layer

English | [中文](trust.zh.md)

[← README](../../README.md) ｜ Related: [configuration sources and layers](layers.md) · [CLI `dsh-mcp`](cli.md) · [`${VAR}` expansion](env-expansion.md) · [settings page](settings-ui.md)

Project-layer files (`<projectRoot>/.dsh/mcp.yml`, `.dsh/mcp.json`, `.mcp.json`)
are **executable code carriers**: a `stdio` row spawns its `command` inside the
dsh host process. By default the plugin mounts them for every workspace it
discovers, which is convenient for your own projects and risky for a repository
you have only just cloned.

The trust gate is the opt-in answer: with `projectTrust: "allowlist"` the plugin
**does not read project-layer files at all** until the workspace is trusted. It
is off by default (`inherit`) so existing installations, CI jobs, and headless
deployments keep their current behavior.

## Enable the gate

Set the plugin config on the loader row (bundle or profile patch):

```yaml
- id: mcp-project
  name: dsh-project-mcp-manager
  config:
    projectTrust: allowlist
```

Or, for a headless run or CI job, use the environment variable; it wins over
the config:

```powershell
$env:DSH_MCP_PROJECT_TRUST = "allowlist"
```

Accepted values are exactly `inherit` and `allowlist`. Any other value is
ignored: an invalid variable falls back to the config instead of silently
blocking every project.

## What changes in allowlist mode

- The three project-layer files are not opened. Parsing, `${VAR}` expansion,
  and `spawn` all happen after the trust check, so an untrusted file has no
  effect at all.
- User and profile layers are **not** gated: `~/.dsh/mcp.yml`,
  `~/.dsh/mcp.json`, and the profile `mcp.yml`/`mcp.json` belong to your own
  machine and still mount globally.
- Revoking trust unmounts that workspace's rows on the next reconcile. When a
  project-layer file is still on disk (presence only; the file is not read),
  the project diagnostic becomes a workspace-level record: `summary.untrusted:
  true` plus one `untrusted` event, and `dsh-mcp status` prints that the
  workspace was blocked. `dsh-mcp untrust` writes that record itself, so
  `status` is accurate even when the host is not running. A workspace with
  none of those files leaves no diagnostic, and a previous file is removed.
- Trusting the workspace, or running again in `inherit`, clears a leftover
  `summary.untrusted` when the scan has no rows and no error worth keeping.
  A parse error is written as a normal summary, so `status` stops printing
  the block. A stat error other than "file not found" is not treated as
  "no config file", so a permission failure does not delete that diagnostic.
- The plugin logs one warning per untrusted workspace and exposes the state on
  the `projectMcp` service (`trustState`, `setProjectTrusted`).
- Adding a server from the MCP Manager for the current workspace **trusts that
  workspace** after the draft passes validation and the row is written.
  A rejected draft does not open the gate. Writing a row there is already an
  explicit decision, and "added but silently not mounted" would be worse.

## Trust a workspace

Three equivalent ways, all writing the same store:

1. **MCP Manager page** — an untrusted current workspace shows a notice above
   the introduction (the introduction line stays) with a **Trust workspace**
   button. A trusted workspace offers **Revoke trust** in the toolbar.
2. **CLI** — `dsh-mcp trust [dir]` trusts the project root of `dir` (or the
   current directory), `dsh-mcp untrust [dir]` revokes it, and
   `dsh-mcp trusted` lists the store.
3. **The store file** — `$DSH_HOME/mcp-trust.json` (`~/.dsh/mcp-trust.json` by
   default). It is a small JSON document keyed by workspace root:

```json
{
  "version": 1,
  "projects": {
    "f:\\codeprojects\\my-project": {
      "root": "F:\\codeprojects\\my-project",
      "trustedAt": "2026-11-16T12:00:00.000Z"
    }
  }
}
```

The key is the same normalized key the loader uses internally (lowercased on
Windows, so `F:\Work` and `f:\work` are the same workspace). A missing file
means "nothing is trusted". Corrupt JSON makes the plugin log a warning and
treat the store as empty — fail closed, never fail open.

The workspace root follows the same rule as the rest of the plugin: the nearest
ancestor containing `.git`, or the directory itself when there is none. Trusting
a subdirectory therefore trusts the repository, not just that folder.

In `allowlist` mode the running host watches the store and rereads it on every
reconcile, so a CLI trust or revoke applies within a moment, without restarting
dsh.

## Limits

- The gate covers the project layer only. A user-layer row is global by design;
  keep secrets and commands there only if you trust your own machine.
- `inherit` stays the default on purpose: flipping it would break every
  existing headless deployment on upgrade. Treat it as a deployment decision.
- Trust is per workspace root, not per row: once trusted, the whole file is
  executable again. Review the file before trusting a repository you did not
  write.
