import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectMcpRegistry, projectMcpFile } from "../lib/registry.js";
import { bindProjectMcpService } from "../lib/service.js";
import { extractManagedRows, writeManagedRows } from "../lib/mcp-file.js";
import { createReporter, fakeAgent, fakeCtx, rmRetry, stdioRow } from "./helpers/registry-harness.mjs";

const { pass, report } = createReporter("PROJECT REGISTRY CONTEXT");
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

report();
