import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectMcpRegistry, projectMcpFile } from "../lib/registry.js";
import { bindProjectMcpService, PROJECT_MCP_SERVICE } from "../lib/service.js";
import { apply, PROJECT_MCP_UPDATED_EVENT } from "../lib/index.js";
import { extractManagedRows, writeManagedRows } from "../lib/mcp-file.js";
import { byCodeUnit } from "../lib/model.js";
import { createReporter, fakeAgent, fakeCtx, pathExists, rmRetry, stdioRow } from "./helpers/registry-harness.mjs";

const { pass, report } = createReporter("PROJECT REGISTRY SERVICE");
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

report();
