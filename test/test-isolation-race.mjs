// 隔离时序缝隙探测（审查报告 R32-01 后续，T1–T5）。
// 目标：在 deny + 提示词过滤 + 资源门 的三层防御下，尝试让会话读到不属于本工作区的 MCP。
// 运行：node test/test-isolation-race.mjs（依赖 lib/，先 npm run build:core）。
// 与 test-registry.mjs 不同：本文件逐场景收集失败而非 fail-fast，便于一次跑完看全貌。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectMcpRegistry, projectMcpFile } from "../lib/registry.js";
import { writeManagedRows } from "../lib/mcp-file.js";
import { byCodeUnit } from "../lib/model.js";
import { DIAG_FILE } from "../lib/dsh-paths.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Windows 上 chokidar 关闭后目录句柄可能仍短暂占用：rm 带退避重试。
 *  有界串行重试（Sonar javascript:S9382）：下一轮必须等上一轮失败与退避之后。 */
async function rmRetry(path) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      await delay(250);
    }
  }
  await rm(path, { recursive: true, force: true });
}

const stdioRow = (name, args = ["srv-" + name + ".js"]) => ({
  id: "panel-mcp-" + name,
  name: "@deepseek-ai/dsh-mcp-client",
  config: { serverName: name, transport: "stdio", command: "node", args, env: {}, cwd: "sub", toolCallTimeoutMs: 60000, failOnStartupError: false, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } }
});

/** 最小假宿主 ctx：与 test-registry.mjs 同构（plugin/holdDispose/holdFibers/handlers）。 */
function fakeCtx() {
  const mounts = [];
  const disposals = [];
  const agents = [];
  const disposers = [];
  const schemas = [];
  const handlers = new Map();
  const ctx = {
    mounts,
    disposals,
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
    emit(name, ...args) {
      for (const callback of handlers.get(name) ?? []) callback(...args);
    },
    provide(name, value) {
      this.provided[name] = value;
      return () => { delete this.provided[name]; };
    },
    effect(callback) {
      if (typeof callback === "function") disposers.push(callback);
    },
    logger: { warn() {}, error() {}, info() {} },
    tools: { schemas: () => schemas },
    holdFibers: false,
    held: [],
    holdDispose: false,
    releaseDispose: [],
    plugin(_plugin, config) {
      // cordis fiber 本就是 thenable：用真 Promise 承载 settle，不手写 then
      // （Sonar javascript:S7739）。trackMount 对每个 fiber 只调一次
      // .then(onActive, onFailed)，真 Promise 语义完全覆盖；holdFibers 时
      // 把 resolve 挂起，释放后才 settle。
      let resolveReady;
      const fiber = Object.assign(new Promise((resolve) => { resolveReady = resolve; }), {
        config,
        dispose: async () => {
          disposals.push(config.serverName);
          if (ctx.holdDispose) {
            await new Promise((resolveDispose) => { ctx.releaseDispose.push(resolveDispose); });
          }
        }
      });
      if (ctx.holdFibers) ctx.held.push(() => resolveReady());
      else queueMicrotask(() => resolveReady());
      mounts.push(config);
      return fiber;
    },
    get agents() {
      return { list: () => agents, isOwnedBy: () => false };
    }
  };
  return ctx;
}

/** 假 agent：记录历次 deny，并跟踪「当前生效」的限制（空 deny 会移除限制而非再调 restrict）。 */
function fakeAgent(id, cwd) {
  const denies = [];
  const active = new Set();
  let current = null;
  let failOnce = false;
  const agent = {
    id,
    session: { header: { cwd } },
    denies,
    activeRestrictions: active,
    currentDeny: () => (current === null ? null : current.names),
    failRestrictOnce() { failOnce = true; },
    ctx: {
      tools: {
        restrict({ deny }) {
          if (failOnce) {
            failOnce = false;
            throw new Error("simulated host restrict failure: unknown tool name");
          }
          const names = [...deny].sort(byCodeUnit);
          denies.push(names);
          const entry = { names, disposer: null };
          entry.disposer = () => {
            active.delete(entry);
            if (current === entry) current = null;
          };
          active.add(entry);
          current = entry;
          return entry.disposer;
        }
      }
    }
  };
  return agent;
}

/** 两工作区各一台 Eager（alpha/beta），两个会话已创建且 deny 落定。 */
async function setupTwoWorkspaces(prefix, extraProviders = {}) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const home = join(dir, "home");
  const projA = join(dir, "a");
  const projB = join(dir, "b");
  await mkdir(join(home, ".dsh"), { recursive: true });
  await mkdir(projA);
  await mkdir(projB);
  await writeManagedRows(projectMcpFile(projA), [stdioRow("alpha")], { createIfMissing: true });
  await writeManagedRows(projectMcpFile(projB), [stdioRow("beta")], { createIfMissing: true });
  const savedCwd = process.cwd();
  process.chdir(dir);
  const ctx = fakeCtx();
  ctx.schemas.push({ name: "mcp__alpha__read" }, { name: "mcp__beta__read" });
  const registry = new ProjectMcpRegistry(ctx, {
    globalNames: async () => [],
    userLayerPaths: { mcpYml: join(home, ".dsh", "mcp.yml"), mcpJson: join(home, ".dsh", "mcp.json"), profilesDir: join(home, ".dsh", "profiles") },
    ...extraProviders
  });
  const agentA = fakeAgent("session-a", projA);
  const agentB = fakeAgent("session-b", projB);
  ctx.agentsList.push(agentA, agentB);
  await registry.reconcileNow();
  assert.ok(await registry.waitForState(projA, "alpha", (s) => s?.phase === "active", 5000), "alpha mounts");
  assert.ok(await registry.waitForState(projB, "beta", (s) => s?.phase === "active", 5000), "beta mounts");
  const [created] = ctx.handlers.get("agent/created");
  await created({ agent: agentA, source: "startup" });
  await created({ agent: agentB, source: "startup" });
  assert.deepEqual(agentA.currentDeny(), ["mcp__beta__read"], "baseline: A denies B");
  assert.deepEqual(agentB.currentDeny(), ["mcp__alpha__read"], "baseline: B denies A");
  return { dir, home, projA, projB, savedCwd, ctx, registry, agentA, agentB, created };
}

async function teardown(s) {
  s.ctx.holdDispose = false;
  for (const release of s.ctx.releaseDispose.splice(0)) release();
  for (const disposer of s.ctx.disposers) {
    const cleanup = disposer();
    if (typeof cleanup === "function") cleanup();
  }
  process.chdir(s.savedCwd);
  await rmRetry(s.dir);
}

/** 轮询直到谓词成立（对账链异步推进，不能用固定 sleep）。
 *  有界串行轮询（Sonar javascript:S9382）：逐轮检查 + 退避，不能并行化。 */
async function until(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await delay(20);
  }
  return false;
}

const unhandled = [];
process.on("unhandledRejection", (error) => { unhandled.push(error); });

const failures = [];
async function scenario(name, fn) {
  try {
    await fn();
    console.log("PASS  " + name);
  } catch (error) {
    failures.push({ name, error });
    console.log("FAIL  " + name);
    console.log("      " + (error instanceof Error ? error.message : String(error)));
  }
}

// ── T1：首次 restrict 失败 + 静默宿主 + 卡住的对账 → 新会话无保护窗口 ──────────
// 攻击路径：applyRestriction 的 catch 语义是「保留上一份限制」，但新 agent 没有上一份。
// 叠加 holdDispose 卡住对账链（尾部全量 sweep 到不了）、期间无 tools/change，
// 窗口从毫秒级被拉长到任意长。断言安全属性：窗口内也不得看见别家工具。
await scenario("T1 first-restrict failure must not leave a new session unprotected", async () => {
  const s = await setupTwoWorkspaces("dsh-mcp-race-t1-");
  let stuck;
  try {
    // 触发 alpha 重挂（改 args），并让旧 fiber 的 dispose 挂起 → 对账链卡在卸载中。
    s.ctx.holdDispose = true;
    await writeManagedRows(projectMcpFile(s.projA), [stdioRow("alpha", ["srv-alpha-v2.js"])], { createIfMissing: true });
    stuck = s.registry.reconcileNow();
    assert.ok(await until(() => s.ctx.disposals.includes("alpha")), "alpha dispose starts and is held");

    // 新会话 B2（同工作区 B）：首次 restrict 抛错（模拟「未知名」竞态）。
    const victim = fakeAgent("session-b2", s.projB);
    victim.failRestrictOnce();
    s.ctx.agentsList.push(victim);
    await s.created({ agent: victim, source: "startup" });

    // 观察点：宿主此刻按「注册表 − deny」解析工具。首次失败必须 fail-closed：
    // 临时 deny 全部已注册 MCP 工具，而不是让新会话裸奔。
    assert.deepEqual(victim.currentDeny(), ["mcp__alpha__read", "mcp__beta__read"],
      "fail-closed fallback denies all registered MCP tools");
    assert.equal(victim.activeRestrictions.size, 1, "fallback restriction recorded");
    const deny = victim.currentDeny() ?? [];
    const visible = s.ctx.schemas.map(({ name }) => name).filter((name) => !deny.includes(name));
    assert.ok(!visible.includes("mcp__alpha__read"),
      "cross-workspace tool visible to unprotected session: " + JSON.stringify(visible));

    // 释放后必须自愈：对账尾部 sweep 补上 deny。
    s.ctx.holdDispose = false;
    for (const release of s.ctx.releaseDispose.splice(0)) release();
    await stuck;
    stuck = undefined;
    assert.ok(await s.registry.waitForState(s.projA, "alpha", (state) => state?.phase === "active", 5000), "alpha remounts");
    assert.deepEqual(victim.currentDeny(), ["mcp__alpha__read"], "recovery: tail sweep applies deny");
  } finally {
    if (stuck !== undefined) {
      s.ctx.holdDispose = false;
      for (const release of s.ctx.releaseDispose.splice(0)) release();
      await stuck.catch(() => {});
    }
    await teardown(s);
  }
});

// ── T2：agent/created 派发时 agent 尚未入注册表（宿主时序违约）─────────────────
// prepareAgent 与 waitForVisibleEager 都因同一性检查跳过；创建不得挂起，
// agent 入册后的下一次对账必须补上 deny（追赶路径证明）。
await scenario("T2 unlisted agent at creation catches up on next reconcile", async () => {
  const s = await setupTwoWorkspaces("dsh-mcp-race-t2-");
  try {
    const late = fakeAgent("session-late", s.projB);
    // 不 push 进 agentsList：模拟注册晚于派发的违约时序。
    let timer;
    const creation = s.created({ agent: late, source: "startup" });
    await Promise.race([
      creation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("creation hung for unlisted agent")), 2000); })
    ]).finally(() => clearTimeout(timer));
    assert.equal(late.currentDeny(), null, "no sweep while unlisted (agent cannot run turns yet)");

    s.ctx.agentsList.push(late);
    await s.registry.reconcileNow();
    assert.deepEqual(late.currentDeny(), ["mcp__alpha__read"], "catch-up: reconcile sweeps the now-live agent");
  } finally {
    await teardown(s);
  }
});

// ── T3：信息层 fail-closed（提示词过滤 + 资源门）──────────────────────────────
// 未解析项目 / 空 scope / 缺失 agent 一律按「deny 全部项目服务器」处理。
await scenario("T3 prompt filter and resource gate fail closed for unknown scopes", async () => {
  const s = await setupTwoWorkspaces("dsh-mcp-race-t3-");
  try {
    const [assemble] = s.ctx.handlers.get("system-prompt/assemble");
    const [preExecute] = s.ctx.handlers.get("tools/pre-execute");
    const sections = [
      { name: "harness:identity", text: "You are an AI agent." },
      { name: "mcp:alpha", text: "A instructions" },
      { name: "mcp:beta", text: "B instructions" },
      { name: "mcp-resource-servers", text: 'Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: ["alpha","beta"].' }
    ];
    const next = async () => ({ sections });
    const ghost = fakeAgent("ghost", s.projB); // 从未创建 → 不在 agentProjects

    // 两个未知 scope 顺序断言（Sonar javascript:S9382）：纯内存过滤，无 I/O 可并发。
    for (const scope of [ghost, undefined]) {
      const prompt = await assemble({ sections }, { scope }, next);
      assert.deepEqual(prompt.sections.map(({ name }) => name), ["harness:identity"],
        "unknown scope hides every project section (scope=" + (scope?.id ?? "undefined") + ")");
    }
    // 已解析会话只保留自己的小节。
    const promptA = await assemble({ sections }, { scope: s.agentA }, next);
    assert.deepEqual(promptA.sections.map(({ name }) => name), ["harness:identity", "mcp:alpha", "mcp-resource-servers"]);
    assert.equal(promptA.sections.at(-1).text.endsWith('["alpha"].'), true, "resource list filtered to own servers");

    const resourceTools = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
    // 逐工具顺序断言（Sonar javascript:S9382）：纯内存门检，失败信息按工具名定位。
    for (const name of resourceTools) {
      const allow = async () => ({ kind: "allow" });
      const decide = (agent, server) => preExecute({ name, agent, arguments: { server } }, allow);
      assert.equal((await decide(ghost, "alpha")).kind, "deny", name + ": unknown agent denied");
      assert.equal((await decide(undefined, "alpha")).kind, "deny", name + ": missing agent denied");
      assert.equal((await decide(s.agentA, "beta")).kind, "deny", name + ": cross-workspace denied");
      assert.equal((await decide(s.agentA, "alpha")).kind, "allow", name + ": own server allowed");
    }
    // 非资源工具不受该门影响。
    assert.equal((await preExecute({ name: "read", agent: ghost, arguments: { server: "alpha" } }, async () => ({ kind: "allow" }))).kind, "allow");
  } finally {
    await teardown(s);
  }
});

// ── T4：retained 生效名交换窗口（A 卸载中、B 同名待挂）─────────────────────────
// 窗口内 B 的会话必须持续 deny 旧名字；B 的挂载必须等 nameRelease；
// 交换完成后 A 的会话立即 deny 新实例。全程不得有 plugin-throw 或越权可见。
await scenario("T4 retained-name swap keeps deny continuous across the release chain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-mcp-race-t4-"));
  const home = join(dir, "home");
  const projA = join(dir, "a");
  const projB = join(dir, "b");
  await mkdir(join(home, ".dsh"), { recursive: true });
  await mkdir(projA);
  await mkdir(projB);
  await writeManagedRows(projectMcpFile(projA), [stdioRow("shared-x")], { createIfMissing: true });
  const savedCwd = process.cwd();
  process.chdir(dir);
  const ctx = fakeCtx();
  ctx.schemas.push({ name: "mcp__shared-x__read" });
  const registry = new ProjectMcpRegistry(ctx, {
    globalNames: async () => [],
    userLayerPaths: { mcpYml: join(home, ".dsh", "mcp.yml"), mcpJson: join(home, ".dsh", "mcp.json"), profilesDir: join(home, ".dsh", "profiles") }
  });
  const agentA = fakeAgent("session-a", projA);
  const agentB = fakeAgent("session-b", projB);
  ctx.agentsList.push(agentA, agentB);
  let swapping;
  try {
    await registry.reconcileNow();
    assert.ok(await registry.waitForState(projA, "shared-x", (state) => state?.phase === "active", 5000), "A mounts shared-x");
    const [created] = ctx.handlers.get("agent/created");
    await created({ agent: agentA, source: "startup" });
    await created({ agent: agentB, source: "startup" });
    assert.deepEqual(agentB.currentDeny(), ["mcp__shared-x__read"], "B denies A's shared-x");
    const mountsBefore = ctx.mounts.length;

    // 同一轮：A 删除 shared-x，B 新增 shared-x → 名字交换，dispose 挂起。
    ctx.holdDispose = true;
    await writeManagedRows(projectMcpFile(projA), [], { createIfMissing: true });
    await writeManagedRows(projectMcpFile(projB), [stdioRow("shared-x")], { createIfMissing: true });
    swapping = registry.reconcileNow();
    assert.ok(await until(() => ctx.disposals.includes("shared-x")), "A's dispose starts and is held");

    // 窗口内：B 仍 deny 旧名字；B 的新实例尚未挂载（等 nameRelease），无重复装载。
    assert.deepEqual(agentB.currentDeny(), ["mcp__shared-x__read"], "window: B still denies the dying instance");
    assert.equal(ctx.mounts.length, mountsBefore, "window: B does not mount before the name is released");

    ctx.holdDispose = false;
    for (const release of ctx.releaseDispose.splice(0)) release();
    await swapping;
    swapping = undefined;
    assert.ok(await registry.waitForState(projB, "shared-x", (state) => state?.phase === "active", 5000), "B mounts after release");
    assert.equal(ctx.mounts.at(-1).serverName, "shared-x", "B reuses the released name");
    assert.deepEqual(agentA.currentDeny(), ["mcp__shared-x__read"], "after swap: A denies B's instance");
    assert.equal(agentB.currentDeny(), null, "after swap: B sees its own instance");
  } finally {
    if (swapping !== undefined) {
      ctx.holdDispose = false;
      for (const release of ctx.releaseDispose.splice(0)) release();
      await swapping.catch(() => {});
    }
    ctx.holdDispose = false;
    for (const release of ctx.releaseDispose.splice(0)) release();
    for (const disposer of ctx.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    process.chdir(savedCwd);
    await rmRetry(dir);
  }
});

// ── T5：sweep 重入风暴（restrict 同步触发 tools/change）───────────────────────
// applyingRestrictions 守卫必须挡住嵌套 sweep；风暴后 deny 与最终目录一致，
// 每个 agent 恰好一份生效限制（无 disposer 泄漏）。
await scenario("T5 reentrant tools/change storm keeps restrictions consistent", async () => {
  const s = await setupTwoWorkspaces("dsh-mcp-race-t5-");
  try {
    const originalRestrict = s.agentA.ctx.tools.restrict;
    let calls = 0;
    s.agentA.ctx.tools.restrict = (opts) => {
      calls += 1;
      const disposer = originalRestrict(opts);
      s.ctx.emit("tools/change"); // 宿主真实行为：应用限制同步派发 tools/change
      return disposer;
    };
    s.ctx.schemas.push({ name: "mcp__alpha__write" });
    for (let i = 0; i < 5; i++) s.ctx.emit("tools/change");
    assert.ok(calls >= 5, "storm actually reached restrict");
    assert.deepEqual(s.agentB.currentDeny(), ["mcp__alpha__read", "mcp__alpha__write"], "B denies the full alpha catalog");
    assert.deepEqual(s.agentA.currentDeny(), ["mcp__beta__read"], "A denies beta");
    assert.equal(s.agentA.activeRestrictions.size, 1, "A holds exactly one live restriction");
    assert.equal(s.agentB.activeRestrictions.size, 1, "B holds exactly one live restriction");
  } finally {
    await teardown(s);
  }
});

// ── T6：fail-closed 兜底的保护通知、链外自动重试、重试用尽与手动恢复 ────────────
// 通知必须含成因简述与恢复路径、不含原始错误文本（可能带别家工具名）；
// 重试走链外定时器：对账链卡在慢 dispose 时也能自愈；用尽后转手动指引。
await scenario("T6 protection notice, off-chain retry, cap and manual recovery", async () => {
  const s = await setupTwoWorkspaces("dsh-mcp-race-t6-", { fallbackRetryDelaysMs: [10, 20, 30] });
  let stuck;
  try {
    const [assemble] = s.ctx.handlers.get("system-prompt/assemble");
    const sections = [
      { name: "mcp:alpha", text: "A instructions" },
      { name: "mcp:beta", text: "B instructions" }
    ];
    const next = async () => ({ sections });
    const noticeOf = async (agent) => {
      const prompt = await assemble({ sections }, { scope: agent }, next);
      return prompt.sections.find(({ name }) => name === "mcp-protection-notice");
    };

    // 卡住对账链，制造「无 tools/change、尾部 sweep 到不了」的环境。
    s.ctx.holdDispose = true;
    await writeManagedRows(projectMcpFile(s.projA), [stdioRow("alpha", ["srv-alpha-v2.js"])], { createIfMissing: true });
    stuck = s.registry.reconcileNow();
    assert.ok(await until(() => s.ctx.disposals.includes("alpha")), "alpha dispose starts and is held");

    // 首次失败 → 兜底 + 通知。
    const victim = fakeAgent("session-v1", s.projB);
    victim.failRestrictOnce();
    s.ctx.agentsList.push(victim);
    await s.created({ agent: victim, source: "startup" });
    assert.deepEqual(victim.currentDeny(), ["mcp__alpha__read", "mcp__beta__read"], "fail-closed fallback active");
    const notice = await noticeOf(victim);
    assert.ok(notice !== undefined, "victim prompt carries the protection notice");
    assert.ok(notice.text.includes("temporarily denied"), "notice states the effect");
    assert.ok(notice.text.includes("background retry"), "notice states automatic recovery");
    assert.ok(!notice.text.includes("simulated host restrict failure"), "notice must not leak the raw error text");
    assert.equal(await noticeOf(s.agentA), undefined, "healthy sessions carry no notice");

    // 链外重试：对账链仍卡着，兜底也应自动恢复精确可见性，通知随之消失。
    assert.ok(await until(() => (victim.currentDeny() ?? []).length === 1, 3000), "off-chain retry recovers while the chain is stuck");
    assert.deepEqual(victim.currentDeny(), ["mcp__alpha__read"], "precise visibility restored");
    assert.equal(await noticeOf(victim), undefined, "notice disappears after recovery");

    // 重试用尽：持续失败 → 通知转为手动指引；随后手动触发（释放对账链）恢复。
    const stubborn = fakeAgent("session-v2", s.projB);
    let fails = 4; // 首次 + 3 次重试都失败，第 5 次（手动触发的 sweep）成功
    const originalRestrict = stubborn.ctx.tools.restrict;
    stubborn.ctx.tools.restrict = (opts) => {
      // 只让精确 deny（单工具名）失败，模拟未知名竞态；兜底的全量精确名不受影响。
      if (opts.deny.length === 1 && fails > 0) {
        fails -= 1;
        throw new Error("persistent host failure");
      }
      return originalRestrict(opts);
    };
    s.ctx.agentsList.push(stubborn);
    await s.created({ agent: stubborn, source: "startup" });
    // 轮询通知文本直到重试用尽（10+20+30ms 退避，毫秒级到达）。
    // 有界串行轮询（Sonar javascript:S9382）：逐轮读取 + 退避。
    const deadline = Date.now() + 3000;
    let text = "";
    while (Date.now() < deadline) {
      const n = await noticeOf(stubborn);
      text = n?.text ?? "";
      if (text.includes("exhausted")) break;
      await delay(15);
    }
    assert.ok(text.includes("exhausted"), "notice switches to manual guidance after retries are exhausted");
    assert.ok(text.includes("edit any MCP configuration file"), "manual recovery path is stated");
    assert.deepEqual(stubborn.currentDeny(), ["mcp__alpha__read", "mcp__beta__read"], "still fail-closed after cap");

    s.ctx.holdDispose = false;
    for (const release of s.ctx.releaseDispose.splice(0)) release();
    await stuck;
    stuck = undefined;
    assert.deepEqual(stubborn.currentDeny(), ["mcp__alpha__read"], "manual trigger (reconcile tail sweep) recovers");
    assert.equal(await noticeOf(stubborn), undefined, "notice cleared after manual recovery");

    // 全局诊断留有 restrict-fallback 事件（含成因与 agent）；落盘走锁，异步轮询。
    // 有界串行轮询（Sonar javascript:S9382）：逐轮读盘 + 退避。
    const diagPath = join(s.home, ".dsh", DIAG_FILE);
    const diagDeadline = Date.now() + 3000;
    let recorded = false;
    while (Date.now() < diagDeadline) {
      try {
        const doc = JSON.parse(await readFile(diagPath, "utf8"));
        recorded = (doc.events ?? []).some((e) => e.type === "restrict-fallback" && e.agent === "session-v1");
        if (recorded) break;
      } catch {
        // 尚未落盘
      }
      await delay(15);
    }
    assert.ok(recorded, "global diag records the fallback event");
  } finally {
    if (stuck !== undefined) {
      s.ctx.holdDispose = false;
      for (const release of s.ctx.releaseDispose.splice(0)) release();
      await stuck.catch(() => {});
    }
    await teardown(s);
  }
});

await delay(200);
if (unhandled.length > 0) {
  failures.push({ name: "unhandledRejection", error: unhandled[0] });
  console.log("FAIL  unhandled rejections: " + unhandled.map(String).join(" | "));
}
if (failures.length > 0) {
  console.log(`\nISOLATION RACE RESULTS: ${failures.length} failed`);
  for (const { name, error } of failures) {
    console.log("\n--- " + name + " ---");
    console.log(error instanceof Error ? error.stack : String(error));
  }
  process.exitCode = 1;
} else {
  console.log("\nALL ISOLATION RACE TESTS PASSED (T1 restrict-failure window, T2 late registration, T3 fail-closed gates, T4 name swap, T5 reentrancy, T6 protection notice and retry)");
}
