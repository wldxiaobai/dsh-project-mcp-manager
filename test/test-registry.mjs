import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectMcpRegistry, projectMcpFile } from "../lib/registry.js";
import { MCP_BLOCK_BEGIN, MCP_BLOCK_END, writeManagedRows } from "../lib/mcp-file.js";

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
  return JSON.parse(await readFile(diagFile(projectRoot), "utf8"));
}

const stdioRow = (name, command = "node") => ({
  id: "panel-mcp-" + name,
  name: "@deepseek-ai/dsh-mcp-client",
  config: { serverName: name, transport: "stdio", command, args: [], env: {}, cwd: "sub", toolCallTimeoutMs: 60000, failOnStartupError: false, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } }
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
          denies.push([...deny].sort());
          return () => {};
        }
      }
    },
    denies
  };
}

const dir = await mkdtemp(join(tmpdir(), "dsh-project-mcp-manager-registry-"));
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
    // 用户层注入到不存在的目录：真实 home 的 ~/.dsh/mcp.yml、~/.claude.json 不得进入本套断言。
    userLayerPaths: { mcpYml: join(dir, "nohome", ".dsh", "mcp.yml"), claudeJson: join(dir, "nohome", ".claude.json") }
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
  const vanished = (await readDiag(projectC)).filter((row) => row.kind === "scan").at(-1);
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

  // ── 10+. Claude Code 适配层：.mcp.json / ~/.claude.json / 影子优先 / ${VAR} ──
  const dir2 = await mkdtemp(join(tmpdir(), "dsh-mcp-cc-"));
  const home2 = join(dir2, "fakehome"); // dir2 本身即进程 cwd 项目；fakehome 只是注入的用户层目录
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
        bad: { type: "sse", url: "http://example/" }
      }
    }), "utf8");
    await writeFile(join(home2, ".claude.json"), JSON.stringify({
      oauth: { secret: "never-read" },
      mcpServers: { gamma: { command: "node", args: ["g.js"] } },
      projects: { "C:/somewhere": { mcpServers: { localonly: { command: "node", args: [] } } } }
    }), "utf8");

    const ctx2 = fakeCtx();
    const registry2 = new ProjectMcpRegistry(ctx2, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(home2, ".dsh", "mcp.yml"), claudeJson: join(home2, ".claude.json") }
    });
    ctx2.agentsList.push(fakeAgent("session-e", dir2));
    await registry2.reconcileNow();

    // 10. 装载集合：cc-project(alpha)+cc-user(gamma) 生效；beta 因缺变量跳过、bad(sse) 拒载、localonly 不读
    const names10 = ctx2.mounts.map((config) => config.serverName).sort();
    assert.deepEqual(names10, ["alpha", "gamma"], "CC project+user rows mount; sse and missing-env rows do not; local scope excluded");
    const alpha10 = ctx2.mounts.find((config) => config.serverName === "alpha");
    assert.equal(alpha10.cwd, dir2, "CC stdio cwd defaults to project root");
    const diagE10 = await readDiag(dir2);
    assert.ok(diagE10.some((row) => row.kind === "scan" && Array.isArray(row.ccEntryErrors) && row.ccEntryErrors.some((note) => note.includes("bad"))), "sse entry error recorded in scan diag");
    assert.ok(diagE10.some((row) => row.kind === "env-missing" && row.rawName === "beta" && row.missingVar === "CC_TEST_MISSING"), "env-missing diag names the variable, not the value");
    pass("registry mounts CC-dialect rows and reports per-entry/env failures");

    // 11. 快照分区：yml 缺失不出分区；cc-project 分区带行与 entryErrors；两个 global 用户层分区
    const snap11 = await registry2.snapshot();
    assert.equal(snap11.find((file) => file.path === projectMcpFile(dir2)), undefined, "absent project yml yields no partition");
    const ccPart11 = snap11.find((file) => file.source === "cc-project");
    assert.ok(ccPart11 !== undefined && ccPart11.project === dir2);
    assert.deepEqual(ccPart11.servers.map((server) => server.serverName).sort(), ["alpha", "beta"]);
    assert.ok(Array.isArray(ccPart11.entryErrors) && ccPart11.entryErrors.some((note) => note.includes("bad")));
    const betaView11 = ccPart11.servers.find((server) => server.serverName === "beta");
    assert.equal(betaView11.fiberPhase, "pending", "env-skipped row shows pending, not active");
    const userYml11 = snap11.find((file) => file.source === "user-yml");
    assert.ok(userYml11 === undefined, "no user yml yet");
    const ccUser11 = snap11.find((file) => file.source === "cc-user");
    assert.ok(ccUser11 !== undefined && ccUser11.kind === "global");
    assert.deepEqual(ccUser11.servers.map((server) => server.serverName), ["gamma"]);
    pass("snapshot partitions CC project file and user layers");

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
      { ...stdioRow("eta"), config: { ...stdioRow("eta").config, command: "${CC_TEST_BIN}", env: { T: "${CC_TEST_MISSING}" } } }
    ]);
    await registry2.reconcileNow();
    const beta13 = ctx2.mounts.filter((config) => config.serverName === "beta").at(-1);
    assert.ok(beta13 !== undefined, "beta mounts once its env var exists");
    assert.equal(beta13.env.T, "sekret", "${VAR} expanded from process.env at mount time");
    assert.equal(beta13.command, "node", "${VAR} expanded in command too");
    const eta13 = ctx2.mounts.filter((config) => config.serverName === "eta").at(-1);
    assert.ok(eta13 !== undefined, "native yml row with ${VAR} mounts expanded");
    assert.equal(eta13.env.T, "sekret");
    assert.equal(eta13.command, "node");
    pass("registry expands whole-value ${VAR} refs from the environment for all sources");

    // 14. 用户层 yml 热装载（watcher 事件驱动，非 reconcileNow）
    await writeManagedRows(join(home2, ".dsh", "mcp.yml"), [stdioRow("epsilon")], { createIfMissing: true });
    const epsilonActive = await registry2.waitForState(dir2, "epsilon", (state) => state?.phase === "active", 5000);
    assert.ok(epsilonActive, "user ~/.dsh/mcp.yml row hot-mounts via the user watcher");
    pass("registry watches and hot-mounts the user ~/.dsh/mcp.yml");

    // 15. ~/.claude.json 哈希门：CC 重写无关状态位不触发 reconcile
    // 先等对账计数稳定（14 的热事件可能还有余波），基线才可信。
    let count15 = registry2.debugReconcileCount;
    for (let waited = 0; waited < 6000; waited += 300) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
      const next = registry2.debugReconcileCount;
      if (next === count15) break;
      count15 = next;
    }
    const claude15 = JSON.parse(await readFile(join(home2, ".claude.json"), "utf8"));
    claude15.telemetry = { ping: 9 };
    await writeFile(join(home2, ".claude.json"), JSON.stringify(claude15), "utf8");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
    assert.equal(registry2.debugReconcileCount, count15, "mcpServers-unchanged rewrite must not reconcile");
    const gate15 = JSON.parse(await readFile(join(home2, ".claude.json"), "utf8"));
    gate15.mcpServers.zeta = { command: "node", args: [] };
    await writeFile(join(home2, ".claude.json"), JSON.stringify(gate15), "utf8");
    const zetaActive = await registry2.waitForState(dir2, "zeta", (state) => state?.phase === "active", 5000);
    assert.ok(zetaActive, "changed mcpServers subtree passes the hash gate and mounts");
    pass("claude.json watcher gates on the mcpServers subtree hash");

    for (const disposer of ctx2.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
  } finally {
    if (savedBin === undefined) delete process.env.CC_TEST_BIN;
    else process.env.CC_TEST_BIN = savedBin;
    if (savedMissing === undefined) delete process.env.CC_TEST_MISSING;
    else process.env.CC_TEST_MISSING = savedMissing;
    process.chdir(dir);
    await rm(dir2, { recursive: true, force: true });
  }
} finally {
  process.chdir(originalCwd);
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL PROJECT REGISTRY TESTS PASSED");
