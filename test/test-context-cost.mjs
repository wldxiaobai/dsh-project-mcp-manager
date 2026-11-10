import assert from "node:assert/strict";
import {
  CONTEXT_COST_ALERT_TOKENS,
  CONTEXT_COST_WARN_TOKENS,
  contextCostLevel,
  estimateSchemaTokens,
  mcpContextCost,
  mcpServerOfTool
} from "../lib/context-cost.js";

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

console.log(`\n${passed} context-cost checks passed`);