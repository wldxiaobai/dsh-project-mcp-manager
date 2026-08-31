import assert from "node:assert/strict";
import {
  MAX_TIMER_DELAY_MS,
  SERVER_NAME_RE,
  denySetFor,
  effectiveServerNames,
  inputFromPatchRow,
  mcpServerInputSchema,
  mergeSecretPatch,
  namespacedServerName,
  patchRowToView,
  projectKeyOf,
  rowIdForServerName,
  serverNameFromRowId,
  toOfficialConfig,
  toPatchRow
} from "../lib/model.js";

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}
function expectThrow(name, fn, needle) {
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    if (needle !== undefined) assert.match(String(error?.message ?? error), needle);
  }
  assert.equal(threw, true, name + " should throw");
  pass(name);
}

// 1. stdio parse + defaults + official config
const stdio = mcpServerInputSchema.parse({ serverName: "github", transport: "stdio", command: "npx" });
assert.equal(stdio.args.length, 0);
assert.equal(stdio.cwd, "");
assert.equal(stdio.toolCallTimeoutMs, 60000);
assert.equal(stdio.failOnStartupError, false);
assert.deepEqual(stdio.reconnect, { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 });
const official = toOfficialConfig(stdio);
assert.equal(official.transport, "stdio");
assert.deepEqual(official.args, []);
pass("stdio input parses with defaults and maps to official config");

// 2. http parse + headers
const http = mcpServerInputSchema.parse({ serverName: "web", transport: "streamable-http", url: "http://localhost:3000/mcp", headers: { Authorization: "Bearer x" } });
assert.equal(toOfficialConfig(http).headers.Authorization, "Bearer x");
pass("streamable-http input parses and maps headers");

// 3. invalid inputs
expectThrow("bad serverName rejected", () => mcpServerInputSchema.parse({ serverName: "bad/name", transport: "stdio", command: "npx" }), /serverName/);
expectThrow("missing command rejected", () => mcpServerInputSchema.parse({ serverName: "ok", transport: "stdio" }));
expectThrow("bad url rejected", () => mcpServerInputSchema.parse({ serverName: "ok", transport: "streamable-http", url: "not-url" }));

// 4. row id mapping
assert.equal(rowIdForServerName("github"), "panel-mcp-github");
assert.equal(serverNameFromRowId("panel-mcp-github"), "github");
assert.equal(serverNameFromRowId("other-row"), undefined);
pass("managed row id round-trips through serverName");

// 5. toPatchRow enabled/disabled
const enabledRow = toPatchRow(stdio, true);
assert.equal(enabledRow.disabled, undefined);
assert.equal(enabledRow.name, "@deepseek-ai/dsh-mcp-client");
const disabledRow = toPatchRow(stdio, false);
assert.equal(disabledRow.disabled, true);
pass("toPatchRow maps enabled flag to disabled row field");

// 6. patchRowToView redacts secrets
const secretRow = toPatchRow(mcpServerInputSchema.parse({
  serverName: "github",
  transport: "stdio",
  command: "npx",
  env: { GITHUB_TOKEN: "super-secret", FOO: "bar" }
}));
const view = patchRowToView(secretRow);
assert.deepEqual(view.envKeys.sort(), ["FOO", "GITHUB_TOKEN"]);
assert.equal(JSON.stringify(view).includes("super-secret"), false);
pass("patchRowToView redacts secret values");

const httpView = patchRowToView(toPatchRow(http));
assert.deepEqual(httpView.headerKeys, ["Authorization"]);
assert.equal(JSON.stringify(httpView).includes("Bearer x"), false);
pass("http view redacts header values");

// 7. secret merge semantics
assert.deepEqual(mergeSecretPatch({ A: "1", B: "2" }, { B: null, C: "3" }), { A: "1", C: "3" });
assert.deepEqual(mergeSecretPatch(undefined, undefined), {});
pass("secret patch null deletes, string overrides, absent preserves");

// 8. effectiveServerNames：唯一名保持原名，冲突名（含全局占用）双方都改
const projA = "/tmp/projA";
const projB = "/tmp/projB";
const eff1 = effectiveServerNames(
  [{ projectRoot: projA, names: ["unique", "dup"] }, { projectRoot: projB, names: ["dup"] }],
  ["global-only"]
);
assert.equal(eff1.get(projectKeyOf(projA) + "\u0000unique"), "unique");
assert.equal(eff1.get(projectKeyOf(projA) + "\u0000dup"), namespacedServerName(projA, "dup"));
assert.equal(eff1.get(projectKeyOf(projB) + "\u0000dup"), namespacedServerName(projB, "dup"));
const eff2 = effectiveServerNames([{ projectRoot: projA, names: ["conflict"] }], ["conflict"]);
assert.equal(eff2.get(projectKeyOf(projA) + "\u0000conflict"), namespacedServerName(projA, "conflict"));
pass("effectiveServerNames renames only conflicting names deterministically");

// 9. namespacedServerName 合法且确定性
const ns = namespacedServerName(projA, "dup");
assert.match(ns, SERVER_NAME_RE);
assert.ok(ns.length <= 32, "namespaced name stays within serverName limit");
assert.equal(namespacedServerName(projA, "dup"), namespacedServerName(projA, "dup"));
pass("namespacedServerName produces valid, deterministic names");

// 10. denySetFor：own 项目不 deny，无项目 deny 全部
const mounted = [{ projectRoot: projA, effectiveNames: ["a1", "a2"] }, { projectRoot: projB, effectiveNames: ["b1"] }];
assert.deepEqual(denySetFor(projA, mounted), ["b1"]);
assert.deepEqual(denySetFor(undefined, mounted).sort(), ["a1", "a2", "b1"]);
pass("denySetFor scopes visibility to the session's own project");

assert.equal(SERVER_NAME_RE.test("a_b-1"), true);
assert.equal(SERVER_NAME_RE.test("bad/name"), false);
pass("serverName regex matches official contract");

// 11. 未知 transport 显式报错（此前落 stdio 分支，误报「command 必填」）
expectThrow(
  "unknown transport reports the real problem",
  () => inputFromPatchRow({ id: "panel-mcp-x", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "x", transport: "http", url: "http://localhost:3000/mcp" } }),
  /transport 必须为 "stdio" 或 "streamable-http"/
);
// 已知 transport 不受影响
assert.equal(inputFromPatchRow({ id: "panel-mcp-x", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "x", transport: "stdio", command: "node" } }).transport, "stdio");
assert.equal(inputFromPatchRow({ id: "panel-mcp-x", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "x", transport: "streamable-http", url: "http://localhost:3000/mcp" } }).transport, "streamable-http");
pass("known transports still parse through inputFromPatchRow");

// 12. reconnect 上限镜像官方（dsh-mcp-client lib/index.js:734-735）
expectThrow("maxDelayMs above MAX_TIMER_DELAY_MS rejected", () => mcpServerInputSchema.parse({
  serverName: "x", transport: "stdio", command: "n", reconnect: { maxDelayMs: MAX_TIMER_DELAY_MS + 1 }
}), /maxDelayMs/);
expectThrow("initialDelayMs above MAX_TIMER_DELAY_MS rejected", () => mcpServerInputSchema.parse({
  serverName: "x", transport: "stdio", command: "n", reconnect: { initialDelayMs: 2147483648 }
}), /initialDelayMs/);
assert.equal(MAX_TIMER_DELAY_MS, 2147483647);
assert.equal(mcpServerInputSchema.parse({ serverName: "x", transport: "stdio", command: "n", reconnect: { maxDelayMs: MAX_TIMER_DELAY_MS } }).reconnect.maxDelayMs, MAX_TIMER_DELAY_MS);
pass("reconnect delays clamped to the official MAX_TIMER_DELAY_MS");

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL MCP MODEL TESTS PASSED");
