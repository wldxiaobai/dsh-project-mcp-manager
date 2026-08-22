# dsh-project-mcp-manager

A project-level MCP auto-loading plugin for DSH: write MCP server configs in
`<projectRoot>/.dsh/mcp.yml` and they are mounted automatically (via the
official `@deepseek-ai/dsh-mcp-client`) whenever a dsh session opens in that
project. Changes to the file hot-reload into the running dsh process, and tool
visibility is scoped per session cwd. No UI — core functionality only.

## Installation (mount into a profile)

The plugin is mounted through a **bundle patch**: once the package is added to
`dsh.profile.bundles`, dsh synthesizes each bundle's patch (the
`cordis.patch.yml` pointed to by `dsh.bundle.patch`) into plugin lines at
startup, in order.

**Prerequisite: install dsh itself** (for users who don't have dsh yet):

```powershell
npm install -g @deepseek-ai/dsh        # official npm package
npm install -g deepseek-ai/dsh         # or install from the GitHub source
```

**Option 1: the dsh plugin command (recommended)** — `dsh plugin` forwards
pnpm inside the profile directory and handles installing/upgrading
dependencies:

```powershell
# Install the latest version (web profile shown as an example;
# substitute the name of any other profile, e.g. headless)
dsh plugin --profile web add dsh-project-mcp-manager@latest

# Install a specific version (check available versions with
# npm view dsh-project-mcp-manager versions)
dsh plugin --profile web add dsh-project-mcp-manager@0.1.0
```

**Option 2: install directly with pnpm** (equivalent to option 1):

```powershell
# dshHome defaults to %USERPROFILE%\.dsh (uses $DSH_HOME if set)
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add dsh-project-mcp-manager@latest
```

**Option 3: local development install** (a junction that live-syncs your
source, so code changes take effect immediately):

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add link:<path-to-your-dsh-mcp-project-source>   # e.g. D:\dev\dsh-mcp-project
```

**Upgrading / pinning versions**: re-run the `add` command from option 1 with
the desired version suffix — `@latest` upgrades to the newest release, `@0.1.0`
pins to a specific version.

## Build & test

```powershell
npm install
npm run build     # tsc → lib/
node test/test-model.mjs
node test/test-registry.mjs
```

## Configuration format

`<projectRoot>/.dsh/mcp.yml` uses the same managed-block format as the profile
`cordis.patch.yml` (a YAML `insert` list between begin/end markers), with one
MCP server per line:

```yaml
# >>> dsh-project-mcp-manager:mcp:begin
- insert:
    - id: panel-mcp-gitlab
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: gitlab
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-gitlab']
        cwd: .            # resolved relative to the project root
        toolCallTimeoutMs: 60000
        failOnStartupError: false
        reconnect:
          enabled: true
          initialDelayMs: 500
          maxDelayMs: 30000
          maxAttempts: 10
# <<< dsh-project-mcp-manager:mcp:end
```

`transport` supports `stdio` (command/args/env/cwd) and `streamable-http`
(url/headers). Add `disabled: true` to a line to deactivate it. Content outside
the markers is preserved byte-for-byte.

## How it works

- **Project discovery**: the `session.header.cwd` of an active agent session,
  plus the dsh process start directory → walk up to the nearest ancestor
  containing `.git` as the project root (falls back to the directory itself
  when there is no `.git`).
- **Mounting**: each `(project, serverName)` pair mounts one
  `@deepseek-ai/dsh-mcp-client` instance (`ctx.plugin`) on the host ctx and
  registers it into the global tool layer. Multiple sessions inside the same
  project share a single connection.
- **Hot reload**: chokidar watches each project root (depth 2, ignoring
  node_modules/.git/.hg/.svn); changes to `.dsh/mcp.yml` trigger a full
  reconciliation after a 150 ms debounce: added lines are mounted, removed
  lines are unmounted, and config changes are remounted.
- **Effective names**: when the original `serverName` is unique across the
  whole catalog (global lines + all project lines) it keeps its name; on a
  conflict both sides are renamed to
  `p<first 6 chars of sha256(projectRoot)>_<original name>` (truncated to 32
  characters, deterministic and independent of mount order) to avoid the
  serverName reservation conflicts that `dsh-mcp-client` makes per process
  root. Global lines (profile `cordis.patch.yml` / mcp-client lines already
  mounted at the bundle level) participate in occupancy determination but are
  never renamed.
- **Session visibility**: when an agent is created, its session cwd resolves
  to a project, and `tools.restrict({ deny })` is applied to that agent to deny
  every project server except those of the session's own project; a session
  without a cwd falls back to the owner project (subagents), then to the
  project containing the dsh process cwd. Released when the session is
  destroyed.

## Security boundary

`stdio` lines in `.dsh/mcp.yml` spawn their `command` inside the dsh host
process — project files are **executable code carriers**, so only add them in
projects you trust. Lines that fail to mount or are invalid are skipped with a
warning and do not affect other servers.
