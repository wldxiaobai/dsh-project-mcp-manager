/**
 * JSON 写入器测试：CLI 独占契约（保留未知顶层键与键序）、解析失败拒绝覆盖、
 * 加锁原子写、条目映射（缺省值不落盘、${VAR} 保持字面值）。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJsonDocument, readJsonServers, toJsonEntry, updateJsonServers, writeJsonServers } from "../lib/json-write.js";
import { mcpServerInputSchema } from "../lib/model.js";

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const dir = await mkdtemp(join(tmpdir(), "dsh-project-mcp-manager-jsonwrite-"));
const target = join(dir, "mcp.json");

try {
  // 1. 缺失文件：创建并写出稳定形状（2 空格缩进 + 结尾换行）
  await writeJsonServers(target, { alpha: { command: "node", args: ["a.js"] } });
  const created = await readFile(target, "utf8");
  assert.equal(created, '{\n  "mcpServers": {\n    "alpha": {\n      "command": "node",\n      "args": [\n        "a.js"\n      ]\n    }\n  }\n}\n');
  assert.equal(await exists(target + ".mcp-project.lock"), false, "lock file is cleaned up");
  pass("writeJsonServers creates the file with stable formatting and releases the lock");

  // 2. 未知顶层键与键序保留：只替换 mcpServers 的值
  await writeFile(target, JSON.stringify({
    $schema: "https://example/schema.json",
    mcpServers: { alpha: { command: "node", args: ["old.js"] } },
    extra: { keep: [1, 2, 3] }
  }, null, 4), "utf8");
  await writeJsonServers(target, { alpha: { command: "node", args: ["new.js"] }, beta: { url: "https://b/mcp" } });
  const doc = await readJsonDocument(target);
  assert.deepEqual(Object.keys(doc), ["$schema", "mcpServers", "extra"], "top-level key order preserved");
  assert.deepEqual(doc.$schema, "https://example/schema.json");
  assert.deepEqual(doc.extra, { keep: [1, 2, 3] });
  assert.deepEqual(Object.keys(doc.mcpServers), ["alpha", "beta"], "existing entry first, appended after");
  assert.deepEqual(doc.mcpServers.alpha.args, ["new.js"]);
  pass("unknown top-level keys and key order survive a write");

  // 3. 解析失败 / 顶层非对象：拒绝写入，文件原样保留
  const broken = '{"mcpServers": {"a": {"command": "sk-secret",}}';
  await writeFile(target, broken, "utf8");
  await assert.rejects(() => writeJsonServers(target, { x: { command: "node" } }), /JSON 语法错误/, "refuses to overwrite an unparsable file");
  assert.equal(await readFile(target, "utf8"), broken, "file untouched after the refusal");
  await assert.rejects(() => readJsonDocument(target), (error) => !String(error.message).includes("sk-secret"), "error message must not leak file content");
  await writeFile(target, "[]", "utf8");
  await assert.rejects(() => writeJsonServers(target, {}), /顶层必须是 JSON 对象/);
  pass("unparsable or non-object files are refused without leaking content");

  // 4. 空文件按空文档处理；readJsonServers 过滤非对象条目
  await writeFile(target, "   \n", "utf8");
  assert.deepEqual(await readJsonDocument(target), {});
  await writeFile(target, JSON.stringify({ mcpServers: { good: { command: "node" }, bad: "nope" } }), "utf8");
  assert.deepEqual(Object.keys(await readJsonServers(target)), ["good"]);
  pass("blank files read as empty and non-object entries are skipped");

  // 5. 条目映射：缺省值不落盘、${VAR} 字面保留、透传键按需写入
  const stdio = mcpServerInputSchema.parse({ serverName: "s", transport: "stdio", command: "node", args: [], env: { TOKEN: "${GH_TOKEN}" }, cwd: "." });
  assert.deepEqual(toJsonEntry(stdio), { command: "node", env: { TOKEN: "${GH_TOKEN}" } });
  const http = mcpServerInputSchema.parse({ serverName: "h", transport: "streamable-http", url: "https://h/mcp", headers: { Authorization: "Bearer ${T}" } });
  assert.deepEqual(toJsonEntry(http), { url: "https://h/mcp", headers: { Authorization: "Bearer ${T}" } });
  const tuned = mcpServerInputSchema.parse({
    serverName: "t",
    transport: "stdio",
    command: "node",
    cwd: "sub/dir",
    toolCallTimeoutMs: 1234,
    failOnStartupError: true,
    reconnect: { enabled: false, initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 2 }
  });
  assert.deepEqual(toJsonEntry(tuned), {
    command: "node",
    cwd: "sub/dir",
    toolCallTimeoutMs: 1234,
    failOnStartupError: true,
    reconnect: { enabled: false, initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 2 }
  });
  pass("toJsonEntry omits defaults, keeps ${VAR} literal, writes non-default passthrough keys");

  // 6. 并发更新：锁内读-改-写，两条 add 都不会丢
  await rm(target, { force: true });
  await Promise.all([
    updateJsonServers(target, (servers) => { servers.one = { command: "node", args: ["1.js"] }; }),
    updateJsonServers(target, (servers) => { servers.two = { command: "node", args: ["2.js"] }; })
  ]);
  const after = await readJsonServers(target);
  const afterKeys = Object.keys(after);
  afterKeys.sort();
  assert.deepEqual(afterKeys, ["one", "two"], "concurrent read-modify-write keeps both entries");
  assert.equal(await exists(target + ".mcp-project.lock"), false, "no lock left behind after concurrent writes");
  pass("concurrent updates serialize through the lock without losing entries");
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL JSON WRITE TESTS PASSED");
