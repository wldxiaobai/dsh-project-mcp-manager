import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectMcpRegistry, projectMcpFile } from "../lib/registry.js";
import { writeManagedRows } from "../lib/mcp-file.js";

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
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

  // 6. 清理：effect 收集的 disposer 关闭 watcher、释放装载（chokidar 句柄）
  for (const disposer of ctx.disposers) {
    const cleanup = disposer();
    if (typeof cleanup === "function") cleanup();
  }
  assert.deepEqual(ctx.disposals, [mounted.serverName]);
  pass("registry cleanup disposes watcher and mounted fibers");
} finally {
  process.chdir(originalCwd);
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL PROJECT REGISTRY TESTS PASSED");
