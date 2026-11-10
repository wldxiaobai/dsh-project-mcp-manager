import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { apply } from "@deepseek-ai/dsh-mcp-client";
import { allowedTools, eagerToolName } from "../lib/lazy/proxies.js";

/**
 * Parity harness for the Eager tool-name mirror.
 *
 * The official package does not export its naming helper, so this drives the
 * public `apply` entry against a local Streamable HTTP MCP fixture instead of
 * importing internal modules. The local HTTP server avoids spawning a child
 * process, which also keeps the test runnable in a pipe-restricted sandbox.
 */

const SERVER = "probe-srv";
const PREFIX = `mcp__${SERVER}__`;
const TOOL_NAMES = [
  "echo",
  "read-file_2",
  "Read_File-2",
  "bad name",
  "slash/name",
  "名字",
  "x".repeat(80),
  "b".repeat(64 - PREFIX.length),
  "c".repeat(65 - PREFIX.length)
];

function startMcpFixture() {
  let sessions = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" || request.method === "DELETE" || request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      response.writeHead(400);
      response.end("invalid json");
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    const replies = [];
    let hasRequest = false;
    for (const item of messages) {
      if (item.id === undefined) continue;
      hasRequest = true;
      if (item.method === "initialize") {
        response.setHeader("mcp-session-id", `probe-${++sessions}`);
        replies.push({
          jsonrpc: "2.0",
          id: item.id,
          result: {
            protocolVersion: item.params?.protocolVersion ?? "2025-06-18",
            serverInfo: { name: "probe", version: "1" },
            capabilities: { tools: {} }
          }
        });
      } else if (item.method === "tools/list") {
        replies.push({
          jsonrpc: "2.0",
          id: item.id,
          result: {
            tools: TOOL_NAMES.map((name) => ({
              name,
              description: name,
              inputSchema: { type: "object", properties: {} }
            }))
          }
        });
      } else if (item.method === "tools/call") {
        replies.push({ jsonrpc: "2.0", id: item.id, result: { content: [{ type: "text", text: "ok" }] } });
      } else {
        replies.push({ jsonrpc: "2.0", id: item.id, error: { code: -32601, message: "Method not found" } });
      }
    }
    if (!hasRequest) {
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(Array.isArray(message) ? replies : replies[0]));
  });
  return new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveStart({ server, url: `http://127.0.0.1:${address.port}/mcp` });
    });
  });
}

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}

const registered = new Map();
const ctx = new Context();
const releaseTools = ctx.provide("tools", {
  register(definition) {
    registered.set(definition.description, definition.name);
    return () => registered.delete(definition.description);
  }
});
let fixture;
let fiber;
try {
  fixture = await startMcpFixture();
  fiber = ctx.plugin({ inject: ["tools"], apply }, {
    serverName: SERVER,
    transport: "streamable-http",
    url: fixture.url,
    headers: {},
    toolCallTimeoutMs: 5000,
    failOnStartupError: false
  });
  await fiber.await();
  assert.equal(registered.size, TOOL_NAMES.length, "the public bridge registers every fixture tool");

  for (const rawName of TOOL_NAMES) {
    const official = registered.get(rawName);
    assert.ok(official !== undefined, `the public bridge registered ${JSON.stringify(rawName)}`);
    assert.equal(
      eagerToolName(SERVER, rawName, PREFIX + rawName),
      official,
      `the mirror matches the public bridge for ${JSON.stringify(rawName)}`
    );
  }
  pass("mirror matches official public apply output for legal, illegal, long, hashed, and 64-char boundary names");

  const exact = "b".repeat(64 - PREFIX.length);
  const over = "c".repeat(65 - PREFIX.length);
  assert.equal(eagerToolName(SERVER, "echo", PREFIX + "echo"), PREFIX + "echo");
  assert.equal(eagerToolName("srv_1-x", "read-file_2", "mcp__srv_1-x__read-file_2"), "mcp__srv_1-x__read-file_2");
  assert.equal(eagerToolName(SERVER, exact, PREFIX + exact), PREFIX + exact, "exactly 64 clean characters stay verbatim");
  assert.equal(eagerToolName(SERVER, exact, PREFIX + exact).length, 64);
  const overHash = eagerToolName(SERVER, over, PREFIX + over);
  assert.equal(overHash.length, 64, "overflowing names stay within the 64-character contract");
  assert.ok(overHash.startsWith(PREFIX + "c"));
  assert.match(overHash, /_[0-9a-f]{12}$/);
  const spaced = eagerToolName(SERVER, "bad name", PREFIX + "bad name");
  assert.ok(spaced.startsWith(PREFIX + "bad_name_"));
  assert.match(spaced, /_[0-9a-f]{12}$/);
  const longName = eagerToolName(SERVER, "x".repeat(80), PREFIX + "x".repeat(80));
  assert.equal(longName.length, 64);
  assert.ok(longName.startsWith(PREFIX + "x"));
  assert.match(longName, /_[0-9a-f]{12}$/);
  assert.notEqual(eagerToolName(SERVER, "first", PREFIX + "first"), eagerToolName(SERVER, "second", PREFIX + "second"),
    "the identity hash distinguishes different tool names");
  pass("mirror keeps the 64-character, invalid-character, and hash contract");

  const catalog = TOOL_NAMES.map((name) => ({ name }));
  const state = (tools) => ({ effectiveName: SERVER, rawName: SERVER, row: { config: { tools } } });
  assert.deepEqual(allowedTools(state({ allow: ["echo"] }), catalog).map((tool) => tool.name), ["echo"]);
  assert.deepEqual(allowedTools(state({ allow: [registered.get("bad name")] }), catalog).map((tool) => tool.name), ["bad name"],
    "a full mcp__… filter matches the official public name");
  assert.deepEqual(allowedTools(state({ allow: [registered.get("x".repeat(80))] }), catalog).map((tool) => tool.name), ["x".repeat(80)],
    "a full-name filter matches a hashed long name");
  assert.deepEqual(allowedTools(state({ deny: ["echo"] }), catalog).map((tool) => tool.name), TOOL_NAMES.slice(1));
  assert.deepEqual(allowedTools(state({ allow: ["*"], deny: [registered.get("read-file_2")] }), catalog).map((tool) => tool.name),
    TOOL_NAMES.filter((name) => name !== "read-file_2"));
  assert.deepEqual(allowedTools(state({ allow: ["read-file_2"] }), catalog).map((tool) => tool.name), ["read-file_2"]);
  pass("Lazy filters match short names and the official full names");
} finally {
  await fiber?.dispose?.();
  await releaseTools?.();
  if (fixture !== undefined) {
    fixture.server.closeAllConnections?.();
    await new Promise((resolveClose) => fixture.server.close(resolveClose));
  }
}

console.log(`\n${passed} passed, 0 failed`);
console.log("ALL LAZY NAMING TESTS PASSED");