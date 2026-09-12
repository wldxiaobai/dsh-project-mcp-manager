import assert from "node:assert/strict";
import {
  MAX_TIMER_DELAY_MS,
  MCP_TRANSPORT_ALIASES,
  SERVER_NAME_RE,
  SUPPORTED_MCP_TRANSPORTS,
  byCodeUnit,
  deniedToolsForFilter,
  denySetFor,
  effectiveServerNames,
  expandEnvRefs,
  inputFromPatchRow,
  isUrlOrEnvRef,
  jsonTypeOfTransport,
  matchToolGlob,
  mcpServerInputSchema,
  mergeSecretPatch,
  namespacedServerName,
  parseCliTransport,
  patchRowToView,
  projectKeyOf,
  resolveMcpTransport,
  rowIdForServerName,
  rowNameOf,
  serverNameFromRowId,
  toOfficialConfig,
  toPatchRow,
  unsupportedTransportMessage
} from "../lib/model.js";
import { jsonServerEntrySchema } from "../lib/json-file.js";
import { dshHomeDir, dshHomeFor, isValidProfileName, profileMcpJsonFile, userLayerPathsIn } from "../lib/dsh-paths.js";
import { mcpToolBudgetStats, parseToolBudgetWarn } from "../lib/status.js";
import { join, resolve } from "node:path";

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
const envKeys = [...view.envKeys];
envKeys.sort(byCodeUnit);
assert.deepEqual(envKeys, ["FOO", "GITHUB_TOKEN"]);
assert.equal(JSON.stringify(view).includes("super-secret"), false);
assert.equal(view.tools, undefined);
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
// 纯路径字符串夹具（只喂给 projectKeyOf / namespacedServerName，不落盘），
// 用中性虚构挂载点，避免被安全规则按公共可写目录（/tmp 等）的使用判违规。
const projA = "/srv/projects/alpha";
const projB = "/srv/projects/beta";
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
const denyAll = [...denySetFor(undefined, mounted)];
denyAll.sort(byCodeUnit);
assert.deepEqual(denyAll, ["a1", "a2", "b1"]);
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

// 13. ${VAR} 运行时展开：串内插值、缺失变量整体失败且消息只含变量名
const refInput = mcpServerInputSchema.parse({
  serverName: "cc",
  transport: "stdio",
  command: "${BIN}",
  args: ["--token", "${TOK}", "literal${X}y", "$Y", "${9bad}"],
  env: { KEY: "${K}", KEEP: "plain", DROP: null }
});
const expanded = expandEnvRefs(refInput, { BIN: "node", TOK: "abc", K: "v", X: "hy" });
assert.equal(expanded.ok, true);
assert.equal(expanded.input.command, "node");
assert.deepEqual(expanded.input.args, ["--token", "abc", "literalhyy", "$Y", "${9bad}"]);
assert.deepEqual(expanded.input.env, { KEY: "v", KEEP: "plain", DROP: null });
assert.notEqual(refInput.command, "node"); // 纯函数：不改动输入
pass("expandEnvRefs interpolates ${VAR} inside values, nulls preserved, input untouched");

const missing = expandEnvRefs(refInput, { BIN: "node", TOK: "abc", K: "v" });
assert.deepEqual(missing, { ok: false, missingVar: "X" });
pass("expandEnvRefs reports only the variable name when a reference is missing");

const emptyVar = expandEnvRefs(refInput, { BIN: "node", TOK: "", K: "v", X: "hy" });
assert.deepEqual(emptyVar, { ok: false, missingVar: "TOK" }, "empty-string env value counts as missing");
pass("expandEnvRefs refuses to interpolate empty credentials");

// 13b. cwd 同样参与展开（评审 P3：`${VAR}` 覆盖面）
const cwdInput = mcpServerInputSchema.parse({
  serverName: "cw", transport: "stdio", command: "node", cwd: "${ROOT}/sub"
});
const cwdExpanded = expandEnvRefs(cwdInput, { ROOT: "/srv/app" });
assert.equal(cwdExpanded.ok, true);
assert.equal(cwdExpanded.input.cwd, "/srv/app/sub", "${VAR} interpolates inside cwd");
assert.deepEqual(expandEnvRefs(cwdInput, {}), { ok: false, missingVar: "ROOT" });
pass("expandEnvRefs interpolates cwd and reports missing vars from it");

// 14. http 行：url 占位在展开前必须过 schema，headers 串内插值
assert.equal(isUrlOrEnvRef("${URL}"), true);
assert.equal(isUrlOrEnvRef("https://${HOST}/mcp"), true, "串内占位（host 段）装载前放行，展开后复验兜底");
assert.equal(isUrlOrEnvRef("${GATEWAY}/mcp"), true, "README 的网关前缀占位写法不得在装载前被拒");
assert.equal(isUrlOrEnvRef("http://localhost:3000/mcp"), true);
assert.equal(isUrlOrEnvRef("not-url"), false);
const mixedUrl = mcpServerInputSchema.parse({ serverName: "h", transport: "streamable-http", url: "https://x/${PART}" });
assert.deepEqual(expandEnvRefs(mixedUrl, {}), { ok: false, missingVar: "PART" });
const mixedOk = expandEnvRefs(mixedUrl, { PART: "seg" });
assert.equal(mixedOk.ok, true);
assert.equal(mixedOk.input.url, "https://x/seg");
const httpRef = mcpServerInputSchema.parse({
  serverName: "h", transport: "streamable-http", url: "${URL}", headers: { Authorization: "Bearer ${TOK}", X: "${TOK}" }
});
assert.deepEqual(expandEnvRefs(httpRef, { TOK: "t" }), { ok: false, missingVar: "URL" });
const httpOk = expandEnvRefs(httpRef, { URL: "http://localhost:3000/mcp", TOK: "t" });
assert.equal(httpOk.ok, true);
assert.equal(httpOk.input.url, "http://localhost:3000/mcp");
assert.equal(httpOk.input.headers.Authorization, "Bearer t"); // CC 常见写法：Bearer 前缀 + 串内引用
assert.equal(httpOk.input.headers.X, "t");
pass("http url/headers interpolate in-string refs incl. Bearer ${TOKEN}");

// 15. jsonServerEntrySchema 容忍生态附加字段与 DSH 透传键
assert.equal(jsonServerEntrySchema.safeParse({ command: "npx", args: ["-y", "pkg"], timeout: 5000, scope: "project" }).success, true);
assert.equal(jsonServerEntrySchema.safeParse({ command: "npx", env: { A: 1 } }).success, false); // 非字符串 env 值拒绝
assert.equal(jsonServerEntrySchema.safeParse({}).success, true); // 空条目先容忍，缺 command/url 由归一层报错
assert.equal(jsonServerEntrySchema.safeParse({ command: "npx", toolCallTimeoutMs: 1000, disabled: true }).success, true);
assert.equal(jsonServerEntrySchema.safeParse({ command: "npx", toolCallTimeoutMs: 0 }).success, false);
pass("jsonServerEntrySchema tolerates unknown keys and DSH passthrough, rejects non-string secrets");

// 16. dsh-paths：DSH_HOME 重定位与注入优先（用户层三文件都从这里派生）
{
  const homeDir = process.platform === "win32" ? String.raw`C:\Users\x` : "/home/x";
  const relocated = process.platform === "win32" ? String.raw`D:\dsh-home` : "/srv/dsh-home";
  assert.equal(dshHomeDir(homeDir, {}), join(homeDir, ".dsh"), "no DSH_HOME → <home>/.dsh");
  assert.equal(dshHomeDir(homeDir, { DSH_HOME: "" }), join(homeDir, ".dsh"), "empty DSH_HOME is ignored");
  assert.equal(dshHomeDir(homeDir, { DSH_HOME: relocated }), resolve(relocated), "DSH_HOME wins and is absolutized");
  assert.equal(dshHomeFor(homeDir, { DSH_HOME: relocated }), join(homeDir, ".dsh"), "explicit home injection beats DSH_HOME");
  assert.equal(dshHomeFor(undefined, { DSH_HOME: relocated }), resolve(relocated), "no injection → DSH_HOME");
  const paths = userLayerPathsIn(relocated);
  assert.deepEqual(paths, {
    mcpYml: join(relocated, "mcp.yml"),
    mcpJson: join(relocated, "mcp.json"),
    profilesDir: join(relocated, "profiles")
  }, "user layer paths derive from the dsh home");
  assert.equal(profileMcpJsonFile(paths.profilesDir, "web"), join(relocated, "profiles", "web", "mcp.json"));
  // profile 名校验：外部输入不得越出 profiles 目录
  for (const ok of ["web", "headless", "a.b_c-1", "X9"]) assert.equal(isValidProfileName(ok), true, `${ok} is a valid profile name`);
  for (const bad of ["", ".", "..", "../x", "a/b", String.raw`a\b`, "/abs", "-lead", ".hidden", "C:", "a b"]) {
    assert.equal(isValidProfileName(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
  pass("dshHomeDir/dshHomeFor honour DSH_HOME with injection priority, profile names are validated");
}

// 17. rowNameOf：受管行 id 优先于 config.serverName（CLI 与装载器同口径）
assert.equal(rowNameOf({ id: "panel-mcp-fromid", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "fromconfig" } }), "fromid", "row id wins over config.serverName");
assert.equal(rowNameOf({ name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "onlyconfig" } }), "onlyconfig", "config.serverName is the fallback");
assert.equal(rowNameOf({ id: "other-prefix", name: "@deepseek-ai/dsh-mcp-client", config: {} }), undefined, "no name at all");
pass("rowNameOf prefers the managed row id");

// 18. 传输值域镜像：schema/CLI/JSON 映射从同一常量派生
assert.deepEqual([...SUPPORTED_MCP_TRANSPORTS], ["stdio", "streamable-http"]);
assert.equal(MCP_TRANSPORT_ALIASES.http, "streamable-http");
assert.equal(jsonTypeOfTransport("stdio"), "stdio");
assert.equal(jsonTypeOfTransport("streamable-http"), "http");
assert.deepEqual(resolveMcpTransport("http"), { transport: "streamable-http" });
assert.deepEqual(resolveMcpTransport("stdio"), { transport: "stdio" });
assert.equal(resolveMcpTransport("sse").error, unsupportedTransportMessage("sse"));
assert.match(unsupportedTransportMessage("sse"), /MCP SSE 端点传输/);
assert.match(unsupportedTransportMessage("sse"), /把 type 改为 "http"/);
assert.match(unsupportedTransportMessage("sse"), /删除 type 只留 url/);
assert.deepEqual(parseCliTransport("streamable-http"), { transport: "http" });
assert.deepEqual(parseCliTransport("stdio"), { transport: "stdio" });
assert.match(parseCliTransport("websocket").error, /stdio\|http/);
assert.match(parseCliTransport("sse").error, /MCP SSE 端点传输/);
expectThrow(
  "unknown yml transport still names the mirrored set",
  () => inputFromPatchRow({ id: "panel-mcp-x", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "x", transport: "websocket" } }),
  /"stdio" 或 "streamable-http"/
);
pass("SUPPORTED_MCP_TRANSPORTS is the single source for aliases, CLI parsing, and errors");

assert.equal(matchToolGlob("delete_*", "delete_file"), true);
assert.equal(matchToolGlob("delete_*", "read_file"), false);
assert.equal(matchToolGlob("mcp__gh__*", "mcp__gh__create_issue"), true);
assert.equal(matchToolGlob("?", "a"), true);
assert.equal(matchToolGlob("?", "ab"), false);
assert.equal(matchToolGlob("file.[jt]s", "file.js"), true);
assert.equal(matchToolGlob("file.[jt]s", "file.py"), false);
assert.equal(matchToolGlob("[!a]*", "bcd"), true);
assert.equal(matchToolGlob("[!a]*", "abc"), false);
assert.equal(matchToolGlob("**", "a/b"), true);
const filtered = deniedToolsForFilter("gh", { allow: ["read_*"], deny: ["read_secret"] }, [
  "mcp__gh__read_file",
  "mcp__gh__read_secret",
  "mcp__gh__delete_file",
  "mcp__other__read_file"
]);
filtered.sort(byCodeUnit);
assert.deepEqual(filtered, ["mcp__gh__delete_file", "mcp__gh__read_secret"]);
const stripped = toOfficialConfig(mcpServerInputSchema.parse({
  serverName: "gh",
  transport: "stdio",
  command: "node",
  tools: { deny: ["delete_*"] }
}));
assert.equal(stripped.tools, undefined);
const row = toPatchRow(mcpServerInputSchema.parse({
  serverName: "gh",
  transport: "stdio",
  command: "node",
  tools: { deny: ["delete_*"] }
}));
assert.deepEqual(row.config.tools, { deny: ["delete_*"] });
assert.deepEqual(inputFromPatchRow(row).tools, { deny: ["delete_*"] });
assert.deepEqual(patchRowToView(row)?.tools, { deny: ["delete_*"] });
pass("tool allow/deny globs, deny-over-allow, and official config strips tools");

assert.deepEqual(parseToolBudgetWarn(""), { maxTools: 200, maxBytes: 256 * 1024 });
assert.deepEqual(parseToolBudgetWarn("10"), { maxTools: 10, maxBytes: 256 * 1024 });
assert.deepEqual(parseToolBudgetWarn("10,4096"), { maxTools: 10, maxBytes: 4096 });
assert.deepEqual(parseToolBudgetWarn("nope,-1"), { maxTools: 200, maxBytes: 256 * 1024 });
const budgetStats = mcpToolBudgetStats({
  tools: {
    schemas: () => [
      { name: "mcp__heavy__a", description: "aa", inputSchema: { type: "object" } },
      { name: "mcp__other__b", description: "bb" }
    ]
  }
}, "heavy");
assert.equal(budgetStats.tools, 1);
assert.ok(budgetStats.bytes > 0, "budget bytes include id/description/schema");
pass("tool budget env parse and schema byte stats");

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL MCP MODEL TESTS PASSED");
