import assert from "node:assert/strict";
import {
  ENV_REF_RE,
  MAX_TIMER_DELAY_MS,
  SERVER_NAME_RE,
  ccServerEntrySchema,
  denySetFor,
  effectiveServerNames,
  expandEnvRefs,
  inputFromPatchRow,
  isUrlOrEnvRef,
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

// 13. ${VAR} 运行时展开：整值匹配、缺失变量整体失败且消息只含变量名
assert.equal(ENV_REF_RE.test("${A_1}"), true);
assert.equal(ENV_REF_RE.test("${A}x"), false);
assert.equal(ENV_REF_RE.test("$A"), false);
assert.equal(ENV_REF_RE.test("${9bad}"), false);
const refInput = mcpServerInputSchema.parse({
  serverName: "cc",
  transport: "stdio",
  command: "${BIN}",
  args: ["--token", "${TOK}", "literal${X}y", "$Y", "${9bad}"],
  env: { KEY: "${K}", KEEP: "plain", DROP: null }
});
const expanded = expandEnvRefs(refInput, { BIN: "node", TOK: "abc", K: "v" });
assert.equal(expanded.ok, true);
assert.equal(expanded.input.command, "node");
assert.deepEqual(expanded.input.args, ["--token", "abc", "literal${X}y", "$Y", "${9bad}"]);
assert.deepEqual(expanded.input.env, { KEY: "v", KEEP: "plain", DROP: null });
assert.notEqual(refInput.command, "node"); // 纯函数：不改动输入
pass("expandEnvRefs expands whole-value ${VAR} in command/args/env, nulls preserved, input untouched");

const missing = expandEnvRefs(refInput, { BIN: "node" });
assert.deepEqual(missing, { ok: false, missingVar: "TOK" });
pass("expandEnvRefs reports only the variable name when a reference is missing");

// 14. http 行：url 占位在展开前必须过 schema，headers 同样展开
assert.equal(isUrlOrEnvRef("${URL}"), true);
assert.equal(isUrlOrEnvRef("http://localhost:3000/mcp"), true);
assert.equal(isUrlOrEnvRef("not-url"), false);
// 混合形态 URL 合法但**不展开**（整值语义）：${PART} 留在路径里按字面量装载
const mixedUrl = mcpServerInputSchema.parse({ serverName: "h", transport: "streamable-http", url: "http://x/${PART}" });
assert.equal(expandEnvRefs(mixedUrl, {}).ok, true);
assert.equal(expandEnvRefs(mixedUrl, {}).input.url, "http://x/${PART}");
const httpRef = mcpServerInputSchema.parse({
  serverName: "h", transport: "streamable-http", url: "${URL}", headers: { Authorization: "Bearer ${TOK}", X: "${TOK}" }
});
assert.deepEqual(expandEnvRefs(httpRef, { TOK: "t" }), { ok: false, missingVar: "URL" });
const httpOk = expandEnvRefs(httpRef, { URL: "http://localhost:3000/mcp", TOK: "t" });
assert.equal(httpOk.ok, true);
assert.equal(httpOk.input.url, "http://localhost:3000/mcp");
assert.equal(httpOk.input.headers.Authorization, "Bearer ${TOK}"); // 部分串不展开
assert.equal(httpOk.input.headers.X, "t");
pass("http url/headers expand; partial-string refs stay literal");

// 15. ccServerEntrySchema 容忍 CC 附加字段
assert.equal(ccServerEntrySchema.safeParse({ command: "npx", args: ["-y", "pkg"], timeout: 5000, scope: "project" }).success, true);
assert.equal(ccServerEntrySchema.safeParse({ command: "npx", env: { A: 1 } }).success, false); // 非字符串 env 值拒绝
assert.equal(ccServerEntrySchema.safeParse({}).success, true); // 空条目先容忍，缺 command/url 由归一层报错
pass("ccServerEntrySchema tolerates unknown CC keys, rejects non-string secrets");

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL MCP MODEL TESTS PASSED");
