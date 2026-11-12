import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectMcpRegistry, parseDiagDocument, projectMcpFile } from "../lib/registry.js";
import { writeManagedRows } from "../lib/mcp-file.js";
import { createReporter, fakeAgent, fakeCtx, readDiag, readDiagSummary, rmRetry, stdioRow, waitUntil } from "./helpers/registry-harness.mjs";

const { pass, report } = createReporter("PROJECT REGISTRY CORE");
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
    let kicked = false;
    await waitUntil(async () => {
      if (registryW.debugReconcileCount <= countW) return false;
      try {
        const events = parseDiagDocument(JSON.parse(await readFile(join(homeW, ".mcp-diag.json"), "utf8"))).events;
        if (events.some((row) => row.kind === "foreign-format" && String(row.path).includes("dsh-mcp.json"))) {
          kicked = true;
          return true;
        }
      } catch {
        // 诊断尚未落盘
      }
      return false;
    }, { timeoutMs: 5000, intervalMs: 150 });
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

report();
