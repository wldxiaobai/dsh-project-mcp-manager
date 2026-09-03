import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
    const code = await runCli(["add", "fs", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/srv/data", "-e", "TOKEN=${API_TOKEN}", "--", "extra"], cap.io, deps);
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
    assert.equal(await runCli(["add", "-t", "sse", "x", "https://e/"], cap2.io, deps), 1, "sse rejected");
    assert.ok(cap2.errs.join("\n").includes("sse"));
    const cap3 = io();
    assert.equal(await runCli(["add", "y", "node", "--scope", "local"], cap3.io, deps), 1, "local scope guidance");
    assert.ok(cap3.errs.join("\n").includes("local"));
    pass("cli rejects invalid names, sse transport, and explains local scope");
  }

  // 共存边界基线：cc-user 默认关闭，场景 5+ 的四层视图需要显式 opt-in
  //（场景 10/12 各自临时切换开关验证两态）。
  process.env.DSH_MCP_READ_CLAUDE_USER = "1";
  // 5. list：四个来源 + 遮蔽标注
  await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "node", args: ["shadowed.js"] }, ccserver: { command: "node", args: [] } } }), "utf8");
  await writeFile(join(home, ".claude.json"), JSON.stringify({ oauth: {}, mcpServers: { ccuser: { type: "http", url: "https://u/mcp" } } }), "utf8");
  {
    const cap = io();
    assert.equal(await runCli(["list"], cap.io, deps), 0);
    const text = cap.lines.join("\n");
    assert.ok(text.includes("fs: npx -y @modelcontextprotocol/server-filesystem /srv/data extra (stdio) -- project (.dsh/mcp.yml)"), "project yml row shown with target: " + text);
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

  // 9. 缺省 cwd 按 scope 分化：project="."，user=""（继承宿主 cwd，对齐 CC user 行）
  {
    const cap = io();
    assert.equal(await runCli(["add", "usrv", "node", "u.js", "--scope", "user"], cap.io, deps), 0, cap.errs.join("\n"));
    const userRaw = await readFile(userYml, "utf8");
    assert.match(userRaw, /cwd:\s*(""|'')/, "user-scope row stores empty cwd");
    const cap2 = io();
    assert.equal(await runCli(["add", "psrv", "node", "p.js"], cap2.io, deps), 0, cap2.errs.join("\n"));
    const projRaw = await readFile(projectYml, "utf8");
    assert.match(projRaw, /cwd: \.?$/m, "project-scope row defaults to .");
    assert.ok(projRaw.includes("cwd: ."), "project-scope cwd is the dot literal");
    pass("cli default cwd is '.' for project scope and '' for user scope");
  }
  // 10. DSH_MCP_IGNORE_CLAUDE_JSON=1：list 整个 cc-user 层消失（与 registry 同源开关）
  {
    process.env.DSH_MCP_IGNORE_CLAUDE_JSON = "1";
    try {
      const cap = io();
      assert.equal(await runCli(["list"], cap.io, deps), 0);
      const text = cap.lines.join("\n");
      assert.ok(!text.includes("ccuser"), "ignored: cc-user rows must not be listed");
      assert.ok(!text.includes(".claude.json"), "ignored: no cc-user layer label at all");
      assert.ok(text.includes("psrv"), "ignored: other three layers still listed");
    } finally {
      delete process.env.DSH_MCP_IGNORE_CLAUDE_JSON;
    }
    const cap2 = io();
    assert.equal(await runCli(["list"], cap2.io, deps), 0);
    assert.ok(cap2.lines.join("\n").includes("ccuser"), "switch unset: cc-user layer is back");
    pass("cli list honors DSH_MCP_IGNORE_CLAUDE_JSON");
  }

  // 11. 未注入 resolveProjectRoot 时走真实 findProjectRoot：git 根向上命中 / 无 git 根退回 cwd
  {
    const originalCwd = process.cwd();
    const nogit = join(dir, "nogit");
    const gitroot = join(dir, "gitroot");
    await mkdir(nogit, { recursive: true });
    await mkdir(join(gitroot, ".git"), { recursive: true });
    await mkdir(join(gitroot, "sub"), { recursive: true });
    try {
      process.chdir(nogit);
      const cap = io();
      assert.equal(await runCli(["add", "fb", "node", "f.js"], cap.io, { home }), 0, cap.errs.join("\n"));
      const fbRaw = await readFile(projectMcpFile(nogit), "utf8");
      assert.ok(fbRaw.includes("serverName: fb"), "no git root above → project file lands in cwd");
      process.chdir(join(gitroot, "sub"));
      const cap2 = io();
      assert.equal(await runCli(["add", "up", "node", "u.js"], cap2.io, { home }), 0, cap2.errs.join("\n"));
      const upRaw = await readFile(projectMcpFile(gitroot), "utf8");
      assert.ok(upRaw.includes("serverName: up"), "walks up to the nearest .git ancestor");
      assert.equal(await pathExists(projectMcpFile(join(gitroot, "sub"))), false, "cwd itself is not the project when a git root exists above");
    } finally {
      process.chdir(originalCwd);
    }
    pass("cli resolves project root through real findProjectRoot (git hit and cwd fallback)");
  }

  // 12. cc-user 默认关闭：不设 DSH_MCP_READ_CLAUDE_USER 时 list 无 ~/.claude.json 层，
  // get 未命中时解释被停用的层；opt-in 恢复并给出扇出提示。
  {
    delete process.env.DSH_MCP_READ_CLAUDE_USER;
    try {
      const cap = io();
      assert.equal(await runCli(["list"], cap.io, deps), 0);
      const text = cap.lines.join("\n");
      assert.ok(!text.includes("ccuser"), "cc-user rows hidden by default");
      assert.ok(!text.includes(".claude.json"), "no cc-user layer label by default");
      assert.ok(text.includes("psrv"), "the remaining layers still listed");
      const cap2 = io();
      assert.equal(await runCli(["get", "ccuser"], cap2.io, deps), 1);
      assert.ok(cap2.errs.join("\n").includes("DSH_MCP_READ_CLAUDE_USER"), "not-found message explains the disabled layer");
    } finally {
      process.env.DSH_MCP_READ_CLAUDE_USER = "1";
    }
    const cap3 = io();
    assert.equal(await runCli(["list"], cap3.io, deps), 0);
    const text3 = cap3.lines.join("\n");
    assert.ok(text3.includes("ccuser"), "opt-in brings the layer back");
    assert.ok(text3.includes("提示：cc-user 层已启用"), "reminder printed while the layer is on");
    pass("cli hides cc-user by default, explains it on miss, and reminds when enabled");
  }

  // 13. DSH_MCP_IGNORE_MCP_JSON=1：list 失去项目 .mcp.json 层，get 对只存在于
  // 该层的名字指明停用开关；cc-user 层不受牵连。
  {
    process.env.DSH_MCP_IGNORE_MCP_JSON = "1";
    try {
      const cap = io();
      assert.equal(await runCli(["list"], cap.io, deps), 0);
      const text = cap.lines.join("\n");
      assert.ok(!text.includes("ccserver"), "cc-project rows hidden by the switch");
      assert.ok(text.includes("psrv"), "yml layers untouched");
      assert.ok(text.includes("ccuser"), "cc-user layer not implicated");
      const cap2 = io();
      assert.equal(await runCli(["get", "ccserver"], cap2.io, deps), 1);
      assert.ok(cap2.errs.join("\n").includes("DSH_MCP_IGNORE_MCP_JSON"), "not-found names the stopped layer");
    } finally {
      delete process.env.DSH_MCP_IGNORE_MCP_JSON;
    }
    const cap3 = io();
    assert.equal(await runCli(["list"], cap3.io, deps), 0);
    assert.ok(cap3.lines.join("\n").includes("ccserver"), "the layer returns once the switch is cleared");
    pass("DSH_MCP_IGNORE_MCP_JSON hides the project .mcp.json layer from the CLI");
  }

  // 14. list/get 与装载器同口径：归一名（unityMCP=unity-mcp）与身份键（command+args）
  // 去重剔除的行必须标注「同一服务，去重不装载」，生效行不加注——修复前 CLI 只按
  // 精确同名判遮蔽，这类行被展示成正常加载，与注册表行为对不上号。
  {
    const cap = io();
    assert.equal(await runCli(["add", "unityMCP", "node", "u-server.js"], cap.io, deps), 0, cap.errs.join("\n"));
    const claudePath = join(home, ".claude.json");
    const cu = JSON.parse(await readFile(claudePath, "utf8"));
    cu.mcpServers["unity-mcp"] = { command: "node", args: ["--offline", "u-server.js"] };
    cu.mcpServers["psrv-x"] = { command: "node", args: ["p.js"] };
    await writeFile(claudePath, JSON.stringify(cu), "utf8");
    const listCap = io();
    assert.equal(await runCli(["list"], listCap.io, deps), 0);
    const lines = listCap.lines;
    const lineOf = (name) => lines.find((l) => l.trim().startsWith(name + ":"));
    const unityLine = lineOf("unity-mcp");
    assert.ok(unityLine !== undefined && unityLine.includes('与 "unityMCP" 同一服务') && unityLine.includes("归一化名称"), "normname loss marked: " + unityLine);
    const psrvxLine = lineOf("psrv-x");
    assert.ok(psrvxLine !== undefined && psrvxLine.includes('与 "psrv" 同一服务') && psrvxLine.includes("命令与参数"), "identity loss marked: " + psrvxLine);
    const unityWin = lineOf("unityMCP");
    assert.ok(unityWin !== undefined && !unityWin.includes("遮蔽") && !unityWin.includes("去重"), "the yml winner stays a plain source row: " + unityWin);
    const getCap = io();
    assert.equal(await runCli(["get", "unity-mcp"], getCap.io, deps), 0);
    assert.ok(getCap.lines.join("\n").includes("该行未实际装载"), "get annotates the deduped loser");
    const getWin = io();
    assert.equal(await runCli(["get", "unityMCP"], getWin.io, deps), 0);
    assert.ok(!getWin.lines.join("\n").includes("未实际装载"), "the effective winner gets no annotation");
    pass("cli list/get mark cross-layer same-service dedup with the registry's merge");
  }
} finally {
  delete process.env.DSH_MCP_READ_CLAUDE_USER;
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL CLI TESTS PASSED");
