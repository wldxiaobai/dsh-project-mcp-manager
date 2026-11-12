import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectMcpRegistry, projectMcpFile } from "../lib/registry.js";
import { writeManagedRows } from "../lib/mcp-file.js";
import { createReporter, fakeAgent, fakeCtx, pathExists, readTraceLines, rmRetry, waitForTrace } from "./helpers/registry-harness.mjs";

const { pass, report } = createReporter("PROJECT REGISTRY LAZY");
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

report();
