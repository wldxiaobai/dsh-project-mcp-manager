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
    globalNames: async () => ["gitlab"] // 全局已占用 gitlab → 项目行必须改名
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
} finally {
  process.chdir(originalCwd);
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL PROJECT REGISTRY TESTS PASSED");
