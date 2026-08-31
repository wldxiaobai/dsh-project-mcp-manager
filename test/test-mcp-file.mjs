/**
 * mcp-file 受管块解析测试：原生 cordis 方言 `!!js` 标签必须被显式拒绝
 * （此前经 yaml 包解析只剩 Unresolved tag 警告，值静默降级为字面量字符串）。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MCP_BLOCK_BEGIN, MCP_BLOCK_END, extractManagedRows, writeManagedRows } from "../lib/mcp-file.js";

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

const block = (body) => MCP_BLOCK_BEGIN + "\n" + body + MCP_BLOCK_END + "\n";
const rowYaml = (configLines) =>
  "- insert:\n    - id: panel-mcp-demo\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n" + configLines;

// 1. 基线：纯字面值行正常解析
const good = block(rowYaml("        serverName: demo\n        transport: stdio\n        command: npx\n"));
const rows = extractManagedRows(good);
assert.equal(rows.length, 1);
assert.equal(rows[0].config.command, "npx");
pass("plain literal rows still parse");

// 2. env 中的 !!js（官方 README 示例写法）→ 显式报错，不静默降级
expectThrow("env !!js is rejected with an explicit error", () => extractManagedRows(block(rowYaml(
  "        serverName: demo\n        transport: stdio\n        command: npx\n        env:\n          TOKEN: !!js process.env.GITHUB_TOKEN\n"
))), /!!js/);

// 3. disabled: !!js → 同样拒绝（否则因 !== true 被当启用装载）
expectThrow("disabled !!js is rejected", () => extractManagedRows(block(rowYaml(
  "        serverName: demo\n        transport: stdio\n        command: npx\n") + "").replace(
  "    - id: panel-mcp-demo", "    - id: panel-mcp-demo\n      disabled: !!js process.env.MCP_DISABLE"
)));

// 4. 其他未解析标签一律拒绝（守卫覆盖整个方言面，不只 !!js）
expectThrow("unknown custom tag is rejected", () => extractManagedRows(block(rowYaml(
  "        serverName: demo\n        transport: stdio\n        command: !custom something\n"
))), /不支持的 YAML 标签/);

// 5. 标记外的 !!js 不受影响：插件只装载受管块行，块外内容逐字节保留
const withOutsideJs = "- id: other-row\n  name: other-plugin\n  config:\n    token: !!js process.env.OTHER\n\n" + good;
assert.equal(extractManagedRows(withOutsideJs).length, 1, "out-of-block !!js must not break the read path");
pass("!!js outside the managed block is ignored by the read path");

// 6. writeManagedRows 对含标记外 !!js 的文件仍可写回（validatePatchText 只查 parse errors），
//    且标记外内容原样保留
const dir = await mkdtemp(join(tmpdir(), "dsh-project-mcp-manager-mcpfile-"));
try {
  const path = join(dir, "mcp.yml");
  await writeFile(path, withOutsideJs, "utf8");
  const next = await writeManagedRows(path, [{ id: "panel-mcp-demo2", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "demo2", transport: "stdio", command: "node" } }]);
  assert.ok(next.includes("token: !!js process.env.OTHER"), "out-of-block content preserved byte-for-byte");
  assert.ok(next.includes("panel-mcp-demo2"), "managed block replaced");
  assert.equal(extractManagedRows(next).length, 1);
  pass("writeManagedRows keeps out-of-block !!js and swaps only the managed block");
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL MCP FILE TESTS PASSED");
