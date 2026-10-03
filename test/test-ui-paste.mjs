import assert from "node:assert/strict";
import { parsePastedConfig } from "../packages/ui/src/client/paste-config.ts";

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}

{
  const parsed = parsePastedConfig(`{
    "mcpServers": {
      "gitlab": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-gitlab"],
        "env": { "GITLAB_TOKEN": "\${GITLAB_TOKEN}" }
      }
    }
  }`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.name, "gitlab");
  assert.equal(parsed.fields.transport, "stdio");
  assert.equal(parsed.fields.command, "npx");
  assert.equal(parsed.fields.args, "-y\n@modelcontextprotocol/server-gitlab");
  assert.equal(parsed.fields.env, "GITLAB_TOKEN=${GITLAB_TOKEN}");
  assert.equal(parsed.skipped, 0);
  pass("json mcpServers stdio fills name, command, args, and env");
}

{
  const parsed = parsePastedConfig(`{
    "mcpServers": {
      "sentry": {
        "url": "https://mcp.sentry.dev/mcp",
        "headers": { "Authorization": "Bearer \${SENTRY_TOKEN}" }
      }
    }
  }`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.transport, "http");
  assert.equal(parsed.fields.url, "https://mcp.sentry.dev/mcp");
  assert.equal(parsed.fields.headers, "Authorization: Bearer ${SENTRY_TOKEN}");
  assert.equal(parsed.fields.command, "");
  pass("json url entry fills the remote fields");
}

{
  const parsed = parsePastedConfig(`
mcpServers:
  gitlab:
    command: npx
    args:
      - -y
      - pkg
`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.name, "gitlab");
  assert.equal(parsed.fields.args, "-y\npkg");
  pass("yaml mcpServers fills the same fields");
}

{
  const parsed = parsePastedConfig(`
# >>> dsh-project-mcp-manager:mcp:begin
- insert:
    - id: panel-mcp-godot
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: godot
        transport: stdio
        command: godot
        args: ["--mcp"]
# <<< dsh-project-mcp-manager:mcp:end
`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.name, "godot");
  assert.equal(parsed.fields.command, "godot");
  assert.equal(parsed.fields.args, "--mcp");
  pass("managed yml insert row uses serverName, not the plugin id");
}

{
  const parsed = parsePastedConfig(`{
    "servers": {
      "off": { "command": "skip", "enabled": false },
      "kept": { "command": "node", "args": ["srv.js"] },
      "also": { "type": "http", "url": "https://mcp.example/mcp" }
    }
  }`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.name, "kept");
  assert.equal(parsed.fields.command, "node");
  assert.equal(parsed.skipped, 1);
  pass("servers map skips enabled:false and reports the rest");
}

{
  const parsed = parsePastedConfig(`{ "type": "sse", "url": "https://mcp.example/sse" }`);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "sse");
  pass("sse is rejected instead of being filled as a remote URL");
}

{
  const parsed = parsePastedConfig(`{ "command": "npx", "url": "https://mcp.example/mcp" }`);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "both");
  pass("command plus url without a transport is rejected");
}

{
  assert.equal(parsePastedConfig("   ").ok, false);
  assert.equal(parsePastedConfig("   ").reason, "empty");
  assert.equal(parsePastedConfig("not a server").reason, "none");
  assert.equal(parsePastedConfig("{").reason, "parse");
  pass("empty, plain text, and broken json each get their own reason");
}

{
  const parsed = parsePastedConfig(`{ "httpUrl": "https://mcp.example/mcp", "headers": { "Authorization": "Bearer tok" } }`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.transport, "http");
  assert.equal(parsed.fields.url, "https://mcp.example/mcp");
  pass("httpUrl alone is a remote URL");
}

{
  const cases = [
    [{ mcpServers: { preferred: { command: "first" } }, servers: { other: { command: "second" } } }, "preferred"],
    [{ mcpServers: null, servers: { fallback: { command: "node" } } }, "fallback"],
    [{ mcpServers: {}, servers: { ignored: { command: "node" } } }, undefined],
    [{ mcpServers: null, command: "ignored" }, undefined],
    [{ insert: [{ command: "nested", serverName: "insert" }], command: "ignored" }, "insert"],
    [{ id: "panel-mcp-fallback", config: { serverName: "  ", command: "node" }, command: "ignored" }, "fallback"],
    [{ id: "panel-mcp-ignored", config: { serverName: " named ", command: "node" } }, "named"],
    [{ first: { command: "node" }, second: { url: "https://example.com" } }, "first"],
    [{ first: { command: "node" }, metadata: "not a server" }, undefined],
  ];
  for (const [input, name] of cases) {
    const parsed = parsePastedConfig(JSON.stringify(input));
    if (name === undefined) assert.deepEqual(parsed, { ok: false, reason: "none" });
    else {
      assert.equal(parsed.ok, true);
      assert.equal(parsed.fields.name, name);
    }
  }
  pass("collection preserves wrapper priority, managed names, and bare-map detection");
}

{
  const parsed = parsePastedConfig(JSON.stringify([
    null,
    [{ command: "disabled", enabled: false }, { type: "sse", url: "https://example.com" }],
    { config: { serverName: "off", command: "disabled", enabled: false } },
    { serverName: "first", command: " node ", args: ["srv.js", 42, false], env: { TOKEN: "value", PORT: 42, DEBUG: false, OMIT: null } },
    { serverName: "second", command: "other" },
  ]));
  assert.deepEqual(parsed, {
    ok: true,
    fields: { name: "first", transport: "stdio", command: "node", args: "srv.js\n42\nfalse", url: "", env: "TOKEN=value\nPORT=42\nDEBUG=false", headers: "" },
    skipped: 1,
  });
  pass("nested arrays keep the first valid candidate and only count other valid candidates");
}

{
  const cases = [
    [{ type: "sse", transport: "unknown", url: "a", httpUrl: "b" }, "sse"],
    [{ type: "stdio", transport: "http", command: "node" }, "transport"],
    [{ type: "unknown", command: "node" }, "transport"],
    [{ url: "a", httpUrl: "b" }, "fields"],
    [{ command: "node", url: "a", args: {} }, "both"],
    [{ type: "http", args: {} }, "fields"],
    [{ type: "http" }, "url"],
    [{ type: "stdio", url: "a" }, "command"],
    [{ command: "node", args: [{}] }, "fields"],
    [{ command: "node", env: { KEY: [] } }, "fields"],
    [{ command: "node", headers: [] }, "fields"],
  ];
  for (const [input, reason] of cases) {
    assert.deepEqual(parsePastedConfig(JSON.stringify(input)), { ok: false, reason });
  }
  assert.deepEqual(parsePastedConfig(JSON.stringify([{ type: "sse" }, { type: "unknown" }])), { ok: false, reason: "sse" });
  assert.deepEqual(parsePastedConfig(JSON.stringify([{ type: "unknown" }, { type: "sse" }])), { ok: false, reason: "transport" });
  pass("validation preserves failure priority and the first failed candidate reason");
}

{
  const http = parsePastedConfig(JSON.stringify({
    type: " HTTP ", transport: "streamable-http", command: "ignored", args: ["ignored"],
    url: " https://example.com/mcp ", httpUrl: "https://example.com/mcp", env: { IGNORED: true },
    headers: { Authorization: "token", Count: 1, Debug: false, Omit: null },
  }));
  assert.deepEqual(http, {
    ok: true,
    fields: { name: "", transport: "http", command: "", args: "", url: "https://example.com/mcp", env: "", headers: "Authorization: token\nCount: 1\nDebug: false" },
    skipped: 0,
  });
  const stdio = parsePastedConfig(JSON.stringify({ transport: "stdio", command: "node", args: "raw args", url: "https://example.com", headers: { Ignored: true } }));
  assert.equal(stdio.ok, true);
  assert.equal(stdio.fields.args, "raw args");
  assert.equal(stdio.fields.url, "");
  assert.equal(stdio.fields.headers, "");
  pass("explicit transports select their fields and accept equivalent URL and transport aliases");
}

{
  const parsed = parsePastedConfig("mcpServers: [\n---\ncommand: node\nserverName: valid\n");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.name, "valid");
  assert.equal(parsed.skipped, 0);
  assert.deepEqual(parsePastedConfig("mcpServers: [\n---\nplain text\n"), { ok: false, reason: "parse" });
  pass("valid YAML documents survive another document parse error");
}

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL UI PASTE TESTS PASSED");
