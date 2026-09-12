import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectMcpRegistry, parseDiagDocument, projectMcpFile, mergeSourcedRows, profileNameFromConfigPath } from "../lib/registry.js";
import { MCP_BLOCK_BEGIN, MCP_BLOCK_END, writeManagedRows } from "../lib/mcp-file.js";
import { byCodeUnit } from "../lib/model.js";

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}

const diagFile = (projectRoot) => join(projectRoot, ".dsh", ".mcp-diag.json");
async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function readDiag(projectRoot) {
  return parseDiagDocument(JSON.parse(await readFile(diagFile(projectRoot), "utf8"))).events;
}
async function readDiagSummary(projectRoot) {
  return parseDiagDocument(JSON.parse(await readFile(diagFile(projectRoot), "utf8"))).summary;
}
/** 轮询 diag 直到谓词成立：事件驱动用例里对账链可能仍在落盘（不能用固定 sleep）。 */
async function waitForDiag(projectRoot, predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (predicate(await readDiag(projectRoot))) return true;
    } catch {
      // diag 尚不存在或正被半读到截断 JSON：视为「暂不满足」，继续轮询。
      // （writeDiag 用非原子的 writeFile，轮询方必须自己扛住中间态。）
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  return false;
}
/** Windows 上 chokidar 关闭后目录句柄可能仍短暂占用：rm 带退避重试。 */
async function rmRetry(path) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  await rm(path, { recursive: true, force: true });
}

const stdioRow = (name, command = "node") => ({
  id: "panel-mcp-" + name,
  name: "@deepseek-ai/dsh-mcp-client",
  config: { serverName: name, transport: "stdio", command, args: ["srv-" + name + ".js"], env: {}, cwd: "sub", toolCallTimeoutMs: 60000, failOnStartupError: false, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } }
});

/** 最小假宿主 ctx：记录 plugin 装载与 restrict 调用；effect 收集清理器。 */
function fakeCtx() {
  const mounts = [];
  const disposals = [];
  const restrictions = [];
  const agents = [];
  const disposers = [];
  const schemas = []; // 全局工具注册表（测试按需 push 工具名）
  const ctx = {
    mounts,
    disposals,
    restrictions,
    agentsList: agents,
    disposers,
    schemas,
    on() {},
    effect(callback) {
      if (typeof callback === "function") disposers.push(callback);
    },
    logger: { warn() {}, error() {}, info() {} },
    tools: {
      schemas: () => schemas
    },
    plugin(_plugin, config) {
      let resolved = false;
      const fiber = {
        config,
        dispose: async () => {
          disposals.push(config.serverName);
        },
        then(onFulfilled) {
          if (!resolved) {
            resolved = true;
            queueMicrotask(() => onFulfilled?.());
          }
          return Promise.resolve();
        }
      };
      mounts.push(config);
      return fiber;
    },
    get agents() {
      return {
        list: () => agents,
        isOwnedBy: () => false
      };
    }
  };
  return ctx;
}

function fakeAgent(id, cwd) {
  const denies = [];
  return {
    id,
    session: { header: { cwd } },
    ctx: {
      tools: {
        restrict({ deny }) {
          const denyNames = [...deny];
          denyNames.sort(byCodeUnit);
          denies.push(denyNames);
          return () => {};
        }
      }
    },
    denies
  };
}

const dir = await mkdtemp(join(tmpdir(), "dsh-project-mcp-manager-registry-"));

// ── profile 名解析（纯函数，宿主内部路径形态）──────────────────────────────
{
  // 无关路径用例只要求「解析不出 profile」，用中性的虚构挂载点，避免踩
  // 公共可写目录（/tmp 等）的安全规则——这里根本不碰文件系统。
  const profilePathCases = [
    { config: "file:///C:/Users/x/.dsh/profiles/web/cordis.yml", expected: "web", note: "file URL config path" },
    { config: String.raw`C:\Users\x\.dsh\profiles\headless\cordis.snapshot.yml`, expected: "headless", note: "windows path + replay basename" },
    { config: "file:///home/u/.dsh/profiles/tui/", expected: "tui", note: "baseUrl directory form" },
    { config: "/srv/apps/cordis.yml", expected: undefined, note: "unrelated path yields no profile" },
    { config: undefined, expected: undefined, note: "missing config path" }
  ];
  for (const testCase of profilePathCases) {
    assert.equal(profileNameFromConfigPath(testCase.config), testCase.expected, testCase.note);
  }
  pass("profileNameFromConfigPath resolves the running profile from host-internal paths");
}

// ── 0. mergeSourcedRows 跨来源同服务去重（纯函数）──────────────────────────
{
  const srow = (rawName, source, config, disabled = false) => ({
    rawName,
    source,
    ...(disabled ? { disabled: true } : {}),
    row: { id: "panel-mcp-" + rawName, name: "@deepseek-ai/dsh-mcp-client", ...(disabled ? { disabled: true } : {}), ...(config === undefined ? {} : { config }) }
  });
  const stdioCfg = (serverName, command, args) => ({ serverName, transport: "stdio", command, args, env: {}, cwd: "" });
  const httpCfg = (serverName, url) => ({ serverName, transport: "streamable-http", url, headers: {} });

  // 0.1 事故对：同名服务两种写法（args 差 --offline）→ 归一名键命中，高层胜出
  {
    const m = mergeSourcedRows([
      [srow("unityMCP", "dsh-project", stdioCfg("unityMCP", String.raw`C:\uvx.exe`, ["--from", "mcpforunityserver==10.1.0", "mcp-for-unity", "--transport", "stdio"]))],
      [],
      [],
      [srow("unity-mcp", "dsh-user", stdioCfg("unity-mcp", String.raw`C:\uvx.exe`, ["--offline", "--from", "mcpforunityserver==10.1.0", "mcp-for-unity", "--transport", "stdio"]))]
    ]);
    assert.deepEqual(m.rows.map((r) => r.rawName), ["unityMCP"], "normname dup drops the low-priority twin");
    assert.deepEqual(m.shadowedIdentity, [{ name: "unity-mcp", winner: "unityMCP", reason: "normname", source: "dsh-user", winnerSource: "dsh-project" }], "identity shadow reports the incident pair with both layers");
    assert.deepEqual(m.shadowedUser, ["unity-mcp"], "the dropped user-layer row also counts as project-shadowed user row");
  }
  // 0.2 完全相同的 command+args（名字归一后不同）→ 身份键命中
  {
    const m = mergeSourcedRows([
      [srow("pencilA", "dsh-project", stdioCfg("pencilA", String.raw`C:\pencil\mcp-server.exe`, ["--agent", "cli"]))],
      [],
      [srow("pencil-user", "dsh-user-yml", stdioCfg("pencil-user", String.raw`C:\pencil\mcp-server.exe`, ["--agent", "cli"]))]
    ]);
    assert.deepEqual(m.rows.map((r) => r.rawName), ["pencilA"], "identity dup keeps the yml row");
    assert.deepEqual(m.shadowedIdentity, [{ name: "pencil-user", winner: "pencilA", reason: "identity", source: "dsh-user-yml", winnerSource: "dsh-project" }]);
  }
  // 0.3 同 command 不同 args 是不同服务：node a.js 与 node b.js 不许互杀
  {
    const m = mergeSourcedRows([
      [srow("aa", "dsh-project", stdioCfg("aa", "node", ["a.js"])), srow("bb", "dsh-project", stdioCfg("bb", "node", ["b.js"]))]
    ]);
    assert.equal(m.rows.length, 2, "same command, different args are different services");
    assert.equal(m.shadowedIdentity.length, 0);
  }
  // 0.4 http 用 url 做身份键
  {
    const m = mergeSourcedRows([
      [srow("remote", "dsh-project", httpCfg("remote", "https://mcp.example/api"))],
      [],
      [],
      [srow("remote2", "dsh-user", httpCfg("remote2", "https://mcp.example/api"))]
    ]);
    assert.deepEqual(m.rows.map((r) => r.rawName), ["remote"]);
    assert.deepEqual(m.shadowedIdentity, [{ name: "remote2", winner: "remote", reason: "identity", source: "dsh-user", winnerSource: "dsh-project" }]);
  }
  // 0.5 disabled 占名行注册归一名键：给用户层行提供占名退出手段
  {
    const m = mergeSourcedRows([
      [srow("gamma", "dsh-project", undefined, true)],
      [],
      [],
      [srow("Gamma", "dsh-user", stdioCfg("Gamma", "node", ["g.js"]))]
    ]);
    assert.equal(m.rows.length, 0, "disabled placeholder mounts nothing and its normname twin stays shadowed");
    assert.deepEqual(m.shadowedIdentity, [{ name: "Gamma", winner: "gamma", reason: "normname", source: "dsh-user", winnerSource: "dsh-project" }]);
  }
  // 0.6 空 command 的行不注册身份键（两行都无 config 时不得互杀）
  {
    const m = mergeSourcedRows([
      [],
      [],
      [srow("uc-a", "dsh-user-yml", stdioCfg("uc-a", "", []))],
      [srow("uc-b", "dsh-user", stdioCfg("uc-b", "", []))]
    ]);
    assert.equal(m.rows.length, 2, "rows without a command never claim the identity key");
    assert.equal(m.shadowedIdentity.length, 0);
  }
  // 0.7 精确同名遮蔽仍先到先得，且不重复记入 shadowedIdentity
  {
    const m = mergeSourcedRows([
      [srow("dup", "dsh-project", stdioCfg("dup", "node", ["x.js"]))],
      [srow("dup", "cc-project", stdioCfg("dup", "node", ["other.js"]))]
    ]);
    assert.deepEqual(m.shadowedOwnCc, ["dup"]);
    assert.equal(m.shadowedIdentity.length, 0, "exact-name shadow is not an identity shadow");
  }
  pass("mergeSourcedRows dedups same service across layers by normalized name and identity, disabled rows hold the name");
}

const originalCwd = process.cwd();
try {
  process.chdir(dir); // 进程 cwd 兜底指向 temp 目录，避免污染断言
  const projectA = join(dir, "projA");
  const projectB = join(dir, "projB");
  const fileA = projectMcpFile(projectA);
  await writeManagedRows(fileA, [stdioRow("gitlab")], { createIfMissing: true });
  // 项目 B：有 .dsh 目录（如放了 skills）但没有 mcp.yml —— 纯"零配置项目"场景。
  await mkdir(join(projectB, ".dsh"), { recursive: true });

  const ctx = fakeCtx();
  const registry = new ProjectMcpRegistry(ctx, {
    globalNames: async () => ["gitlab"], // 全局已占用 gitlab → 项目行必须改名
    // 用户层注入到不存在的目录：真实 home 的 ~/.dsh/mcp.yml 不得进入本套断言。
    userLayerPaths: { mcpYml: join(dir, "nohome", ".dsh", "mcp.yml"), mcpJson: join(dir, "nohome", ".dsh", "mcp.json"), profilesDir: join(dir, "nohome", ".dsh", "profiles") }
  });
  const agentA = fakeAgent("session-a", projectA);
  const agentB = fakeAgent("session-b", projectB);
  ctx.agentsList.push(agentA, agentB);

  await registry.reconcileNow();

  // 1. 项目行装载：生效名与全局冲突 → p<hex>_gitlab
  assert.equal(ctx.mounts.length, 1, "exactly one project server mounted");
  const mounted = ctx.mounts[0];
  assert.notEqual(mounted.serverName, "gitlab");
  assert.match(mounted.serverName, /^p[0-9a-f]{6}_gitlab$/);
  assert.equal(mounted.command, "node");
  assert.equal(mounted.cwd, join(projectA, "sub"), "relative cwd resolved against project root");
  pass("registry mounts project rows with namespaced effective names");

  // 2. 会话可见性：session-a 只见自己项目（从不 deny 自己的服务器）；session-b deny 全部。
  //    deny 集 = 工具名展开（mcp__<server>__*），不是 serverName。
  ctx.schemas.push({ id: "mcp__" + mounted.serverName + "__echo" });
  await registry.reconcileNow();
  assert.equal(agentA.denies.length, 0, "session in the owning project is never restricted");
  assert.deepEqual(agentB.denies[agentB.denies.length - 1], ["mcp__" + mounted.serverName + "__echo"]);
  pass("registry denies other projects' servers per session and keeps the session's own");

  // 3. 快照：项目分区含一行，scope 标注工作区
  const snapshot = await registry.snapshot();
  const projAFile = snapshot.find((file) => file.project === projectA);
  assert.ok(projAFile !== undefined, "snapshot contains project A partition");
  assert.equal(projAFile.ok, true);
  assert.equal(projAFile.servers.length, 1);
  assert.equal(projAFile.servers[0].serverName, "gitlab");
  assert.equal(projAFile.servers[0].scope.kind, "workspace");
  assert.equal(projAFile.servers[0].effectiveServerName, mounted.serverName);
  assert.equal(projAFile.servers[0].fiberPhase, "active");
  const summaryA = await readDiagSummary(projectA);
  assert.ok(summaryA !== undefined, "configured project diag includes a summary");
  assert.ok(summaryA.rows >= 1, "summary counts project rows");
  assert.ok(summaryA.mounted >= 1, "summary counts mounted servers");
  assert.equal(await pathExists(diagFile(projectB)), false, "zero-config project still has no diag after summary writes");
  pass("registry snapshot reports project file rows with workspace scope and phase");

  // 4. 移除行 → 卸载（fiber dispose）
  await writeManagedRows(fileA, []);
  await registry.reconcileNow();
  assert.deepEqual(ctx.disposals, [mounted.serverName]);
  const snapshot2 = await registry.snapshot();
  const projAFile2 = snapshot2.find((file) => file.project === projectA);
  assert.ok(projAFile2 !== undefined);
  assert.equal(projAFile2.servers.length, 0);
  pass("registry unmounts servers whose rows were removed");

  // 5. waitForState：行不存在时立即返回 true（卸载已确认）
  const waited = await registry.waitForState(projectA, "gitlab", (state) => state === undefined, 1000);
  assert.equal(waited, true);
  pass("registry waitForState confirms unmounted state");

  // 6. 诊断落盘：零配置项目（有 .dsh 目录但无 mcp.yml）不写诊断、不算已知项目；
  //    已配置项目的扫描/装载仍留痕。修复前：第二轮 reconcile 起每轮都往
  //    <projectB>/.dsh/.mcp-diag.json 追加一条误报的 ENOENT "error"。
  await registry.reconcileNow();
  await registry.reconcileNow();
  assert.equal(await pathExists(diagFile(projectB)), false, "clean project without mcp.yml must not get a diag file");
  assert.equal((await registry.snapshot()).find((file) => file.project === projectB), undefined, "project without config is not a known project");
  const diagA = await readDiag(projectA);
  assert.ok(diagA.some((row) => row.kind === "scan" && row.ok === true && row.rows.includes("gitlab")), "configured project still logs its scans");
  assert.equal(diagA.some((row) => row.ok === false), false, "no spurious scan error recorded for a project that only emptied its rows");
  pass("registry writes no diagnostics for a clean project without mcp.yml");

  // 7. 真异常仍要留痕：装载存续期间 mcp.yml 被删除 → scan 记 ok:false + ENOENT 并卸载
  const projectC = join(dir, "projC");
  await writeManagedRows(projectMcpFile(projectC), [stdioRow("echo-c")], { createIfMissing: true });
  // 项目由会话 cwd / 进程 cwd 发现，新目录必须先有会话指向它
  const agentC = fakeAgent("session-c", projectC);
  ctx.agentsList.push(agentC);
  await registry.reconcileNow();
  assert.ok(ctx.mounts.some((config) => config.serverName === "echo-c"), "project C server mounted");
  assert.equal(await pathExists(diagFile(projectC)), true, "configured project gets a diag file");
  await rm(projectMcpFile(projectC), { force: true });
  await registry.reconcileNow();
  const vanished = (await readDiag(projectC)).findLast((row) => row.kind === "scan");
  assert.equal(vanished.ok, false, "losing mcp.yml under a live mount is reported as an error");
  assert.match(String(vanished.error), /ENOENT/);
  assert.ok(ctx.disposals.includes("echo-c"), "server unmounted after its config file vanished");
  pass("registry records a real scan error when the config file disappears under a live mount");

  // 8. 原生 `!!js` 标签（官方 README 的 env 示例写法）在项目文件里必须显式
  //    拒绝：先正常装载一行，再把块改成含 !!js —— 重对账应卸载该行、diag 留
  //    痕，快照把该文件标 ok:false（带 !!js 错误）而不是整体炸掉。
  const projectD = join(dir, "projD");
  await writeManagedRows(projectMcpFile(projectD), [stdioRow("echo-d")], { createIfMissing: true });
  const agentD = fakeAgent("session-d", projectD);
  ctx.agentsList.push(agentD);
  await registry.reconcileNow();
  assert.ok(ctx.mounts.some((config) => config.serverName === "echo-d"), "project D baseline row mounted");
  await writeFile(projectMcpFile(projectD), [
    MCP_BLOCK_BEGIN,
    "- insert:",
    "    - id: panel-mcp-echo-d",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: echo-d",
    "        transport: stdio",
    "        command: node",
    "        env:",
    "          TOKEN: !!js process.env.MCP_TOKEN",
    MCP_BLOCK_END,
    ""
  ].join("\n"), "utf8");
  await registry.reconcileNow();
  assert.ok(ctx.disposals.includes("echo-d"), "row unmounted when its file became unparseable");
  assert.equal(ctx.mounts.filter((config) => config.serverName === "echo-d").length, 1, "!!js file must not re-mount");
  const snapD = (await registry.snapshot()).find((entryFile) => entryFile.project === projectD);
  assert.ok(snapD !== undefined && snapD.ok === false, "snapshot marks the bad file instead of throwing");
  assert.match(String(snapD.error), /!!js/);
  assert.equal(snapD.servers.length, 0);
  const diagD = await readDiag(projectD);
  assert.ok(diagD.some((row) => row.kind === "scan" && row.ok === false && String(row.error).includes("!!js")), "diag records the rejection");
  pass("registry rejects native !!js tags in project files with an explicit error");

  // 9. 清理：effect 收集的 disposer 关闭 watcher、不重复 dispose 已卸载的 fiber
  const disposedBeforeCleanup = [...ctx.disposals];
  assert.deepEqual(disposedBeforeCleanup, [mounted.serverName, "echo-c", "echo-d"], "all mounted servers were disposed by their own unmount paths");
  for (const disposer of ctx.disposers) {
    const cleanup = disposer();
    if (typeof cleanup === "function") cleanup();
  }
  assert.deepEqual(ctx.disposals, disposedBeforeCleanup, "cleanup does not re-dispose already-unmounted fibers");
  pass("registry cleanup disposes watcher and mounted fibers");

  // ── 10+. 遗留 CC 项目层：.mcp.json / 影子优先 / ${VAR} ──────────────────
  const dir2 = await mkdtemp(join(tmpdir(), "dsh-mcp-cc-"));
  // fake home 必须落在项目树之外（与任何项目根无祖先关系）：用户层热重载只能
  // 由用户 watcher 证明，不许借项目 watcher 的 depth 覆盖冒充。
  const home2 = await mkdtemp(join(tmpdir(), "dsh-mcp-cc-home-"));
  await mkdir(join(home2, ".dsh"), { recursive: true });
  const savedBin = process.env.CC_TEST_BIN;
  const savedMissing = process.env.CC_TEST_MISSING;
  try {
    delete process.env.CC_TEST_MISSING;
    process.env.CC_TEST_BIN = "node";
    process.chdir(dir2);
    await writeFile(join(dir2, ".mcp.json"), JSON.stringify({
      mcpServers: {
        alpha: { command: "node", args: ["a-cc.js"] },
        beta: { command: "${CC_TEST_BIN}", args: [], env: { T: "${CC_TEST_MISSING}" } },
        bad: { type: "sse", url: "https://example/" }
      }
    }), "utf8");

    const ctx2 = fakeCtx();
    const registry2 = new ProjectMcpRegistry(ctx2, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(home2, ".dsh", "mcp.yml"), mcpJson: join(home2, ".dsh", "mcp.json"), profilesDir: join(home2, ".dsh", "profiles") }
    });
    ctx2.agentsList.push(fakeAgent("session-e", dir2));
    await registry2.reconcileNow();

    // 10. 装载集合：cc-project(alpha) 生效；beta 因缺变量跳过、bad(sse) 拒载
    const names10 = ctx2.mounts.map((config) => config.serverName);
    names10.sort(byCodeUnit);
    assert.deepEqual(names10, ["alpha"], "legacy .mcp.json rows mount; sse and missing-env rows do not");
    const alpha10 = ctx2.mounts.find((config) => config.serverName === "alpha");
    assert.equal(alpha10.cwd, dir2, "CC stdio cwd defaults to project root");
    const diagE10 = await readDiag(dir2);
    assert.ok(diagE10.some((row) => row.kind === "scan" && Array.isArray(row.ccEntryErrors) && row.ccEntryErrors.some((note) => note.includes("bad"))), "sse entry error recorded in scan diag");
    assert.ok(diagE10.some((row) => row.kind === "env-missing" && row.rawName === "beta" && row.missingVar === "CC_TEST_MISSING"), "env-missing diag names the variable, not the value");
    const summaryE10 = await readDiagSummary(dir2);
    assert.ok(summaryE10 !== undefined, "diag file carries a summary after reconcile");
    assert.equal(summaryE10.skippedByReason["env-missing"], 1, "summary counts env-missing skips");
    assert.ok(summaryE10.unhealthy.some((item) => item.name === "beta" && item.reason === "env-missing"), "summary names the env-missing row");
    pass("registry mounts legacy CC-dialect rows and reports per-entry/env failures");

    // 11. 快照分区：yml 缺失不出分区；cc-project 分区带行与 entryErrors；用户 yml 分区
    const snap11 = await registry2.snapshot();
    assert.equal(snap11.find((file) => file.path === projectMcpFile(dir2)), undefined, "absent project yml yields no partition");
    const ccPart11 = snap11.find((file) => file.source === "cc-project");
    assert.ok(ccPart11 !== undefined && ccPart11.project === dir2);
    const ccNames11 = ccPart11.servers.map((server) => server.serverName);
    ccNames11.sort(byCodeUnit);
    assert.deepEqual(ccNames11, ["alpha", "beta"]);
    assert.ok(Array.isArray(ccPart11.entryErrors) && ccPart11.entryErrors.some((note) => note.includes("bad")));
    const betaView11 = ccPart11.servers.find((server) => server.serverName === "beta");
    assert.equal(betaView11.fiberPhase, "pending", "fiberPhase stays on the lifecycle vocabulary");
    assert.equal(betaView11.skipReason, "env-missing", "the skip reason rides on its own field");
    const userYml11 = snap11.find((file) => file.source === "dsh-user-yml");
    assert.ok(userYml11 === undefined, "no user yml yet");
    pass("snapshot partitions the legacy project file and user layers");

    // 12. 影子优先：项目 yml 同名行压过 .mcp.json，diag 记 shadowedByYml
    await writeManagedRows(projectMcpFile(dir2), [{ ...stdioRow("alpha"), config: { ...stdioRow("alpha").config, args: ["a-yml.js"] } }], { createIfMissing: true });
    await registry2.reconcileNow();
    const alphaMounts12 = ctx2.mounts.filter((config) => config.serverName === "alpha");
    assert.ok(alphaMounts12.length >= 2, "shadowed row was remounted from the yml layer");
    assert.deepEqual(alphaMounts12.at(-1).args, ["a-yml.js"], "yml row wins over .mcp.json row of the same name");
    const diag12 = await readDiag(dir2);
    assert.ok(diag12.some((row) => row.kind === "scan" && Array.isArray(row.shadowedByYml) && row.shadowedByYml.includes("alpha")), "shadowing recorded in diag");
    const snap12 = await registry2.snapshot();
    const alphaYml12 = snap12.find((file) => file.path === projectMcpFile(dir2)).servers.find((server) => server.serverName === "alpha");
    assert.equal(alphaYml12.fiberPhase, "active");
    const alphaCc12 = snap12.find((file) => file.source === "cc-project").servers.find((server) => server.serverName === "alpha");
    assert.equal(alphaCc12.fiberPhase, null, "shadowed CC row shows no phase while yml owns the name");
    pass("project yml shadows same-named .mcp.json rows with diagnostics");

    // 13. 变量补齐 → 行可装载（env 展开进装载配置）；原生 yml 行同样享受展开（全来源统一）
    process.env.CC_TEST_MISSING = "sekret";
    await writeManagedRows(projectMcpFile(dir2), [
      { ...stdioRow("alpha"), config: { ...stdioRow("alpha").config, args: ["a-yml.js"] } },
      { ...stdioRow("eta"), config: { ...stdioRow("eta").config, args: ["eta-yml.js"], command: "${CC_TEST_BIN}", env: { T: "${CC_TEST_MISSING}" } } }
    ]);
    await registry2.reconcileNow();
    const beta13 = ctx2.mounts.findLast((config) => config.serverName === "beta");
    assert.ok(beta13 !== undefined, "beta mounts once its env var exists");
    assert.equal(beta13.env.T, "sekret", "${VAR} expanded from process.env at mount time");
    assert.equal(beta13.command, "node", "${VAR} expanded in command too");
    const eta13 = ctx2.mounts.findLast((config) => config.serverName === "eta");
    assert.ok(eta13 !== undefined, "native yml row with ${VAR} mounts expanded");
    assert.equal(eta13.env.T, "sekret");
    assert.equal(eta13.command, "node");
    pass("registry expands ${VAR} refs from the environment for all sources");

    // 14. 用户层 yml 热装载（watcher 事件驱动，非 reconcileNow）。fake home 已在
    // 项目树外，用户 watcher 是唯一可能的触发源；先稳定计数再写文件，断言计数
    // 增长才不会被上一节残留的 debounce 定时器假绿。
    let count14 = registry2.debugReconcileCount;
    for (let waited = 0; waited < 6000; waited += 300) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
      const next = registry2.debugReconcileCount;
      if (next === count14) break;
      count14 = next;
    }
    await writeManagedRows(join(home2, ".dsh", "mcp.yml"), [stdioRow("epsilon")], { createIfMissing: true });
    const epsilonActive = await registry2.waitForGlobalState("epsilon", (state) => state?.phase === "active", 5000);
    assert.ok(epsilonActive, "user ~/.dsh/mcp.yml row hot-mounts via the user watcher");
    assert.ok(registry2.debugReconcileCount > count14, "the user yml write itself must have driven the reconcile");
    pass("registry watches and hot-mounts the user ~/.dsh/mcp.yml");

    // 15. 用户层 JSON 层不在本提交范围：此处仅断言遗留用户 yml 的写入会驱动对账。
    let count15 = registry2.debugReconcileCount;
    for (let waited = 0; waited < 6000; waited += 300) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
      const next = registry2.debugReconcileCount;
      if (next === count15) break;
      count15 = next;
    }
    await writeManagedRows(join(home2, ".dsh", "mcp.yml"), [stdioRow("epsilon"), stdioRow("zeta")], { createIfMissing: true });
    const zetaActive = await registry2.waitForGlobalState("zeta", (state) => state?.phase === "active", 5000);
    assert.ok(zetaActive, "user yml row hot-mounts through the user watcher");
    pass("user ~/.dsh/mcp.yml watcher drives reconciliation");

    // 16. P0 回归：坏 .mcp.json 不得卸掉同项目的原生 yml 服务器（源级隔离）。
    // 修复前：项目级 ok = yml.ok && cc 无 fileError，整项目被踢出生效名目录，
    // yml 行连同好配置一起被卸载且装不回去。
    const dir3 = join(dir2, "proj3");
    await mkdir(join(dir3, ".dsh"), { recursive: true });
    await writeManagedRows(projectMcpFile(dir3), [stdioRow("keep-yml")], { createIfMissing: true });
    await writeFile(join(dir3, ".mcp.json"), JSON.stringify({ mcpServers: { "cc-x": { command: "node", args: ["x.js"] } } }), "utf8");
    ctx2.agentsList.push(fakeAgent("session-f", dir3));
    await registry2.reconcileNow();
    assert.ok(
      ctx2.mounts.some((config) => config.serverName === "keep-yml") && ctx2.mounts.some((config) => config.serverName === "cc-x"),
      "both project sources mounted in baseline");
    const dispBefore16 = ctx2.disposals.length;
    await writeFile(join(dir3, ".mcp.json"), "{ invalid json", "utf8");
    await registry2.reconcileNow();
    assert.deepEqual(ctx2.disposals.slice(dispBefore16), ["cc-x"], "only the broken source's rows unmount; the yml server stays");
    assert.ok(await registry2.waitForState(dir3, "keep-yml", (state) => state?.phase === "active", 500), "yml row stayed active through the bad .mcp.json");
    const snap16 = await registry2.snapshot();
    const ccPart16 = snap16.find((file) => file.source === "cc-project" && file.project === dir3);
    assert.ok(ccPart16 !== undefined && ccPart16.ok === false && /json/i.test(String(ccPart16.error)), "cc partition reports the file error");
    pass("a broken .mcp.json does not unmount native yml servers of the same project");

    // 17. 反向：yml 坏时，同项目 .mcp.json 行照常装载/重装载
    await writeFile(join(dir3, ".mcp.json"), JSON.stringify({ mcpServers: { "cc-x": { command: "node", args: ["x2.js"] } } }), "utf8");
    await writeFile(projectMcpFile(dir3), "data: [unclosed\n", "utf8");
    await registry2.reconcileNow();
    assert.ok(ctx2.disposals.includes("keep-yml"), "yml row unmounts while its file is unparseable");
    const remount17 = ctx2.mounts.findLast((config) => config.serverName === "cc-x");
    assert.ok(remount17 !== undefined && ctx2.mounts.filter((config) => config.serverName === "cc-x").length >= 2, ".mcp.json row remounts despite the broken yml");
    assert.deepEqual(remount17.args, ["x2.js"], "remounted with the repaired .mcp.json config");
    pass("a broken project mcp.yml does not block .mcp.json rows");

    // 18. P1 回归：写 .mcp.json 本身要触发热对账（README 承诺的 150ms 路径）。
    // 修复前：kick 过滤器只认 .dsh/mcp.yml，CC 文件增删改要等别的巧合才生效。
    // 先等计数稳定：16/17 的文件写入各留下过 debounce 定时器，不安抚就测不准。
    let count18 = registry2.debugReconcileCount;
    for (let waited = 0; waited < 6000; waited += 300) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
      const next = registry2.debugReconcileCount;
      if (next === count18) break;
      count18 = next;
    }
    const ccFile18 = join(dir2, ".mcp.json");
    const parsed18 = JSON.parse(await readFile(ccFile18, "utf8"));
    parsed18.mcpServers["hot-cc"] = { command: "node", args: ["hot-cc.js"] };
    await writeFile(ccFile18, JSON.stringify(parsed18), "utf8");
    const hotActive18 = await registry2.waitForState(dir2, "hot-cc", (state) => state?.phase === "active", 5000);
    assert.ok(hotActive18, "editing .mcp.json hot-mounts without an explicit reconcile");
    assert.ok(registry2.debugReconcileCount > count18, "the .mcp.json write itself must have driven the reconcile");
    pass("registry hot-reloads project .mcp.json edits via the watcher");

    // 19. http 行端到端：Bearer 串内插值进装载配置；展开后非法 url 以 env-invalid 拒载
    const parsed19 = JSON.parse(await readFile(ccFile18, "utf8"));
    parsed19.mcpServers["http-ok"] = { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer ${CC_TEST_MISSING}" } };
    parsed19.mcpServers["http-bad"] = { type: "http", url: "${CC_TEST_NOTURL}" };
    process.env.CC_TEST_NOTURL = "not a url";
    try {
      await writeFile(ccFile18, JSON.stringify(parsed19), "utf8");
      assert.ok(await registry2.waitForState(dir2, "http-ok", (state) => state?.phase === "active", 5000), "http row with interpolated Bearer header mounts");
      const httpOk19 = ctx2.mounts.findLast((config) => config.serverName === "http-ok");
      assert.equal(httpOk19.headers.Authorization, "Bearer sekret", "in-string interpolation reaches the mount config");
      assert.ok(await registry2.waitForState(dir2, "http-bad", (state) => state === undefined, 500), "invalid expanded url is never mounted");
      const seen19 = await waitForDiag(dir2, (lines) => lines.some((row) => row.kind === "env-invalid" && row.rawName === "http-bad"), 5000);
      assert.ok(seen19, "post-expansion schema failure lands as env-invalid diag");
      const diag19 = await readDiag(dir2);
      assert.equal(diag19.some((row) => row.error === "not a url"), false, "diag must not echo the offending value");
    } finally {
      delete process.env.CC_TEST_NOTURL;
    }
    pass("registry interpolates Bearer ${VAR} end-to-end and rejects invalid post-expansion urls");

    // 20. P2：yml 禁用行占名遮蔽下层——关掉 yml 的 alpha 后，.mcp.json 同名行
    // 不得「顶上」装载（修复前：disabled 在读取层直接消失，名字让位给 CC 副本）。
    const alphaMounts20 = ctx2.mounts.filter((config) => config.serverName === "alpha").length;
    await writeManagedRows(projectMcpFile(dir2), [
      { ...stdioRow("alpha"), disabled: true, config: { ...stdioRow("alpha").config, args: ["a-yml.js"] } },
      stdioRow("eta")
    ]);
    await registry2.reconcileNow();
    assert.ok(ctx2.disposals.includes("alpha"), "disabled yml row unmounts");
    assert.equal(ctx2.mounts.filter((config) => config.serverName === "alpha").length, alphaMounts20, "disabled name is not taken over by the .mcp.json row");
    assert.ok(!(await registry2.waitForState(dir2, "alpha", (state) => state !== undefined, 400)), "no alpha state while yml keeps it disabled");
    const eta20 = await registry2.waitForState(dir2, "eta", (state) => state?.phase === "active", 1000);
    assert.ok(eta20, "sibling rows unaffected");
    pass("disabled native rows shadow lower layers instead of yielding the name");

    // 22. P1 回归：项目层空 cwd 按文档解析为项目根；用户层空 cwd 保持继承宿主目录。
    // 修复前：mountServer 只处理非空 cwd，省略 cwd 的手写 yml 行拿宿主进程 cwd，
    // 与 README「空 cwd = 项目根」的说法对不上。
    const dir4 = join(dir2, "proj4");
    await mkdir(join(dir4, ".dsh"), { recursive: true });
    await writeManagedRows(projectMcpFile(dir4), [
      { id: "panel-mcp-nocwd", name: "@deepseek-ai/dsh-mcp-client", config: { ...stdioRow("nocwd").config, cwd: "" } }
    ], { createIfMissing: true });
    await writeManagedRows(join(home2, ".dsh", "mcp.yml"), [
      { id: "panel-mcp-user-nocwd", name: "@deepseek-ai/dsh-mcp-client", config: { ...stdioRow("user-nocwd").config, cwd: "" } }
    ]);
    ctx2.agentsList.push(fakeAgent("session-g", dir4));
    await registry2.reconcileNow();
    const nocwd22 = ctx2.mounts.findLast((config) => config.serverName === "nocwd");
    assert.ok(nocwd22 !== undefined, "project row with empty cwd mounts");
    assert.equal(nocwd22.cwd, dir4, "empty cwd at the project layer resolves to the project root");
    const userNoCwd22 = ctx2.mounts.findLast((config) => config.serverName === "user-nocwd");
    assert.ok(userNoCwd22 !== undefined, "user row with empty cwd mounts globally");
    assert.equal(userNoCwd22.cwd, "", "empty cwd at the global layer stays host-inherit");
    assert.equal(ctx2.mounts.filter((config) => config.serverName === "user-nocwd").length, 1, "a user row mounts exactly once regardless of project count");
    pass("empty stdio cwd resolves to the project root for project sources and stays host-inherit for user sources");

    // 23. P1 回归：项目 watcher 只认「已知项目根下的精确配置文件」。修复前：
    // kick 按「以 .dsh/mcp.yml 结尾」的后缀匹配，项目树里任何嵌套层的同名文件
    // 都算命中。这里钉住精确语义：stray 目录下的 .dsh/mcp.yml 不得惊动管线。
    let count23 = registry2.debugReconcileCount;
    for (let waited = 0; waited < 6000; waited += 300) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
      const next = registry2.debugReconcileCount;
      if (next === count23) break;
      count23 = next;
    }
    await mkdir(join(dir2, "stray", ".dsh"), { recursive: true });
    await writeFile(join(dir2, "stray", ".dsh", "mcp.yml"), "- insert:\n", "utf8");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
    assert.equal(registry2.debugReconcileCount, count23, "a stray nested .dsh/mcp.yml must not drive reconciles");
    pass("project watcher kicks only on the exact config files of known project roots");

    // 24. 全局用户层挂载与项目无关：新项目（无项目行）不建条目、不写诊断；
    // 用户层实例仍只有一条。真实 yml 行装载后文件被删 → 仍记 scan 错。
    const dir5 = join(dir2, "proj5");
    await mkdir(join(dir5, ".dsh"), { recursive: true });
    ctx2.agentsList.push(fakeAgent("session-h", dir5));
    await registry2.reconcileNow();
    // 用户层活行：场景 22 重写过用户 yml，epsilon 已不在，用 user-nocwd（dsh-user-yml 源）。
    const eps24 = await registry2.waitForGlobalState("user-nocwd", (state) => state?.phase === "active", 5000);
    assert.ok(eps24, "the user-layer row is mounted globally");
    assert.equal(ctx2.mounts.filter((config) => config.serverName === "user-nocwd").length, 1, "adding a project does not add a second global instance");
    await registry2.reconcileNow();
    assert.equal(await pathExists(diagFile(dir5)), false, "a project with no rows writes no diagnostics");
    // 对照：真实 yml 行装载后文件被删 → 记 scan 错仍是正确行为
    await writeManagedRows(projectMcpFile(dir5), [stdioRow("real-yml")], { createIfMissing: true });
    await registry2.reconcileNow();
    assert.ok(await registry2.waitForState(dir5, "real-yml", (state) => state?.phase === "active", 5000), "project yml row mounts");
    await rm(projectMcpFile(dir5));
    await registry2.reconcileNow();
    const diag24 = await readDiag(dir5);
    assert.ok(diag24.some((row) => row.kind === "scan" && row.ok === false && String(row.error).includes("ENOENT")), "deleting a live yml file still records a scan error");
    pass("absent project yml stays silent for user-layer-only mounts and stays loud for removed live yml files");

    // 26. .mcp.json 可关：IGNORE_MCP_JSON=1 → 该层不读不看、分区消失、已装
    // cc-project fiber 被卸；yml 源不受牵连。撤开关后恢复。
    process.env.DSH_MCP_IGNORE_MCP_JSON = "1";
    try {
      const dispBefore26 = ctx2.disposals.length;
      await registry2.reconcileNow();
      assert.ok(ctx2.disposals.slice(dispBefore26).includes("hot-cc"), "cc-project fiber unmounts when the layer is switched off");
      assert.ok(await registry2.waitForState(dir2, "eta", (state) => state?.phase === "active", 500), "native yml rows stay mounted");
      const snap26 = await registry2.snapshot();
      assert.equal(snap26.find((file) => file.source === "cc-project"), undefined, "cc-project partitions vanish with the switch");
      let count26 = registry2.debugReconcileCount;
      for (let waited = 0; waited < 6000; waited += 300) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
        const next = registry2.debugReconcileCount;
        if (next === count26) break;
        count26 = next;
      }
      const ccFile26 = JSON.parse(await readFile(join(dir2, ".mcp.json"), "utf8"));
      ccFile26.mcpServers["hot26"] = { command: "node", args: ["hot26.js"] };
      await writeFile(join(dir2, ".mcp.json"), JSON.stringify(ccFile26), "utf8");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
      assert.equal(registry2.debugReconcileCount, count26, ".mcp.json edits must not drive reconciles while the layer is off");
    } finally {
      delete process.env.DSH_MCP_IGNORE_MCP_JSON;
    }
    await registry2.reconcileNow();
    assert.ok(await registry2.waitForState(dir2, "hot26", (state) => state?.phase === "active", 5000), ".mcp.json rows return once the switch is cleared");
    pass("DSH_MCP_IGNORE_MCP_JSON gates reading, watching, and partitions of the project .mcp.json layer");

    // 28. 跨来源同服务去重（集成）：事故复刻——proj6 的 yml unityMCP 与用户层
    // unity-mcp 是同一服务器的两种写法（args 差 --offline），proj6 只装一条，
    // 被剔除者进 diag 并告警；其它没有 yml twin 的项目照常挂 unity-mcp。
    {
      const dir6 = join(dir2, "proj6");
      await mkdir(dir6, { recursive: true });
      await writeManagedRows(projectMcpFile(dir6), [{
        id: "panel-mcp-unityMCP",
        name: "@deepseek-ai/dsh-mcp-client",
        config: { serverName: "unityMCP", transport: "stdio", command: "node", args: ["u-server.js"], env: {}, cwd: "", toolCallTimeoutMs: 60000, failOnStartupError: false, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } }
      }], { createIfMissing: true });
      const userRow = (name, args) => ({
        id: "panel-mcp-" + name,
        name: "@deepseek-ai/dsh-mcp-client",
        config: { serverName: name, transport: "stdio", command: "node", args, env: {}, cwd: "", toolCallTimeoutMs: 60000, failOnStartupError: false, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } }
      });
      await writeManagedRows(join(home2, ".dsh", "mcp.yml"), [userRow("unity-mcp", ["--offline", "u-server.js"])], { createIfMissing: true });
      const warns28 = [];
      const origWarn28 = ctx2.logger.warn;
      ctx2.logger.warn = (msg) => { warns28.push(String(msg)); };
      try {
        ctx2.agentsList.push(fakeAgent("session-j", dir6));
        await registry2.reconcileNow();
        assert.ok(
          await waitForDiag(dir6, (rows) => rows.some((r) => r.kind === "scan" && Array.isArray(r.shadowedIdentity)
            && r.shadowedIdentity.some((s) => s.name === "unity-mcp" && s.winner === "unityMCP" && s.reason === "normname"))),
          "scan diag reports the identity shadow with winner and reason");
        assert.ok(warns28.some((w) => w.includes('跳过重复服务定义 "unity-mcp"')), "dup definition warned on the first reconcile: " + JSON.stringify(warns28.slice(-3)));
        assert.ok(await registry2.waitForState(dir6, "unityMCP", (state) => state?.phase === "active", 5000), "the yml twin mounts in proj6");
        const snap28 = await registry2.snapshot();
        const part6 = snap28.find((file) => file.project === dir6 && file.source === "dsh-project");
        assert.ok(part6 !== undefined && part6.servers.length === 1 && part6.servers[0].serverName === "unityMCP", "proj6 serves exactly the yml definition");
        // serverView（P2-6）：单行视图同样只给「本行拥有装载实例」的生命周期与工具数。
        const view6 = await registry2.serverView(dir6, "unityMCP");
        assert.ok(view6 !== undefined && view6.fiberPhase === "active" && view6.source === "dsh-project", "serverView shows the owning yml row as mounted");
        const viewCpu = await registry2.serverView(dir6, "unity-mcp");
        assert.ok(viewCpu !== undefined && viewCpu.source === "dsh-user-yml", "serverView resolves the global row to its user-layer source");
        // 全局实例仍在（只挂一条），但 proj6 的会话按项目侧压制 deny 掉它的工具。
        assert.ok(await registry2.waitForGlobalState("unity-mcp", (state) => state?.phase === "active", 5000), "the shadowed global row still mounts exactly once");
        ctx2.schemas.push({ id: "mcp__unity-mcp__ping" }, { id: "mcp__unityMCP__ping" });
        await registry2.reconcileNow();
        const agentJ = ctx2.agentsList.find((agent) => agent.id === "session-j");
        assert.ok(agentJ.denies.some((deny) => deny.includes("mcp__unity-mcp__ping")), "proj6 denies the suppressed global server's tools: " + JSON.stringify(agentJ.denies));
        assert.ok(agentJ.denies.every((deny) => !deny.includes("mcp__unityMCP__ping")), "proj6 keeps its own yml server visible");
        const agentB28 = ctx2.agentsList.find((agent) => agent.id === "session-e");
        assert.ok(agentB28.denies.every((deny) => !deny.includes("mcp__unity-mcp__ping")), "other projects keep the global server visible");
        // 变更门控（P1-2 回归）：剔除集稳定就不得每次对账各刷一遍；集合真正
        // 变化（清零→再出现）才重新告警。
        const dup28 = () => warns28.filter((w) => w.includes('跳过重复服务定义 "unity-mcp"')).length;
        assert.equal(dup28(), 1, "identity dedup warned exactly on first sight");
        await registry2.reconcileNow();
        await registry2.reconcileNow();
        assert.equal(dup28(), 1, "stable shadow set stays silent across reconciles");
        await writeManagedRows(join(home2, ".dsh", "mcp.yml"), [userRow("distinct-28", ["u-server.js", "extra"])]);
        await registry2.reconcileNow();
        assert.equal(dup28(), 1, "clearing the shadow alone must not warn");
        assert.ok(await registry2.waitForGlobalState("distinct-28", (state) => state?.phase === "active", 5000), "the replacement server mounts once the shadow is gone");
        await writeManagedRows(join(home2, ".dsh", "mcp.yml"), [userRow("unity-mcp", ["--offline", "u-server.js"])]);
        await registry2.reconcileNow();
        assert.equal(dup28(), 2, "a changed shadow set re-arms the dedup warning");
      } finally {
        ctx2.logger.warn = origWarn28;
      }
      pass("registry dedups the same service across layers and reports the shadowed twin");
    }

    // 29. DSH 自有 JSON 层：项目 .dsh/mcp.json、用户 ~/.dsh/mcp.json、profile json；
    // 同项目内 yml 与 json 同名时 yml 胜出（逐行优先序），profile 名解析不出时降级。
    {
      const dir7 = join(dir2, "proj7");
      await mkdir(join(dir7, ".dsh"), { recursive: true });
      await writeManagedRows(projectMcpFile(dir7), [stdioRow("both")], { createIfMissing: true });
      await writeFile(join(dir7, ".dsh", "mcp.json"), JSON.stringify({
        mcpServers: {
          both: { command: "node", args: ["from-json.js"] },
          jsonproj: { command: "node", args: ["p.js"] }
        }
      }), "utf8");
      await writeFile(join(home2, ".dsh", "mcp.json"), JSON.stringify({
        mcpServers: { jsonuser: { command: "node", args: ["u.js"] } }
      }), "utf8");
      await mkdir(join(home2, ".dsh", "profiles", "web"), { recursive: true });
      await writeFile(join(home2, ".dsh", "profiles", "web", "mcp.json"), JSON.stringify({
        mcpServers: { jsonprofile: { command: "node", args: ["pr.js"] } }
      }), "utf8");
      const userPaths = {
        mcpYml: join(home2, ".dsh", "mcp.yml"),
        mcpJson: join(home2, ".dsh", "mcp.json"),
        profilesDir: join(home2, ".dsh", "profiles")
      };
      const ctx3 = fakeCtx();
      const registry3 = new ProjectMcpRegistry(ctx3, { globalNames: async () => [], activeProfile: async () => "web", userLayerPaths: userPaths });
      // 两个项目：全局行也只应挂一条（不随项目数变化）。
      const dir7b = join(dir2, "proj7b");
      await mkdir(join(dir7b, ".dsh"), { recursive: true });
      ctx3.agentsList.push(fakeAgent("session-k", dir7), fakeAgent("session-k2", dir7b));
      await registry3.reconcileNow();
      const names29 = ctx3.mounts.map((config) => config.serverName);
      for (const expected of ["jsonproj", "jsonprofile", "jsonuser"]) {
        assert.ok(names29.includes(expected), `${expected} mounts from its DSH json layer: ${names29.join(",")}`);
      }
      assert.equal(names29.filter((name) => name === "jsonuser").length, 1, "user json row mounts once for the whole host");
      assert.equal(names29.filter((name) => name === "jsonprofile").length, 1, "profile json row mounts once for the whole host");
      const both29 = ctx3.mounts.findLast((config) => config.serverName === "both");
      assert.deepEqual(both29.args, ["srv-both.js"], "yml wins over .dsh/mcp.json for the same name");
      const snap29 = await registry3.snapshot();
      assert.ok(snap29.some((file) => file.source === "dsh-project-json" && file.project === dir7), "project json partition present");
      const userPart29 = snap29.find((file) => file.source === "dsh-user" && file.kind === "global");
      assert.ok(userPart29 !== undefined, "user json partition present");
      assert.equal(userPart29.servers[0].fiberPhase, "active", "global partition carries the global fiber phase");
      assert.ok(snap29.some((file) => file.source === "dsh-profile-user" && file.kind === "global"), "profile json partition present");
      // 与宿主 patch 行全局服务器撞名 → 跳过（name-taken），不改名、不冲突。
      const ctxTaken = fakeCtx();
      const registryTaken = new ProjectMcpRegistry(ctxTaken, { globalNames: async () => ["jsonuser"], activeProfile: async () => "web", userLayerPaths: userPaths });
      ctxTaken.agentsList.push(fakeAgent("session-m", dir7));
      await registryTaken.reconcileNow();
      assert.ok(!ctxTaken.mounts.some((config) => config.serverName === "jsonuser"), "a host global name is not taken over");
      const viewTaken = await registryTaken.serverView(dir7, "jsonuser");
      assert.equal(viewTaken.skipReason, "name-taken", "skip reason names the host-global collision");
      // profile 名解析不出（无 activeProfile provider）→ 不读 profile 层，其余照常。
      const ctx4 = fakeCtx();
      const registry4 = new ProjectMcpRegistry(ctx4, { globalNames: async () => [], userLayerPaths: userPaths });
      ctx4.agentsList.push(fakeAgent("session-l", dir7));
      await registry4.reconcileNow();
      assert.ok(!ctx4.mounts.some((config) => config.serverName === "jsonprofile"), "profile layer skipped when the profile name is unresolvable");
      assert.ok(ctx4.mounts.some((config) => config.serverName === "jsonuser"), "other user layers unaffected by the profile fallback");
      for (const disposer of [...ctx3.disposers, ...ctxTaken.disposers, ...ctx4.disposers]) {
        const cleanup = disposer();
        if (typeof cleanup === "function") cleanup();
      }
      pass("DSH json layers mount globally for user/profile, per project for project, with yml precedence");
    }

    // 30. 家目录即项目根：<home>/.dsh/mcp.yml|json 是用户层文件，不得被该项目层再挂一次
    //（实机复现：宿主 cwd 为家目录时，同一行会挂成「全局一条 + p<hash>_ 一条」）。
    {
      await writeFile(join(home2, ".dsh", "mcp.json"), JSON.stringify({ mcpServers: { "home-row": { command: "node", args: ["home.js"] } } }), "utf8");
      const ctx5 = fakeCtx();
      const registry5 = new ProjectMcpRegistry(ctx5, {
        globalNames: async () => [],
        userLayerPaths: { mcpYml: join(home2, ".dsh", "mcp.yml"), mcpJson: join(home2, ".dsh", "mcp.json"), profilesDir: join(home2, ".dsh", "profiles") }
      });
      ctx5.agentsList.push(fakeAgent("session-home", home2));
      await registry5.reconcileNow();
      const homeRowMounts = ctx5.mounts.filter((config) => config.serverName.endsWith("home-row")).map((config) => config.serverName);
      assert.deepEqual(homeRowMounts, ["home-row"], "the home project must not mount a second namespaced copy: " + homeRowMounts.join(","));
      const unityMounts30 = ctx5.mounts.filter((config) => config.serverName.endsWith("unity-mcp"));
      assert.equal(unityMounts30.length, 1, "user yml rows are not double-mounted either: " + unityMounts30.join(","));
      const snap30 = await registry5.snapshot();
      assert.ok(!snap30.some((file) => file.source === "dsh-project-json" && file.project === home2), "no project json partition for the home root");
      for (const disposer of ctx5.disposers) {
        const cleanup = disposer();
        if (typeof cleanup === "function") cleanup();
      }
      pass("a project root equal to the DSH home does not double-mount the user layer");
    }

    // 31. DSH_HOME 重定位：不注入 userLayerPaths 时，用户层三文件与全局诊断都跟随 $DSH_HOME
    //（此前硬编码 homedir()/.dsh，重定位后用户层整体静默失效——缺文件是合法零配置，不报错）。
    {
      const savedHome = process.env.DSH_HOME;
      const relocated = await mkdtemp(join(tmpdir(), "dsh-project-mcp-manager-dshhome-"));
      try {
        process.env.DSH_HOME = relocated;
        await writeFile(join(relocated, "mcp.json"), JSON.stringify({
          mcpServers: { relocated: { command: "node", args: ["r.js"] } }
        }), "utf8");
        await writeManagedRows(join(relocated, "mcp.yml"), [stdioRow("relocated-yml")], { createIfMissing: true });
        await mkdir(join(relocated, "profiles", "web"), { recursive: true });
        await writeFile(join(relocated, "profiles", "web", "mcp.json"), JSON.stringify({
          mcpServers: { "relocated-profile": { command: "node", args: ["rp.js"] } }
        }), "utf8");
        const ctx6 = fakeCtx();
        const registry6 = new ProjectMcpRegistry(ctx6, { globalNames: async () => [], activeProfile: async () => "web" });
        const dir31 = join(dir2, "proj31");
        await mkdir(join(dir31, ".dsh"), { recursive: true });
        ctx6.agentsList.push(fakeAgent("session-relocated", dir31));
        await registry6.reconcileNow();
        const names31 = ctx6.mounts.map((config) => config.serverName);
        for (const expected of ["relocated", "relocated-yml", "relocated-profile"]) {
          assert.ok(names31.includes(expected), `${expected} mounts from $DSH_HOME: ${names31.join(",")}`);
        }
        const snap31 = await registry6.snapshot();
        for (const expectedPath of [join(relocated, "mcp.json"), join(relocated, "mcp.yml"), join(relocated, "profiles", "web", "mcp.json")]) {
          assert.ok(snap31.some((file) => file.kind === "global" && file.path === expectedPath), `global partition path follows $DSH_HOME: ${expectedPath}`);
        }
        assert.ok(await pathExists(join(relocated, ".mcp-diag.json")), "global diagnostics land in $DSH_HOME/.mcp-diag.json");
        for (const disposer of ctx6.disposers) {
          const cleanup = disposer();
          if (typeof cleanup === "function") cleanup();
        }
        pass("DSH_HOME relocation moves the user layer files and the global diagnostics");
      } finally {
        if (savedHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = savedHome;
        await rmRetry(relocated);
      }
    }

    // 32. 项目侧压制只针对「真会全局装载」的名字（H1）：
    //  a) 用户层 disabled 占名行 + 项目同名行 → 该项目不得 deny 自己的工具；
    //  b) 宿主 patch 占名 + 用户层同名行被拒（name-taken）+ 项目同名行 → 不得 deny 宿主 patch 的工具。
    {
      const home32 = await mkdtemp(join(tmpdir(), "dsh-project-mcp-manager-h1-"));
      const proj32 = join(dir2, "proj32");
      try {
        await mkdir(proj32, { recursive: true });
        const userPaths32 = { mcpYml: join(home32, "mcp.yml"), mcpJson: join(home32, "mcp.json"), profilesDir: join(home32, "profiles") };
        // a) 用户层 yml 里 selfx 是 disabled 占名行（占名遮蔽下层，但自身不装载）
        await writeManagedRows(userPaths32.mcpYml, [{ id: "panel-mcp-selfx", name: "@deepseek-ai/dsh-mcp-client", disabled: true }], { createIfMissing: true });
        await writeManagedRows(projectMcpFile(proj32), [stdioRow("selfx")], { createIfMissing: true });
        const ctxA = fakeCtx();
        const registryA = new ProjectMcpRegistry(ctxA, { globalNames: async () => [], userLayerPaths: userPaths32 });
        ctxA.agentsList.push(fakeAgent("session-h1a", proj32));
        await registryA.reconcileNow();
        assert.ok(await registryA.waitForState(proj32, "selfx", (state) => state?.phase === "active", 5000), "the project row mounts under its own name");
        const mountedA = ctxA.mounts.map((config) => config.serverName);
        assert.ok(mountedA.includes("selfx"), "a disabled user placeholder does not claim the global name: " + mountedA.join(","));
        assert.equal(registryA.globalState("selfx"), undefined, "the disabled placeholder mounts nothing globally");
        ctxA.schemas.push({ id: "mcp__selfx__ping" });
        await registryA.reconcileNow();
        const agentA = ctxA.agentsList[0];
        assert.ok(agentA.denies.every((deny) => !deny.includes("mcp__selfx__ping")), "the project must not deny its own tools: " + JSON.stringify(agentA.denies));
        const viewA = await registryA.serverView(proj32, "selfx");
        assert.equal(viewA.fiberPhase, "active", "the project row stays active");

        // b) 宿主 patch 占名 hostx：用户层 hostx 被 name-taken 拒掉，项目 hostx 改名
        await writeManagedRows(userPaths32.mcpYml, [{
          id: "panel-mcp-hostx",
          name: "@deepseek-ai/dsh-mcp-client",
          config: { serverName: "hostx", transport: "stdio", command: "node", args: ["u-hostx.js"], env: {}, cwd: "", toolCallTimeoutMs: 60000, failOnStartupError: false, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } }
        }]);
        await writeManagedRows(projectMcpFile(proj32), [stdioRow("hostx")]);
        const ctxB = fakeCtx();
        const registryB = new ProjectMcpRegistry(ctxB, { globalNames: async () => ["hostx"], userLayerPaths: userPaths32 });
        ctxB.agentsList.push(fakeAgent("session-h1b", proj32));
        await registryB.reconcileNow();
        assert.equal(registryB.globalState("hostx"), undefined, "the user row is blocked by the host patch name");
        const projectEffective = ctxB.mounts.map((config) => config.serverName).find((name) => name.endsWith("_hostx"));
        assert.ok(projectEffective !== undefined, "the project row is namespaced around the host patch name: " + ctxB.mounts.map((c) => c.serverName).join(","));
        ctxB.schemas.push({ id: "mcp__hostx__ping" }, { id: `mcp__${projectEffective}__ping` });
        await registryB.reconcileNow();
        const agentB = ctxB.agentsList[0];
        assert.ok(agentB.denies.every((deny) => !deny.includes("mcp__hostx__ping")), "a blocked user row must not make the project deny the host patch tools: " + JSON.stringify(agentB.denies));
        for (const disposer of [...ctxA.disposers, ...ctxB.disposers]) {
          const cleanup = disposer();
          if (typeof cleanup === "function") cleanup();
        }
        pass("project-side suppression only denies globals that actually mount");
      } finally {
        await rmRetry(home32);
        await rmRetry(proj32);
      }
    }

    // 33. 纯用户层内部冲突按全局归因（M3/M4）：零配置项目不写 .mcp-diag.json，
    // 同名/同服务遮蔽只在全局层告警一次并写全局诊断。
    {
      const home33 = await mkdtemp(join(tmpdir(), "dsh-project-mcp-manager-m4-"));
      const proj33 = join(dir2, "proj33");
      try {
        await mkdir(proj33, { recursive: true });
        const userPaths33 = { mcpYml: join(home33, "mcp.yml"), mcpJson: join(home33, "mcp.json"), profilesDir: join(home33, "profiles") };
        // 用户 yml 与用户 json 定义同一个服务（command+args 相同 → 身份键命中），
        // 外加一对精确同名行（yml 胜出）。两类冲突都只属于全局层。
        await writeManagedRows(userPaths33.mcpYml, [{
          id: "panel-mcp-twin-yml",
          name: "@deepseek-ai/dsh-mcp-client",
          config: { serverName: "twin-yml", transport: "stdio", command: "node", args: ["twin.js"], env: {}, cwd: "", toolCallTimeoutMs: 60000, failOnStartupError: false, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } }
        }, {
          id: "panel-mcp-samename",
          name: "@deepseek-ai/dsh-mcp-client",
          config: { serverName: "samename", transport: "stdio", command: "node", args: ["s-yml.js"], env: {}, cwd: "", toolCallTimeoutMs: 60000, failOnStartupError: false, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } }
        }], { createIfMissing: true });
        await writeFile(userPaths33.mcpJson, JSON.stringify({
          mcpServers: {
            "twin-json": { command: "node", args: ["twin.js"] },
            samename: { command: "node", args: ["s-json.js"] }
          }
        }), "utf8");
        const ctx33 = fakeCtx();
        const warns33 = [];
        ctx33.logger.warn = (msg) => { warns33.push(String(msg)); };
        const registry33 = new ProjectMcpRegistry(ctx33, { globalNames: async () => [], userLayerPaths: userPaths33 });
        ctx33.agentsList.push(fakeAgent("session-m4", proj33));
        await registry33.reconcileNow();
        assert.equal(await pathExists(diagFile(proj33)), false, "a zero-config project stays free of .mcp-diag.json");
        const globalDiag = parseDiagDocument(JSON.parse(await readFile(join(home33, ".mcp-diag.json"), "utf8"))).events;
        assert.ok(globalDiag.some((row) => row.kind === "shadow" && Array.isArray(row.shadowedIdentity)
          && row.shadowedIdentity.some((s) => s.name === "twin-json" && s.winner === "twin-yml")), "global diag records the user-layer identity shadow: " + JSON.stringify(globalDiag.slice(-2)));
        assert.ok(globalDiag.some((row) => row.kind === "shadow" && Array.isArray(row.shadowedByHigherLayer)
          && row.shadowedByHigherLayer.some((s) => s.name === "samename" && s.winnerSource === "dsh-user-yml")), "global diag records the same-name shadow between user layers");
        const dupWarns = warns33.filter((w) => w.includes('跳过重复服务定义 "twin-json"'));
        assert.equal(dupWarns.length, 1, "the user-layer dedup warns once, globally: " + JSON.stringify(warns33));
        assert.ok(warns33.every((w) => !w.includes(proj33)), "no warning is attributed to the zero-config project");
        await registry33.reconcileNow();
        await registry33.reconcileNow();
        assert.equal(warns33.filter((w) => w.includes('跳过重复服务定义 "twin-json"')).length, 1, "a stable global shadow set stays silent");
        for (const disposer of ctx33.disposers) {
          const cleanup = disposer();
          if (typeof cleanup === "function") cleanup();
        }
        pass("user-layer-only shadows are attributed globally and leave zero-config projects untouched");
      } finally {
        await rmRetry(home33);
        await rmRetry(proj33);
      }
    }

    // 34. 告警变更门控（M1/M2）：持续存在的坏条目与持续被拒的 name-taken 行，
    // 多次对账只在集合变化时各告警一次（此前每次文件事件都重刷）。
    {
      const home34 = await mkdtemp(join(tmpdir(), "dsh-project-mcp-manager-gate-"));
      const proj34 = join(dir2, "proj34");
      try {
        await mkdir(join(proj34, ".dsh"), { recursive: true });
        const userPaths34 = { mcpYml: join(home34, "mcp.yml"), mcpJson: join(home34, "mcp.json"), profilesDir: join(home34, "profiles") };
        await writeFile(userPaths34.mcpJson, JSON.stringify({
          mcpServers: {
            taken34: { command: "node", args: ["t.js"] },
            bad34: { type: "sse", url: "https://x/mcp" }
          }
        }), "utf8");
        await writeFile(join(proj34, ".dsh", "mcp.json"), JSON.stringify({
          mcpServers: { projbad34: { type: "sse", url: "https://y/mcp" } }
        }), "utf8");
        const ctx34 = fakeCtx();
        const warns34 = [];
        ctx34.logger.warn = (msg) => { warns34.push(String(msg)); };
        const registry34 = new ProjectMcpRegistry(ctx34, { globalNames: async () => ["taken34"], userLayerPaths: userPaths34 });
        ctx34.agentsList.push(fakeAgent("session-gate", proj34));
        await registry34.reconcileNow();
        await registry34.reconcileNow();
        await registry34.reconcileNow();
        const count = (needle) => warns34.filter((w) => w.includes(needle)).length;
        assert.equal(count('"bad34": 不支持 MCP SSE'), 1, "the user-layer bad entry warns once across reconciles: " + JSON.stringify(warns34));
        assert.equal(count('"projbad34": 不支持 MCP SSE'), 1, "the project bad entry warns once across reconciles");
        assert.equal(count('"taken34" 未装载'), 1, "the name-taken warning is gated too");
        assert.ok(warns34.some((w) => w.includes("宿主全局 patch 行")), "the name-taken warning names host global patch rows, not just profile patches");
        assert.equal((await registry34.serverView(proj34, "taken34")).skipReason, "name-taken", "skipReason still reports the collision every round");
        // 集合变化（坏条目修好）后再坏一次 → 重新告警一次。
        await writeFile(userPaths34.mcpJson, JSON.stringify({ mcpServers: { taken34: { command: "node", args: ["t.js"] } } }), "utf8");
        await registry34.reconcileNow();
        assert.equal(count('"bad34": 不支持 MCP SSE'), 1, "fixing an entry does not warn");
        await writeFile(userPaths34.mcpJson, JSON.stringify({
          mcpServers: { taken34: { command: "node", args: ["t.js"] }, bad34: { type: "sse", url: "https://x/mcp" } }
        }), "utf8");
        await registry34.reconcileNow();
        assert.equal(count('"bad34": 不支持 MCP SSE'), 2, "a re-appearing bad entry warns again");
        for (const disposer of ctx34.disposers) {
          const cleanup = disposer();
          if (typeof cleanup === "function") cleanup();
        }
        pass("entry-error and name-taken warnings are gated on set changes");
      } finally {
        await rmRetry(home34);
        await rmRetry(proj34);
      }
    }

    // 35. profile 名校验（M10）：DSH_MCP_PROFILE 是外部输入，`../..` 之类不得被
    // join 进 profiles 目录读到目录外的文件；不合法按「解析不出」降级并告警一次。
    {
      const home35 = await mkdtemp(join(tmpdir(), "dsh-project-mcp-manager-profile-"));
      const proj35 = join(dir2, "proj35");
      try {
        await mkdir(proj35, { recursive: true });
        const userPaths35 = { mcpYml: join(home35, "mcp.yml"), mcpJson: join(home35, "mcp.json"), profilesDir: join(home35, "profiles") };
        // 目录外的"战利品"文件：越界读取会把它当 profile 层装载。
        await writeFile(join(home35, "outside.json"), JSON.stringify({ mcpServers: { escaped: { command: "node", args: ["e.js"] } } }), "utf8");
        await mkdir(join(home35, "profiles", "web"), { recursive: true });
        await writeFile(join(home35, "profiles", "web", "mcp.json"), JSON.stringify({ mcpServers: { okprofile: { command: "node", args: ["p.js"] } } }), "utf8");
        const ctx35 = fakeCtx();
        const warns35 = [];
        ctx35.logger.warn = (msg) => { warns35.push(String(msg)); };
        const registry35 = new ProjectMcpRegistry(ctx35, { globalNames: async () => [], activeProfile: async () => "..", userLayerPaths: userPaths35 });
        ctx35.agentsList.push(fakeAgent("session-profile", proj35));
        await registry35.reconcileNow();
        assert.ok(!ctx35.mounts.some((config) => config.serverName === "escaped"), "an out-of-tree profile name must not be read: " + ctx35.mounts.map((c) => c.serverName).join(","));
        assert.equal(warns35.filter((w) => w.includes("profile 名")).length, 1, "the invalid profile name warns once: " + JSON.stringify(warns35));
        await registry35.reconcileNow();
        assert.equal(warns35.filter((w) => w.includes("profile 名")).length, 1, "a stable invalid name stays silent");
        const snap35 = await registry35.snapshot();
        assert.ok(!snap35.some((file) => file.source === "dsh-profile-user"), "no profile partition for an unresolvable name");
        // 合法名照常读取。
        const ctxOk = fakeCtx();
        const registryOk = new ProjectMcpRegistry(ctxOk, { globalNames: async () => [], activeProfile: async () => "web", userLayerPaths: userPaths35 });
        ctxOk.agentsList.push(fakeAgent("session-profile-ok", proj35));
        await registryOk.reconcileNow();
        assert.ok(ctxOk.mounts.some((config) => config.serverName === "okprofile"), "a valid profile name still mounts its layer");
        for (const disposer of [...ctx35.disposers, ...ctxOk.disposers]) {
          const cleanup = disposer();
          if (typeof cleanup === "function") cleanup();
        }
        pass("invalid profile names are rejected before joining the profiles directory");
      } finally {
        await rmRetry(home35);
        await rmRetry(proj35);
      }
    }

    // 36. C4：对方 {version, servers} 项目文件写入诊断；~/.dsh/dsh-mcp.json 同理；
    // mcpServers 与 servers 并存时不告警。
    {
      const homeF = await mkdtemp(join(tmpdir(), "dsh-mcp-foreign-home-"));
      const projF = await mkdtemp(join(tmpdir(), "dsh-mcp-foreign-proj-"));
      try {
        await mkdir(join(projF, ".dsh"), { recursive: true });
        await writeFile(join(projF, ".dsh", "mcp.json"), JSON.stringify({ version: 1, servers: [{ name: "x" }] }), "utf8");
        await writeFile(join(homeF, "dsh-mcp.json"), JSON.stringify({ version: 1, servers: [] }), "utf8");
        await writeFile(join(homeF, "mcp.json"), JSON.stringify({ mcpServers: {}, servers: [] }), "utf8");
        const ctxF = fakeCtx();
        const warnsF = [];
        ctxF.logger.warn = (msg) => { warnsF.push(String(msg)); };
        const registryF = new ProjectMcpRegistry(ctxF, {
          globalNames: async () => [],
          userLayerPaths: { mcpYml: join(homeF, "mcp.yml"), mcpJson: join(homeF, "mcp.json"), profilesDir: join(homeF, "profiles") }
        });
        ctxF.agentsList.push(fakeAgent("session-foreign", projF));
        await registryF.reconcileNow();
        const diagF = await readDiag(projF);
        assert.ok(diagF.some((row) => typeof row.foreignFormat === "string" && row.foreignFormat.includes("dsh-mcp-manager")), "project diag names the foreign format: " + JSON.stringify(diagF));
        const globalDiag = parseDiagDocument(JSON.parse(await readFile(join(homeF, ".mcp-diag.json"), "utf8"))).events;
        assert.ok(globalDiag.some((row) => row.kind === "foreign-format" && String(row.path).includes("dsh-mcp.json")), "global diag mentions dsh-mcp.json: " + JSON.stringify(globalDiag));
        assert.ok(warnsF.some((w) => w.includes("dsh-mcp-manager")), "host log names the other plugin");
        assert.equal(warnsF.filter((w) => w.includes(join(homeF, "mcp.json")) && w.includes("dsh-mcp-manager")).length, 0, "mcpServers + servers together does not warn");
        for (const disposer of ctxF.disposers) {
          const cleanup = disposer();
          if (typeof cleanup === "function") cleanup();
        }
        pass("foreign {version, servers} format is diagnosed at project and user layers");
      } finally {
        await rmRetry(homeF);
        await rmRetry(projF);
      }
    }

    // 场景 24 的 unlink 会留下防抖后的迟到 reconcile 与 chokidar 内部重扫：
    // 先让队列落空再关 watcher，否则 close 与临时目录删除赛跑、句柄不释放。
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));

    for (const disposer of ctx2.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
  } finally {
    delete process.env.DSH_MCP_IGNORE_MCP_JSON;
    if (savedBin === undefined) delete process.env.CC_TEST_BIN;
    else process.env.CC_TEST_BIN = savedBin;
    if (savedMissing === undefined) delete process.env.CC_TEST_MISSING;
    else process.env.CC_TEST_MISSING = savedMissing;
    process.chdir(dir);
    await rmRetry(dir2);
    await rmRetry(home2);
  }
} finally {
  process.chdir(originalCwd);
  await rmRetry(dir);
}

{
  const dirH = await mkdtemp(join(tmpdir(), "dsh-mcp-health-"));
  const homeH = join(dirH, "home");
  const projH = join(dirH, "proj");
  await mkdir(join(homeH, ".dsh"), { recursive: true });
  await mkdir(projH, { recursive: true });
  const savedCwd = process.cwd();
  try {
    process.chdir(dirH);
    await writeManagedRows(projectMcpFile(projH), [stdioRow("alive")], { createIfMissing: true });
    const ctxH = fakeCtx();
    const registryH = new ProjectMcpRegistry(ctxH, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(homeH, ".dsh", "mcp.yml"), mcpJson: join(homeH, ".dsh", "mcp.json"), profilesDir: join(homeH, ".dsh", "profiles") },
      healthRemountBackoffMs: 0
    });
    ctxH.agentsList.push(fakeAgent("session-h", projH));
    await registryH.reconcileNow();
    assert.equal(ctxH.mounts.length, 1, "initial mount");
    const reads1 = registryH.debugConfigReadCount;
    await registryH.reconcileNow();
    assert.equal(registryH.debugConfigReadCount, reads1, "unchanged files skip reread");
    const effective = ctxH.mounts[0].serverName;
    ctxH.schemas.push({ id: "mcp__" + effective + "__ping" });
    await registryH.reconcileNow();
    ctxH.schemas.length = 0;
    await registryH.reconcileNow();
    assert.equal(ctxH.disposals.length, 1, "dead connection is unmounted once");
    assert.equal(ctxH.mounts.length, 2, "dead connection is remounted once");
    const diagH = await readDiag(projH);
    assert.ok(diagH.some((row) => row.kind === "remount" && row.attempt === 1), "remount diag: " + JSON.stringify(diagH.slice(-4)));
    await registryH.reconcileNow();
    await registryH.reconcileNow();
    await registryH.reconcileNow();
    assert.ok(ctxH.mounts.length >= 4, "three remounts then stop: " + ctxH.mounts.length);
    const diagGive = await readDiag(projH);
    assert.ok(diagGive.some((row) => row.kind === "give-up"), "give-up after remount limit: " + JSON.stringify(diagGive.slice(-6)));
    const mountsAtGiveUp = ctxH.mounts.length;
    await registryH.reconcileNow();
    assert.equal(ctxH.mounts.length, mountsAtGiveUp, "give-up stops further remounts");
    await writeManagedRows(projectMcpFile(projH), [{ ...stdioRow("alive"), config: { ...stdioRow("alive").config, args: ["srv-alive-2.js"] } }]);
    await registryH.reconcileNow();
    assert.ok(registryH.debugConfigReadCount > reads1, "fingerprint change rereads files");
    for (const disposer of ctxH.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    pass("registry remounts dead connections, gives up after the limit, and skips reread when fingerprints match");

    const dirD = await mkdtemp(join(tmpdir(), "dsh-mcp-disabled-"));
    const projD = join(dirD, "proj");
    await mkdir(projD, { recursive: true });
    await writeManagedRows(projectMcpFile(projD), [{ ...stdioRow("off"), disabled: true }], { createIfMissing: true });
    const ctxD = fakeCtx();
    const registryD = new ProjectMcpRegistry(ctxD, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(dirD, "home", ".dsh", "mcp.yml"), mcpJson: join(dirD, "home", ".dsh", "mcp.json"), profilesDir: join(dirD, "home", ".dsh", "profiles") },
      healthRemountBackoffMs: 0
    });
    ctxD.agentsList.push(fakeAgent("session-d", projD));
    await registryD.reconcileNow();
    assert.equal(ctxD.mounts.length, 0, "disabled rows never mount");
    await registryD.reconcileNow();
    assert.equal(ctxD.mounts.length, 0, "health remount does not revive disabled rows");
    for (const disposer of ctxD.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    await rmRetry(dirD);
    pass("registry health remount never revives disabled rows");

    const dirZ = await mkdtemp(join(tmpdir(), "dsh-mcp-nevertools-"));
    const projZ = join(dirZ, "proj");
    await mkdir(projZ, { recursive: true });
    await writeManagedRows(projectMcpFile(projZ), [stdioRow("quiet")], { createIfMissing: true });
    const ctxZ = fakeCtx();
    const registryZ = new ProjectMcpRegistry(ctxZ, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(dirZ, "home", ".dsh", "mcp.yml"), mcpJson: join(dirZ, "home", ".dsh", "mcp.json"), profilesDir: join(dirZ, "home", ".dsh", "profiles") },
      healthRemountBackoffMs: 0
    });
    ctxZ.agentsList.push(fakeAgent("session-z", projZ));
    await registryZ.reconcileNow();
    await registryZ.reconcileNow();
    await registryZ.reconcileNow();
    assert.equal(ctxZ.mounts.length, 1, "a server that never had tools is not remounted");
    assert.equal(ctxZ.disposals.length, 0);
    for (const disposer of ctxZ.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    await rmRetry(dirZ);
    pass("registry does not remount servers that never exposed tools");
  } finally {
    process.chdir(savedCwd);
    await rmRetry(dirH);
  }
}

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL PROJECT REGISTRY TESTS PASSED");
