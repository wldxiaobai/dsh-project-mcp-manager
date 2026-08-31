import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../lib/cli.js";
import { projectMcpFile } from "../lib/registry.js";

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}

function io() {
  const out = [];
  const err = [];
  return { lines: out, errs: err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}

const dir = await mkdtemp(join(tmpdir(), "dsh-mcp-cli-"));
const home = join(dir, "home");
const project = join(dir, "proj");
await mkdir(join(home, ".dsh"), { recursive: true });
await mkdir(project, { recursive: true });
const deps = { home, resolveProjectRoot: async () => project };
const projectYml = projectMcpFile(project);
const userYml = join(home, ".dsh", "mcp.yml");

try {
  // 1. add stdio（含多 args、env、-- 透传），写进项目 yml
  {
    const cap = io();
    const code = await runCli(["add", "fs", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp/data", "-e", "TOKEN=${API_TOKEN}", "--", "extra"], cap.io, deps);
    assert.equal(code, 0, cap.errs.join("\n"));
    const raw = await readFile(projectYml, "utf8");
    assert.ok(raw.includes("serverName: fs"), "managed block written");
    assert.ok(raw.includes("extra"), "-- args carried through");
    assert.ok(raw.includes("TOKEN: ${API_TOKEN}"), "${VAR} stored literally, not expanded at write time");
    pass("cli add writes a stdio row with env refs kept literal");
  }

  // 2. 重复 add 同名报错
  {
    const cap = io();
    const code = await runCli(["add", "fs", "node"], cap.io, deps);
    assert.equal(code, 1);
    assert.ok(cap.errs.join("\n").includes("已存在"));
    pass("cli add rejects duplicate server names");
  }

  // 3. add http + header；--scope user 落 ~/.dsh/mcp.yml
  {
    const cap = io();
    const code = await runCli(["add", "--transport", "http", "remote", "https://example/mcp", "-H", "Authorization: Bearer ${TOK}", "--scope", "user"], cap.io, deps);
    assert.equal(code, 0, cap.errs.join("\n"));
    const raw = await readFile(userYml, "utf8");
    assert.ok(raw.includes("transport: streamable-http"), "http maps to streamable-http");
    assert.ok(raw.includes("serverName: remote"));
    pass("cli add --scope user http row lands in ~/.dsh/mcp.yml");
  }

  // 4. 坏名字 / 坏 transport / local 作用域指引
  {
    const cap = io();
    assert.equal(await runCli(["add", "bad name!", "node"], cap.io, deps), 1, "invalid server name rejected");
    assert.ok(cap.errs.join("\n").includes("配置无效"));
    const cap2 = io();
    assert.equal(await runCli(["add", "-t", "sse", "x", "http://e/"], cap2.io, deps), 1, "sse rejected");
    assert.ok(cap2.errs.join("\n").includes("sse"));
    const cap3 = io();
    assert.equal(await runCli(["add", "y", "node", "--scope", "local"], cap3.io, deps), 1, "local scope guidance");
    assert.ok(cap3.errs.join("\n").includes("local"));
    pass("cli rejects invalid names, sse transport, and explains local scope");
  }

  // 5. list：四个来源 + 遮蔽标注
  await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "node", args: ["shadowed.js"] }, ccserver: { command: "node", args: [] } } }), "utf8");
  await writeFile(join(home, ".claude.json"), JSON.stringify({ oauth: {}, mcpServers: { ccuser: { type: "http", url: "https://u/mcp" } } }), "utf8");
  {
    const cap = io();
    assert.equal(await runCli(["list"], cap.io, deps), 0);
    const text = cap.lines.join("\n");
    assert.ok(text.includes("fs: npx -y @modelcontextprotocol/server-filesystem /tmp/data extra (stdio) -- project (.dsh/mcp.yml)"), "project yml row shown with target: " + text);
    assert.ok(text.includes("ccserver: node shadowed.js") === false, "cc shadowed entry uses yml winner label");
    const fsLines = cap.lines.filter((line) => line.startsWith("  fs:"));
    assert.equal(fsLines.length, 2, "both fs rows listed (winner + shadowed)");
    assert.ok(fsLines.some((line) => line.includes("已被 project (.dsh/mcp.yml) 遮蔽")), "shadow annotation present");
    assert.ok(text.includes("ccuser: https://u/mcp (streamable-http)"), "cc-user row listed with http target");
    assert.ok(text.includes("remote: https://example/mcp (streamable-http)"), "user yml row listed");
    pass("cli list shows all four layers with shadow annotations");
  }

  // 6. get：优先层胜出 + 密钥只出键名 + 遮蔽提示
  {
    const cap = io();
    assert.equal(await runCli(["get", "fs"], cap.io, deps), 0);
    const text = cap.lines.join("\n");
    assert.ok(text.includes("Source:   project (.dsh/mcp.yml)"));
    assert.ok(text.includes("TOKEN=<configured>"), "env value not printed");
    assert.ok(!text.includes("Bearer") && !text.includes("${API_TOKEN}"), "secret values never leak into get output: " + text);
    assert.ok(text.includes("遮蔽"), "shadowed lower-layer row noted");
    const cap2 = io();
    assert.equal(await runCli(["get", "nonexistent"], cap2.io, deps), 1);
    pass("cli get resolves the winning layer without leaking secret values");
  }

  // 7. remove：只动原生 yml；只读层给出指引
  {
    const cap = io();
    assert.equal(await runCli(["remove", "fs"], cap.io, deps), 0);
    const raw = await readFile(projectYml, "utf8");
    assert.ok(!raw.includes("serverName: fs"), "row removed");
    const ccRaw = await readFile(join(project, ".mcp.json"), "utf8");
    assert.ok(ccRaw.includes("ccserver"), ".mcp.json untouched by remove");
    const cap2 = io();
    const code2 = await runCli(["remove", "ccserver"], cap2.io, deps);
    assert.equal(code2, 1);
    assert.ok(cap2.errs.join("\n").includes(".mcp.json"), "read-only layer guidance for cc name");
    const cap3 = io();
    assert.equal(await runCli(["remove", "remote", "--scope", "user"], cap3.io, deps), 0);
    assert.ok(!(await readFile(userYml, "utf8")).includes("serverName: remote"), "user scope remove works");
    pass("cli remove edits only native files and explains read-only layers");
  }

  // 8. --cwd 存储与 help
  {
    const cap = io();
    assert.equal(await runCli(["add", "wsrv", "node", "s.js", "-c", "srv/sub"], cap.io, deps), 0);
    assert.ok((await readFile(projectYml, "utf8")).includes("cwd: srv/sub"), "cwd stored relative to project root");
    const cap2 = io();
    assert.equal(await runCli(["--help"], cap2.io, deps), 0);
    assert.ok(cap2.lines.join("\n").includes("dsh-mcp add <name>"));
    pass("cli stores --cwd relative to project and prints help");
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL CLI TESTS PASSED");
