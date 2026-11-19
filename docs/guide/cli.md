# CLI: `dsh-mcp`

English | [中文](cli.zh.md)

[← README](../../README.md) ｜ Related: [configuration format](format.md) · [configuration sources and layers](layers.md) · [`${VAR}` expansion](env-expansion.md)

Command-line management for the **native** config files (writes only
`mcp.yml` or `mcp.json` — never the legacy `.mcp.json`; it does not
connect to a running dsh host, which converges via the file watchers). In the
web and desktop apps the [settings page](settings-ui.md) covers adding,
switching, and removing too:

```powershell
dsh-mcp add gitlab npx -y @modelcontextprotocol/server-gitlab -e GITLAB_TOKEN=${GITLAB_TOKEN}
dsh-mcp add --transport http sentry https://mcp.sentry.dev/mcp -H "Authorization: Bearer ${SENTRY_TOKEN}"
dsh-mcp add --scope user shared node ./tools/shared.js        # writes ~/.dsh/mcp.yml
dsh-mcp add --format json jsonproj node ./tools/p.js          # writes <projectRoot>/.dsh/mcp.json
dsh-mcp add --scope profile --profile web shared node ./s.js   # writes ~/.dsh/profiles/web/mcp.yml
dsh-mcp list          # all source layers, with shadow annotations
dsh-mcp get gitlab    # winning-layer entry; secret values shown as key names only
dsh-mcp remove gitlab # searches yml then json in priority order and deletes; read-only layers get edit guidance
dsh-mcp status        # layer row counts, names, and diagnostic summary (no host connection)
dsh-mcp import --from .cursor/mcp.json --dry-run   # preview mcpServers import; no writes
dsh-mcp trust         # mark this workspace trusted in $DSH_HOME/mcp-trust.json
dsh-mcp untrust ..    # revoke the parent directory's project root
dsh-mcp trusted       # print the store path and every trusted root
```

Scopes: `--scope project` (default; writes `<projectRoot>/.dsh/mcp.yml` under
the nearest `.git` ancestor), `--scope user` (writes `~/.dsh/mcp.yml`) and
`--scope profile` (requires `--profile <name>`; writes
`~/.dsh/profiles/<name>/mcp.yml`).
**Write format**: `--format yml|json` takes precedence over the
`DSH_MCP_CLI_FORMAT` environment variable (`yml`|`json`, default `yml`); with
`--format json`, project, user and profile scopes write `.dsh/mcp.json`,
`~/.dsh/mcp.json` and `~/.dsh/profiles/<name>/mcp.json` respectively. `add`'s default `cwd` follows the scope: `"."`
(the project root) for project, `""` (the host directory) for user/profile;
`-c` overrides it explicitly.

`add` does not take `--allow` / `--deny`. Per-entry `tools.allow` /
`tools.deny` (and JSON `includeTools` / `excludeTools`) must be written in
the config file or brought in with `dsh-mcp import`. `list` and `get` still
show those filters (pattern text only).

**`status`** reads the seven source layers and the diagnostic files
(per-project `$DSH_HOME/mcp-diag/<hash>.json`, global `$DSH_HOME/.mcp-diag.json`;
neither is written into a workspace). It
prints each layer's row count and names, then the latest `summary`
(mounted / skipped / unhealthy / tool-budget hits). `summary.untrusted: true`
prints an extra line: the workspace is untrusted, so its project-layer files
were not read. The trust-store line reports `DSH_MCP_PROJECT_TRUST` when that
variable is set; otherwise it says the host config decides and the default is
`inherit`. A diagnostic file written by
an older on-demand version may also print `idle-not-mounted` names; current
versions keep every discovered workspace mounted and no longer produce them. It
does not inspect host memory: if the
host has never reconciled, the files are absent and the command reports
that. `--scope project|user|profile` filters which layers are listed and which
diagnostic file is printed (the project file vs
`$DSH_HOME/.mcp-diag.json`). `--scope profile` lists only profile layers
(add `--profile <name>` to keep one); `--scope user` still lists every
user-layer file, including all profiles. Legacy idle rows from an older
diagnostic file still print as not-mounted (no session), not as unhealthy.

**`trust` / `untrust` / `trusted`** read and write
`$DSH_HOME/mcp-trust.json` inside the file lock. They never touch a config
file and never connect to a host. `trust [dir]` resolves the project root of
`dir` (or the current directory) with the loader's rule — the nearest `.git`
ancestor — and adds it to the store; `untrust [dir]` removes it. Untrusting a
root that is not in the store prints that fact and does not write the file.
When a project-layer file is still present, `untrust` records a workspace-level
diagnostic (presence only; the file is not read) so `status` can print the
block without a running host. `trust` clears that `summary.untrusted` flag.
`trusted` prints the store path and every trusted root. A corrupt store is
rejected instead of being overwritten. The store only changes loading when the plugin runs with
`projectTrust: "allowlist"` (or `DSH_MCP_PROJECT_TRUST=allowlist`). In the
default `inherit` mode the host still loads project files; `untrust` can still
write the workspace diagnostic that `status` prints, and the next inherit
reconcile clears that block when the workspace has nothing to keep. See
[workspace trust](trust.md).

**`import`** copies `{"mcpServers":{...}}` into a native yml or JSON file
(`--scope` / `--format` / `--profile` match `add`; default scope is
**project**). Same-name keys are skipped unless `--overwrite` is set
(the skip/overwrite decision runs inside the file lock, matching `add`).
`--dry-run` prints the add/skip/overwrite plan and any shadow conflicts
(`shadowViewOf`) without writing. VS Code `{servers:{…}}`, a bare entry
object, and a JSON array are rejected. Bad entries are reported one by
one; valid siblings still import. `--from -` reads stdin.

There is no `local` scope — `--scope local`
fails with an explanation. `--transport` accepts `stdio` (default) and `http`;
the MCP SSE endpoint transport (`sse`) is refused with an actionable error
(change `type` to `"http"`, or drop `type` and keep `url`).

**Reserved short flags**: besides `-s`/`-t`/`-e`/`-H`/`-c`/`-h`, since v0.4.0
`-f` (`--format`) and `-p` (`--profile`) are CLI options too. Both consume the
next token as their value, so pass them to the spawned server command after `--`
(everything after `--` is treated as a positional argument). `--from`,
`--dry-run` and `--overwrite` are reserved for `import`. Any other unknown
`-` token is still forwarded to the server command line verbatim.

**Ownership contract**: JSON files belong exclusively to this CLI (neither the
host plugin nor the settings page writes them). Writes keep other top-level keys and key order,
refuse to overwrite a file that fails to parse, and are atomic; `${VAR}`
references are written through literally so secrets stay in the environment
(see [`${VAR}` expansion](env-expansion.md)). The yml side goes through the
managed block, so content outside the begin/end markers is preserved
byte-for-byte. The managed yml is shared with the
[settings page](settings-ui.md); both read-modify-write it under the same file
lock, so they can be mixed.
