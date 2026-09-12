import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../lib/cli.js";
import { projectMcpFile } from "../lib/registry.js";
import { writeManagedRows } from "../lib/mcp-file.js";

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
    assert.ok(cap2.errs.join("\n").includes("MCP SSE 端点传输"), "sse error names the MCP SSE endpoint transport");
    assert.ok(cap2.errs.join("\n").includes('把 type 改为 "http"'), "sse error offers the http type fix");
    const capUnknown = io();
    assert.equal(await runCli(["add", "-t", "websocket", "x", "https://e/"], capUnknown.io, deps), 1, "unknown transport rejected");
    assert.ok(capUnknown.errs.join("\n").includes("stdio|http"), "unknown --transport names the accepted set");
    const capAlias = io();
    assert.equal(await runCli(["add", "-t", "streamable-http", "aliashttp", "https://example/mcp"], capAlias.io, deps), 0, capAlias.errs.join("\n"));
    assert.ok((await readFile(projectYml, "utf8")).includes("serverName: aliashttp"), "streamable-http alias writes an http row");
    const cap3 = io();
    assert.equal(await runCli(["add", "y", "node", "--scope", "local"], cap3.io, deps), 1, "local scope guidance");
    assert.ok(cap3.errs.join("\n").includes("local"));
    pass("cli rejects invalid names, unknown transports, and explains local scope");
  }

  // 5. list：三个来源 + 遮蔽标注
  await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "node", args: ["shadowed.js"] }, ccserver: { command: "node", args: [] } } }), "utf8");
  {
    const cap = io();
    assert.equal(await runCli(["list"], cap.io, deps), 0);
    const text = cap.lines.join("\n");
    assert.ok(text.includes("fs: npx -y @modelcontextprotocol/server-filesystem /srv/data extra (stdio) -- project (.dsh/mcp.yml)"), "project yml row shown with target: " + text);
    assert.ok(text.includes("ccserver: node shadowed.js") === false, "cc shadowed entry uses yml winner label");
    const fsLines = cap.lines.filter((line) => line.startsWith("  fs:"));
    assert.equal(fsLines.length, 2, "both fs rows listed (winner + shadowed)");
    assert.ok(fsLines.some((line) => line.includes("已被 project (.dsh/mcp.yml) 遮蔽")), "shadow annotation present");
    assert.ok(text.includes("remote: https://example/mcp (streamable-http)"), "user yml row listed");
    pass("cli list shows every layer with shadow annotations");
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

  // 13. DSH_MCP_IGNORE_MCP_JSON=1：list 失去项目 .mcp.json 层，get 对只存在于
  // 该层的名字指明停用开关；原生 yml 层不受牵连。
  {
    process.env.DSH_MCP_IGNORE_MCP_JSON = "1";
    try {
      const cap = io();
      assert.equal(await runCli(["list"], cap.io, deps), 0);
      const text = cap.lines.join("\n");
      assert.ok(!text.includes("ccserver"), "cc-project rows hidden by the switch");
      assert.ok(text.includes("psrv"), "yml layers untouched");
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
    assert.equal(await runCli(["add", "unity-mcp", "node", "--offline", "u-server.js", "--scope", "user"], cap.io, deps), 0, cap.errs.join("\n"));
    assert.equal(await runCli(["add", "psrv-x", "node", "p.js", "--scope", "user"], cap.io, deps), 0, cap.errs.join("\n"));
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

  // 15. DSH 自有 JSON 层：项目 .dsh/mcp.json、用户 ~/.dsh/mcp.json、profile json
  // 都出现在 list；profile 层按 profile 名打标签，get 能命中。
  {
    await writeFile(join(project, ".dsh", "mcp.json"), JSON.stringify({ mcpServers: { pj: { command: "node", args: ["pj.js"] } } }), "utf8");
    await writeFile(join(home, ".dsh", "mcp.json"), JSON.stringify({ mcpServers: { uj: { command: "node", args: ["uj.js"] } } }), "utf8");
    await mkdir(join(home, ".dsh", "profiles", "web"), { recursive: true });
    await writeFile(join(home, ".dsh", "profiles", "web", "mcp.json"), JSON.stringify({ mcpServers: { prj: { type: "http", url: "https://p/mcp" } } }), "utf8");
    const cap = io();
    assert.equal(await runCli(["list"], cap.io, deps), 0);
    const text = cap.lines.join("\n");
    assert.ok(text.includes("pj: node pj.js (stdio) -- project (.dsh/mcp.json)"), "project json layer listed: " + text);
    assert.ok(text.includes("uj: node uj.js (stdio) -- user (~/.dsh/mcp.json)"), "user json layer listed: " + text);
    assert.ok(text.includes("prj: https://p/mcp (streamable-http) -- profile (web)"), "profile layer labelled by name: " + text);
    const getCap = io();
    assert.equal(await runCli(["get", "prj"], getCap.io, deps), 0);
    assert.ok(getCap.lines.join("\n").includes("Source:   profile (web)"), "get reports the profile layer");
    pass("cli lists DSH json layers and labels profile layers by name");
  }

  // 16. --format / DSH_MCP_CLI_FORMAT / --scope profile：写入目标与 JSON 独占契约
  {
    const jsonPath = join(project, ".dsh", "mcp.json");
    await rm(jsonPath, { force: true });
    const cap = io();
    assert.equal(await runCli(["add", "fj", "node", "f.js", "-e", "TOKEN=${FJ_TOKEN}", "--format", "json"], cap.io, deps), 0, cap.errs.join("\n"));
    const doc = JSON.parse(await readFile(jsonPath, "utf8"));
    assert.deepEqual(doc.mcpServers.fj, { type: "stdio", command: "node", args: ["f.js"], env: { TOKEN: "${FJ_TOKEN}" } }, "json add writes explicit type, keeps ${VAR} literal and omits default cwd");
    assert.ok(!(await readFile(projectYml, "utf8")).includes("serverFJ"), "yml untouched by a json add");

    // 环境变量等价于 --format json；显式 --format 优先。
    process.env.DSH_MCP_CLI_FORMAT = "json";
    try {
      const capEnv = io();
      assert.equal(await runCli(["add", "envj", "node", "e.js"], capEnv.io, deps), 0, capEnv.errs.join("\n"));
      assert.ok(JSON.parse(await readFile(jsonPath, "utf8")).mcpServers.envj !== undefined, "DSH_MCP_CLI_FORMAT=json selects the json file");
      const capFlag = io();
      assert.equal(await runCli(["add", "flagyml", "node", "y.js", "--format", "yml"], capFlag.io, deps), 0, capFlag.errs.join("\n"));
      assert.ok((await readFile(projectYml, "utf8")).includes("serverName: flagyml"), "--format beats the environment variable");
      process.env.DSH_MCP_CLI_FORMAT = "toml";
      const capBad = io();
      assert.equal(await runCli(["add", "bad", "node", "b.js"], capBad.io, deps), 1, "unknown format value is rejected");
      assert.ok(capBad.errs.join("\n").includes("DSH_MCP_CLI_FORMAT"), "error names the variable");
    } finally {
      delete process.env.DSH_MCP_CLI_FORMAT;
    }

    // remove 按优先序找文件：只存在于 json 的行从 json 删除。
    const capRm = io();
    assert.equal(await runCli(["remove", "envj"], capRm.io, deps), 0, capRm.errs.join("\n"));
    assert.equal(JSON.parse(await readFile(jsonPath, "utf8")).mcpServers.envj, undefined, "json row removed from the json file");
    assert.ok(capRm.lines.join("\n").includes(jsonPath), "removal reports the json file");

    // profile 作用域：缺 --profile 报错列出可用 profile；不存在的 profile 报错；yml 格式被拒。
    const capNoProfile = io();
    assert.equal(await runCli(["add", "pp", "node", "p.js", "--scope", "profile"], capNoProfile.io, deps), 1);
    assert.ok(capNoProfile.errs.join("\n").includes("web"), "missing --profile lists available profiles: " + capNoProfile.errs.join("\n"));
    const capBadProfile = io();
    assert.equal(await runCli(["add", "pp", "node", "p.js", "--scope", "profile", "--profile", "nope"], capBadProfile.io, deps), 1);
    assert.ok(capBadProfile.errs.join("\n").includes("不存在"), "unknown profile is rejected");
    const capYmlProfile = io();
    assert.equal(await runCli(["add", "pp", "node", "p.js", "--scope", "profile", "--profile", "web", "--format", "yml"], capYmlProfile.io, deps), 1);
    assert.ok(capYmlProfile.errs.join("\n").includes("只支持 json"), "profile scope rejects yml");
    const capProfile = io();
    assert.equal(await runCli(["add", "pp", "node", "p.js", "--scope", "profile", "--profile", "web"], capProfile.io, deps), 0, capProfile.errs.join("\n"));
    const profileDoc = JSON.parse(await readFile(join(home, ".dsh", "profiles", "web", "mcp.json"), "utf8"));
    assert.deepEqual(profileDoc.mcpServers.pp, { type: "stdio", command: "node", args: ["p.js"] }, "profile row written to profiles/<name>/mcp.json");
    pass("cli --format / DSH_MCP_CLI_FORMAT / --scope profile write to the right file");
  }

  // 20. 行 id 与 config.serverName 不一致（M5/T8）：CLI 判重、get、remove 都必须
  // 用装载器口径（受管行 id 优先），否则 CLI 删不掉装载器实际装载的那条。
  {
    const ymlPath = projectMcpFile(project);
    await rm(ymlPath, { force: true });
    await writeManagedRows(ymlPath, [{
      id: "panel-mcp-byid",
      name: "@deepseek-ai/dsh-mcp-client",
      config: { serverName: "byconfig", transport: "stdio", command: "node", args: ["m.js"], env: {}, cwd: ".", toolCallTimeoutMs: 60000, failOnStartupError: false, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } }
    }], { createIfMissing: true });
    const capGet = io();
    assert.equal(await runCli(["get", "byid"], capGet.io, deps), 0, capGet.errs.join("\n"));
    assert.ok(capGet.lines.join("\n").includes("Name:     byid"), "get resolves the row by its managed id: " + capGet.lines.join("\n"));
    const capDup = io();
    assert.equal(await runCli(["add", "byid", "node", "dup.js"], capDup.io, deps), 1, "duplicate detection uses the loader's name");
    const capRm = io();
    assert.equal(await runCli(["remove", "byid"], capRm.io, deps), 0, capRm.errs.join("\n"));
    assert.ok(!(await readFile(ymlPath, "utf8")).includes("panel-mcp-byid"), "remove deletes the row the loader would mount");
    pass("cli name resolution matches the loader when row id and config.serverName disagree");
  }

  // 19. yml 与 json 同名（H3/M8）：add 提示新行会被遮蔽 + 另一方言还有条目；
  // remove 首个命中即删，但要说清「另一方言的同名行将接管生效」，二次 remove 才清空。
  {
    const ymlPath = projectMcpFile(project);
    const jsonPath = join(project, ".dsh", "mcp.json");
    await rm(ymlPath, { force: true });
    await rm(jsonPath, { force: true });
    const capYml = io();
    assert.equal(await runCli(["add", "twin", "node", "y.js"], capYml.io, deps), 0, capYml.errs.join("\n"));
    const capJson = io();
    assert.equal(await runCli(["add", "twin", "node", "j.js", "--format", "json"], capJson.io, deps), 0, capJson.errs.join("\n"));
    const jsonOut = capJson.lines.join("\n");
    assert.ok(jsonOut.includes("不会装载"), "add warns that the shadowed row will not mount: " + jsonOut);
    assert.ok(jsonOut.includes(ymlPath), "the warning names the shadowing yml layer");
    assert.ok(jsonOut.includes("提示：同作用域"), "add points at the other dialect file: " + jsonOut);

    const capRm1 = io();
    assert.equal(await runCli(["remove", "twin"], capRm1.io, deps), 0, capRm1.errs.join("\n"));
    const rm1 = capRm1.lines.join("\n");
    assert.ok(rm1.includes(ymlPath), "the first remove hits the yml layer");
    assert.ok(rm1.includes("接管生效"), "the first remove announces the json takeover: " + rm1);
    assert.ok(rm1.includes(jsonPath), "the takeover notice names the json file");
    assert.ok(JSON.parse(await readFile(jsonPath, "utf8")).mcpServers.twin !== undefined, "the json row is still there after the first remove");
    const capRm2 = io();
    assert.equal(await runCli(["remove", "twin"], capRm2.io, deps), 0, capRm2.errs.join("\n"));
    assert.equal(JSON.parse(await readFile(jsonPath, "utf8")).mcpServers.twin, undefined, "the second remove clears the json row");
    assert.ok(!capRm2.lines.join("\n").includes("接管生效"), "no takeover notice when nothing is left");
    pass("cli add flags shadowed writes and remove announces cross-dialect takeover");
  }

  // 18. mcpServers 里的非对象坏条目：add/remove 不得顺手删掉它（此前读-改-写
  // 会过滤非对象条目，任何一次写入都让用户手写的 `"legacy": "node x.js"` 永久消失）；
  // 坏条目占的名字要能被判重看见，指名 remove 能清掉。
  {
    const jsonPath = join(project, ".dsh", "mcp.json");
    await writeFile(jsonPath, JSON.stringify({ mcpServers: { legacy: "node x.js", ok: { command: "node", args: ["ok.js"] } } }, null, 2), "utf8");
    const capAdd = io();
    assert.equal(await runCli(["add", "fresh", "node", "f.js", "--format", "json"], capAdd.io, deps), 0, capAdd.errs.join("\n"));
    const doc = JSON.parse(await readFile(jsonPath, "utf8"));
    assert.equal(doc.mcpServers.legacy, "node x.js", "the malformed entry survives an add");
    assert.ok(doc.mcpServers.fresh !== undefined, "the new row is written");
    const capDup = io();
    assert.equal(await runCli(["add", "legacy", "node", "l.js", "--format", "json"], capDup.io, deps), 1, "a name held by a malformed entry is not silently overwritten");
    assert.ok(capDup.errs.join("\n").includes("已存在"), "duplicate detection sees the malformed entry");
    const capRm = io();
    assert.equal(await runCli(["remove", "legacy", "--format", "json"], capRm.io, deps), 0, capRm.errs.join("\n"));
    const after = JSON.parse(await readFile(jsonPath, "utf8"));
    assert.equal(after.mcpServers.legacy, undefined, "remove can clear a malformed entry");
    assert.ok(after.mcpServers.ok !== undefined, "unrelated entries untouched");
    pass("cli add/remove preserve malformed mcpServers entries and can clear them by name");
  }

  // 17. DSH_HOME 重定位：未注入 deps.home 时，用户层与 profile 层路径都跟随 $DSH_HOME；
  // 注入的 deps.home 仍优先于环境变量（否则测试会读到真实用户配置，注入失去隔离意义）。
  {
    const relocated = join(dir, "dsh-home");
    await mkdir(join(relocated, "profiles", "web"), { recursive: true });
    await writeFile(join(relocated, "mcp.json"), JSON.stringify({ mcpServers: { relocated: { command: "node", args: ["r.js"] } } }), "utf8");
    const savedHome = process.env.DSH_HOME;
    process.env.DSH_HOME = relocated;
    try {
      const envDeps = { resolveProjectRoot: async () => project };
      const capAdd = io();
      assert.equal(await runCli(["add", "envhome", "node", "eh.js", "--scope", "user"], capAdd.io, envDeps), 0, capAdd.errs.join("\n"));
      assert.ok(await pathExists(join(relocated, "mcp.yml")), "user scope write follows $DSH_HOME");
      const capList = io();
      assert.equal(await runCli(["list"], capList.io, envDeps), 0, capList.errs.join("\n"));
      const listed = capList.lines.join("\n");
      assert.ok(listed.includes("relocated:"), "user json layer under $DSH_HOME is listed: " + listed);
      // get 未命中时报出实际查过的六层路径（M6）：重定位后的用户层路径必须在列。
      const capMiss = io();
      assert.equal(await runCli(["get", "nosuch"], capMiss.io, envDeps), 1);
      const missText = capMiss.errs.join("\n");
      assert.ok(missText.includes(join(relocated, "mcp.json")), "miss message lists the relocated user json path: " + missText);
      assert.ok(missText.includes(join(relocated, "mcp.yml")), "miss message lists the relocated user yml path");
      const capProfile = io();
      assert.equal(await runCli(["add", "ph", "node", "ph.js", "--scope", "profile", "--profile", "web"], capProfile.io, envDeps), 0, capProfile.errs.join("\n"));
      assert.ok(await pathExists(join(relocated, "profiles", "web", "mcp.json")), "profile scope write follows $DSH_HOME");
      // deps.home 注入优先：同一环境下仍写进注入的 home。
      const capInjected = io();
      assert.equal(await runCli(["add", "injhome", "node", "ih.js", "--scope", "user", "--format", "json"], capInjected.io, deps), 0, capInjected.errs.join("\n"));
      assert.ok(await pathExists(join(home, ".dsh", "mcp.json")), "injected deps.home wins over $DSH_HOME");
      pass("cli follows DSH_HOME for user/profile scopes while deps.home injection still wins");
    } finally {
      if (savedHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = savedHome;
    }
  }

  // 21. status：空态、层行数、诊断摘要中的跳过原因
  {
    const statusDir = await mkdtemp(join(tmpdir(), "dsh-mcp-status-"));
    const statusHome = join(statusDir, "home");
    const statusProj = join(statusDir, "proj");
    await mkdir(join(statusHome, ".dsh"), { recursive: true });
    await mkdir(statusProj, { recursive: true });
    const statusDeps = { home: statusHome, resolveProjectRoot: async () => statusProj };
    try {
      const capEmpty = io();
      assert.equal(await runCli(["status"], capEmpty.io, statusDeps), 0);
      assert.ok(capEmpty.lines.join("\n").includes("尚无运行时诊断"), "empty status: " + capEmpty.lines.join("\n"));
      assert.equal(await runCli(["add", "fs", "node", "s.js"], io().io, statusDeps), 0);
      const capRows = io();
      assert.equal(await runCli(["status"], capRows.io, statusDeps), 0);
      const listed = capRows.lines.join("\n");
      assert.ok(listed.includes("fs"), "status lists configured names: " + listed);
      await mkdir(join(statusProj, ".dsh"), { recursive: true });
      await writeFile(join(statusProj, ".dsh", ".mcp-diag.json"), JSON.stringify({
        summary: {
          at: "2026-01-01T00:00:00.000Z",
          rows: 1,
          mounted: 0,
          skippedByReason: { "env-missing": 1 },
          unhealthy: [{ name: "fs", reason: "env-missing" }, { name: "dead", reason: "give-up" }],
          toolBudget: [{ name: "heavy", tools: 240, bytes: 300000 }]
        },
        events: []
      }), "utf8");
      const capDiag = io();
      assert.equal(await runCli(["status"], capDiag.io, statusDeps), 0);
      const text = capDiag.lines.join("\n");
      assert.ok(text.includes("env-missing"), "status surfaces skip reason: " + text);
      assert.ok(text.includes("不健康：fs"), "status names the unhealthy row: " + text);
      assert.ok(text.includes("不健康：dead (give-up)"), "status names give-up rows: " + text);
      assert.ok(text.includes("工具预算：heavy 240 个工具"), "status surfaces tool budget: " + text);
      pass("cli status shows empty state, layer rows, and diagnostic skip reasons");
    } finally {
      await rm(statusDir, { recursive: true, force: true });
    }
  }

  // 22. import：mcpServers 文件/stdin、dry-run 不写盘、同名 skip/overwrite、坏条目、--scope user
  {
    const importDir = await mkdtemp(join(tmpdir(), "dsh-mcp-import-"));
    const importHome = join(importDir, "home");
    const importProj = join(importDir, "proj");
    await mkdir(join(importHome, ".dsh"), { recursive: true });
    await mkdir(importProj, { recursive: true });
    const importDeps = { home: importHome, resolveProjectRoot: async () => importProj };
    const srcFile = join(importDir, "mcpServers.json");
    await writeFile(srcFile, JSON.stringify({
      mcpServers: {
        alpha: { command: "node", args: ["a.js"] },
        beta: { command: "node", args: ["b.js"] },
        bad: { type: "sse", url: "https://example/" }
      }
    }), "utf8");
    try {
      const capMiss = io();
      assert.equal(await runCli(["import"], capMiss.io, importDeps), 1);
      assert.ok(capMiss.errs.join("\n").includes("--from"), capMiss.errs.join("\n"));
      const capMissingFile = io();
      assert.equal(await runCli(["import", "--from", join(importDir, "nope-missing.json")], capMissingFile.io, importDeps), 1);
      const vscodeFile = join(importDir, "vscode.json");
      await writeFile(vscodeFile, JSON.stringify({ servers: { vs: { command: "node", args: ["v.js"] } } }), "utf8");
      const capVs = io();
      assert.equal(await runCli(["import", "--from", vscodeFile], capVs.io, importDeps), 1);
      assert.ok(capVs.errs.join("\n").includes("servers"), "vscode dialect: " + capVs.errs.join("\n"));
      const capDry = io();
      assert.equal(await runCli(["import", "--from", srcFile, "--dry-run"], capDry.io, importDeps), 1, capDry.errs.join("\n"));
      assert.ok(capDry.lines.join("\n").includes("将添加"), "dry-run lists adds: " + capDry.lines.join("\n"));
      assert.ok(capDry.errs.join("\n").includes("bad"), "dry-run reports bad entries: " + capDry.errs.join("\n"));
      assert.equal(await pathExists(join(importProj, ".dsh", "mcp.yml")), false, "dry-run must not create the target file");
      const capImp = io();
      assert.equal(await runCli(["import", "--from", srcFile], capImp.io, importDeps), 1, capImp.errs.join("\n"));
      assert.ok(capImp.lines.join("\n").includes("alpha"), capImp.lines.join("\n"));
      assert.ok(await pathExists(join(importProj, ".dsh", "mcp.yml")), "import writes project yml");
      const capSkip = io();
      assert.equal(await runCli(["import", "--from", srcFile], capSkip.io, importDeps), 1);
      assert.ok(capSkip.lines.join("\n").includes("跳过"), "same-name skip: " + capSkip.lines.join("\n"));
      const srcOw = join(importDir, "overwrite.json");
      await writeFile(srcOw, JSON.stringify({ mcpServers: { alpha: { command: "node", args: ["a2.js"] } } }), "utf8");
      const capOw = io();
      assert.equal(await runCli(["import", "--from", srcOw, "--overwrite"], capOw.io, importDeps), 0, capOw.errs.join("\n"));
      assert.ok(capOw.lines.join("\n").includes("已覆盖"), capOw.lines.join("\n"));
      const getAlpha = io();
      assert.equal(await runCli(["get", "alpha"], getAlpha.io, importDeps), 0);
      assert.ok(getAlpha.lines.join("\n").includes("a2.js"), "overwrite replaced the command: " + getAlpha.lines.join("\n"));
      const capStdin = io();
      assert.equal(await runCli(["import", "--from", "-", "--scope", "user"], capStdin.io, {
        ...importDeps,
        readStdin: async () => JSON.stringify({ mcpServers: { fromstdin: { command: "node", args: ["s.js"] } } })
      }), 0, capStdin.errs.join("\n"));
      assert.ok(await pathExists(join(importHome, ".dsh", "mcp.yml")), "stdin import writes user yml");
      const getUser = io();
      assert.equal(await runCli(["get", "fromstdin"], getUser.io, importDeps), 0);
      const srcShadow = join(importDir, "shadow.json");
      await writeFile(srcShadow, JSON.stringify({ mcpServers: { alpha: { command: "node", args: ["other.js"] } } }), "utf8");
      const capShadow = io();
      assert.equal(await runCli(["import", "--from", srcShadow, "--scope", "user", "--dry-run"], capShadow.io, importDeps), 0);
      assert.ok(capShadow.lines.join("\n").includes("不会装载"), "dry-run previews shadow: " + capShadow.lines.join("\n"));
      const srcRaceA = join(importDir, "race-a.json");
      const srcRaceB = join(importDir, "race-b.json");
      await writeFile(srcRaceA, JSON.stringify({ mcpServers: { race: { command: "node", args: ["ra.js"] } } }), "utf8");
      await writeFile(srcRaceB, JSON.stringify({ mcpServers: { race: { command: "node", args: ["rb.js"] } } }), "utf8");
      const capRaceA = io();
      const capRaceB = io();
      await Promise.all([
        runCli(["import", "--from", srcRaceA], capRaceA.io, importDeps),
        runCli(["import", "--from", srcRaceB], capRaceB.io, importDeps)
      ]);
      const raceYml = await readFile(projectMcpFile(importProj), "utf8");
      const hasRa = raceYml.includes("ra.js");
      const hasRb = raceYml.includes("rb.js");
      assert.equal(hasRa !== hasRb, true, "concurrent import without overwrite keeps exactly one winner: " + raceYml);
      const raceOut = capRaceA.lines.join("\n") + "\n" + capRaceB.lines.join("\n");
      assert.ok(raceOut.includes("已添加") && raceOut.includes("跳过"), "loser skips inside the lock: " + raceOut);
      pass("cli import reads mcpServers, dry-runs, skips/overwrites, and writes user scope");
    } finally {
      await rm(importDir, { recursive: true, force: true });
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL CLI TESTS PASSED");
