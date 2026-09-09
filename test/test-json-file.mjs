/**
 * JSON 方言读取测试：条目归一（stdio/http/sse）、坏条目隔离、诊断不泄露文件内容、
 * DSH 自有 JSON 层（项目/profile/用户）的 cwd 策略与透传键、遗留 CC 项目层语义。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mcpJsonLayerEnabled, readDshJsonFile, readMcpJsonFile } from "../lib/json-file.js";

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}

const dir = await mkdtemp(join(tmpdir(), "dsh-project-mcp-manager-jsonfile-"));
const write = async (name, text) => {
  const path = join(dir, name);
  await writeFile(path, text, "utf8");
  return path;
};

try {
  // 1. 遗留 CC 项目层：stdio 条目归一、args 缺省 []、cwd 固定项目根、行形状与受管行同构
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
  pass("legacy cc-project: stdio entries normalize with defaults, project-root cwd, ${VAR} kept literal");

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
  pass("http entries map to streamable-http; unknown keys tolerated");

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

  // 3b. enabled:false 静默跳过（不占名）；disabled:true 占名不装载；url 无 type 按 http 推断
  const p3b = await write("quirks.json", JSON.stringify({
    mcpServers: {
      "off-switch": { command: "node", enabled: false },
      "off-alias": { command: "node", disabled: true },
      "off-truthy": { command: "node", disabled: false, enabled: true },
      "url-only": { url: "https://example.com/mcp" },
      "full-name": { type: "streamable-http", url: "https://example.com/s" }
    }
  }));
  const r3b = await readDshJsonFile(p3b, { source: "dsh-project-json", cwdPolicy: "project", projectRoot: "/work/proj" });
  assert.deepEqual(r3b.entryErrors, [], "off flags must be silent, url-only must not error as missing-command");
  assert.deepEqual(r3b.rows.map((row) => row.rawName).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), ["full-name", "off-alias", "off-truthy", "url-only"]);
  const alias = r3b.rows.find((row) => row.rawName === "off-alias");
  assert.equal(alias.disabled, true, "disabled:true occupies the name");
  assert.equal(alias.row.disabled, true);
  assert.equal(r3b.rows.find((row) => row.rawName === "url-only").row.config.transport, "streamable-http");
  pass("enabled:false skipped silently; disabled:true occupies the name; url inferred as http");

  // 4. DSH 自有 JSON 层：缺 mcpServers 视为空层；cwd 策略按来源分化；DSH 透传键生效
  const p4 = await write("dsh.json", JSON.stringify({
    mcpServers: {
      proj: { command: "node", args: ["p.js"], toolCallTimeoutMs: 1234, failOnStartupError: true, reconnect: { maxAttempts: 3 } },
      user: { command: "node", args: ["u.js"], cwd: "sub" }
    }
  }));
  const projRows = await readDshJsonFile(p4, { source: "dsh-project-json", cwdPolicy: "project", projectRoot: "/work/proj" });
  const proj = projRows.rows.find((row) => row.rawName === "proj");
  assert.equal(proj.source, "dsh-project-json");
  assert.equal(proj.row.config.cwd, "/work/proj");
  assert.equal(proj.row.config.toolCallTimeoutMs, 1234);
  assert.equal(proj.row.config.failOnStartupError, true);
  assert.equal(proj.row.config.reconnect.maxAttempts, 3);
  assert.equal(projRows.rows.find((row) => row.rawName === "user").row.config.cwd, "sub");
  const userRows = await readDshJsonFile(p4, { source: "dsh-user", cwdPolicy: "host", projectRoot: "" });
  assert.equal(userRows.rows.find((row) => row.rawName === "proj").row.config.cwd, "", "user layer keeps host cwd");
  const noKey = await readDshJsonFile(await write("other.json", '{"theme":"dark"}'), { source: "dsh-user", cwdPolicy: "host", projectRoot: "" });
  assert.deepEqual(noKey.rows, []);
  assert.equal(noKey.fileError, undefined, "missing mcpServers is an empty DSH layer");
  assert.ok(/缺少 mcpServers/.test((await readMcpJsonFile(join(dir, "other.json"), "/p")).fileError ?? ""), "legacy file still errors");
  pass("DSH json layers: cwd policy per source, passthrough keys, missing mcpServers is empty");

  // 5. JSON 损坏：fileError 不得含文件内容片段
  const secret = "sk-liv${secret-not-allowed-in-error}e";
  const p5 = await write("broken.json", `{"mcpServers": {"a": {"command": "${secret}",}}`);
  const r5 = await readMcpJsonFile(p5, "/work/proj");
  assert.ok(r5.fileError !== undefined && /JSON 解析失败/.test(r5.fileError));
  assert.ok(!JSON.stringify(r5).includes(secret), "diagnostics must never contain file content");
  const r6 = await readMcpJsonFile(await write("arr.json", "[]"), "/p");
  assert.ok(/顶层必须是 JSON 对象/.test(r6.fileError ?? ""));
  pass("file-level errors are reported without leaking content; shape violations detected");

  // 6. 文件缺失是正常空结果
  const missing = join(dir, "does-not-exist.json");
  assert.deepEqual((await readMcpJsonFile(missing, "/p")).rows, []);
  assert.equal((await readMcpJsonFile(missing, "/p")).fileError, undefined);
  assert.deepEqual((await readDshJsonFile(missing, { source: "dsh-user", cwdPolicy: "host", projectRoot: "" })).rows, []);
  pass("missing files yield empty results without errors");
} finally {
  await rm(dir, { recursive: true, force: true });
}

// 7. 共存边界开关谓词真值表（纯函数，传入合成 env，不碰 process.env）
assert.equal(mcpJsonLayerEnabled({}), true, "legacy .mcp.json layer on by default");
assert.equal(mcpJsonLayerEnabled({ DSH_MCP_IGNORE_MCP_JSON: "1" }), false, "IGNORE_MCP_JSON closes it");
pass("legacy project .mcp.json switch follows the documented truth table");

// 8. 不再读取任何 Claude 用户态文件：编译产物里不得出现该路径
const libDir = new URL("../lib/", import.meta.url);
const libFiles = (await readdir(libDir)).filter((name) => name.endsWith(".js"));
assert.ok(libFiles.length > 0);
for (const name of libFiles) {
  const text = await readFile(new URL(name, libDir), "utf8");
  assert.ok(!/claude\.json/i.test(text), `${name} must not reference the Claude user state file`);
}
pass("no built module references the Claude user state file");

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL JSON FILE TESTS PASSED");
