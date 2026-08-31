/**
 * cc-file 兼容层读取测试：CC 条目归一（stdio/http/sse）、坏条目隔离、
 * 诊断不泄露文件内容、~/.claude.json 严格 allowlist 与 serversHash 门控。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJsonString, readClaudeUserFile, readMcpJsonFile } from "../lib/cc-file.js";

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}

const dir = await mkdtemp(join(tmpdir(), "dsh-project-mcp-manager-ccfile-"));
const write = async (name, text) => {
  const path = join(dir, name);
  await writeFile(path, text, "utf8");
  return path;
};

try {
  // 1. stdio 条目归一：默认 transport、args 缺省 []、cwd 固定项目根、id/name 与受管行同构
  const p1 = await write("mcp.json", JSON.stringify({
    mcpServers: {
      tasks: { command: "node", args: ["server.js"], env: { TOKEN: "${GH_TOKEN}" } },
      plain: { command: "npx" }
    }
  }));
  const r1 = await readMcpJsonFile(p1, "/work/proj");
  assert.equal(r1.fileError, undefined);
  assert.deepEqual(r1.entryErrors, []);
  assert.equal(r1.rows.length, 2);
  const tasks = r1.rows.find((row) => row.rawName === "tasks");
  assert.equal(tasks.source, "cc-project");
  assert.equal(tasks.row.id, "panel-mcp-tasks");
  assert.equal(tasks.row.name, "@deepseek-ai/dsh-mcp-client");
  assert.equal(tasks.row.config.transport, "stdio");
  assert.equal(tasks.row.config.command, "node");
  assert.deepEqual(tasks.row.config.args, ["server.js"]);
  assert.equal(tasks.row.config.cwd, "/work/proj");
  assert.equal(tasks.row.config.env.TOKEN, "${GH_TOKEN}"); // 保持字面值，mount 时才展开
  assert.deepEqual(r1.rows.find((row) => row.rawName === "plain").row.config.args, []);
  pass("stdio entries normalize with defaults, project-root cwd, managed row shape; ${VAR} kept literal");

  // 2. type:"http" → streamable-http + headers；多余字段容忍
  const p2 = await write("http.json", JSON.stringify({
    mcpServers: { remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOK}" }, timeout: 5000 } }
  }));
  const r2 = await readMcpJsonFile(p2, "/work/proj");
  assert.equal(r2.rows.length, 1);
  assert.equal(r2.rows[0].row.config.transport, "streamable-http");
  assert.equal(r2.rows[0].row.config.url, "https://example.com/mcp");
  assert.equal(r2.rows[0].row.config.headers.Authorization, "Bearer ${TOK}");
  assert.equal(r2.rows[0].row.config.toolCallTimeoutMs, 60000);
  pass("http entries map to streamable-http; unknown CC keys tolerated");

  // 3. sse 拒绝 + 坏条目隔离（非法名、缺 command、缺 url、非字符串 env 值），其余条目保留
  const p3 = await write("mixed.json", JSON.stringify({
    mcpServers: {
      legacy: { type: "sse", url: "https://example.com/sse" },
      "bad name!": { command: "x" },
      empty: {},
      "http-no-url": { type: "http" },
      "num-env": { command: "x", env: { A: 1 } },
      survivor: { command: "keep-me" }
    }
  }));
  const r3 = await readMcpJsonFile(p3, "/work/proj");
  assert.equal(r3.fileError, undefined);
  assert.equal(r3.rows.length, 1);
  assert.equal(r3.rows[0].rawName, "survivor");
  assert.equal(r3.entryErrors.length, 5);
  assert.ok(r3.entryErrors.some((e) => /sse/.test(e)), "sse rejection present");
  assert.ok(r3.entryErrors.some((e) => /serverName 非法/.test(e)));
  assert.ok(r3.entryErrors.some((e) => /缺少 command/.test(e)));
  pass("sse and broken entries are rejected per-entry without affecting valid ones");

  // 3b. enabled:false / disabled:true 静默跳过（不装载不报错不占名）；url 无 type
  //     按 http 推断；type:"streamable-http" 显式写法容忍。
  const p3b = await write("quirks.json", JSON.stringify({
    mcpServers: {
      "off-switch": { command: "node", enabled: false },
      "off-alias": { command: "node", disabled: true },
      "off-truthy": { command: "node", disabled: false, enabled: true },
      "url-only": { url: "https://example.com/mcp" },
      "full-name": { type: "streamable-http", url: "https://example.com/s" }
    }
  }));
  const r3b = await readMcpJsonFile(p3b, "/work/proj");
  assert.deepEqual(r3b.entryErrors, [], "off flags must be silent, url-only must not error as missing-command");
  assert.deepEqual(r3b.rows.map((row) => row.rawName).sort(), ["full-name", "off-truthy", "url-only"]);
  assert.equal(r3b.rows.find((row) => row.rawName === "url-only").row.config.transport, "streamable-http");
  assert.equal(r3b.rows.find((row) => row.rawName === "full-name").row.config.transport, "streamable-http");
  pass("enabled:false / disabled:true skipped silently; url inferred as http; streamable-http type accepted");

  // 4. JSON 损坏：fileError 不得含文件内容片段（~/.claude.json 可能带凭据）
  const secret = "sk-liv${secret-not-allowed-in-error}e";
  const p4 = await write("broken.json", `{"mcpServers": {"a": {"command": "${secret}",}}`);
  const r4 = await readMcpJsonFile(p4, "/work/proj");
  assert.ok(r4.fileError !== undefined && /JSON 解析失败/.test(r4.fileError));
  assert.ok(!JSON.stringify(r4).includes(secret), "diagnostics must never contain file content");
  // 顶层非对象 / 缺 mcpServers
  const r5 = await readMcpJsonFile(await write("arr.json", "[]"), "/p");
  assert.ok(/顶层必须是 JSON 对象/.test(r5.fileError ?? ""));
  const r6 = await readMcpJsonFile(await write("nomcp.json", '{"other":1}'), "/p");
  assert.ok(/缺少 mcpServers/.test(r6.fileError ?? ""));
  pass("file-level errors are reported without leaking content; shape violations detected");

  // 5. 文件缺失是正常空结果（两个来源都是）
  const missing = join(dir, "does-not-exist.json");
  assert.deepEqual((await readMcpJsonFile(missing, "/p")).rows, []);
  assert.equal((await readMcpJsonFile(missing, "/p")).fileError, undefined);
  const missingUser = await readClaudeUserFile(missing);
  assert.deepEqual(missingUser.rows, []);
  assert.ok(typeof missingUser.serversHash === "string" && missingUser.serversHash.length === 64);
  pass("missing files yield empty results without errors (both sources)");

  // 6. ~/.claude.json allowlist：只摘顶层 mcpServers，其余键（含凭证形状）即弃
  const p6 = await write("claude.json", JSON.stringify({
    oauthAccount: { accessToken: "TOPSECRET", refreshToken: "ALSOSECRET" },
    primaryApiKey: "KEYSECRET",
    numStartups: 42,
    theme: "dark",
    projects: { "/some/cwd": { mcpServers: { localonly: { command: "never-loaded" } }, history: ["private"] } },
    mcpServers: { userlevel: { command: "node", args: ["u.js"] } }
  }));
  const r7 = await readClaudeUserFile(p6);
  assert.equal(r7.fileError, undefined);
  assert.deepEqual(r7.rows.map((row) => row.rawName), ["userlevel"]);
  assert.equal(r7.rows[0].source, "cc-user");
  assert.equal(r7.rows[0].row.config.cwd, ""); // user 层不逐项目定 cwd
  assert.ok(!JSON.stringify(r7).includes("TOPSECRET"), "non-mcpServers content must be dropped");
  assert.ok(!JSON.stringify(r7).includes("localonly"), "local scope must NOT be imported");
  // serversHash：键序不敏感、内容敏感、与状态位无关
  const r8 = await readClaudeUserFile(await write("claude2.json", JSON.stringify({
    numStartups: 43,
    mcpServers: { userlevel: { args: ["u.js"], command: "node" } }
  })));
  assert.equal(r8.serversHash, r7.serversHash, "key order and unrelated state must not change the hash");
  const r9 = await readClaudeUserFile(await write("claude3.json", JSON.stringify({
    mcpServers: { userlevel: { command: "node", args: ["changed.js"] } }
  })));
  assert.notEqual(r9.serversHash, r7.serversHash, "mcpServers content change must change the hash");
  pass("claude.json allowlist drops everything but mcpServers; local scope excluded; hash is order-insensitive");
} finally {
  await rm(dir, { recursive: true, force: true });
}

// 7. canonicalJsonString 对嵌套对象同样排序
assert.equal(
  canonicalJsonString({ b: { y: 1, x: 2 }, a: [3, { d: 4, c: 5 }] }),
  canonicalJsonString({ a: [3, { c: 5, d: 4 }], b: { x: 2, y: 1 } })
);
pass("canonicalJsonString sorts nested keys deterministically");

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL CC FILE TESTS PASSED");
