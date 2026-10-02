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

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL UI PASTE TESTS PASSED");
