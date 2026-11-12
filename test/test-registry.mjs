import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectMcpRegistry, parseDiagDocument, planProjectChanges, projectMcpFile, mergeSourcedRows, profileNameFromConfigPath } from "../lib/registry.js";
import { bindProjectMcpService, PROJECT_MCP_SERVICE } from "../lib/service.js";
import { apply, PROJECT_MCP_UPDATED_EVENT } from "../lib/index.js";
import { MCP_BLOCK_BEGIN, MCP_BLOCK_END, extractManagedRows, writeManagedRows } from "../lib/mcp-file.js";
import { byCodeUnit } from "../lib/model.js";
import { projectDiagFile } from "../lib/dsh-paths.js";

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}

const diagFile = (dshHome, projectRoot) => projectDiagFile(dshHome, projectRoot);
const legacyDiagFile = (projectRoot) => join(projectRoot, ".dsh", ".mcp-diag.json");
async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function readDiag(dshHome, projectRoot) {
  return parseDiagDocument(JSON.parse(await readFile(diagFile(dshHome, projectRoot), "utf8"))).events;
}
async function readDiagSummary(dshHome, projectRoot) {
  return parseDiagDocument(JSON.parse(await readFile(diagFile(dshHome, projectRoot), "utf8"))).summary;
}
/** 轮询 diag 直到谓词成立：事件驱动用例里对账链可能仍在落盘（不能用固定 sleep）。 */
async function waitForDiag(dshHome, projectRoot, predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (predicate(await readDiag(dshHome, projectRoot))) return true;
    } catch {
      // diag 尚不存在或正被半读到截断 JSON：视为「暂不满足」，继续轮询。
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

/** 读某个 Lazy fixture 的 trace；每个标签一份，避免多个子进程并发写同一文件。 */
async function readTraceLines(path) {
  try {
    return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}
/** 轮询 trace 直到谓词成立：等子进程真正退出，不用固定 sleep。
 * 每次检查与退避有先后依赖，不能预先并发启动各轮检查。
 */
async function waitForTrace(path, predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate(await readTraceLines(path))) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
}

const stdioRow = (name, command = "node") => ({
  id: "panel-mcp-" + name,
  name: "@deepseek-ai/dsh-mcp-client",
  config: { serverName: name, transport: "stdio", command, args: ["srv-" + name + ".js"], env: {}, cwd: "sub", toolCallTimeoutMs: 60000, failOnStartupError: false, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } }
});

/** 最小假宿主 ctx：记录 plugin 装载与 restrict 调用；effect 收集清理器；on 记录监听器供 emit 触发。 */
function fakeCtx() {
  const mounts = [];
  const disposals = [];
  const restrictions = [];
  const agents = [];
  const disposers = [];
  const schemas = []; // 全局工具注册表（测试按需 push 工具名）
  const handlers = new Map(); // 事件名 → 监听器数组（emit 用）
  const ctx = {
    mounts,
    disposals,
    restrictions,
    agentsList: agents,
    disposers,
    schemas,
    handlers,
    provided: {},
    on(name, callback) {
      const list = handlers.get(name) ?? [];
      list.push(callback);
      handlers.set(name, list);
      return () => {
        const index = list.indexOf(callback);
        if (index >= 0) list.splice(index, 1);
      };
    },
    /** 触发已注册的宿主事件（mock 需要；真实宿主由 dsh 派发）。 */
    emit(name, ...args) {
      for (const callback of handlers.get(name) ?? []) callback(...args);
    },
    provide(name, value) {
      this.provided[name] = value;
      return () => {
        delete this.provided[name];
      };
    },
    effect(callback) {
      if (typeof callback === "function") disposers.push(callback);
    },
    logger: { warn() {}, error() {}, info() {} },
    tools: {
      schemas: () => schemas
    },
    holdFibers: false,
    held: [],
    holdDispose: false,
    releaseDispose: [],
    plugin(_plugin, config) {
      let resolved = false;
      const fiber = {
        config,
        dispose: async () => {
          disposals.push(config.serverName);
          if (ctx.holdDispose) {
            await new Promise((resolveDispose) => {
              ctx.releaseDispose.push(resolveDispose);
            });
          }
        },
        then(onFulfilled) {
          if (!resolved) {
            resolved = true;
            if (ctx.holdFibers) ctx.held.push(() => onFulfilled?.());
            else queueMicrotask(() => onFulfilled?.());
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

// ── 0.8 planProjectChanges：连接字段 vs 非连接字段（纯函数）──────────────────
{
  const rowOf = (config) => ({ id: "panel-mcp-alpha", name: "@deepseek-ai/dsh-mcp-client", config });
  const baseConfig = {
    serverName: "alpha",
    transport: "stdio",
    command: "node",
    args: ["a.js"],
    env: {},
    cwd: "",
    toolCallTimeoutMs: 60000,
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }
  };
  const projectKey = "proj-key-for-plan";
  const effective = new Map([[projectKey + "\u0000alpha", "alpha"]]);
  const current = [{ rawName: "alpha", effectiveName: "alpha", row: rowOf(baseConfig) }];
  const desired = (config) => [{ rawName: "alpha", source: "dsh-project", row: rowOf(config) }];
  assert.deepEqual(
    planProjectChanges(current, desired(baseConfig), effective, projectKey),
    { toUnmount: [], toMount: [] },
    "an unchanged row is left alone"
  );
  // tools.allow/deny 只影响 restrict（就地换 state.row），不是连接字段。
  assert.deepEqual(
    planProjectChanges(current, desired({ ...baseConfig, tools: { deny: ["echo_*"] } }), effective, projectKey),
    { toUnmount: [], toMount: [] },
    "tools-only edit keeps the fiber"
  );
  // maxInstructionBytes 只在连接时被官方读取：改它必须拆连接，顺序（先 unmount 再 mount）由 reconcileContainer 保证。
  const plan = planProjectChanges(current, desired({ ...baseConfig, maxInstructionBytes: 4096 }), effective, projectKey);
  assert.deepEqual(plan.toUnmount, ["alpha"], "connection-field change unmounts first");
  assert.deepEqual(plan.toMount.map((item) => item.rawName), ["alpha"], "and mounts the same rawName back with the new row");
  // 生效名变化同样拆连接（原名不变时全局冲突会让项目行改名）。
  const renamed = planProjectChanges(current, desired(baseConfig), new Map([[projectKey + "\u0000alpha", "p123abc_alpha"]]), projectKey);
  assert.deepEqual(renamed.toUnmount, ["alpha"]);
  assert.deepEqual(renamed.toMount.map((item) => item.rawName), ["alpha"]);
  pass("planProjectChanges remounts on connection-field and effective-name changes but not for tools-only edits");
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
  ctx.schemas.push({ name: "mcp__" + mounted.serverName + "__echo" });
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
  const home0 = join(dir, "nohome", ".dsh");
  const summaryA = await readDiagSummary(home0, projectA);
  assert.ok(summaryA !== undefined, "configured project diag includes a summary");
  assert.ok(summaryA.rows >= 1, "summary counts project rows");
  assert.ok(summaryA.mounted >= 1, "summary counts mounted servers");
  assert.equal(await pathExists(legacyDiagFile(projectA)), false, "project diag is not written into the workspace");
  await writeFile(legacyDiagFile(projectA), "{}\n", "utf8");
  await registry.reconcileNow();
  assert.equal(await pathExists(legacyDiagFile(projectA)), false, "a leftover workspace diag is removed on the next reconcile");
  assert.equal(await pathExists(diagFile(home0, projectB)), false, "zero-config project still has no diag after summary writes");
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
  assert.equal(await pathExists(diagFile(join(dir, "nohome", ".dsh"), projectB)), false, "clean project without mcp.yml must not get a diag file");
  assert.equal(await pathExists(legacyDiagFile(projectB)), false, "clean project does not get a workspace diag file");
  assert.equal((await registry.snapshot()).find((file) => file.project === projectB), undefined, "project without config is not a known project");
  const diagA = await readDiag(join(dir, "nohome", ".dsh"), projectA);
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
  assert.equal(await pathExists(diagFile(join(dir, "nohome", ".dsh"), projectC)), true, "configured project gets a diag file outside the workspace");
  assert.equal(await pathExists(legacyDiagFile(projectC)), false, "configured project diag stays out of the workspace");
  await rm(projectMcpFile(projectC), { force: true });
  await registry.reconcileNow();
  const vanished = (await readDiag(join(dir, "nohome", ".dsh"), projectC)).findLast((row) => row.kind === "scan");
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
  const diagD = await readDiag(join(dir, "nohome", ".dsh"), projectD);
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
    const diagE10 = await readDiag(join(home2, ".dsh"), dir2);
    assert.ok(diagE10.some((row) => row.kind === "scan" && Array.isArray(row.ccEntryErrors) && row.ccEntryErrors.some((note) => note.includes("bad"))), "sse entry error recorded in scan diag");
    assert.ok(diagE10.some((row) => row.kind === "env-missing" && row.rawName === "beta" && row.missingVar === "CC_TEST_MISSING"), "env-missing diag names the variable, not the value");
    const summaryE10 = await readDiagSummary(join(home2, ".dsh"), dir2);
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
    const diag12 = await readDiag(join(home2, ".dsh"), dir2);
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
      const seen19 = await waitForDiag(join(home2, ".dsh"), dir2, (lines) => lines.some((row) => row.kind === "env-invalid" && row.rawName === "http-bad"), 5000);
      assert.ok(seen19, "post-expansion schema failure lands as env-invalid diag");
      const diag19 = await readDiag(join(home2, ".dsh"), dir2);
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
    assert.equal(await pathExists(diagFile(join(home2, ".dsh"), dir5)), false, "a project with no rows writes no diagnostics");
    // 对照：真实 yml 行装载后文件被删 → 记 scan 错仍是正确行为
    await writeManagedRows(projectMcpFile(dir5), [stdioRow("real-yml")], { createIfMissing: true });
    await registry2.reconcileNow();
    assert.ok(await registry2.waitForState(dir5, "real-yml", (state) => state?.phase === "active", 5000), "project yml row mounts");
    await rm(projectMcpFile(dir5));
    await registry2.reconcileNow();
    const diag24 = await readDiag(join(home2, ".dsh"), dir5);
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
          await waitForDiag(join(home2, ".dsh"), dir6, (rows) => rows.some((r) => r.kind === "scan" && Array.isArray(r.shadowedIdentity)
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
        ctx2.schemas.push({ name: "mcp__unity-mcp__ping" }, { name: "mcp__unityMCP__ping" });
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
      // profile 原生 yml（profiles/<name>/mcp.yml）：压过该 profile 的 mcp.json 与 ~/.dsh/mcp.yml。
      await writeManagedRows(join(home2, ".dsh", "profiles", "web", "mcp.yml"), [stdioRow("ymlprofile"), stdioRow("jsonprofile"), stdioRow("jsonuser")], { createIfMissing: true });
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
      for (const expected of ["jsonproj", "jsonprofile", "jsonuser", "ymlprofile"]) {
        assert.ok(names29.includes(expected), `${expected} mounts from its DSH json layer: ${names29.join(",")}`);
      }
      assert.equal(names29.filter((name) => name === "jsonuser").length, 1, "user json row mounts once for the whole host");
      assert.equal(names29.filter((name) => name === "jsonprofile").length, 1, "profile json row mounts once for the whole host");
      const both29 = ctx3.mounts.findLast((config) => config.serverName === "both");
      assert.deepEqual(both29.args, ["srv-both.js"], "yml wins over .dsh/mcp.json for the same name");
      const profileYmlWin = ctx3.mounts.findLast((config) => config.serverName === "jsonprofile");
      assert.deepEqual(profileYmlWin.args, ["srv-jsonprofile.js"], "profile yml wins over profile mcp.json for the same name");
      const userShadowed = ctx3.mounts.findLast((config) => config.serverName === "jsonuser");
      assert.deepEqual(userShadowed.args, ["srv-jsonuser.js"], "profile yml wins over ~/.dsh/mcp.json for the same name");
      const snap29 = await registry3.snapshot();
      assert.ok(snap29.some((file) => file.source === "dsh-project-json" && file.project === dir7), "project json partition present");
      const userPart29 = snap29.find((file) => file.source === "dsh-user" && file.kind === "global");
      assert.ok(userPart29 !== undefined, "user json partition present");
      assert.equal(userPart29.servers[0].fiberPhase, null, "shadowed user json row is not active");
      assert.ok(snap29.some((file) => file.source === "dsh-profile-user" && file.kind === "global"), "profile json partition present");
      const profileYmlPart = snap29.find((file) => file.source === "dsh-profile-user-yml" && file.kind === "global");
      assert.ok(profileYmlPart !== undefined, "profile yml partition present");
      assert.ok(profileYmlPart.servers.some((server) => server.serverName === "ymlprofile" && server.fiberPhase === "active"), "profile yml row is active");
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
        ctxA.schemas.push({ name: "mcp__selfx__ping" });
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
        ctxB.schemas.push({ name: "mcp__hostx__ping" }, { name: `mcp__${projectEffective}__ping` });
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
        assert.equal(await pathExists(diagFile(home33, proj33)), false, "a zero-config project stays free of a dsh-home diag");
        assert.equal(await pathExists(legacyDiagFile(proj33)), false, "a zero-config project stays free of a workspace diag");
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
        const diagF = await readDiag(homeF, projF);
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
  // M8：启动时没有对方全局文件，创建 `dsh-mcp.json` 必须经用户 watcher kick 对账并诊断。
  const homeW = await mkdtemp(join(tmpdir(), "dsh-mcp-foreign-watch-"));
  const projW = await mkdtemp(join(tmpdir(), "dsh-mcp-foreign-watch-proj-"));
  try {
    await mkdir(join(projW, ".dsh"), { recursive: true });
    const ctxW = fakeCtx();
    const registryW = new ProjectMcpRegistry(ctxW, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(homeW, "mcp.yml"), mcpJson: join(homeW, "mcp.json"), profilesDir: join(homeW, "profiles") }
    });
    ctxW.agentsList.push(fakeAgent("session-fw", projW));
    await registryW.reconcileNow();
    let countW = registryW.debugReconcileCount;
    for (let waited = 0; waited < 6000; waited += 300) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
      const next = registryW.debugReconcileCount;
      if (next === countW) break;
      countW = next;
    }
    await writeFile(join(homeW, "dsh-mcp.json"), JSON.stringify({ version: 1, servers: [] }), "utf8");
    const startedW = Date.now();
    let kicked = false;
    while (Date.now() - startedW < 5000) {
      if (registryW.debugReconcileCount > countW) {
        try {
          const events = parseDiagDocument(JSON.parse(await readFile(join(homeW, ".mcp-diag.json"), "utf8"))).events;
          if (events.some((row) => row.kind === "foreign-format" && String(row.path).includes("dsh-mcp.json"))) {
            kicked = true;
            break;
          }
        } catch {
          // 诊断尚未落盘
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    }
    assert.ok(kicked, "creating dsh-mcp.json must kick reconcile and diagnose the foreign format");
    assert.equal(ctxW.mounts.length, 0, "foreign dsh-mcp.json is never mounted");
    for (const disposer of ctxW.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    pass("registry watches ~/.dsh/dsh-mcp.json and diagnoses it without mounting");
  } finally {
    await rmRetry(homeW);
    await rmRetry(projW);
  }
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
    const pulseDead = async () => {
      ctxH.schemas.push({ name: "mcp__" + effective + "__ping" });
      await registryH.reconcileNow();
      ctxH.schemas.length = 0;
      await registryH.reconcileNow();
      await registryH.reconcileNow();
    };
    await pulseDead();
    assert.equal(ctxH.disposals.length, 1, "dead connection is unmounted once");
    assert.equal(ctxH.mounts.length, 2, "dead connection is remounted once");
    const diagH = await readDiag(join(homeH, ".dsh"), projH);
    assert.ok(diagH.some((row) => row.kind === "remount" && row.attempt === 1), "remount diag: " + JSON.stringify(diagH.slice(-4)));
    const mountsAfterFirst = ctxH.mounts.length;
    await registryH.reconcileNow();
    await registryH.reconcileNow();
    assert.equal(ctxH.mounts.length, mountsAfterFirst, "new fiber without tools does not remount (official reconnect window)");

    ctxH.schemas.push({ name: "mcp__" + effective + "__ping" });
    await registryH.reconcileNow();
    const mountsFlicker = ctxH.mounts.length;
    ctxH.schemas.length = 0;
    await registryH.reconcileNow();
    ctxH.schemas.push({ name: "mcp__" + effective + "__ping" });
    await registryH.reconcileNow();
    assert.equal(ctxH.mounts.length, mountsFlicker, "brief 0-tool window on the same fiber does not remount");
    assert.equal(registryH.debugHealth(projH, "alive")?.remountCount, 0, "tools returning reset remountCount");

    await pulseDead();
    await pulseDead();
    await pulseDead();
    assert.equal(ctxH.mounts.length, 5, "four recovered deaths remount four times, no give-up: " + ctxH.mounts.length);
    ctxH.schemas.push({ name: "mcp__" + effective + "__ping" });
    await registryH.reconcileNow();
    assert.equal(registryH.debugHealth(projH, "alive")?.remountCount, 0, "recovery after the fourth remount still resets the counter");
    assert.equal(registryH.debugHealth(projH, "alive")?.givenUp, false);

    ctxH.schemas.length = 0;
    await registryH.reconcileNow();
    await registryH.reconcileNow();
    await registryH.reconcileNow();
    await registryH.reconcileNow();
    await registryH.reconcileNow();
    const diagGive = await readDiag(join(homeH, ".dsh"), projH);
    assert.ok(diagGive.some((row) => row.kind === "give-up"), "give-up after remount limit without recovery: " + JSON.stringify(diagGive.slice(-6)));
    const mountsAtGiveUp = ctxH.mounts.length;
    await registryH.reconcileNow();
    assert.equal(ctxH.mounts.length, mountsAtGiveUp, "give-up stops further remounts");
    const summaryGive = await readDiagSummary(join(homeH, ".dsh"), projH);
    assert.ok(summaryGive?.unhealthy.some((item) => item.name === "alive" && item.reason === "give-up"), "give-up is unhealthy in summary: " + JSON.stringify(summaryGive));
    assert.ok((summaryGive?.skippedByReason["give-up"] ?? 0) >= 1, "summary counts give-up skips");
    const giveView = (await registryH.snapshot()).flatMap((file) => file.servers ?? []).find((row) => row.serverName === "alive");
    assert.equal(giveView?.skipReason, "give-up", "snapshot skipReason is give-up while the fiber is still active");

    ctxH.schemas.push({ name: "mcp__" + effective + "__ping" });
    await registryH.reconcileNow();
    assert.equal(registryH.debugHealth(projH, "alive")?.givenUp, false, "tools returning after give-up clears givenUp");
    assert.equal(registryH.debugHealth(projH, "alive")?.remountCount, 0);
    const summaryRecovered = await readDiagSummary(join(homeH, ".dsh"), projH);
    assert.ok(summaryRecovered?.unhealthy.every((item) => item.reason !== "give-up"), "summary drops give-up after recovery: " + JSON.stringify(summaryRecovered));
    assert.ok((summaryRecovered?.mounted ?? 0) >= 1, "recovered row counts as mounted");
    const recoveredView = (await registryH.snapshot()).flatMap((file) => file.servers ?? []).find((row) => row.serverName === "alive");
    assert.equal(recoveredView?.skipReason, null, "snapshot no longer marks give-up after tools return");

    const snapCount = registryH.debugReconcileCount;
    const during = registryH.reconcileNow();
    const snapA = registryH.snapshot();
    const snapB = registryH.snapshot();
    await during;
    const [viewA, viewB] = await Promise.all([snapA, snapB]);
    const rowA = viewA.flatMap((file) => file.servers ?? []).find((row) => row.serverName === "alive");
    const rowB = viewB.flatMap((file) => file.servers ?? []).find((row) => row.serverName === "alive");
    assert.equal(rowA?.fiberPhase, rowB?.fiberPhase, "concurrent snapshots share one reconcile generation");
    assert.equal(rowA?.skipReason, rowB?.skipReason);
    await registryH.snapshot();
    await registryH.snapshot();
    assert.equal(registryH.debugReconcileCount, snapCount + 1, "snapshot is read-only and does not reconcile");
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

    const dirT = await mkdtemp(join(tmpdir(), "dsh-mcp-tools-"));
    const projT = join(dirT, "proj");
    await mkdir(projT, { recursive: true });
    const filtered = {
      ...stdioRow("box"),
      config: { ...stdioRow("box").config, tools: { allow: ["read_*"], deny: ["read_secret"] } }
    };
    await writeManagedRows(projectMcpFile(projT), [filtered], { createIfMissing: true });
    const ctxT = fakeCtx();
    const warnsT = [];
    ctxT.logger.warn = (msg) => { warnsT.push(String(msg)); };
    const registryT = new ProjectMcpRegistry(ctxT, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(dirT, "home", ".dsh", "mcp.yml"), mcpJson: join(dirT, "home", ".dsh", "mcp.json"), profilesDir: join(dirT, "home", ".dsh", "profiles") }
    });
    const agentT = fakeAgent("session-t", projT);
    let restrictCalls = 0;
    const innerRestrict = agentT.ctx.tools.restrict;
    agentT.ctx.tools.restrict = (opts) => {
      restrictCalls += 1;
      if (restrictCalls === 1) throw new Error("unknown tool name");
      return innerRestrict(opts);
    };
    ctxT.agentsList.push(agentT);
    await registryT.reconcileNow();
    const mountedT = ctxT.mounts[0].serverName;
    ctxT.schemas.push(
      { name: `mcp__${mountedT}__read_file` },
      { name: `mcp__${mountedT}__read_secret` },
      { name: `mcp__${mountedT}__delete_file` }
    );
    await registryT.reconcileNow();
    assert.ok(warnsT.some((w) => w.includes("暂未应用")), "unknown names are retried: " + warnsT.join("|"));
    await registryT.reconcileNow();
    const lastDeny = agentT.denies.at(-1);
    assert.ok(lastDeny.includes(`mcp__${mountedT}__delete_file`), "allow-list denies unmatched tools: " + lastDeny);
    assert.ok(lastDeny.includes(`mcp__${mountedT}__read_secret`), "deny wins over allow: " + lastDeny);
    assert.ok(!lastDeny.includes(`mcp__${mountedT}__read_file`), "allowed tools stay visible: " + lastDeny);
    assert.ok(!ctxT.mounts[0].tools, "tools filter is stripped before ctx.plugin");
    const mountsAfterFilter = ctxT.mounts.length;
    const denyAfter = agentT.denies.at(-1);
    await writeManagedRows(projectMcpFile(projT), [{
      ...filtered,
      config: { ...filtered.config, tools: { allow: ["read_*"], deny: ["read_secret", "read_file"] } }
    }]);
    await registryT.reconcileNow();
    assert.equal(ctxT.mounts.length, mountsAfterFilter, "tools-only edits must not remount");
    const denyAfterEdit = agentT.denies.at(-1);
    assert.ok(denyAfterEdit.includes(`mcp__${mountedT}__read_file`), "tools.deny change updates restrict without remount: " + denyAfterEdit);
    assert.notEqual(denyAfterEdit.join("\n"), denyAfter.join("\n"), "restrict deny set changes after tools.deny edit");
    for (const disposer of ctxT.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    await rmRetry(dirT);
    pass("registry expands tools.allow/deny to registered names and retries unknown denies");

    const dirGlob = await mkdtemp(join(tmpdir(), "dsh-mcp-badglob-"));
    const projGlob = join(dirGlob, "proj");
    await mkdir(projGlob, { recursive: true });
    await writeManagedRows(projectMcpFile(projGlob), [{
      ...stdioRow("box"),
      config: { ...stdioRow("box").config, tools: { deny: ["[z-a]", "delete_*"] } }
    }], { createIfMissing: true });
    const ctxGlob = fakeCtx();
    const warnsGlob = [];
    ctxGlob.logger.warn = (msg) => { warnsGlob.push(String(msg)); };
    const registryGlob = new ProjectMcpRegistry(ctxGlob, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(dirGlob, "home", ".dsh", "mcp.yml"), mcpJson: join(dirGlob, "home", ".dsh", "mcp.json"), profilesDir: join(dirGlob, "home", ".dsh", "profiles") }
    });
    ctxGlob.agentsList.push(fakeAgent("session-glob", projGlob));
    await registryGlob.reconcileNow();
    assert.equal(ctxGlob.mounts.length, 1, "illegal glob still mounts the server");
    assert.ok(warnsGlob.some((w) => w.includes("工具过滤 glob 无效") && w.includes("[z-a]")), "illegal glob is warned: " + warnsGlob.join("|"));
    for (const disposer of ctxGlob.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    await rmRetry(dirGlob);
    pass("registry warns on illegal tool globs without skipping the row");

    const dirBgt = await mkdtemp(join(tmpdir(), "dsh-mcp-budget-"));
    const projBgt = join(dirBgt, "proj");
    await mkdir(projBgt, { recursive: true });
    await writeManagedRows(projectMcpFile(projBgt), [stdioRow("heavy")], { createIfMissing: true });
    const ctxBgt = fakeCtx();
    const warnsBgt = [];
    ctxBgt.logger.warn = (msg) => { warnsBgt.push(String(msg)); };
    const registryBgt = new ProjectMcpRegistry(ctxBgt, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(dirBgt, "home", ".dsh", "mcp.yml"), mcpJson: join(dirBgt, "home", ".dsh", "mcp.json"), profilesDir: join(dirBgt, "home", ".dsh", "profiles") },
      toolBudget: { maxTools: 2, maxBytes: 1024 * 1024 }
    });
    ctxBgt.agentsList.push(fakeAgent("session-bgt", projBgt));
    await registryBgt.reconcileNow();
    const heavyName = ctxBgt.mounts[0].serverName;
    ctxBgt.schemas.push(
      { name: `mcp__${heavyName}__a`, description: "a" },
      { name: `mcp__${heavyName}__b`, description: "b" },
      { name: `mcp__${heavyName}__c`, description: "c" }
    );
    await registryBgt.reconcileNow();
    const budgetWarns = warnsBgt.filter((w) => w.includes("超过告警阈值"));
    assert.equal(budgetWarns.length, 1, "budget warns once: " + budgetWarns.join("|"));
    await registryBgt.reconcileNow();
    assert.equal(warnsBgt.filter((w) => w.includes("超过告警阈值")).length, 1, "budget warn is gated");
    const summaryBgt = await readDiagSummary(join(dirBgt, "home", ".dsh"), projBgt);
    assert.ok(summaryBgt.toolBudget?.some((item) => item.name === heavyName && item.tools === 3), "summary lists over-budget server: " + JSON.stringify(summaryBgt.toolBudget));
    assert.equal(ctxBgt.schemas.length, 3, "budget never clips tools");
    ctxBgt.schemas.length = 1;
    await registryBgt.reconcileNow();
    assert.equal(warnsBgt.filter((w) => w.includes("超过告警阈值")).length, 1, "under-budget clears the gate without warning");
    ctxBgt.schemas.push(
      { name: `mcp__${heavyName}__b`, description: "b" },
      { name: `mcp__${heavyName}__c`, description: "c" }
    );
    await registryBgt.reconcileNow();
    assert.equal(warnsBgt.filter((w) => w.includes("超过告警阈值")).length, 2, "same over-budget count warns again after dropping under the threshold");
    for (const disposer of ctxBgt.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    await rmRetry(dirBgt);
    pass("registry warns once when a server exceeds the tool budget and never clips");
  } finally {
    process.chdir(savedCwd);
    await rmRetry(dirH);
  }
}

{
  const dirSvc = await mkdtemp(join(tmpdir(), "dsh-mcp-service-"));
  const homeSvc = join(dirSvc, "home");
  const projSvc = join(dirSvc, "proj");
  await mkdir(join(homeSvc, ".dsh"), { recursive: true });
  await mkdir(projSvc, { recursive: true });
  await writeManagedRows(projectMcpFile(projSvc), [stdioRow("query")], { createIfMissing: true });
  const ctxSvc = fakeCtx();
  const updates = [];
  const warnsSvc = [];
  ctxSvc.logger.warn = (message) => warnsSvc.push(String(message));
  ctxSvc.on(PROJECT_MCP_UPDATED_EVENT, () => updates.push(1));
  const registrySvc = new ProjectMcpRegistry(ctxSvc, {
    globalNames: async () => [],
    userLayerPaths: { mcpYml: join(homeSvc, ".dsh", "mcp.yml"), mcpJson: join(homeSvc, ".dsh", "mcp.json"), profilesDir: join(homeSvc, ".dsh", "profiles") }
  });
  ctxSvc.agentsList.push(fakeAgent("session-svc", projSvc));
  const service = bindProjectMcpService(registrySvc);
  await service.reload();
  const snapService = await service.snapshot();
  const snapRegistry = await registrySvc.snapshot();
  assert.deepEqual(snapService, snapRegistry, "provided snapshot matches registry.snapshot");
  const viewService = await service.serverView(projSvc, "query");
  const viewRegistry = await registrySvc.serverView(projSvc, "query");
  assert.deepEqual(viewService, viewRegistry, "provided serverView matches registry.serverView");
  assert.equal(viewService?.serverName, "query");
  assert.equal(service.globalState("query"), registrySvc.globalState("query"));
  assert.equal(service.globalState("query"), undefined, "project rows are not global state");
  const before = registrySvc.debugReconcileCount;
  const updatesBeforeReload = updates.length;
  await service.reload();
  assert.ok(registrySvc.debugReconcileCount > before, "reload runs reconcileNow");
  assert.equal(updates.length, updatesBeforeReload + 1, "each successful reconcile emits projectMcp/updated");
  assert.ok(updatesBeforeReload >= 1, "constructor reconcile emits before the explicit reload");
  const updatesAfterReconcile = updates.length;
  await service.snapshot();
  await service.serverView(projSvc, "query");
  assert.equal(service.globalState("query"), undefined);
  assert.equal(updates.length, updatesAfterReconcile, "snapshot/serverView/globalState do not emit");
  ctxSvc.on(PROJECT_MCP_UPDATED_EVENT, () => {
    throw new Error("listener boom");
  });
  await service.reload();
  assert.equal(updates.length, updatesAfterReconcile + 1, "a throwing listener does not drop the reconcile");
  assert.ok(warnsSvc.some((message) => message.includes("变更事件投递失败")), "throwing listener is warned: " + warnsSvc.join("|"));
  const dts = readFileSync(new URL("../lib/index.d.ts", import.meta.url), "utf8");
  for (const name of ["ProjectFileState", "McpServerRuntimeView", "McpServerView", "McpRowSource", "ProjectServerState", "FiberPhaseView", "PROJECT_MCP_UPDATED_EVENT", "McpAddDraft", "McpWriteTarget", "serviceIdentityKeyOf"]) {
    assert.ok(dts.includes(name), "package entry exports " + name);
  }
  for (const disposer of ctxSvc.disposers) {
    const cleanup = disposer();
    if (typeof cleanup === "function") cleanup();
  }

  const savedHome = process.env.DSH_HOME;
  const savedProfile = process.env.DSH_MCP_PROFILE;
  const savedCwdSvc = process.cwd();
  try {
    process.env.DSH_HOME = join(dirSvc, "dsh-home");
    delete process.env.DSH_MCP_PROFILE;
    await mkdir(process.env.DSH_HOME, { recursive: true });
    process.chdir(projSvc);
    const ctxApply = fakeCtx();
    ctxApply.agentsList.push(fakeAgent("session-apply", projSvc));
    apply(ctxApply);
    const provided = ctxApply.provided[PROJECT_MCP_SERVICE];
    assert.ok(provided, "apply provides projectMcp");
    assert.equal(typeof provided.snapshot, "function");
    assert.equal(typeof provided.serverView, "function");
    assert.equal(typeof provided.globalState, "function");
    assert.equal(typeof provided.reload, "function");
    await provided.reload();
    const applyView = await provided.serverView(projSvc, "query");
    assert.equal(applyView?.serverName, "query", "apply service.serverView matches the project row");
    const applySnap = await provided.snapshot();
    assert.ok(applySnap.some((part) => part.servers?.some((row) => row.serverName === "query")), "apply service.snapshot contains the project row");
    for (const disposer of ctxApply.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
  } finally {
    process.chdir(savedCwdSvc);
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    if (savedProfile === undefined) delete process.env.DSH_MCP_PROFILE;
    else process.env.DSH_MCP_PROFILE = savedProfile;
  }
  await rmRetry(dirSvc);
  pass("projectMcp service matches registry queries and apply provides it");
}

// 受管 yml 编辑：启停 / 删除 / 工具开关只写该作用域的受管块；其它来源落占位或拷贝。
{
  const dirEdit = await mkdtemp(join(tmpdir(), "dsh-mcp-edit-"));
  const homeEdit = join(dirEdit, "home");
  const projEdit = join(dirEdit, "proj");
  await mkdir(join(homeEdit, ".dsh"), { recursive: true });
  await mkdir(join(projEdit, ".dsh"), { recursive: true });
  await writeManagedRows(projectMcpFile(projEdit), [stdioRow("own")], { createIfMissing: true });
  await writeFile(join(projEdit, ".dsh", "mcp.json"), JSON.stringify({
    mcpServers: { fromjson: { command: "node", args: ["j.js"] } }
  }), "utf8");
  const ctxEdit = fakeCtx();
  const opened = [];
  const registryEdit = new ProjectMcpRegistry(ctxEdit, {
    globalNames: async () => [],
    userLayerPaths: { mcpYml: join(homeEdit, ".dsh", "mcp.yml"), mcpJson: join(homeEdit, ".dsh", "mcp.json"), profilesDir: join(homeEdit, ".dsh", "profiles") },
    openPath: (path) => { opened.push(path); }
  });
  ctxEdit.agentsList.push(fakeAgent("session-edit", projEdit));
  await registryEdit.reconcileNow();
  const ymlPath = projectMcpFile(projEdit);

  // 打开配置文件：项目层落到 <root>/.dsh/mcp.yml。
  assert.equal(await registryEdit.openConfigFile("dsh-project", projEdit), ymlPath);
  assert.deepEqual(opened, [ymlPath], "openPath receives the managed yml path");

  // 停用 yml 行：就地翻 disabled，不新建行。
  await registryEdit.setServerEnabled("dsh-project", projEdit, "own", false);
  let rows = extractManagedRows(await readFile(ymlPath, "utf8"));
  assert.equal(rows.length, 1, "disable edits the existing yml row in place");
  assert.equal(rows[0].disabled, true);
  // 再启用：去掉 disabled。
  await registryEdit.setServerEnabled("dsh-project", projEdit, "own", true);
  rows = extractManagedRows(await readFile(ymlPath, "utf8"));
  assert.equal(rows[0].disabled, undefined, "enable clears the disabled flag");

  // 停用 JSON 层行：在受管 yml 里落一条 disabled 占位（同 id），不改 json 文件。
  await registryEdit.setServerEnabled("dsh-project-json", projEdit, "fromjson", false);
  rows = extractManagedRows(await readFile(ymlPath, "utf8"));
  const placeholder = rows.find((row) => row.id === "panel-mcp-fromjson");
  assert.ok(placeholder !== undefined, "disabling a json row lands a placeholder in the managed yml");
  assert.equal(placeholder.disabled, true);
  assert.equal(JSON.parse(await readFile(join(projEdit, ".dsh", "mcp.json"), "utf8")).mcpServers.fromjson.command, "node", "the json file is untouched");

  // 删除 yml 行：就地移除。
  await registryEdit.removeServer("dsh-project", projEdit, "own");
  rows = extractManagedRows(await readFile(ymlPath, "utf8"));
  assert.ok(!rows.some((row) => row.id === "panel-mcp-own"), "removing a yml row deletes it");

  // 工具开关：deny 写入受管 yml 的 tools.deny；再打开时移除。
  await registryEdit.setServerEnabled("dsh-project-json", projEdit, "fromjson", true);
  await registryEdit.setToolEnabled("dsh-project-json", projEdit, "fromjson", "read_file", false);
  rows = extractManagedRows(await readFile(ymlPath, "utf8"));
  const taken = rows.find((row) => row.id === "panel-mcp-fromjson");
  assert.deepEqual(taken?.config?.tools, { deny: ["read_file"] }, "tool disable writes tools.deny into the managed yml");
  await registryEdit.setToolEnabled("dsh-project-json", projEdit, "fromjson", "read_file", true);
  rows = extractManagedRows(await readFile(ymlPath, "utf8"));
  assert.equal(rows.find((row) => row.id === "panel-mcp-fromjson")?.config?.tools, undefined, "re-enabling the last denied tool drops the tools key");

  // 遗留 .mcp.json 不改原文件，停用落到同项目的受管 yml。
  await writeFile(join(projEdit, ".mcp.json"), JSON.stringify({ mcpServers: { ghost: { command: "node", args: ["g.js"] } } }), "utf8");
  await registryEdit.reconcileNow();
  await registryEdit.setServerEnabled("cc-project", projEdit, "ghost", false);
  rows = extractManagedRows(await readFile(ymlPath, "utf8"));
  assert.equal(rows.find((row) => row.id === "panel-mcp-ghost")?.disabled, true, "legacy .mcp.json disable lands in the project yml");
  assert.equal(JSON.parse(await readFile(join(projEdit, ".mcp.json"), "utf8")).mcpServers.ghost.command, "node", "legacy .mcp.json is not rewritten");
  await assert.rejects(() => registryEdit.removeServer("dsh-project", projEdit, "nosuch"), /找不到服务器/);

  for (const disposer of ctxEdit.disposers) {
    const cleanup = disposer();
    if (typeof cleanup === "function") cleanup();
  }
  await rmRetry(dirEdit);
  pass("managed yml edits: enable/disable/remove/tool toggles write only the managed block");
}

{
  const dirM1 = await mkdtemp(join(tmpdir(), "dsh-mcp-fp-profile-"));
  const homeM1 = join(dirM1, "home");
  const projM1 = join(dirM1, "proj");
  const profilesM1 = join(homeM1, ".dsh", "profiles");
  await mkdir(join(profilesM1, "web"), { recursive: true });
  await mkdir(join(profilesM1, "job"), { recursive: true });
  await mkdir(projM1, { recursive: true });
  await writeManagedRows(projectMcpFile(projM1), [stdioRow("keep")], { createIfMissing: true });
  await writeFile(join(profilesM1, "web", "mcp.json"), JSON.stringify({ mcpServers: { webonly: { command: "node", args: ["w.js"] } } }), "utf8");
  await writeFile(join(profilesM1, "job", "mcp.json"), JSON.stringify({ mcpServers: { jobonly: { command: "node", args: ["j.js"] } } }), "utf8");
  const savedCwdM1 = process.cwd();
  let profile = "web";
  let hostNames = [];
  try {
    process.chdir(dirM1);
    const ctxM1 = fakeCtx();
    const registryM1 = new ProjectMcpRegistry(ctxM1, {
      globalNames: async () => hostNames,
      activeProfile: async () => profile,
      userLayerPaths: { mcpYml: join(homeM1, ".dsh", "mcp.yml"), mcpJson: join(homeM1, ".dsh", "mcp.json"), profilesDir: profilesM1 }
    });
    ctxM1.agentsList.push(fakeAgent("session-m1", projM1));
    await registryM1.reconcileNow();
    assert.ok(registryM1.globalState("webonly")?.phase === "active", "web profile row mounts");
    const readsAfterWeb = registryM1.debugConfigReadCount;
    await registryM1.reconcileNow();
    assert.equal(registryM1.debugConfigReadCount, readsAfterWeb, "unchanged profile+host still skip reread");
    profile = "job";
    await registryM1.reconcileNow();
    assert.ok(registryM1.debugConfigReadCount > readsAfterWeb, "switching profile rereads despite unchanged files");
    assert.ok(registryM1.globalState("jobonly")?.phase === "active", "job profile row mounts after switch");
    assert.equal(registryM1.globalState("webonly"), undefined, "previous profile row unmounts");
    const readsAfterJob = registryM1.debugConfigReadCount;
    hostNames = ["host-patch-x"];
    await registryM1.reconcileNow();
    assert.ok(registryM1.debugConfigReadCount > readsAfterJob, "host globalNames change rereads despite unchanged files");
    for (const disposer of ctxM1.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    pass("fingerprint includes active profile and host global names so env/host changes reread");
  } finally {
    process.chdir(savedCwdM1);
    await rmRetry(dirM1);
  }
}

// ── agent/created 事件路径（dsh 0.2 用 source 覆盖原 session-start 的边沿）────
{
  const dirCreated = await mkdtemp(join(tmpdir(), "dsh-mcp-agent-created-"));
  const homeCreated = join(dirCreated, "home");
  const projCreated = join(dirCreated, "proj");
  await mkdir(join(homeCreated, ".dsh"), { recursive: true });
  await mkdir(projCreated, { recursive: true });
  // 项目层与用户层同名 "shared"：项目行胜出（生效名带 p<hash>_ 前缀），全局实例
  // 仍宿主级挂一条，只对该项目的会话 deny（项目侧压制）。
  await writeManagedRows(projectMcpFile(projCreated), [stdioRow("shared")], { createIfMissing: true });
  await writeManagedRows(join(homeCreated, ".dsh", "mcp.yml"), [stdioRow("shared")], { createIfMissing: true });
  const savedCwdCreated = process.cwd();
  try {
    process.chdir(dirCreated);
    const ctxCreated = fakeCtx();
    const registryCreated = new ProjectMcpRegistry(ctxCreated, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(homeCreated, ".dsh", "mcp.yml"), mcpJson: join(homeCreated, ".dsh", "mcp.json"), profilesDir: join(homeCreated, ".dsh", "profiles") }
    });
    ctxCreated.schemas.push({ name: "mcp__shared__ping" });
    // 构造时无在线会话：用户层常驻，项目层不挂。resume 边沿靠事件补扫，不靠 reconcileNow。
    await registryCreated.reconcileNow();
    assert.ok(registryCreated.globalState("shared")?.phase === "active", "user-layer row is mounted host-wide before any session");
    assert.equal(ctxCreated.mounts.length, 1, "no project mount while no session is known: " + JSON.stringify(ctxCreated.mounts.map((config) => config.serverName)));

    const agentResume = fakeAgent("session-resume", projCreated);
    ctxCreated.agentsList.push(agentResume);
    ctxCreated.emit("agent/created", { agent: agentResume, source: "resume" });
    assert.ok(
      await registryCreated.waitForState(projCreated, "shared", (state) => state?.phase === "active", 5000),
      "agent/created (source: resume) mounts the session project without an explicit reconcileNow"
    );
    const projectMount = ctxCreated.mounts.find((config) => config.serverName !== "shared");
    assert.ok(projectMount !== undefined, "the project row mounts: " + JSON.stringify(ctxCreated.mounts.map((config) => config.serverName)));
    assert.match(projectMount.serverName, /^p[0-9a-f]{6}_shared$/, "project row keeps the namespaced effective name");
    // deny 应用：本会话 deny 被自己项目行遮蔽的全局实例工具（展开成已注册的工具名）。
    await registryCreated.reconcileNow();
    assert.deepEqual(
      agentResume.denies.at(-1),
      ["mcp__shared__ping"],
      "the resumed session denies the shadowed global server's tools: " + JSON.stringify(agentResume.denies)
    );
    for (const disposer of ctxCreated.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    pass("agent/created (source: resume) mounts the session project and applies the session deny");
  } finally {
    process.chdir(savedCwdCreated);
    await rmRetry(dirCreated);
  }
}

// session/created 单独就能装上项目，不依赖 agent/created（作用域过滤漏掉后者时的路径）。
{
  const dirSession = await mkdtemp(join(tmpdir(), "dsh-mcp-session-created-"));
  const homeSession = join(dirSession, "home");
  const projSession = join(dirSession, "proj");
  await mkdir(join(homeSession, ".dsh"), { recursive: true });
  await mkdir(projSession, { recursive: true });
  await writeManagedRows(projectMcpFile(projSession), [stdioRow("from-session")], { createIfMissing: true });
  const projRestored = join(dirSession, "restored");
  await mkdir(projRestored);
  await writeManagedRows(projectMcpFile(projRestored), [stdioRow("restored")], { createIfMissing: true });
  const savedCwdSession = process.cwd();
  try {
    process.chdir(dirSession);
    const ctxSession = fakeCtx();
    ctxSession.sessions = { list: () => [{ header: { cwd: projRestored } }] };
    const registrySession = new ProjectMcpRegistry(ctxSession, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(homeSession, ".dsh", "mcp.yml"), mcpJson: join(homeSession, ".dsh", "mcp.json"), profilesDir: join(homeSession, ".dsh", "profiles") }
    });
    await registrySession.reconcileNow();
    assert.deepEqual(ctxSession.mounts.map(({ serverName }) => serverName), ["restored"],
      "a workspace restored in the host session store mounts before agent creation");
    ctxSession.emit("session/created", { id: "session-direct", header: { cwd: projSession } });
    assert.ok(
      await registrySession.waitForState(projSession, "from-session", (state) => state?.phase === "active", 5000),
      "session/created mounts the workspace project without agent/created"
    );
    ctxSession.emit("session/disposed", { id: "session-direct", header: { cwd: projSession } });
    await registrySession.reconcileNow();
    assert.equal((await registrySession.serverView(projSession, "from-session")).fiberPhase, "active");
    assert.deepEqual(ctxSession.disposals, [], "closing the last session keeps a known workspace mounted");
    for (const disposer of ctxSession.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    pass("session/created mounts a newly opened workspace without waiting for agent/created");
  } finally {
    process.chdir(savedCwdSession);
    await rmRetry(dirSession);
  }
}

// 多工作区会话同时在线时，各自保持连接和工具视图。
{
  const dirFocus = await mkdtemp(join(tmpdir(), "dsh-mcp-focus-"));
  const homeFocus = join(dirFocus, "home");
  const projA = join(dirFocus, "a");
  const projB = join(dirFocus, "b");
  const globalPath = join(homeFocus, ".dsh", "mcp.yml");
  await mkdir(dirname(globalPath), { recursive: true });
  await mkdir(projA);
  await mkdir(projB);
  await writeManagedRows(projectMcpFile(projA), [stdioRow("alpha")], { createIfMissing: true });
  await writeManagedRows(projectMcpFile(projB), [stdioRow("beta")], { createIfMissing: true });
  await writeManagedRows(globalPath, [stdioRow("common")], { createIfMissing: true });
  const ctxFocus = fakeCtx();
  const agentA = fakeAgent("session-a", projA);
  const agentB = fakeAgent("session-b", projB);
  ctxFocus.agentsList.push(agentA, agentB);
  ctxFocus.schemas.push({ name: "mcp__alpha__read" }, { name: "mcp__beta__read" }, { name: "mcp__common__read" });
  try {
    const registryFocus = new ProjectMcpRegistry(ctxFocus, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: globalPath, mcpJson: join(homeFocus, ".dsh", "mcp.json"), profilesDir: join(homeFocus, ".dsh", "profiles") }
    });
    await registryFocus.reconcileNow();
    assert.deepEqual(ctxFocus.mounts.map(({ serverName }) => serverName).sort(byCodeUnit), ["alpha", "beta", "common"]);
    for (const agent of [agentA, agentB, agentA, agentB]) {
      ctxFocus.emit("session/event", { id: agent.id, header: agent.session.header }, { type: "user/message" });
      assert.equal(registryFocus.focusedProjectRoot(), agent.session.header.cwd);
      assert.deepEqual(agentA.denies.at(-1), ["mcp__beta__read"]);
      assert.deepEqual(agentB.denies.at(-1), ["mcp__alpha__read"]);
    }
    const [assemble] = ctxFocus.handlers.get("system-prompt/assemble");
    const [preExecute] = ctxFocus.handlers.get("tools/pre-execute");
    const sections = [
      { name: "mcp:alpha", text: "A instructions" },
      { name: "mcp:beta", text: "B instructions" },
      { name: "mcp:common", text: "Shared instructions" },
      { name: "mcp-resource-servers", text: 'Available servers: ["alpha","beta","common"].' }
    ];
    const resourceTools = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
    const verifyVisibility = async (agent, own, other) => {
      const prompt = await assemble({ sections }, { scope: agent }, async () => ({ sections }));
      assert.deepEqual(prompt.sections.map(({ name }) => name), [`mcp:${own}`, "mcp:common", "mcp-resource-servers"]);
      assert.equal(prompt.sections.at(-1).text, `Available servers: ["${own}","common"].`);
      await Promise.all(resourceTools.map(async (name) => {
        const next = async () => ({ kind: "allow" });
        const decide = (server) => preExecute({ name, agent, arguments: { server } }, next);
        const decisions = await Promise.all([decide(other), decide(own), decide("common")]);
        assert.deepEqual(decisions.map(({ kind }) => kind), ["deny", "allow", "allow"]);
      }));
    };
    await Promise.all([
      verifyVisibility(agentA, "alpha", "beta"),
      verifyVisibility(agentB, "beta", "alpha")
    ]);
    ctxFocus.schemas.push({ name: "mcp__alpha__write" });
    ctxFocus.emit("tools/change");
    assert.deepEqual(agentB.denies.at(-1), ["mcp__alpha__read", "mcp__alpha__write"]);
    assert.deepEqual(agentA.denies.at(-1), ["mcp__beta__read"]);
    ctxFocus.emit("session/event", { id: agentA.id, header: agentA.session.header }, { type: "tool/result" });
    assert.equal(registryFocus.focusedProjectRoot(), projB);
    await registryFocus.reconcileNow();
    assert.equal(ctxFocus.mounts.length, 3, "focus switches do not create new connections");
    assert.deepEqual(ctxFocus.disposals, [], "focus switches do not close connections");
    pass("switching between workspaces keeps eager connections and session isolation");
  } finally {
    for (const disposer of ctxFocus.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    await rmRetry(dirFocus);
  }
}

{
  const dirPrep = await mkdtemp(join(tmpdir(), "dsh-mcp-prepare-yml-"));
  const homePrep = join(dirPrep, "home");
  const projPrep = join(dirPrep, "proj");
  await mkdir(join(homePrep, ".dsh"), { recursive: true });
  await mkdir(projPrep, { recursive: true });
  await writeFile(join(projPrep, ".mcp.json"), JSON.stringify({ mcpServers: { godot: { command: "node" } } }), "utf8");
  const savedCwdPrep = process.cwd();
  try {
    process.chdir(dirPrep);
    const ctxPrep = fakeCtx();
    const registryPrep = new ProjectMcpRegistry(ctxPrep, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(homePrep, ".dsh", "mcp.yml"), mcpJson: join(homePrep, ".dsh", "mcp.json"), profilesDir: join(homePrep, ".dsh", "profiles") }
    });
    const created = await registryPrep.prepareManagedYml("cc-project", projPrep);
    assert.equal(created, projectMcpFile(projPrep), "legacy project source prepares the managed yml, not the json file");
    const text = await readFile(created, "utf8");
    assert.match(text, /^\[\]\s*$/, "a missing yml is created as an empty patch array");
    await writeFile(created, text + "# keep-me\n", "utf8");
    const again = await registryPrep.prepareManagedYml("cc-project", projPrep);
    assert.match(await readFile(again, "utf8"), /# keep-me/, "an existing yml is not rewritten");
    for (const disposer of ctxPrep.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    pass("prepareManagedYml creates a missing managed yml and leaves an existing one untouched");
  } finally {
    process.chdir(savedCwdPrep);
    await rmRetry(dirPrep);
  }
}

{
  const dirAdd = await mkdtemp(join(tmpdir(), "dsh-mcp-add-"));
  const homeAdd = join(dirAdd, "home");
  const projAdd = join(dirAdd, "proj");
  const projOther = join(dirAdd, "other");
  const profiles = join(homeAdd, ".dsh", "profiles");
  await mkdir(join(homeAdd, ".dsh"), { recursive: true });
  await mkdir(projAdd, { recursive: true });
  await mkdir(projOther, { recursive: true });
  const savedCwdAdd = process.cwd();
  try {
    process.chdir(dirAdd);
    const ctxAdd = fakeCtx();
    const agentAdd = fakeAgent("session-add", projAdd);
    const agentOther = fakeAgent("session-other", projOther);
    ctxAdd.agentsList.push(agentAdd);
    const registryAdd = new ProjectMcpRegistry(ctxAdd, {
      globalNames: async () => [],
      activeProfile: async () => "web",
      userLayerPaths: { mcpYml: join(homeAdd, ".dsh", "mcp.yml"), mcpJson: join(homeAdd, ".dsh", "mcp.json"), profilesDir: profiles }
    });
    const serviceAdd = bindProjectMcpService(registryAdd);
    await registryAdd.reconcileNow();
    assert.equal(registryAdd.focusedProjectRoot(), projAdd, "a single known workspace is the add target before an explicit focus event");
    const targets = serviceAdd.writeTargets();
    assert.deepEqual(targets.map((item) => item.id), ["project", "user", "profile"]);
    assert.equal(targets[0].projectRoot, projAdd);
    assert.equal(targets[0].path, projectMcpFile(projAdd));

    const written = await serviceAdd.addServer("dsh-project", projAdd, {
      serverName: "gitlab",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-gitlab"],
      env: { GITLAB_TOKEN: "${GITLAB_TOKEN}" }
    });
    assert.equal(written, projectMcpFile(projAdd));
    let rows = extractManagedRows(await readFile(written, "utf8"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "panel-mcp-gitlab");
    assert.equal(rows[0].config.serverName, "gitlab");
    assert.equal(rows[0].config.transport, "stdio");
    assert.equal(rows[0].config.command, "npx");
    assert.deepEqual(rows[0].config.args, ["-y", "@modelcontextprotocol/server-gitlab"]);
    assert.equal(rows[0].config.cwd, ".");
    assert.deepEqual(rows[0].config.env, { GITLAB_TOKEN: "${GITLAB_TOKEN}" });
    assert.equal(rows[0].disabled, undefined);

    await assert.rejects(
      () => registryAdd.addServer("dsh-project", projAdd, { serverName: "gitlab", transport: "stdio", command: "node" }),
      /已经写在这份 mcp\.yml 里/
    );
    rows = extractManagedRows(await readFile(written, "utf8"));
    assert.equal(rows.length, 1, "a duplicate name does not append a second row");

    await assert.rejects(
      () => registryAdd.addServer("dsh-project", projAdd, { serverName: "bad name", transport: "stdio", command: "node" }),
      /配置无效/
    );

    await registryAdd.addServer("dsh-project", projAdd, {
      serverName: "sentry",
      transport: "streamable-http",
      url: "https://mcp.sentry.dev/mcp",
      headers: { Authorization: "Bearer ${TOKEN}" }
    });
    rows = extractManagedRows(await readFile(written, "utf8"));
    const http = rows.find((row) => row.config?.serverName === "sentry");
    assert.equal(http?.config?.transport, "streamable-http");
    assert.equal(http?.config?.url, "https://mcp.sentry.dev/mcp");
    assert.deepEqual(http?.config?.headers, { Authorization: "Bearer ${TOKEN}" });

    const userPath = await registryAdd.addServer("dsh-user-yml", "", {
      serverName: "shared",
      transport: "stdio",
      command: "node",
      args: ["shared.js"]
    });
    const userRows = extractManagedRows(await readFile(userPath, "utf8"));
    assert.equal(userRows[0].config.cwd, "", "user-layer add leaves cwd empty so it inherits the host");
    assert.equal(userRows[0].config.command, "node");

    const profilePath = await registryAdd.addServer("dsh-profile-user-yml", "", {
      serverName: "webtool",
      transport: "stdio",
      command: "node"
    });
    assert.equal(profilePath, join(profiles, "web", "mcp.yml"));
    const profileRows = extractManagedRows(await readFile(profilePath, "utf8"));
    assert.equal(profileRows[0].config.serverName, "webtool");
    assert.equal(profileRows[0].config.cwd, "");

    ctxAdd.agentsList.push(agentOther);
    ctxAdd.emit("agent/created", { agent: agentOther, source: "resume" });
    await registryAdd.reconcileNow();
    assert.equal(registryAdd.focusedProjectRoot(), projOther, "agent/created moves the add target to that workspace");
    await assert.rejects(
      () => registryAdd.addServer("dsh-project", projAdd, { serverName: "late", transport: "stdio", command: "node" }),
      /写入位置当前不可用/
    );
    assert.equal(extractManagedRows(await readFile(written, "utf8")).some((row) => row.config?.serverName === "late"), false);

    for (const disposer of ctxAdd.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    pass("addServer writes a managed yml row for the workspace, user, and profile");
  } finally {
    process.chdir(savedCwdAdd);
    await rmRetry(dirAdd);
  }
}

{
  const dirLate = await mkdtemp(join(tmpdir(), "dsh-mcp-settle-"));
  const homeLate = join(dirLate, "home");
  const projLate = join(dirLate, "proj");
  await mkdir(join(homeLate, ".dsh"), { recursive: true });
  await mkdir(projLate, { recursive: true });
  await writeManagedRows(projectMcpFile(projLate), [stdioRow("late")], { createIfMissing: true });
  const ctxLate = fakeCtx();
  ctxLate.holdFibers = true;
  const agentLate = fakeAgent("session-late", projLate);
  const projLazyOnly = join(dirLate, "lazy-only");
  const projDuplicate = join(dirLate, "duplicate");
  const lazy = stdioRow("lazy");
  lazy.config.mode = "lazy";
  await writeManagedRows(projectMcpFile(projLazyOnly), [lazy], { createIfMissing: true });
  ctxLate.tools.register = () => () => {};
  const agentLazyOnly = fakeAgent("session-lazy-only", projLazyOnly);
  ctxLate.agentsList.push(agentLate, agentLazyOnly);
  const updatesLate = [];
  ctxLate.on(PROJECT_MCP_UPDATED_EVENT, () => updatesLate.push(1));
  const registryLate = new ProjectMcpRegistry(ctxLate, {
    globalNames: async () => [],
    userLayerPaths: {
      mcpYml: join(homeLate, ".dsh", "mcp.yml"),
      mcpJson: join(homeLate, ".dsh", "mcp.json"),
      profilesDir: join(homeLate, ".dsh", "profiles")
    }
  });
  try {
    await registryLate.reconcileNow();
    const during = await registryLate.serverView(projLate, "late");
    assert.equal(during?.fiberPhase, "loading", "held fiber stays starting until it settles: " + JSON.stringify(during));
    const updatesWhileHeld = updatesLate.length;
    assert.ok(updatesWhileHeld >= 1, "reconcile still emits while the fiber is held");
    const effective = during?.effectiveServerName ?? "late";
    ctxLate.schemas.push({ name: `mcp__${effective}__ping` });
    const [onAgentCreated] = ctxLate.handlers.get("agent/created");
    const create = (agent, signal) => onAgentCreated({ agent, source: "resume", signal });
    // 新建会话（不在启动快照里）：创建等待其可见 Eager 就绪，首条模型请求才可见工具。
    const agentLateNew = fakeAgent("session-late-new", projLate);
    ctxLate.agentsList.push(agentLateNew);
    let eagerStarted = false;
    const waiting = create(agentLateNew, AbortSignal.timeout(5000)).then(() => { eagerStarted = true; });
    const cancellation = new AbortController();
    const agentLateCancelled = fakeAgent("session-late-cancelled", projLate);
    ctxLate.agentsList.push(agentLateCancelled);
    const cancelled = assert.rejects(create(agentLateCancelled, cancellation.signal), { name: "AbortError" });
    cancellation.abort();
    await cancelled;
    const agentLazyNew = fakeAgent("session-lazy-only-new", projLazyOnly);
    ctxLate.agentsList.push(agentLazyNew);
    await create(agentLazyNew, AbortSignal.timeout(1000));
    // 启动恢复（replay）不等待：agentLate 在构造时的在线快照里，即使 fiber 仍被挂起。
    await create(agentLate, AbortSignal.timeout(1000));
    assert.equal(eagerStarted, false, "session creation has not completed while its Eager server mounts");
    await registryLate.reconcileNow();
    const updatesBeforeSettle = updatesLate.length;
    const release = ctxLate.held[0];
    assert.equal(typeof release, "function", "mount registered a held fiber");
    release();
    const after = await registryLate.serverView(projLate, "late");
    assert.equal(after?.fiberPhase, "active");
    assert.equal(after?.toolCount, 1, "tool count is visible once the fiber settles");
    assert.equal(updatesLate.length, updatesBeforeSettle + 1, "settling after reconcile emits projectMcp/updated");
    await waiting;
    assert.equal(eagerStarted, true);
    await writeManagedRows(projectMcpFile(projDuplicate), [stdioRow("late")], { createIfMissing: true });
    ctxLate.agentsList.push(fakeAgent("session-duplicate", projDuplicate));
    await registryLate.reconcileNow();
    const duplicate = await registryLate.serverView(projDuplicate, "late");
    assert.match(duplicate?.effectiveServerName, /^p[0-9a-f]{6}_late$/);
    assert.equal((await registryLate.serverView(projLate, "late"))?.effectiveServerName, effective);
    assert.deepEqual(ctxLate.mounts.map(({ serverName }) => serverName), [effective, duplicate.effectiveServerName]);
    assert.deepEqual(ctxLate.disposals, [], "a new colliding workspace does not remount the online server");
    pass("model admission waits only for its Eager servers and new collisions preserve existing mounts");
  } finally {
    for (const disposer of ctxLate.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    await rmRetry(dirLate);
  }
}

{
  const dirTools = await mkdtemp(join(tmpdir(), "dsh-mcp-tool-states-"));
  const homeTools = join(dirTools, "home");
  const projTools = join(dirTools, "proj");
  await mkdir(join(homeTools, ".dsh"), { recursive: true });
  await mkdir(projTools, { recursive: true });
  const denied = stdioRow("own");
  denied.config.tools = { deny: ["read"] };
  await writeManagedRows(projectMcpFile(projTools), [denied], { createIfMissing: true });
  const ctxTools = fakeCtx();
  ctxTools.agentsList.push(fakeAgent("session-tools", projTools));
  const registryTools = new ProjectMcpRegistry(ctxTools, {
    globalNames: async () => [],
    userLayerPaths: { mcpYml: join(homeTools, ".dsh", "mcp.yml"), mcpJson: join(homeTools, ".dsh", "mcp.json"), profilesDir: join(homeTools, ".dsh", "profiles") }
  });
  try {
    await registryTools.reconcileNow();
    assert.ok(await registryTools.waitForState(projTools, "own", (state) => state?.phase === "active"), "denied row mounts");
    const effective = (await registryTools.serverView(projTools, "own"))?.effectiveServerName ?? "own";
    ctxTools.schemas.push({ name: `mcp__${effective}__read` }, { name: `mcp__${effective}__write` });
    assert.deepEqual(registryTools.toolStates(projTools, "own"), [
      { name: "read", enabled: false },
      { name: "write", enabled: true }
    ], "yml tools.deny is reflected as enabled: false");
    pass("toolStates reads tools.deny from the mounted patch row");
  } finally {
    for (const disposer of ctxTools.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    await rmRetry(dirTools);
  }
}

{
  const dirMask = await mkdtemp(join(tmpdir(), "dsh-mcp-remove-mask-"));
  const homeMask = join(dirMask, "home");
  const projMask = join(dirMask, "proj");
  await mkdir(join(homeMask, ".dsh"), { recursive: true });
  await mkdir(join(projMask, ".dsh"), { recursive: true });
  const ymlMask = projectMcpFile(projMask);
  const kept = stdioRow("kept");
  kept.config.args = ["same.js"];
  await writeManagedRows(ymlMask, [stdioRow("both"), kept], { createIfMissing: true });
  await writeFile(join(projMask, ".dsh", "mcp.json"), JSON.stringify({
    mcpServers: {
      both: { command: "node", args: ["from-json.js"] },
      jsononly: { command: "node", args: ["only.js"] },
      alias: { command: "node", args: ["same.js"] }
    }
  }), "utf8");
  const ctxMask = fakeCtx();
  ctxMask.agentsList.push(fakeAgent("session-mask", projMask));
  const registryMask = new ProjectMcpRegistry(ctxMask, {
    globalNames: async () => [],
    userLayerPaths: { mcpYml: join(homeMask, ".dsh", "mcp.yml"), mcpJson: join(homeMask, ".dsh", "mcp.json"), profilesDir: join(homeMask, ".dsh", "profiles") }
  });
  try {
    await registryMask.reconcileNow();
    await registryMask.removeServer("dsh-project", projMask, "both");
    let rows = extractManagedRows(await readFile(ymlMask, "utf8"));
    const masked = rows.find((row) => row.id === "panel-mcp-both");
    assert.equal(masked?.disabled, true, "same-name json keeps a disabled yml placeholder");
    assert.equal(JSON.parse(await readFile(join(projMask, ".dsh", "mcp.json"), "utf8")).mcpServers.both.command, "node");

    await registryMask.removeServer("dsh-project-json", projMask, "jsononly");
    rows = extractManagedRows(await readFile(ymlMask, "utf8"));
    assert.equal(rows.find((row) => row.id === "panel-mcp-jsononly")?.disabled, true, "json-only delete writes a placeholder");
    await registryMask.reconcileNow();
    await registryMask.removeServer("dsh-project", projMask, "jsononly");
    rows = extractManagedRows(await readFile(ymlMask, "utf8"));
    assert.equal(rows.find((row) => row.id === "panel-mcp-jsononly")?.disabled, true, "deleting the placeholder does not unmask the json row");

    await registryMask.removeServer("dsh-project", projMask, "kept");
    rows = extractManagedRows(await readFile(ymlMask, "utf8"));
    const identityMask = rows.find((row) => row.id === "panel-mcp-kept");
    assert.equal(identityMask?.disabled, true, "same command in a lower layer keeps the yml row disabled");
    assert.deepEqual(identityMask?.config?.args, ["same.js"]);
    pass("remove leaves a disabled placeholder while a lower layer still defines the server");
  } finally {
    for (const disposer of ctxMask.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    await rmRetry(dirMask);
  }
}

{
  const dirSrc = await mkdtemp(join(tmpdir(), "dsh-mcp-source-row-"));
  const homeSrc = join(dirSrc, "home");
  const profiles = join(homeSrc, ".dsh", "profiles", "desktop");
  await mkdir(profiles, { recursive: true });
  await writeManagedRows(join(profiles, "mcp.yml"), [stdioRow("shared")], { createIfMissing: true });
  const profileRows = extractManagedRows(await readFile(join(profiles, "mcp.yml"), "utf8"));
  profileRows[0].config.command = "profile-bin";
  await writeManagedRows(join(profiles, "mcp.yml"), profileRows);
  await writeFile(join(homeSrc, ".dsh", "mcp.json"), JSON.stringify({
    mcpServers: { shared: { command: "user-bin", args: ["user.js"] } }
  }), "utf8");
  const ctxSrc = fakeCtx();
  const registrySrc = new ProjectMcpRegistry(ctxSrc, {
    globalNames: async () => [],
    activeProfile: async () => "desktop",
    userLayerPaths: { mcpYml: join(homeSrc, ".dsh", "mcp.yml"), mcpJson: join(homeSrc, ".dsh", "mcp.json"), profilesDir: join(homeSrc, ".dsh", "profiles") }
  });
  try {
    await registrySrc.reconcileNow();
    await assert.rejects(() => registrySrc.setToolEnabled("dsh-user-yml", "", "shared", "read", false), /找不到服务器/);
    const written = await registrySrc.setServerEnabled("dsh-user", "", "shared", false);
    const userRows = extractManagedRows(await readFile(written, "utf8"));
    assert.equal(userRows.length, 1);
    assert.equal(userRows[0].disabled, true);
    assert.equal(userRows[0].config.command, "user-bin", "user-layer disable copies the user json row, not the profile row");
    await assert.rejects(() => registrySrc.removeServer("no-such-layer", "", "shared"), /写入位置当前不可用/);
    pass("writes use the requested source and reject an unknown layer");
  } finally {
    for (const disposer of ctxSrc.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    await rmRetry(dirSrc);
  }
}

{
  const dirLock = await mkdtemp(join(tmpdir(), "dsh-mcp-workspace-lock-"));
  const homeLock = join(dirLock, "home");
  const projFocus = join(dirLock, "focus");
  const projBack = join(dirLock, "back");
  await mkdir(join(homeLock, ".dsh"), { recursive: true });
  await mkdir(projFocus, { recursive: true });
  await mkdir(projBack, { recursive: true });
  const ymlBack = projectMcpFile(projBack);
  await writeManagedRows(projectMcpFile(projFocus), [stdioRow("front")], { createIfMissing: true });
  await writeManagedRows(ymlBack, [stdioRow("behind")], { createIfMissing: true });
  const savedCwdLock = process.cwd();
  try {
    process.chdir(dirLock);
    const ctxLock = fakeCtx();
    const agentFocus = fakeAgent("session-lock-focus", projFocus);
    ctxLock.agentsList.push(agentFocus);
    const registryLock = new ProjectMcpRegistry(ctxLock, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(homeLock, ".dsh", "mcp.yml"), mcpJson: join(homeLock, ".dsh", "mcp.json"), profilesDir: join(homeLock, ".dsh", "profiles") }
    });
    ctxLock.emit("agent/created", { agent: agentFocus, source: "resume" });
    await registryLock.reconcileNow();
    assert.equal(registryLock.focusedProjectRoot(), projFocus);
    const before = await readFile(ymlBack, "utf8");
    await assert.rejects(
      () => registryLock.setServerEnabled("dsh-project", projBack, "behind", false),
      /这个工作区当前不能改/
    );
    await assert.rejects(
      () => registryLock.removeServer("dsh-project", projBack, "behind"),
      /这个工作区当前不能改/
    );
    assert.equal(await readFile(ymlBack, "utf8"), before, "a background workspace is not rewritten");
    for (const disposer of ctxLock.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    pass("a background workspace cannot be enabled or removed");
  } finally {
    process.chdir(savedCwdLock);
    await rmRetry(dirLock);
  }
}

{
  const dirChain = await mkdtemp(join(tmpdir(), "dsh-mcp-unmount-chain-"));
  const homeChain = join(dirChain, "home");
  const projChain = join(dirChain, "proj");
  const projAway = join(dirChain, "away");
  await mkdir(join(homeChain, ".dsh"), { recursive: true });
  await mkdir(projChain, { recursive: true });
  await mkdir(projAway, { recursive: true });
  await writeManagedRows(projectMcpFile(projChain), [stdioRow("alpha")], { createIfMissing: true });
  const savedCwdChain = process.cwd();
  let ctxChain;
  try {
    process.chdir(dirChain);
    ctxChain = fakeCtx();
    const agentChain = fakeAgent("session-chain", projChain);
    const agentAway = fakeAgent("session-away", projAway);
    ctxChain.agentsList.push(agentChain);
    const registryChain = new ProjectMcpRegistry(ctxChain, {
      globalNames: async () => [],
      healthRemountBackoffMs: 0,
      userLayerPaths: { mcpYml: join(homeChain, ".dsh", "mcp.yml"), mcpJson: join(homeChain, ".dsh", "mcp.json"), profilesDir: join(homeChain, ".dsh", "profiles") }
    });
    await registryChain.reconcileNow();
    // 先让 away 工作区被扫描（无配置行）：会话创建的 Eager 等待只查已扫描目录，
    // 不会被后面挂起的 dispose 堵住。
    ctxChain.agentsList.push(agentAway);
    await registryChain.reconcileNow();
    const effective = ctxChain.mounts[0].serverName;
    ctxChain.schemas.push({ name: "mcp__" + effective + "__ping" });
    await registryChain.reconcileNow();
    ctxChain.schemas.length = 0;
    await registryChain.reconcileNow();
    ctxChain.holdDispose = true;
    const remounting = registryChain.reconcileNow();
    const started = Date.now();
    while (ctxChain.disposals.length === 0 && Date.now() - started < 3000) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    assert.equal(ctxChain.disposals.length, 1, "health remount disposes the dead fiber");
    const mountsAtHold = ctxChain.mounts.length;
    ctxChain.schemas.push({ name: "mcp__" + effective + "__ping" });
    const [onAgentCreated] = ctxChain.handlers.get("agent/created");
    const creation = onAgentCreated({ agent: agentAway, source: "startup" });
    let timer;
    try {
      await Promise.race([
        creation,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("session creation waited for MCP disposal")), 1000);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.deepEqual(agentAway.denies.at(-1), ["mcp__" + effective + "__ping"],
      "a new agent is isolated before the pending MCP disposal completes");
    assert.equal(ctxChain.mounts.length, mountsAtHold, "the server is not mounted again while dispose is still running");
    const release = ctxChain.releaseDispose.shift();
    assert.equal(typeof release, "function");
    release();
    await remounting;
    assert.ok(
      await registryChain.waitForState(projChain, "alpha", (state) => state?.phase === "active", 5000),
      "health remount completes after switching workspaces"
    );
    await registryChain.reconcileNow();
    assert.equal(registryChain.focusedProjectRoot(), projAway);
    pass("session creation applies isolation without waiting for MCP disposal");
  } finally {
    process.chdir(savedCwdChain);
    for (const release of ctxChain?.releaseDispose ?? []) release();
    for (const disposer of ctxChain?.disposers ?? []) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    await rmRetry(dirChain);
  }
}

{
  const dirHost = await mkdtemp(join(tmpdir(), "dsh-mcp-host-focus-"));
  const homeHost = join(dirHost, "home");
  const projVisible = join(dirHost, "visible");
  const projLast = join(dirHost, "last");
  await mkdir(join(homeHost, ".dsh"), { recursive: true });
  await mkdir(projVisible, { recursive: true });
  await mkdir(projLast, { recursive: true });
  await writeManagedRows(projectMcpFile(projVisible), [stdioRow("shown")], { createIfMissing: true });
  await writeManagedRows(projectMcpFile(projLast), [stdioRow("hidden")], { createIfMissing: true });
  const savedCwdHost = process.cwd();
  let ctxHost;
  try {
    process.chdir(dirHost);
    ctxHost = fakeCtx();
    const agentVisible = fakeAgent("session-visible", projVisible);
    const agentLast = fakeAgent("session-last", projLast);
    ctxHost.agentsList.push(agentVisible, agentLast);
    ctxHost.sessions = {
      current: () => ({ header: { cwd: projLast } }),
      list: () => ({ current: { header: { cwd: projVisible } } })
    };
    const registryHost = new ProjectMcpRegistry(ctxHost, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(homeHost, ".dsh", "mcp.yml"), mcpJson: join(homeHost, ".dsh", "mcp.json"), profilesDir: join(homeHost, ".dsh", "profiles") }
    });
    ctxHost.emit("agent/created", { agent: agentVisible, source: "resume" });
    ctxHost.emit("agent/created", { agent: agentLast, source: "resume" });
    assert.ok(await registryHost.waitForState(projVisible, "shown", (state) => state?.phase === "active", 5000), "visible session mounts its project");
    assert.equal(registryHost.focusedProjectRoot(), projVisible, "cold start follows the visible session, not the session being restored");
    const hidden = await registryHost.serverView(projLast, "hidden");
    assert.equal(hidden?.fiberPhase, "active", "both restored workspaces mount at startup");
    const projOpened = join(dirHost, "opened");
    await mkdir(projOpened, { recursive: true });
    await writeManagedRows(projectMcpFile(projOpened), [stdioRow("fresh")], { createIfMissing: true });
    ctxHost.emit("session/created", { id: "session-opened", header: { cwd: projOpened } });
    assert.ok(await registryHost.waitForState(projOpened, "fresh", (state) => state?.phase === "active", 5000), "a workspace opened during recovery mounts");
    assert.equal(registryHost.focusedProjectRoot(), projOpened, "session/created is not pulled back to the visible session");
    const agentOpened = fakeAgent("session-clicked", join(dirHost, "clicked"));
    const projClicked = agentOpened.session.header.cwd;
    await mkdir(projClicked, { recursive: true });
    await writeManagedRows(projectMcpFile(projClicked), [stdioRow("clicked")], { createIfMissing: true });
    ctxHost.agentsList.push(agentOpened);
    ctxHost.emit("agent/created", { agent: agentOpened, source: "resume" });
    assert.ok(await registryHost.waitForState(projClicked, "clicked", (state) => state?.phase === "active", 5000), "a workspace the user opens mounts");
    assert.equal(registryHost.focusedProjectRoot(), projClicked, "agent/created after cold start is not rewritten");
    ctxHost.emit("session/event", { id: "session-last", header: { cwd: projLast } }, { type: "tool/result" });
    await registryHost.reconcileNow();
    assert.equal(registryHost.focusedProjectRoot(), projClicked, "a background tool result still does not move focus");
    pass("cold start uses the visible session and later opens keep focus");
  } finally {
    process.chdir(savedCwdHost);
    for (const disposer of ctxHost?.disposers ?? []) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    await rmRetry(dirHost);
  }
}

{
  const dirOff = await mkdtemp(join(tmpdir(), "dsh-mcp-unsubscribe-"));
  const homeOff = join(dirOff, "home");
  const projOff = join(dirOff, "proj");
  await mkdir(join(homeOff, ".dsh"), { recursive: true });
  await mkdir(projOff, { recursive: true });
  const ctxOff = fakeCtx();
  const registryOff = new ProjectMcpRegistry(ctxOff, {
    globalNames: async () => [],
    userLayerPaths: { mcpYml: join(homeOff, ".dsh", "mcp.yml"), mcpJson: join(homeOff, ".dsh", "mcp.json"), profilesDir: join(homeOff, ".dsh", "profiles") }
  });
  try {
    let hits = 0;
    const off = registryOff.subscribeUpdated(() => { hits += 1; });
    await registryOff.reconcileNow();
    assert.ok(hits >= 1, "subscribeUpdated hears projectMcp/updated");
    const after = hits;
    off();
    await registryOff.reconcileNow();
    assert.equal(hits, after, "the disposer from ctx.on removes the listener");
    pass("subscribeUpdated returns the cordis disposer");
  } finally {
    for (const disposer of ctxOff.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    await rmRetry(dirOff);
  }
}

{
  // 会话起来时项目还没有 .dsh。只盯三个尚不存在的文件路径会永久错过
  // `.dsh/mcp.yml`；监听项目根之后再创建该文件，必须热装载。
  const dirLate = await mkdtemp(join(tmpdir(), "dsh-mcp-late-dsh-"));
  const homeLate = join(dirLate, "home");
  const projLateWatch = join(dirLate, "proj");
  await mkdir(join(homeLate, ".dsh"), { recursive: true });
  await mkdir(projLateWatch, { recursive: true });
  const ctxLate = fakeCtx();
  const registryLate = new ProjectMcpRegistry(ctxLate, {
    globalNames: async () => [],
    userLayerPaths: { mcpYml: join(homeLate, ".dsh", "mcp.yml"), mcpJson: join(homeLate, ".dsh", "mcp.json"), profilesDir: join(homeLate, ".dsh", "profiles") }
  });
  try {
    ctxLate.agentsList.push(fakeAgent("session-late-dsh", projLateWatch));
    await registryLate.reconcileNow();
    let countLate = registryLate.debugReconcileCount;
    for (let waited = 0; waited < 6000; waited += 300) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
      const next = registryLate.debugReconcileCount;
      if (next === countLate) break;
      countLate = next;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
    assert.equal(await pathExists(projectMcpFile(projLateWatch)), false, "the project starts without .dsh/mcp.yml");
    await writeManagedRows(projectMcpFile(projLateWatch), [stdioRow("late-yml")], { createIfMissing: true });
    assert.ok(
      await registryLate.waitForState(projLateWatch, "late-yml", (state) => state?.phase === "active", 5000),
      "creating .dsh/mcp.yml after the watcher is up hot-mounts"
    );
    assert.ok(registryLate.debugReconcileCount > countLate, "the new project yml must drive reconcile without reconcileNow");
    pass("creating .dsh/mcp.yml after the project watcher starts hot-mounts");
  } finally {
    for (const disposer of ctxLate.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    await rmRetry(dirLate);
  }
}

// Real stdio protocol with the same fake DSH registry used by the Eager tests.
{
  const root = await mkdtemp(join(tmpdir(), "dsh-mcp-lazy-"));
  const project = join(root, "project");
  const other = join(root, "other");
  const script = join(root, "server.mjs");
  const trace = join(root, "requests");
  await mkdir(join(project, ".dsh"), { recursive: true });
  await mkdir(other);
  await writeFile(script, String.raw`
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [trace, label] = process.argv.slice(2);
appendFileSync(trace, "start:" + label + "\n");
const inputSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
for await (const line of createInterface({ input: process.stdin })) {
  const { method, id, params } = JSON.parse(line);
  if (id === undefined) continue;
  appendFileSync(trace, method + "\n");
  let result;
  if (method === "initialize") {
    result = { protocolVersion: params.protocolVersion, serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } };
  } else if (method === "tools/list") {
    result = { tools: ["echo", "secret"].map((name) => ({ name, description: "Fixture " + name, inputSchema })) };
  } else if (method === "tools/call") {
    result = { content: [{ type: "text", text: label + ":" + params.arguments.value }] };
  }
  const response = result === undefined
    ? { error: { code: -32601, message: "Method not found" } }
    : { result };
  console.log(JSON.stringify({ jsonrpc: "2.0", id, ...response }));
}
`);
  const config = join(project, ".dsh", "mcp.json");
  const writeConfig = (label, mode = "lazy") => writeFile(config, JSON.stringify({
    mcpServers: {
      demo: {
        command: process.execPath, args: [script, trace, label], mode, toolCallTimeoutMs: 5000,
        tools: { allow: ["*"], deny: ["secret"] }
      }
    }
  }));
  await writeConfig("first");
  const ctx = fakeCtx();
  const registered = new Map();
  ctx.tools.schemas = () => [...registered.values()];
  ctx.tools.register = (definition) => {
    assert.ok(!registered.has(definition.name));
    registered.set(definition.name, definition);
    return () => registered.delete(definition.name);
  };
  const agent = fakeAgent("lazy-owner", project);
  const outsider = fakeAgent("other-project", other);
  ctx.agentsList.push(agent, outsider);
  const previousDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, "dsh-home");
  const registry = new ProjectMcpRegistry(ctx, { globalNames: async () => [] });
  const execute = (name, args, owner = agent) => registered.get(name).execute(args, {
    agent: owner, signal: new AbortController().signal
  });
  try {
    await registry.reconcileNow();
    assert.deepEqual([...registered.keys()], ["mcp_search", "mcp_describe", "mcp_call"]);
    assert.equal(ctx.mounts.length, 0);
    assert.equal(await pathExists(trace), false, "Lazy discovery must not spawn a process at startup");
    assert.ok(outsider.denies.some((deny) => deny.includes("mcp_call")));
    await assert.rejects(() => execute("mcp_call", { server: "demo", tool: "echo" }, outsider), /unavailable in this session/);
    assert.equal(await pathExists(trace), false, "cross-project rejection must happen before connecting");

    // Count the actual registered proxy definitions without discovery/spawn.
    const proxyChars = JSON.stringify([...registered.values()].map(({ name, description, parameters }) =>
      ({ name, description, parameters }))).length;
    const proxyCost = registry.contextCost(agent.id);
    assert.equal(proxyCost.tools, 3);
    assert.equal(proxyCost.chars, proxyChars);
    assert.equal(proxyCost.estTokens, Math.ceil(proxyChars / 4) + 4);
    assert.equal(proxyCost.servers.length, 1);
    assert.equal(proxyCost.servers[0].kind, "lazy-proxy");
    assert.equal(registry.contextCost(outsider.id).tools, 0, "global fallback excludes another project's denied proxies");
    outsider.ctx.tools.schemas = () => { throw new Error("scope unavailable"); };
    assert.equal(registry.contextCost(outsider.id).tools, 0, "a failing scoped view must not leak proxy cost across projects");
    agent.ctx.tools.schemas = () => [];
    assert.equal(registry.contextCost(agent.id).tools, 0, "a valid empty scoped view wins over the global catalog");
    agent.ctx.tools.schemas = () => [...registered.values()].filter(({ name }) => name !== "mcp_call");
    assert.equal(registry.contextCost(agent.id).tools, 2, "count only proxies still visible under host restrictions");
    delete agent.ctx.tools.schemas;
    assert.equal(await pathExists(trace), false, "context-cost reads never connect or discover a Lazy server");

    const [search] = await Promise.all([
      execute("mcp_search", { query: "fixture" }),
      execute("mcp_search", { server: "demo" })
    ]);
    const described = await execute("mcp_describe", { server: "demo", tool: "echo" });
    assert.deepEqual(JSON.parse(search.content[0].text).tools.map(({ tool }) => tool), ["echo"]);
    assert.deepEqual(JSON.parse(described.content[0].text).inputSchema.required, ["value"]);
    await assert.rejects(() => execute("mcp_call", { server: "demo", tool: "secret" }), /unavailable in this session/);
    const invoke = () => execute("mcp_call", { server: "demo", tool: "echo", arguments: { value: "ok" } });
    assert.equal((await invoke()).content[0].text, "first:ok");
    const firstTrace = await readFile(trace, "utf8");
    assert.equal(firstTrace.match(/^initialize$/gm).length, 1, "concurrent discovery shares one connection");
    assert.equal(firstTrace.match(/^tools\/list$/gm).length, 1, "metadata is reused");
    await writeConfig("second");
    await registry.reconcileNow();
    await assert.rejects(invoke, /Run mcp_search/);
    await execute("mcp_search", { server: "demo" });
    assert.equal((await invoke()).content[0].text, "second:ok", "hot reload replaces the connection");
    await writeConfig("third", "eager");
    await registry.reconcileNow();
    assert.equal(registered.size, 0, "switching the last Lazy server back removes the proxies");
    assert.equal(ctx.mounts.at(-1).args.at(-1), "third");
    assert.ok(!Object.hasOwn(ctx.mounts.at(-1), "mode"), "mode must not reach the official client");
    pass("Lazy stdio connects on demand, caches discovery, applies filters and session isolation, and hot-reloads");
  } finally {
    for (const disposer of ctx.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    await rmRetry(root);
  }
}

/** 所有并发文件操作落定后才允许 finally 清理临时目录。 */
async function finishFixtureWrites(operations) {
  const outcomes = await Promise.allSettled(operations);
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure !== undefined) throw failure.reason;
}

/** 两个隔离场景共用设施；配置差异和授权断言留在各自用例里。 */
async function withLazyProjects({ prefix, rowsA, rowsB, globalRows = [], extraSessionA = false }, run) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const home = join(root, "home");
  const projA = join(root, "project-a");
  const projB = join(root, "project-b");
  const script = join(root, "lazy-fixture.mjs");
  const savedCwd = process.cwd();
  const ctx = fakeCtx();
  try {
    await finishFixtureWrites([home, projA, projB].map((directory) =>
      mkdir(join(directory, ".dsh"), { recursive: true })));
    await writeFile(script, String.raw`
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [trace, label] = process.argv.slice(2);
const log = (line) => appendFileSync(trace, line + "\n");
log("start:" + label);
process.on("exit", () => log("exit:" + label));
const inputSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
for await (const line of createInterface({ input: process.stdin })) {
  const { method, id, params } = JSON.parse(line);
  if (id === undefined) continue;
  log("method:" + label + ":" + method);
  let result;
  if (method === "initialize") {
    result = { protocolVersion: params.protocolVersion, serverInfo: { name: "fixture-" + label, version: "1" }, capabilities: { tools: {} } };
  } else if (method === "tools/list") {
    result = { tools: ["echo", "secret"].map((name) => ({ name, description: label + " " + name, inputSchema })) };
  } else if (method === "tools/call") {
    result = { content: [{ type: "text", text: label + ":" + params.arguments.value }] };
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id, ...(result === undefined ? { error: { code: -32601, message: "Method not found" } } : { result }) }));
}
`);
    const traceFor = (label) => join(root, "trace-" + label + ".log");
    const lazyRow = ([name, label]) => ({
      id: "panel-" + label,
      name: "@deepseek-ai/dsh-mcp-client",
      config: {
        serverName: name,
        transport: "stdio",
        command: process.execPath,
        args: [script, traceFor(label), label],
        mode: "lazy",
        toolCallTimeoutMs: 5000,
        tools: { allow: ["*"], deny: ["secret"] }
      }
    });
    const targets = [
      [projectMcpFile(projA), rowsA],
      [projectMcpFile(projB), rowsB],
      [join(home, ".dsh", "mcp.yml"), globalRows]
    ];
    await finishFixtureWrites(targets.filter(([, rows]) => rows.length > 0).map(([path, rows]) =>
      writeManagedRows(path, rows.map(lazyRow), { createIfMissing: true })));
    process.chdir(root);
    const registered = new Map();
    ctx.tools.schemas = () => [...registered.values()];
    ctx.tools.register = (definition) => {
      assert.ok(!registered.has(definition.name));
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    };
    const agentA = fakeAgent("lazy-a", projA);
    const agentB = fakeAgent("lazy-b", projB);
    const agentA2 = extraSessionA ? fakeAgent("lazy-a2", projA) : undefined;
    ctx.agentsList.push(agentA);
    if (agentA2 !== undefined) {
      agentA2.session.id = agentA2.id;
      ctx.agentsList.push(agentA2);
    }
    ctx.agentsList.push(agentB);
    const registry = new ProjectMcpRegistry(ctx, {
      globalNames: async () => [],
      userLayerPaths: {
        mcpYml: join(home, ".dsh", "mcp.yml"),
        mcpJson: join(home, ".dsh", "mcp.json"),
        profilesDir: join(home, ".dsh", "profiles")
      }
    });
    const execute = (name, args, agent) => registered.get(name).execute(args, {
      agent, signal: new AbortController().signal
    });
    const viewsOf = async (projectRoot) => (await registry.snapshot()).find((entry) => entry.project === projectRoot)?.servers ?? [];
    await run({ ctx, registry, registered, execute, viewsOf, traceFor, projA, projB, agentA, agentA2, agentB });
  } finally {
    for (const disposer of ctx.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    process.chdir(savedCwd);
    await rmRetry(root);
  }
}

// Gate1：两个项目同时有 Lazy 时，隔离必须落在“哪个 server 可见”，而不是只靠
// “没有 Lazy 就整体 deny 三个代理工具”。这里覆盖：异名、跨项目同原名（生效名
// 改名）、search/describe/call 双向越权，以及会话销毁后的 active-session 检查。
await withLazyProjects({
  prefix: "dsh-mcp-lazy-two-project-",
  rowsA: [["demo", "a-demo"], ["alpha", "a-alpha"]],
  rowsB: [["demo", "b-demo"], ["beta", "b-beta"]],
  extraSessionA: true
}, async ({ ctx, registry, registered, execute, viewsOf, traceFor, projA, projB, agentA, agentA2, agentB }) => {
  await registry.reconcileNow();
  assert.deepEqual([...registered.keys()], ["mcp_search", "mcp_describe", "mcp_call"]);
  assert.equal(ctx.mounts.length, 0, "Lazy rows must not mount the official client");
  const aProxyCost = registry.contextCost(agentA.id);
  const bProxyCost = registry.contextCost(agentB.id);
  assert.equal(aProxyCost.tools, 3, "multiple Lazy servers still share three proxy definitions");
  assert.deepEqual(aProxyCost.servers, bProxyCost.servers, "two projects share the same proxy schema cost, not per-server copies");
  assert.equal(await pathExists(traceFor("a-demo")), false, "startup must not spawn a Lazy server");

  const aViews = await viewsOf(projA);
  const bViews = await viewsOf(projB);
  const effective = (views, name) => views.find((view) => view.serverName === name)?.effectiveServerName;
  const aDemo = effective(aViews, "demo");
  const aAlpha = effective(aViews, "alpha");
  const bDemo = effective(bViews, "demo");
  const bBeta = effective(bViews, "beta");
  assert.ok(aDemo && bDemo && aAlpha && bBeta,
    "both projects' Lazy views must be present: " + JSON.stringify({ aViews, bViews }));
  assert.notEqual(aDemo, bDemo, "the same raw name in two projects must get distinct effective names");
  assert.equal(aAlpha, "alpha");
  assert.equal(bBeta, "beta");

  for (const [agent, label] of [[agentA, "A"], [agentA2, "A2"], [agentB, "B"]]) {
    const deny = agent.denies.at(-1) ?? [];
    assert.ok(!["mcp_search", "mcp_describe", "mcp_call"].some((name) => deny.includes(name)),
      label + " has its own Lazy server; the proxy tools must not be denied: " + JSON.stringify(deny));
  }

  // 只连本项目的 a-alpha；不要先做无 server 过滤的 search，否则会把 a-demo
  // 也拉起来，后面的“跨项目不得新增连接”断言就失去意义。
  await execute("mcp_search", { server: aAlpha }, agentA);
  await execute("mcp_search", { server: bBeta }, agentB);
  const descA = await execute("mcp_describe", { server: aAlpha, tool: "echo" }, agentA);
  assert.deepEqual(JSON.parse(descA.content[0].text).inputSchema.required, ["value"]);
  assert.equal((await execute("mcp_call", { server: aAlpha, tool: "echo", arguments: { value: "own" } }, agentA)).content[0].text, "a-alpha:own");
  assert.equal((await execute("mcp_call", { server: bBeta, tool: "echo", arguments: { value: "own" } }, agentB)).content[0].text, "b-beta:own");

  const crossSearchA = await execute("mcp_search", { server: bDemo }, agentA);
  assert.deepEqual(JSON.parse(crossSearchA.content[0].text).tools, [], "A must not search B's effective server");
  await assert.rejects(() => execute("mcp_describe", { server: bDemo, tool: "echo" }, agentA), /unavailable in this session/);
  await assert.rejects(() => execute("mcp_call", { server: bDemo, tool: "echo", arguments: { value: "x" } }, agentA), /unavailable in this session/);
  assert.equal(await pathExists(traceFor("b-demo")), false, "A's cross-project attempt must fail before B connects");

  const crossSearchB = await execute("mcp_search", { server: aDemo }, agentB);
  assert.deepEqual(JSON.parse(crossSearchB.content[0].text).tools, [], "B must not search A's effective server");
  await assert.rejects(() => execute("mcp_describe", { server: aDemo, tool: "echo" }, agentB), /unavailable in this session/);
  await assert.rejects(() => execute("mcp_call", { server: aDemo, tool: "echo", arguments: { value: "x" } }, agentB), /unavailable in this session/);
  assert.equal(await pathExists(traceFor("a-demo")), false, "B's cross-project attempt must fail before A connects");

  const broadA = JSON.parse((await execute("mcp_search", { query: "echo" }, agentA)).content[0].text);
  assert.ok(broadA.tools.length > 0);
  assert.ok(broadA.tools.every(({ server }) => server === aDemo || server === aAlpha),
    "A's broad search must only contain A's servers: " + JSON.stringify(broadA.tools));
  const broadB = JSON.parse((await execute("mcp_search", { query: "echo" }, agentB)).content[0].text);
  assert.ok(broadB.tools.length > 0);
  assert.ok(broadB.tools.every(({ server }) => server === bDemo || server === bBeta),
    "B's broad search must only contain B's servers: " + JSON.stringify(broadB.tools));
  await assert.rejects(() => execute("mcp_call", { server: aAlpha, tool: "secret", arguments: { value: "x" } }, agentA), /unavailable in this session/);

  const invokeA2 = () => execute("mcp_call", { server: aAlpha, tool: "echo", arguments: { value: "own" } }, agentA2);
  await assert.rejects(invokeA2, /Run mcp_search/);
  const traceA = traceFor("a-alpha");
  const initializations = async () => (await readTraceLines(traceA)).filter((line) => line === "method:a-alpha:initialize").length;
  assert.equal(await initializations(), 1);
  await execute("mcp_search", { server: aAlpha }, agentA2);
  assert.equal((await invokeA2()).content[0].text, "a-alpha:own");
  assert.equal(await initializations(), 2, "a new session opens an independent connection");
  const indexA2 = ctx.agentsList.findIndex((agent) => agent.id === agentA2.id);
  assert.ok(indexA2 >= 0);
  ctx.agentsList.splice(indexA2, 1);
  ctx.emit("agent/disposed", { agent: agentA2 });
  const replacement = { ...agentA2 };
  ctx.agentsList.push(replacement);
  await registry.reconcileNow();
  assert.equal((await execute("mcp_call", { server: aAlpha, tool: "echo", arguments: { value: "replacement" } }, replacement)).content[0].text, "a-alpha:replacement");
  assert.equal(await initializations(), 2, "agent replacement keeps the same session connection");
  ctx.emit("session/disposed", replacement.session);
  await assert.rejects(() => execute("mcp_search", { server: aAlpha }, replacement), /active DSH session is required/);
  ctx.agentsList.pop();
  assert.ok(await waitForTrace(traceA, (lines) => lines.includes("exit:a-alpha")));
  await registry.reconcileNow();
  await assert.rejects(() => execute("mcp_call", { server: aAlpha, tool: "echo", arguments: { value: "dead" } }, agentA2), /active DSH session is required/);
  assert.equal((await execute("mcp_call", { server: aAlpha, tool: "echo", arguments: { value: "alive" } }, agentA)).content[0].text, "a-alpha:alive",
    "the surviving session keeps its own Lazy server");
  pass("Gate1: two projects with Lazy servers isolate server scope, namespacing, proxy availability and disposed sessions");
});

// Gate1：全局 Lazy 被项目行同名遮蔽时，A 只能看到项目生效名，B 看到全局名；
// 切换焦点时继续复用 Lazy 连接，项目遮蔽全局的规则按会话生效。
await withLazyProjects({
  prefix: "dsh-mcp-lazy-global-focus-",
  rowsA: [["shared", "a-shared"], ["demo", "a-demo"]],
  rowsB: [["demo", "b-demo"], ["beta", "b-beta"]],
  globalRows: [["shared", "g-shared"]]
}, async ({ ctx, registry, registered, execute, viewsOf, traceFor, projA, projB, agentA, agentB }) => {
  await registry.reconcileNow();
  assert.deepEqual([...registered.keys()], ["mcp_search", "mcp_describe", "mcp_call"]);
  const snap = await registry.snapshot();
  const globalViews = snap.find((entry) => entry.kind === "global")?.servers ?? [];
  const aViews = await viewsOf(projA);
  const bViews = await viewsOf(projB);
  const effective = (views, name) => views.find((view) => view.serverName === name)?.effectiveServerName;
  const aShared = effective(aViews, "shared");
  const aDemo = effective(aViews, "demo");
  const bDemo = effective(bViews, "demo");
  const bBeta = effective(bViews, "beta");
  assert.ok(aShared && aDemo && bDemo && bBeta,
    "both projects' Lazy views must be present: " + JSON.stringify({ aViews, bViews }));
  assert.notEqual(aShared, "shared", "A's local shared must be namespaced against the global shared");
  assert.ok(globalViews.some((view) => view.serverName === "shared" && view.effectiveServerName === "shared"),
    "the global shared row must keep its original effective name: " + JSON.stringify(globalViews));

  const aSearchGlobal = await execute("mcp_search", { server: "shared" }, agentA);
  assert.deepEqual(JSON.parse(aSearchGlobal.content[0].text).tools, [], "A must not see the global shared shadowed by its project row");
  await assert.rejects(() => execute("mcp_call", { server: "shared", tool: "echo", arguments: { value: "x" } }, agentA), /unavailable in this session/);
  await execute("mcp_search", { server: aShared }, agentA);
  assert.equal((await execute("mcp_call", { server: aShared, tool: "echo", arguments: { value: "local" } }, agentA)).content[0].text, "a-shared:local");

  const bSearchGlobal = JSON.parse((await execute("mcp_search", { server: "shared" }, agentB)).content[0].text);
  assert.deepEqual(bSearchGlobal.tools.map(({ server }) => server), ["shared"]);
  assert.equal((await execute("mcp_call", { server: "shared", tool: "echo", arguments: { value: "global" } }, agentB)).content[0].text, "g-shared:global");
  await execute("mcp_search", { server: bBeta }, agentB);
  assert.equal((await execute("mcp_call", { server: bBeta, tool: "echo", arguments: { value: "b" } }, agentB)).content[0].text, "b-beta:b");

  await assert.rejects(() => execute("mcp_call", { server: aShared, tool: "echo", arguments: { value: "x" } }, agentB), /unavailable in this session/);
  await assert.rejects(() => execute("mcp_call", { server: bDemo, tool: "echo", arguments: { value: "x" } }, agentA), /unavailable in this session/);
  assert.equal(await pathExists(traceFor("b-demo")), false, "A must not connect to B's demo");

  const switchAndVerify = async (agent, cwd) => {
    ctx.emit("session/event", { id: agent.id, header: { cwd } }, { type: "user/message" });
    await registry.reconcileNow();
    assert.equal((await execute("mcp_call", { server: aShared, tool: "echo", arguments: { value: "a" } }, agentA)).content[0].text, "a-shared:a");
    assert.equal((await execute("mcp_call", { server: bBeta, tool: "echo", arguments: { value: "b" } }, agentB)).content[0].text, "b-beta:b");
    await assert.rejects(() => execute("mcp_call", { server: bBeta, tool: "echo", arguments: { value: "x" } }, agentA), /unavailable in this session/);
    await assert.rejects(() => execute("mcp_call", { server: aShared, tool: "echo", arguments: { value: "x" } }, agentB), /unavailable in this session/);
  };
  await switchAndVerify(agentA, projA);
  await switchAndVerify(agentB, projB);
  await switchAndVerify(agentA, projA);
  // 常驻挂载后焦点切换不再卸载代理：两个会话各自仍计一组共享代理定义。
  assert.equal(registry.contextCost(agentA.id).tools, 3, "resident mounts keep one shared proxy group visible to A after switches");
  assert.equal(registry.contextCost(agentB.id).tools, 3, "resident mounts keep one shared proxy group visible to B after switches");
  await Promise.all(["a-shared", "b-beta"].map(async (label) => {
    const lines = await readTraceLines(traceFor(label));
    assert.equal(lines.filter((line) => line === `method:${label}:initialize`).length, 1, "switches reuse the same Lazy connection");
    assert.ok(!lines.includes(`exit:${label}`), "switches keep the Lazy subprocess alive");
  }));
  pass("workspace switches preserve Lazy connections and isolate project tools");
});

// setLoadingMode 契约：managed 行就地更新；JSON/遗留层只读，takeover 写受管 yml
// 且原文件不动、disabled 保持；用户/profile/当前项目可写，非当前项目与非法 mode 拒绝；
// mode 只留在受管 yml，不传给官方 mcp-client（既有 lazy 断言继续保留）。
{
  const dirMode = await mkdtemp(join(tmpdir(), "dsh-mcp-loading-mode-"));
  const homeMode = join(dirMode, "home");
  const projMode = join(dirMode, "proj");
  const projOtherMode = join(dirMode, "other");
  const profilesMode = join(homeMode, ".dsh", "profiles");
  await mkdir(join(homeMode, ".dsh"), { recursive: true });
  await mkdir(join(projMode, ".dsh"), { recursive: true });
  await mkdir(projOtherMode, { recursive: true });
  await mkdir(join(profilesMode, "web"), { recursive: true });
  const ymlMode = projectMcpFile(projMode);
  const jsonMode = join(projMode, ".dsh", "mcp.json");
  const legacyJsonMode = join(projMode, ".mcp.json");
  const userYmlMode = join(homeMode, ".dsh", "mcp.yml");
  const profileYmlMode = join(profilesMode, "web", "mcp.yml");
  await writeManagedRows(ymlMode, [stdioRow("own")], { createIfMissing: true });
  await writeFile(jsonMode, JSON.stringify({
    mcpServers: {
      fromjson: { command: "node", args: ["j.js"] },
      rawdisabled: { command: "node", args: ["r.js"], disabled: true }
    }
  }), "utf8");
  await writeFile(legacyJsonMode, JSON.stringify({
    mcpServers: { legacy: { command: "node", args: ["l.js"] } }
  }), "utf8");
  await writeManagedRows(userYmlMode, [stdioRow("usershared")], { createIfMissing: true });
  await writeManagedRows(profileYmlMode, [stdioRow("webtool")], { createIfMissing: true });
  const savedCwdMode = process.cwd();
  process.chdir(dirMode);
  const ctxMode = fakeCtx();
  ctxMode.tools.register = () => () => {};
  ctxMode.tools.schemas = () => [];
  ctxMode.agentsList.push(fakeAgent("session-mode", projMode));
  const registryMode = new ProjectMcpRegistry(ctxMode, {
    globalNames: async () => [],
    activeProfile: async () => "web",
    userLayerPaths: {
      mcpYml: userYmlMode,
      mcpJson: join(homeMode, ".dsh", "mcp.json"),
      profilesDir: profilesMode
    }
  });
  try {
    await registryMode.reconcileNow();

    // 1) 同一条受管行就地更新：不新增行，只改 config.mode，其它字段保留。
    await registryMode.setLoadingMode("dsh-project", projMode, "own", "lazy");
    let rows = extractManagedRows(await readFile(ymlMode, "utf8"));
    assert.equal(rows.length, 1, "mode update edits the existing managed row in place");
    assert.equal(rows[0].config.mode, "lazy");
    assert.equal(rows[0].config.command, "node");
    await registryMode.setLoadingMode("dsh-project", projMode, "own", "eager");
    rows = extractManagedRows(await readFile(ymlMode, "utf8"));
    assert.equal(rows.length, 1, "switching back does not duplicate the managed row");
    assert.equal(rows[0].config.mode, "eager");

    // 2) mode 只写入受管行；切到 eager 后官方 client 配置不带 mode。
    await registryMode.reconcileNow();
    const ownMount = ctxMode.mounts.findLast((mount) => mount.serverName === "own");
    assert.ok(ownMount !== undefined, "the eager row mounts the official client");
    assert.equal(Object.hasOwn(ownMount, "mode"), false, "mode must not be passed to the official mcp-client");

    // 3) 用户层和 profile 层各自写自己的受管 yml。
    await registryMode.setLoadingMode("dsh-user-yml", "", "usershared", "lazy");
    let userRows = extractManagedRows(await readFile(userYmlMode, "utf8"));
    assert.equal(userRows.length, 1);
    assert.equal(userRows[0].config.mode, "lazy");
    await registryMode.setLoadingMode("dsh-profile-user-yml", "", "webtool", "lazy");
    let profileRows = extractManagedRows(await readFile(profileYmlMode, "utf8"));
    assert.equal(profileRows.length, 1);
    assert.equal(profileRows[0].config.mode, "lazy");

    // 4) JSON takeover：先停用成受管占位，再切 mode；disabled 必须保留，原 JSON 逐字节不动。
    const jsonBeforeMode = await readFile(jsonMode, "utf8");
    await registryMode.setServerEnabled("dsh-project-json", projMode, "fromjson", false);
    let takeover = extractManagedRows(await readFile(ymlMode, "utf8")).find((row) => row.id === "panel-mcp-fromjson");
    assert.equal(takeover?.disabled, true, "the JSON row first lands as a disabled managed placeholder");
    await registryMode.setLoadingMode("dsh-project-json", projMode, "fromjson", "lazy");
    takeover = extractManagedRows(await readFile(ymlMode, "utf8")).find((row) => row.id === "panel-mcp-fromjson");
    assert.equal(takeover?.disabled, true, "setting mode must not re-enable a disabled takeover");
    assert.equal(takeover?.config?.mode, "lazy");
    assert.equal(takeover?.config?.command, "node", "the takeover copies the JSON row config");
    await registryMode.setLoadingMode("dsh-project-json", projMode, "fromjson", "eager");
    takeover = extractManagedRows(await readFile(ymlMode, "utf8")).find((row) => row.id === "panel-mcp-fromjson");
    assert.equal(takeover?.disabled, true);
    assert.equal(takeover?.config?.mode, "eager");
    assert.equal(await readFile(jsonMode, "utf8"), jsonBeforeMode, "the .dsh/mcp.json file must stay byte-identical");

    // 4b) JSON 自身 disabled:true 的行同样可以 takeover；disabled 原样保留，JSON 不动。
    await registryMode.setLoadingMode("dsh-project-json", projMode, "rawdisabled", "lazy");
    const rawDisabledTakeover = extractManagedRows(await readFile(ymlMode, "utf8")).find((row) => row.id === "panel-mcp-rawdisabled");
    assert.equal(rawDisabledTakeover?.disabled, true, "a JSON row disabled:true keeps disabled in the takeover");
    assert.equal(rawDisabledTakeover?.config?.mode, "lazy");
    assert.equal(rawDisabledTakeover?.config?.command, "node");
    assert.equal(await readFile(jsonMode, "utf8"), jsonBeforeMode, "a disabled JSON row must not be rewritten either");

    // 5) 遗留 .mcp.json 同样只写受管 yml，原文件不动。
    const legacyBeforeMode = await readFile(legacyJsonMode, "utf8");
    await registryMode.setLoadingMode("cc-project", projMode, "legacy", "lazy");
    const legacyTakeover = extractManagedRows(await readFile(ymlMode, "utf8")).find((row) => row.id === "panel-mcp-legacy");
    assert.equal(legacyTakeover?.config?.mode, "lazy");
    assert.equal(legacyTakeover?.config?.command, "node");
    assert.equal(await readFile(legacyJsonMode, "utf8"), legacyBeforeMode, "the legacy .mcp.json file must stay byte-identical");

    // 6) config-less disabled placeholder: requireSourceRow must find it, but
    // setLoadingMode must reject instead of writing a mode-only invalid config.
    const placeholderRows = extractManagedRows(await readFile(ymlMode, "utf8"));
    await writeManagedRows(ymlMode, [...placeholderRows, {
      id: "panel-mcp-placeholder",
      name: "@deepseek-ai/dsh-mcp-client",
      disabled: true
    }]);
    await registryMode.reconcileNow();
    const placeholderBefore = await readFile(ymlMode, "utf8");
    await assert.rejects(
      () => registryMode.setLoadingMode("dsh-project", projMode, "placeholder", "lazy"),
      /缺少有效连接配置，不能切换加载模式/
    );
    assert.equal(await readFile(ymlMode, "utf8"), placeholderBefore, "a config-less placeholder must not be rewritten");

    // 7) 非法 mode 在写盘前拒绝，受管 yml 不变。
    const beforeInvalidMode = await readFile(ymlMode, "utf8");
    await assert.rejects(() => registryMode.setLoadingMode("dsh-project", projMode, "own", "sometime"));
    assert.equal(await readFile(ymlMode, "utf8"), beforeInvalidMode, "an invalid mode must not rewrite the managed yml");

    // 8) 后台工作区不能写；文件保持不变。
    const beforeOtherMode = await readFile(ymlMode, "utf8");
    const agentOtherMode = fakeAgent("session-mode-other", projOtherMode);
    ctxMode.agentsList.push(agentOtherMode);
    ctxMode.emit("agent/created", { agent: agentOtherMode, source: "resume" });
    await registryMode.reconcileNow();
    await assert.rejects(
      () => registryMode.setLoadingMode("dsh-project", projMode, "own", "lazy"),
      /这个工作区当前不能改/
    );
    assert.equal(await readFile(ymlMode, "utf8"), beforeOtherMode, "a background workspace must not be rewritten");
    pass("setLoadingMode updates managed rows, preserves disabled JSON takeovers, scopes writable layers and rejects invalid modes");
  } finally {
    for (const disposer of ctxMode.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    process.chdir(savedCwdMode);
    await rmRetry(dirMode);
  }
}

// ── contextCost：会话级 MCP 定义占用（只读、按会话可见性）────────────────────
{
  const dirCost = await mkdtemp(join(tmpdir(), "dsh-mcp-context-cost-"));
  const homeCost = join(dirCost, "home");
  const projCost = join(dirCost, "proj");
  await mkdir(join(homeCost, ".dsh"), { recursive: true });
  await mkdir(projCost, { recursive: true });
  await writeManagedRows(projectMcpFile(projCost), [stdioRow("alpha")], { createIfMissing: true });
  const savedCwdCost = process.cwd();
  try {
    process.chdir(dirCost);
    const ctxCost = fakeCtx();
    const registryCost = new ProjectMcpRegistry(ctxCost, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(homeCost, ".dsh", "mcp.yml"), mcpJson: join(homeCost, ".dsh", "mcp.json"), profilesDir: join(homeCost, ".dsh", "profiles") }
    });
    const costAgent = fakeAgent("session-cost", projCost);
    // 会话作用域视图：本插件已经按 deny 过滤后的那一份；宿主工具不在统计里。
    costAgent.ctx.tools.schemas = () => [
      { name: "mcp__alpha__read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { name: "mcp__alpha__write_file", description: "Write a file", parameters: { type: "object", properties: {} } },
      { name: "bash", description: "Host shell", parameters: { type: "object", properties: {} } }
    ];
    costAgent.session.requestContext = () => ({ contextWindow: 200000 });
    ctxCost.agentsList.push(costAgent);
    await registryCost.reconcileNow();

    const cost = registryCost.contextCost();
    assert.equal(cost.sessionId, "session-cost", "the focused session is measured");
    assert.equal(cost.tools, 2, "host tools are excluded from the MCP cost");
    assert.equal(cost.contextWindow, 200000, "the window comes from the session route metadata");
    assert.deepEqual(cost.servers.map((server) => [server.name, server.tools]), [["alpha", 2]]);
    assert.ok(cost.estTokens > 0, "a real catalog prices above zero: " + JSON.stringify(cost));
    assert.equal(cost.level, "ok", "a two-tool server stays below the reminder threshold");

    // 指定别的会话：找不到就退回零值，不借用当前会话的数字。
    const missing = registryCost.contextCost("no-such-session");
    assert.deepEqual([missing.sessionId, missing.tools, missing.level], ["no-such-session", 0, "ok"]);

    // deny 之后同一个会话的占用必须下降：统计口径跟随会话可见性。
    costAgent.ctx.tools.schemas = () => [
      { name: "mcp__alpha__read_file", description: "Read a file", parameters: { type: "object", properties: {} } }
    ];
    assert.equal(registryCost.contextCost().tools, 1, "the scoped view is read on every query");

    // 超过阈值时 level 升级，页面据此换配色与图标。
    costAgent.ctx.tools.schemas = () => [
      { name: "mcp__alpha__big", description: "x".repeat(40000), parameters: { type: "object", properties: {} } }
    ];
    assert.equal(registryCost.contextCost().level, "alert", "40k characters is well past 10k estimated tokens");

    // 工具调用结果：读会话当前的 deriveMessages()，Eager 与 Lazy 都按服务器归属。
    const resultMessages = [
      { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "mcp__alpha__read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "x".repeat(8) }] },
      { role: "assistant", content: [{ type: "tool-call", id: "c2", name: "mcp_call", arguments: JSON.stringify({ server: "demo", tool: "ping" }) }] },
      { role: "tool", toolCallId: "c2", content: [{ type: "text", text: "y".repeat(4) }] },
      { role: "assistant", content: [{ type: "tool-call", id: "c3", name: "bash", arguments: "{}" }] },
      { role: "tool", toolCallId: "c3", content: [{ type: "text", text: "host output" }] }
    ];
    costAgent.session.deriveMessages = () => resultMessages;
    const resultCost = registryCost.resultCost();
    assert.equal(resultCost.sessionId, "session-cost", "the focused session is measured");
    assert.equal(resultCost.calls, 2, "host tool results are excluded");
    assert.equal(resultCost.estTokens, 19, "10 for the Eager result + 9 for the Lazy result");
    assert.equal(resultCost.contextWindow, 200000, "the window comes from the same session route metadata");
    assert.deepEqual(resultCost.servers.map(({ name, kind, calls }) => ({ name, kind, calls })), [
      { name: "alpha", kind: undefined, calls: 1 },
      { name: "demo", kind: "lazy", calls: 1 }
    ]);
    assert.equal(registryCost.resultCost("no-such-session").calls, 0, "an unknown session gets zero, not the focused session's figure");
    costAgent.session.deriveMessages = () => { throw new Error("surface unavailable"); };
    assert.equal(registryCost.resultCost().calls, 0, "a failing deriveMessages() must not throw through the query face");

    // tool/result 改变仍保留的结果集时补发一次 updated；签名没变则不重复发。
    costAgent.session.deriveMessages = () => resultMessages;
    const resultUpdates = [];
    const unsubscribeResults = registryCost.subscribeUpdated(() => resultUpdates.push("updated"));
    ctxCost.emit("session/event", costAgent.session, { type: "tool/result" });
    assert.equal(resultUpdates.length, 1, "a new retained result emits projectMcp/updated");
    ctxCost.emit("session/event", costAgent.session, { type: "tool/result" });
    assert.equal(resultUpdates.length, 1, "an unchanged result signature does not re-emit");
    const longerResults = [
      ...resultMessages,
      { role: "assistant", content: [{ type: "tool-call", id: "c4", name: "mcp_call", arguments: JSON.stringify({ server: "demo", tool: "echo" }) }] },
      { role: "tool", toolCallId: "c4", content: [{ type: "text", text: "z".repeat(8) }] }
    ];
    costAgent.session.deriveMessages = () => longerResults;
    ctxCost.emit("session/event", costAgent.session, { type: "tool/result" });
    assert.equal(resultUpdates.length, 2, "a larger retained result emits again");
    costAgent.session.deriveMessages = () => resultMessages;
    ctxCost.emit("session/event", costAgent.session, { type: "assistant/message", surfaceOp: { op: "replace", startSeq: 0, endSeq: 0 } });
    assert.equal(resultUpdates.length, 3, "a compaction replacement that drops results emits too");
    unsubscribeResults();

    // 上下文窗口未知时省略该字段，而不是写 0。
    costAgent.session.requestContext = () => undefined;
    assert.equal("contextWindow" in registryCost.contextCost(), false);

    const serviceCost = bindProjectMcpService(registryCost);
    assert.equal(serviceCost.contextCost().sessionId, "session-cost", "the service exposes the same read");
    costAgent.session.deriveMessages = () => resultMessages;
    assert.equal(serviceCost.resultCost().calls, 2, "the service exposes the same result read");

    for (const disposer of ctxCost.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    pass("contextCost measures only the session's visible MCP schemas and reports the threshold level");
  } finally {
    process.chdir(savedCwdCost);
    await rmRetry(dirCost);
  }
}

// ── contextCost：活动会话选择 + 代码模式（PTC）无法估算 ──────────────────────
{
  const dirSel = await mkdtemp(join(tmpdir(), "dsh-mcp-cost-select-"));
  const homeSel = join(dirSel, "home");
  const projSel = join(dirSel, "proj");
  await mkdir(join(homeSel, ".dsh"), { recursive: true });
  await mkdir(projSel, { recursive: true });
  await writeManagedRows(projectMcpFile(projSel), [stdioRow("alpha")], { createIfMissing: true });
  const savedCwdSel = process.cwd();
  try {
    process.chdir(dirSel);
    const ctxSel = fakeCtx();
    const registrySel = new ProjectMcpRegistry(ctxSel, {
      globalNames: async () => [],
      userLayerPaths: { mcpYml: join(homeSel, ".dsh", "mcp.yml"), mcpJson: join(homeSel, ".dsh", "mcp.json"), profilesDir: join(homeSel, ".dsh", "profiles") }
    });
    const agentA = fakeAgent("sel-a", projSel);
    const agentB = fakeAgent("sel-b", projSel);
    agentA.session.id = "sel-a";
    agentB.session.id = "sel-b";
    agentA.ctx.tools.schemas = () => [{ name: "mcp__alpha__read", description: "Read", parameters: { type: "object", properties: {} } }];
    agentB.ctx.tools.schemas = () => [
      { name: "mcp__alpha__read", description: "Read", parameters: { type: "object", properties: {} } },
      { name: "mcp__alpha__write", description: "Write", parameters: { type: "object", properties: {} } }
    ];
    // B 后枚举：旧实现会拿「最后一个」冒充活动会话。
    ctxSel.agentsList.push(agentA, agentB);
    await registrySel.reconcileNow();

    // 没有宿主当前项、也没有用户回合时，才退回焦点工作区里最后一个。
    assert.equal(registrySel.contextCost().sessionId, "sel-b", "fallback is the last focused agent");

    // 宿主当前选中 A：即便 B 后枚举，也要读 A。
    ctxSel.sessions = { list: () => ({ current: { id: "sel-a" } }) };
    assert.equal(registrySel.contextCost().sessionId, "sel-a", "host current wins over enumeration order");
    assert.equal(registrySel.contextCost().tools, 1);
    assert.equal(registrySel.resultCost().sessionId, "sel-a", "result cost follows the same selection");
    // current 也可能是字符串 id。
    ctxSel.sessions = { list: () => ({ current: "sel-b" }) };
    assert.equal(registrySel.contextCost().sessionId, "sel-b", "string current id is honoured");
    assert.equal(registrySel.contextCost().tools, 2);

    // 宿主没有当前项（数组形态）时，跟随最近一次顶层用户回合。
    ctxSel.sessions = { list: () => [] };
    ctxSel.emit("session/event", { id: "sel-a", header: agentA.session.header }, { type: "user/message" });
    assert.equal(registrySel.contextCost().sessionId, "sel-a", "the latest top-level user turn selects the session");
    ctxSel.emit("session/event", { id: "sel-b", header: agentB.session.header }, { type: "user/message" });
    assert.equal(registrySel.contextCost().sessionId, "sel-b", "switching sessions in the same workspace re-selects");

    // 子代理的 user/message 不能把选择从真实会话上抢走。
    ctxSel.emit("session/event", { id: "sel-child", header: { cwd: projSel, origin: "subagent" } }, { type: "user/message" });
    assert.equal(registrySel.contextCost().sessionId, "sel-b", "a subagent turn does not steal the selection");
    ctxSel.emit("session/event", { id: "sel-deep", header: { cwd: projSel, delegationDepth: 2 } }, { type: "user/message" });
    assert.equal(registrySel.contextCost().sessionId, "sel-b", "a delegated turn does not steal the selection");
    // 压缩注入的 surface-replace（也是 user/message）同样不挪选择。
    ctxSel.emit("session/event", { id: "sel-a", header: agentA.session.header }, { type: "user/message", surfaceOp: { op: "replace", startSeq: 0, endSeq: 0 } });
    assert.equal(registrySel.contextCost().sessionId, "sel-b", "a compaction replace does not steal the selection");

    // 活动会话被销毁后清掉记录，退回焦点兜底。
    ctxSel.emit("session/disposed", { id: "sel-b" });
    assert.equal(registrySel.contextCost().sessionId, "sel-b", "disposed id falls back to the last focused agent");

    // 代码模式（PTC）：请求头里有保留名 run_code → 定义与结果都报无法估算。
    const agentPtc = fakeAgent("sel-ptc", projSel);
    agentPtc.session.id = "sel-ptc";
    agentPtc.session.requestHeader = () => ({ tools: [{ name: "run_code" }, { name: "mcp__alpha__read" }] });
    agentPtc.session.requestContext = () => ({ contextWindow: 200000 });
    agentPtc.ctx.tools.schemas = () => [{ name: "mcp__alpha__read", description: "x".repeat(40000), parameters: { type: "object", properties: {} } }];
    agentPtc.session.deriveMessages = () => [
      { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "mcp__alpha__read", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "x".repeat(40000) }] }
    ];
    ctxSel.agentsList.push(agentPtc);
    ctxSel.sessions = { list: () => ({ current: { id: "sel-ptc" } }) };
    const ptcCost = registrySel.contextCost();
    assert.equal(ptcCost.unsupported, "code-mode", "PTC definitions are not priced from raw schemas");
    assert.equal(ptcCost.sessionId, "sel-ptc");
    assert.deepEqual([ptcCost.tools, ptcCost.estTokens, ptcCost.servers], [0, 0, []]);
    assert.equal(ptcCost.contextWindow, 200000);
    const ptcResult = registrySel.resultCost();
    assert.equal(ptcResult.unsupported, "code-mode", "PTC results nested in run_code are not attributed");
    assert.deepEqual([ptcResult.calls, ptcResult.estTokens], [0, 0]);

    // 切回原生执行器（请求头没有 run_code）即恢复估算，不被 unsupported 缓存住。
    agentPtc.session.seq = 1;
    agentPtc.session.requestHeader = () => ({ tools: [{ name: "mcp__alpha__read" }] });
    const nativeAgain = registrySel.contextCost();
    assert.equal(nativeAgain.unsupported, undefined, "native executor is estimated again");
    assert.equal(nativeAgain.tools, 1);
    assert.equal(registrySel.resultCost().calls, 1, "native results are attributed again");
    // 还没有请求头（刚恢复的会话）按原生口径估算，首次请求后自我纠正。
    agentPtc.session.requestHeader = () => undefined;
    assert.equal(registrySel.contextCost().unsupported, undefined, "no header yet falls back to native estimate");

    for (const disposer of ctxSel.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    pass("contextCost follows the active session and reports code mode as unsupported");
  } finally {
    process.chdir(savedCwdSel);
    await rmRetry(dirSel);
  }
}

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL PROJECT REGISTRY TESTS PASSED");
// chokidar close() is fire-and-forget in registry dispose; on Windows a
// pending FSWatcher can keep the event loop alive after the suite finishes.
process.exit(0);
