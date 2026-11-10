import assert from "node:assert/strict";
import {
  CONTEXT_COST_ALERT_TOKENS,
  CONTEXT_COST_WARN_TOKENS,
  contextCostLevel,
  contextCostSignature,
  estimateSchemaTokens,
  mcpContextCost,
  mcpServerOfTool
} from "../lib/context-cost.js";
import { LAZY_PROXY_GROUP_NAME, LAZY_TOOL_NAMES } from "../lib/lazy/tool-names.js";

let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log("PASS  " + name);
}

const schema = (name, description = "", parameters = { type: "object", properties: {} }) => ({ name, description, parameters });

test("estimateSchemaTokens mirrors the DSH 4-chars-per-token heuristic", () => {
  assert.equal(estimateSchemaTokens(0), 0, "empty list prices as 0, not BLOCK_OVERHEAD");
  assert.equal(estimateSchemaTokens(4), 5, "ceil(4/4)+4");
  assert.equal(estimateSchemaTokens(5), 6, "ceiling rounds up");
  assert.equal(estimateSchemaTokens(4000), 1004);
});

test("contextCostLevel treats the thresholds as inclusive", () => {
  assert.equal(contextCostLevel(0), "ok");
  assert.equal(contextCostLevel(CONTEXT_COST_WARN_TOKENS - 1), "ok");
  assert.equal(contextCostLevel(CONTEXT_COST_WARN_TOKENS), "warn", "reaching 5k is already a reminder");
  assert.equal(contextCostLevel(CONTEXT_COST_ALERT_TOKENS - 1), "warn");
  assert.equal(contextCostLevel(CONTEXT_COST_ALERT_TOKENS), "alert", "reaching 10k is the warning level");
});

test("mcpServerOfTool splits on the first __ unless a known name is longer", () => {
  assert.equal(mcpServerOfTool("read_file"), undefined, "host tools are not MCP");
  assert.equal(mcpServerOfTool("mcp__github__create_issue"), "github");
  assert.equal(mcpServerOfTool("mcp__p4f2a1_unity-mcp__unity_manage"), "p4f2a1_unity-mcp", "known name wins");
  assert.equal(mcpServerOfTool("mcp__weird"), undefined, "no second separator");
});

test("mcpContextCost only prices MCP tools and groups per server", () => {
  const cost = mcpContextCost({
    sessionId: "s1",
    schemas: [
      schema("mcp__alpha__read", "Read a file", { type: "object", properties: { path: { type: "string" } } }),
      schema("mcp__alpha__write", "Write a file"),
      schema("mcp__beta__search", "Search"),
      schema("bash", "Host tool")
    ]
  });
  assert.equal(cost.tools, 3, "the host tool is excluded");
  assert.equal(cost.sessionId, "s1");
  assert.deepEqual(cost.servers.map((server) => [server.name, server.tools]), [["alpha", 2], ["beta", 1]]);
  assert.ok(cost.estTokens > 0);
  assert.equal(cost.level, "ok");
});

test("mcpContextCost keeps the server breakdown sorted by estimated size", () => {
  const cost = mcpContextCost({
    sessionId: "s1",
    schemas: [
      schema("mcp__small__a", "a"),
      schema("mcp__big__a", "x".repeat(4000)),
      schema("mcp__big__b", "y".repeat(4000))
    ]
  });
  assert.deepEqual(cost.servers.map((server) => server.name), ["big", "small"]);
});

test("mcpContextCost skips deferLoading tools: they are not in the next request", () => {
  const cost = mcpContextCost({
    sessionId: "s1",
    schemas: [
      { ...schema("mcp__alpha__deferred", "x".repeat(4000)), deferLoading: true },
      schema("mcp__alpha__kept", "kept")
    ]
  });
  assert.equal(cost.tools, 1);
  assert.equal(cost.servers[0].tools, 1);
});

test("mcpContextCost reports zero for a session without MCP tools", () => {
  const cost = mcpContextCost({ sessionId: null, schemas: [] });
  assert.deepEqual(
    { tools: cost.tools, estTokens: cost.estTokens, level: cost.level, sessionId: cost.sessionId },
    { tools: 0, estTokens: 0, level: "ok", sessionId: null }
  );
  assert.deepEqual(cost.servers, []);
});

test("mcpContextCost carries the context window only when it is usable", () => {
  const withWindow = mcpContextCost({ sessionId: "s1", schemas: [schema("mcp__alpha__read")], contextWindow: 200000 });
  assert.equal(withWindow.contextWindow, 200000);
  const noWindow = mcpContextCost({ sessionId: "s1", schemas: [schema("mcp__alpha__read")], contextWindow: 0 });
  assert.equal("contextWindow" in noWindow, false, "a zero window is not a window");
});

test("mcpContextCost honours custom thresholds", () => {
  // 20k characters ≈ 5k estimated tokens, so the default reminder already applies.
  const big = schema("mcp__alpha__read", "x".repeat(20000));
  assert.equal(mcpContextCost({ sessionId: "s1", schemas: [big] }).level, "warn");
  assert.equal(mcpContextCost({ sessionId: "s1", schemas: [big], warnTokens: 100000 }).level, "ok");
  assert.equal(mcpContextCost({ sessionId: "s1", schemas: [big], alertTokens: 4000 }).level, "alert");
});

test("Lazy-only proxy definitions use model-facing fields and one shared group", () => {
  const parameters = { type: "object", properties: { server: { type: "string" } } };
  // Both native registered definitions and inputSchema/id-compatible views are
  // accepted; callbacks, raw names and host metadata never enter token pricing.
  const inputs = [
    { ...schema("mcp_search", "Find tools", parameters), execute() {}, output: { private: true } },
    { id: "mcp_describe", description: "Describe tools", inputSchema: parameters, rawName: "ignored" },
    { name: "mcp_call", id: "ignored-id", description: "Call tools", parameters, internal: "not model-facing" }
  ];
  const facing = LAZY_TOOL_NAMES.map((name, index) => ({
    name,
    description: ["Find tools", "Describe tools", "Call tools"][index],
    parameters
  }));
  const cost = mcpContextCost({ sessionId: "lazy", schemas: inputs });
  const chars = JSON.stringify(facing).length;
  assert.equal(cost.tools, 3);
  assert.equal(cost.chars, chars);
  assert.equal(cost.estTokens, Math.ceil(chars / 4) + 4);
  assert.deepEqual(cost.servers, [{
    name: LAZY_PROXY_GROUP_NAME, kind: "lazy-proxy", tools: 3, chars, estTokens: Math.ceil(chars / 4) + 4
  }]);
});

test("mixed Eager and Lazy definitions price the whole visible list and separate proxy overhead", () => {
  const eager = schema("mcp__alpha__read", "Read a file");
  const proxies = LAZY_TOOL_NAMES.map((name) => schema(name, "Shared proxy"));
  const visible = [eager, ...proxies];
  const cost = mcpContextCost({ sessionId: "mixed", schemas: [...visible, schema("shell", "Host tool")] });
  const proxyGroup = cost.servers.find((group) => group.kind === "lazy-proxy");
  const eagerGroup = cost.servers.find((group) => group.name === "alpha");
  assert.equal(cost.tools, 4);
  assert.equal(cost.chars, JSON.stringify(visible).length);
  assert.equal(cost.estTokens, estimateSchemaTokens(JSON.stringify(visible).length));
  assert.equal(cost.servers.length, 2);
  assert.equal(proxyGroup.name, LAZY_PROXY_GROUP_NAME);
  assert.equal(proxyGroup.tools, 3);
  assert.equal(proxyGroup.estTokens, estimateSchemaTokens(JSON.stringify(proxies).length));
  assert.equal(eagerGroup.tools, 1);
  assert.equal(eagerGroup.estTokens, estimateSchemaTokens(JSON.stringify([eager]).length));
  assert.equal("kind" in eagerGroup, false, "ordinary server shape remains compatible");
});

test("only the three exact Lazy proxy names are counted outside the mcp__ namespace", () => {
  const names = [
    ...LAZY_TOOL_NAMES,
    "mcp_search_extra", "mcp_describe_more", "mcp_call_extra", "mcp_Search", "mcp_custom", "shell"
  ];
  const cost = mcpContextCost({ sessionId: "exact", schemas: names.map((name) => schema(name)) });
  assert.equal(cost.tools, 3);
  assert.equal(cost.servers.length, 1);
  assert.equal(cost.servers[0].kind, "lazy-proxy");
  assert.equal(mcpServerOfTool("mcp_search"), undefined, "the shared proxy is not a remote server identity");
});

test("deferLoading excludes Lazy proxy definitions as well as remote tools", () => {
  const cost = mcpContextCost({
    sessionId: "deferred",
    schemas: [
      { ...schema("mcp_search", "not exposed"), deferLoading: true },
      schema("mcp_describe", "visible"),
      { ...schema("mcp_call", "not exposed"), deferLoading: true },
      { ...schema("mcp__alpha__read", "not exposed"), deferLoading: true }
    ]
  });
  assert.equal(cost.tools, 1);
  assert.equal(cost.chars, JSON.stringify([schema("mcp_describe", "visible")]).length);
  assert.deepEqual(cost.servers.map(({ name, kind, tools }) => ({ name, kind, tools })), [
    { name: LAZY_PROXY_GROUP_NAME, kind: "lazy-proxy", tools: 1 }
  ]);
});

test("the shared Lazy proxy cost never multiplies by known mounted server count", () => {
  const schemas = LAZY_TOOL_NAMES.map((name) => schema(name, "Shared proxy"));
  const first = mcpContextCost({ sessionId: "shared", schemas, knownServers: ["alpha"] });
  const many = mcpContextCost({ sessionId: "shared", schemas, knownServers: ["alpha", "beta", "gamma", "other__server"] });
  assert.deepEqual(many, first);
  assert.equal(many.tools, 3);
  assert.equal(many.servers.length, 1);
});

test("contextCostSignature changes when visible Lazy proxy definitions change", () => {
  const before = mcpContextCost({ sessionId: "signature", schemas: LAZY_TOOL_NAMES.map((name) => schema(name, "Proxy")) });
  const hidden = mcpContextCost({ sessionId: "signature", schemas: [] });
  const described = mcpContextCost({ sessionId: "signature", schemas: LAZY_TOOL_NAMES.map((name) => schema(name, "A much longer proxy description")) });
  assert.notEqual(contextCostSignature(before), contextCostSignature(hidden));
  assert.notEqual(contextCostSignature(before), contextCostSignature(described));
  assert.equal(contextCostSignature(before), contextCostSignature({ ...before }));
});

console.log(`\n${passed} context-cost checks passed`);