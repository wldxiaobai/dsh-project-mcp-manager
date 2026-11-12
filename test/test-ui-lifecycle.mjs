import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createRequire } from "node:module";
import { Context } from "@deepseek-ai/cordis";
// The host entry imports ./wire.js, so exercise its compiled output after the root build.
import * as ui from "../packages/ui/lib/index.js";
import { projectKeyOf } from "../lib/index.js";

// FiberState is a const enum in Cordis' public declarations, not a runtime export.
const PENDING = 0;
const ACTIVE = 2;
const DISPOSED = 4;
const expectedRoutes = [
  ["/api/project-mcp/state", ["GET"]],
  ["/api/project-mcp/open", ["POST"]],
  ["/api/project-mcp/add", ["POST"]],
  ["/api/project-mcp/server", ["POST"]],
  ["/api/project-mcp/tool", ["POST"]],
  ["/api/project-mcp/tools", ["POST"]],
  ["/api/project-mcp/events", ["GET"]]
];

// Keep deterministic UTF-16 code-unit order, independent of the host locale.
function byCodeUnit(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}

function mockProjectMcp(options = {}) {
  const listeners = new Set();
  const counts = { subscribed: 0, unsubscribed: 0 };
  const modeCalls = [];
  let writeTargets = options.writeTargets ?? [];
  let failMode = options.failMode;
  const service = {
    snapshot: async () => options.snapshot ?? [],
    managedPathFor: (source) => options.managedPathFor?.(source) ?? options.managedPath,
    writeTargets: () => writeTargets,
    setLoadingMode(source, projectRoot, rawName, mode) {
      modeCalls.push({ source, projectRoot, rawName, mode });
      if (failMode !== undefined) throw new Error(failMode);
      return Promise.resolve(options.modePath ?? String.raw`D:\work\.dsh\mcp.yml`);
    },
    contextCost: () => options.contextCost ?? {
      sessionId: "mock-session",
      tools: 2,
      estTokens: 1200,
      level: "ok",
      servers: [{ name: "mock", tools: 2, estTokens: 1200 }],
      warnTokens: 5000,
      alertTokens: 10000
    },
    resultCost: () => options.resultCost ?? {
      sessionId: "mock-session",
      calls: 1,
      estTokens: 800,
      contextWindow: 200000,
      servers: [{ name: "mock", calls: 1, estTokens: 800 }]
    },
    toolStates: () => [{ name: "mock-tool", enabled: true }],
    subscribeUpdated(callback) {
      listeners.add(callback);
      counts.subscribed += 1;
      return () => {
        assert.equal(listeners.delete(callback), true, "subscription must be released exactly once");
        counts.unsubscribed += 1;
      };
    }
  };
  return {
    service,
    listeners,
    counts,
    modeCalls,
    setWriteTargets(next) {
      writeTargets = next;
    },
    setFailMode(next) {
      failMode = next;
    },
    updated() {
      for (const listener of listeners) listener();
    }
  };
}

function mockConnection() {
  const routes = new Map();
  const counts = { registered: 0, unregistered: 0 };
  const service = {
    fetch: {
      register(route) {
        assert.equal(routes.has(route.path), false, "duplicate route: " + route.path);
        const entry = { route };
        routes.set(route.path, entry);
        counts.registered += 1;
        return async () => {
          // Real registrations return async disposers; teardown must await them.
          await Promise.resolve();
          assert.equal(routes.get(route.path), entry, "route must be released exactly once");
          routes.delete(route.path);
          counts.unregistered += 1;
        };
      }
    }
  };
  return { service, routes, counts };
}

function provide(ctx, name, service) {
  return ctx.plugin({
    name: "mock-" + name,
    apply(providerCtx) {
      providerCtx.provide(name, service);
    }
  });
}

function connectionScope(ctx, uiFiber) {
  const scopes = [...ctx.registry.values()].flatMap((runtime) => [...runtime.fibers])
    .filter((fiber) => fiber.parent.fiber === uiFiber.ctx.fiber);
  assert.equal(scopes.length, 1, "UI owns one connection injection scope");
  assert.deepEqual(Object.keys(scopes[0].inject), ["connection"]);
  return scopes[0];
}

function assertRoutes(connection) {
  assert.deepEqual([...connection.routes.keys()].sort(byCodeUnit), expectedRoutes.map(([path]) => path).sort(byCodeUnit));
  for (const [path, methods] of expectedRoutes) {
    const { route } = connection.routes.get(path);
    assert.deepEqual(route.methods, methods);
    assert.equal(route.requestBody, "buffered");
  }
}

async function readState(connection) {
  const { route } = connection.routes.get("/api/project-mcp/state");
  const response = await route.fetch(new Request("http://localhost" + route.path));
  assert.equal(response.status, 200);
  return response.json();
}

async function withPingTimers(callback) {
  const nativeSetInterval = globalThis.setInterval;
  const nativeClearInterval = globalThis.clearInterval;
  const active = new Set();
  const counts = { created: 0, cleared: 0 };
  globalThis.setInterval = (...args) => {
    const timer = nativeSetInterval(...args);
    if (args[1] === 20000) {
      active.add(timer);
      counts.created += 1;
    }
    return timer;
  };
  globalThis.clearInterval = (timer) => {
    if (active.delete(timer)) counts.cleared += 1;
    return nativeClearInterval(timer);
  };
  try {
    await callback({ active, counts });
  } finally {
    globalThis.setInterval = nativeSetInterval;
    globalThis.clearInterval = nativeClearInterval;
    for (const timer of active) nativeClearInterval(timer);
  }
}

async function openEvents(connection, controller = new AbortController()) {
  const { route } = connection.routes.get("/api/project-mcp/events");
  const request = new Request("http://localhost" + route.path, { signal: controller.signal });
  const abortListeners = getEventListeners(request.signal, "abort").length;
  const response = await route.fetch(request);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("cache-control"), "no-cache");
  return { controller, request, abortListeners, reader: response.body.getReader() };
}

async function assertEvent(stream, expected) {
  const chunk = await stream.reader.read();
  assert.equal(chunk.done, false);
  assert.equal(new TextDecoder().decode(chunk.value), expected);
}

async function assertClosed(stream) {
  let timeout;
  try {
    const chunk = await Promise.race([
      stream.reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("SSE did not close during teardown")), 1000);
      })
    ]);
    assert.equal(chunk.done, true);
    assert.equal(getEventListeners(stream.request.signal, "abort").length, stream.abortListeners,
      "SSE request abort handler must be removed");
  } finally {
    clearTimeout(timeout);
  }
}

{
  assert.deepEqual(ui.inject, ["projectMcp"]);
  // The host settings service only projects volatile Config fields into forms
  // (`settings.volatileForm`); without this the three toggles are unreachable.
  const requireFromUi = createRequire(new URL("../packages/ui/package.json", import.meta.url));
  const Schema = requireFromUi("@deepseek-ai/schemastery");
  const config = new Schema(ui.Config.toJSON());
  assert.equal(config.type, "object");
  assert.deepEqual(Object.keys(config.dict).sort(byCodeUnit), ["settingsSection", "settingsTab", "sidebar"]);
  for (const key of ["sidebar", "settingsSection", "settingsTab"]) {
    assert.equal(config.dict[key].meta.volatile, true, `${key} must be volatile`);
    assert.equal(config.dict[key].meta.default, true, `${key} defaults to visible`);
  }
  const ctx = new Context();
  const mcp = mockProjectMcp();
  const connection = mockConnection();
  try {
    const uiFiber = ctx.plugin(ui);
    await uiFiber;
    assert.equal(uiFiber.state, PENDING, "projectMcp remains a hard dependency");
    assert.equal(ctx.registry.size, 1, "no connection scope starts before projectMcp");

    const mcpProvider = provide(ctx, "projectMcp", mcp.service);
    await mcpProvider;
    await uiFiber;
    const scopedFiber = connectionScope(ctx, uiFiber);
    await scopedFiber.await();
    assert.equal(uiFiber.state, ACTIVE, "headless UI row must not remain pending");
    assert.equal(scopedFiber.state, PENDING);
    assert.equal(connection.routes.size, 0);
    assert.equal(mcp.listeners.size, 0, "headless mode does not subscribe to updates");
    pass("projectMcp is required but headless UI row is active without routes");

    const firstConnectionProvider = provide(ctx, "connection", connection.service);
    await firstConnectionProvider;
    await scopedFiber.await();
    assert.equal(uiFiber.state, ACTIVE);
    assert.equal(scopedFiber.state, ACTIVE);
    assertRoutes(connection);
    assert.equal(connection.counts.registered, 7);
    assert.equal(mcp.listeners.size, 1);
    assert.equal((await readState(connection)).revision, 0);
    mcp.updated();
    const state = await readState(connection);
    assert.equal(state.revision, 1);
    assert.deepEqual(state.servers, []);
    assert.deepEqual(state.openTargets, []);
    assert.deepEqual(state.writeTargets, []);
    assert.equal(state.activeProject, null, "no focused workspace is reported as null");
    assert.equal(state.activeProjectKey, null, "no focused workspace has no identity key");
    assert.equal(typeof state.homeDir, "string");
    assert.equal(state.contextCost.estTokens, 1200, "the state carries the definition cost");
    assert.equal(state.resultCost.calls, 1, "the state carries the retained-result cost");
    assert.equal(state.resultCost.servers[0].name, "mock");
    mcp.setWriteTargets([{ id: "project", source: "dsh-project", projectRoot: String.raw`D:\work`, path: String.raw`D:\work\.dsh\mcp.yml` }]);
    const focused = await readState(connection);
    assert.deepEqual(focused.writeTargets, [{ id: "project", source: "dsh-project", projectRoot: String.raw`D:\work`, path: String.raw`D:\work\.dsh\mcp.yml` }]);
    assert.equal(focused.activeProject, String.raw`D:\work`, "the active workspace follows the project write target");
    assert.equal(focused.activeProjectKey, projectKeyOf(String.raw`D:\work`),
      "the workspace identity is the host's projectKeyOf(), not a browser-side guess");
    mcp.setWriteTargets([]);
    const { route: toolRoute } = connection.routes.get("/api/project-mcp/tools");
    const invalid = await toolRoute.fetch(new Request("http://localhost" + toolRoute.path, {
      method: "POST", body: "{}", headers: { "content-type": "application/json" }
    }));
    assert.equal(invalid.status, 400, "existing route guards remain active");
    assert.equal((await invalid.json()).ok, false);
    pass("late connection registers exactly seven routes and state updates still work");

    await firstConnectionProvider.dispose();
    assert.equal(scopedFiber.state, PENDING);
    assert.equal(uiFiber.state, ACTIVE);
    assert.equal(connection.routes.size, 0);
    assert.equal(connection.counts.unregistered, 7);
    assert.equal(mcp.listeners.size, 0);
    assert.equal(mcp.counts.unsubscribed, 1);
    assert.equal(mcpProvider.state, ACTIVE);
    pass("connection provider disposal cleans routes and update subscription");

    const secondConnectionProvider = provide(ctx, "connection", connection.service);
    await secondConnectionProvider;
    await scopedFiber.await();
    assert.equal(connectionScope(ctx, uiFiber), scopedFiber, "reuse the existing scoped fiber");
    assertRoutes(connection);
    assert.equal(connection.counts.registered, 14);
    assert.equal(mcp.listeners.size, 1);
    assert.equal(mcp.counts.subscribed, 2);
    assert.equal((await readState(connection)).revision, 0, "fresh scope resets its revision");
    mcp.updated();
    assert.equal((await readState(connection)).revision, 1, "only one listener remains");
    pass("reappearing connection restores routes without duplicate registrations or listeners");

    await uiFiber.dispose();
    assert.equal(uiFiber.state, DISPOSED);
    assert.equal(scopedFiber.state, DISPOSED);
    assert.equal(connection.routes.size, 0);
    assert.equal(connection.counts.unregistered, 14);
    assert.equal(mcp.listeners.size, 0);
    assert.equal(mcp.counts.unsubscribed, 2);
    assert.equal(mcpProvider.state, ACTIVE, "UI does not own the core provider");
    assert.equal(secondConnectionProvider.state, ACTIVE);
    assert.deepEqual(await ctx.get("projectMcp").snapshot(), []);
    pass("UI disposal cleans its scope while preserving projectMcp and connection providers");
  } finally {
    await ctx.fiber.dispose();
  }
}

{
  const ctx = new Context();
  const mcp = mockProjectMcp();
  const connection = mockConnection();
  try {
    const mcpProvider = provide(ctx, "projectMcp", mcp.service);
    await mcpProvider;
    const uiFiber = ctx.plugin(ui);
    await uiFiber;
    const scopedFiber = connectionScope(ctx, uiFiber);
    assert.equal(scopedFiber.state, PENDING);
    await uiFiber.dispose();
    assert.equal(scopedFiber.state, DISPOSED);
    const connectionProvider = provide(ctx, "connection", connection.service);
    await connectionProvider;
    assert.equal(connection.routes.size, 0);
    assert.equal(connection.counts.registered, 0);
    assert.equal(mcp.listeners.size, 0);
    assert.equal(mcpProvider.state, ACTIVE);
    pass("disposing headless UI prevents a later connection from resurrecting routes");
  } finally {
    await ctx.fiber.dispose();
  }
}

{
  // 每行的工作区身份也由宿主算：项目行给 projectKeyOf()，全局层给空串。
  const ctx = new Context();
  const snapshot = [
    {
      project: String.raw`D:\work`,
      path: String.raw`D:\work\.dsh\mcp.yml`,
      ok: true,
      error: null,
      source: "dsh-project",
      servers: [
        { serverName: "alpha", transport: "stdio", command: "npx", enabled: true, fiberPhase: "active", skipReason: null, toolCount: 2 }
      ]
    },
    {
      project: String.raw`C:\Users\me\.dsh\profiles\web`,
      path: String.raw`C:\Users\me\.dsh\profiles\web\mcp.yml`,
      kind: "global",
      ok: true,
      error: null,
      source: "dsh-profile-user-yml",
      servers: [
        { serverName: "beta", transport: "streamable-http", url: "https://mcp.example/mcp", enabled: true, fiberPhase: "active", skipReason: null, toolCount: 1 }
      ]
    }
  ];
  const mcp = mockProjectMcp({ snapshot });
  const connection = mockConnection();
  try {
    const mcpProvider = provide(ctx, "projectMcp", mcp.service);
    const connectionProvider = provide(ctx, "connection", connection.service);
    await mcpProvider;
    await connectionProvider;
    const uiFiber = ctx.plugin(ui);
    await uiFiber;
    await connectionScope(ctx, uiFiber).await();

    const state = await readState(connection);
    assert.equal(state.servers.length, 2);
    assert.equal(state.servers[0].layer, "project");
    assert.equal(state.servers[0].projectRoot, String.raw`D:\work`);
    assert.equal(state.servers[0].projectKey, projectKeyOf(String.raw`D:\work`), "project rows carry the host project key");
    assert.equal(state.servers[1].layer, "user");
    assert.equal(state.servers[1].projectKey, "", "global rows have no workspace identity");
    pass("state rows carry host-computed workspace keys and global rows stay empty");
  } finally {
    await ctx.fiber.dispose();
  }
}

for (const teardown of ["connection", "UI"]) {
  await withPingTimers(async (timers) => {
    const ctx = new Context();
    const mcp = mockProjectMcp();
    const connection = mockConnection();
    try {
      const mcpProvider = provide(ctx, "projectMcp", mcp.service);
      const connectionProvider = provide(ctx, "connection", connection.service);
      await mcpProvider;
      await connectionProvider;
      const uiFiber = ctx.plugin(ui);
      await uiFiber;
      const scopedFiber = connectionScope(ctx, uiFiber);
      await scopedFiber.await();
      const effectCount = scopedFiber.getEffects().length;
      const streams = [await openEvents(connection), await openEvents(connection)];
      for (const stream of streams) {
        await assertEvent(stream, "event: ready\ndata: 0\n\n");
        assert.equal(getEventListeners(stream.request.signal, "abort").length, stream.abortListeners + 1);
      }
      assert.equal(scopedFiber.getEffects().length, effectCount, "SSE requests do not accumulate effects");
      assert.equal(mcp.listeners.size, 3, "revision plus two live SSE subscriptions");
      assert.equal(timers.active.size, 2);
      mcp.updated();
      for (const stream of streams) await assertEvent(stream, "event: updated\ndata: 1\n\n");

      if (teardown === "connection") await connectionProvider.dispose();
      else await uiFiber.dispose();
      for (const stream of streams) {
        await assertClosed(stream);
        stream.controller.abort();
        await stream.reader.cancel();
      }
      assert.equal(connection.routes.size, 0);
      assert.equal(mcp.listeners.size, 0);
      assert.equal(mcp.counts.unsubscribed, 3, "each revision/SSE subscription is released once");
      assert.equal(timers.active.size, 0);
      assert.deepEqual(timers.counts, { created: 2, cleared: 2 });
      assert.equal(mcpProvider.state, ACTIVE);
      assert.equal(uiFiber.state, teardown === "connection" ? ACTIVE : DISPOSED);
      pass(teardown + " disposal closes active SSE bodies, subscriptions, timers and abort listeners");
    } finally {
      await ctx.fiber.dispose();
    }
  });
}

await withPingTimers(async (timers) => {
  const ctx = new Context();
  const mcp = mockProjectMcp();
  const connection = mockConnection();
  try {
    const mcpProvider = provide(ctx, "projectMcp", mcp.service);
    const connectionProvider = provide(ctx, "connection", connection.service);
    await mcpProvider;
    await connectionProvider;
    const uiFiber = ctx.plugin(ui);
    await uiFiber;
    const scopedFiber = connectionScope(ctx, uiFiber);
    await scopedFiber.await();
    const effectCount = scopedFiber.getEffects().length;

    const aborted = await openEvents(connection);
    await assertEvent(aborted, "event: ready\ndata: 0\n\n");
    aborted.controller.abort();
    await assertClosed(aborted);
    await aborted.reader.cancel();
    assert.equal(mcp.listeners.size, 1);
    assert.equal(timers.active.size, 0);
    assert.equal(mcp.counts.unsubscribed, 1);
    pass("SSE request abort closes the body and releases resources once");

    const canceled = await openEvents(connection);
    await assertEvent(canceled, "event: ready\ndata: 0\n\n");
    await canceled.reader.cancel();
    await assertClosed(canceled);
    canceled.controller.abort();
    assert.equal(mcp.listeners.size, 1);
    assert.equal(timers.active.size, 0);
    assert.equal(mcp.counts.unsubscribed, 2);
    pass("SSE body cancellation removes its subscription, timer and abort handler");

    const controller = new AbortController();
    controller.abort();
    const alreadyAborted = await openEvents(connection, controller);
    await assertClosed(alreadyAborted);
    assert.equal(mcp.counts.subscribed, 3, "already-aborted request adds no subscription");
    assert.deepEqual(timers.counts, { created: 2, cleared: 2 });
    assert.equal(scopedFiber.getEffects().length, effectCount, "closed requests leave no effect disposers");
    await uiFiber.dispose();
    assert.equal(mcp.counts.unsubscribed, 3, "scope disposal only removes its remaining revision listener");
    assert.equal(mcp.listeners.size, 0);
    pass("already-aborted SSE request stays closed without subscribing or allocating a timer");
  } finally {
    await ctx.fiber.dispose();
  }
});

{
  // Contract regression for the UI server route's new `action: "mode"` branch.
  // The core is a spy here: the route must validate and gate before it mutates.
  const ctx = new Context();
  const projectRoot = String.raw`D:\work`;
  const managedPath = String.raw`D:\work\.dsh\mcp.yml`;
  const filePath = String.raw`D:\work\.dsh\mcp.json`;
  const mcp = mockProjectMcp({ managedPath, modePath: managedPath });
  const connection = mockConnection();
  try {
    const mcpProvider = provide(ctx, "projectMcp", mcp.service);
    const connectionProvider = provide(ctx, "connection", connection.service);
    await mcpProvider;
    await connectionProvider;
    const uiFiber = ctx.plugin(ui);
    await uiFiber;
    await connectionScope(ctx, uiFiber).await();
    const { route } = connection.routes.get("/api/project-mcp/server");
    const post = (payload) => route.fetch(new Request("http://localhost" + route.path, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" }
    }));
    const request = (overrides = {}) => ({
      source: "dsh-project",
      projectRoot,
      serverName: "alpha",
      action: "mode",
      ...overrides
    });

    // Each case resets and inspects the same spy; parallel requests would mix
    // modeCalls and invalidate the exact-call assertion.
    for (const mode of ["eager", "lazy"]) {
      mcp.modeCalls.length = 0;
      const response = await post(request({ mode }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, path: managedPath });
      assert.deepEqual(mcp.modeCalls, [{ source: "dsh-project", projectRoot, rawName: "alpha", mode }]);
    }
    pass("server route passes legal eager/lazy modes through to setLoadingMode");

    mcp.modeCalls.length = 0;
    const invalid = await post(request({ mode: "turbo" }));
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { ok: false, message: "加载模式只支持 eager 或 lazy" });
    assert.equal(mcp.modeCalls.length, 0, "invalid mode is rejected before the core call");
    pass("server route rejects an unknown mode without touching the core");

    mcp.modeCalls.length = 0;
    const confirmation = await post(request({ source: "dsh-project-json", filePath, mode: "lazy" }));
    assert.equal(confirmation.status, 200);
    assert.deepEqual(await confirmation.json(), {
      ok: false,
      code: "confirm-yml",
      managedPath,
      filePath
    });
    assert.equal(mcp.modeCalls.length, 0, "JSON takeover without acknowledge never calls the core");
    pass("server route asks for JSON takeover acknowledgement before calling setLoadingMode");

    mcp.modeCalls.length = 0;
    const acknowledged = await post(request({ source: "dsh-project-json", filePath, mode: "lazy", acknowledge: true }));
    assert.equal(acknowledged.status, 200);
    assert.deepEqual(await acknowledged.json(), { ok: true, path: managedPath });
    assert.deepEqual(mcp.modeCalls, [{ source: "dsh-project-json", projectRoot, rawName: "alpha", mode: "lazy" }]);
    pass("acknowledged JSON takeover calls setLoadingMode with the original source and mode");

    mcp.modeCalls.length = 0;
    const invalidAcknowledged = await post(request({ source: "dsh-project-json", filePath, mode: "sideways", acknowledge: true }));
    assert.equal(invalidAcknowledged.status, 400);
    assert.deepEqual(await invalidAcknowledged.json(), { ok: false, message: "加载模式只支持 eager 或 lazy" });
    assert.equal(mcp.modeCalls.length, 0, "validation still runs after acknowledge and before the core call");

    mcp.modeCalls.length = 0;
    mcp.setFailMode("mock write failed");
    const failed = await post(request({ mode: "eager" }));
    assert.equal(failed.status, 400);
    assert.deepEqual(await failed.json(), { ok: false, message: "mock write failed" });
    assert.deepEqual(mcp.modeCalls, [{ source: "dsh-project", projectRoot, rawName: "alpha", mode: "eager" }],
      "the failed attempt is the only core call");
    assert.equal(connection.routes.size, 7, "a rejected mode write leaves the route table intact");
    assert.equal(mcp.listeners.size, 1, "a rejected mode write leaves the update subscription intact");
    mcp.setFailMode(undefined);
    pass("core errors surface as a 400 response without success side effects");
  } finally {
    await ctx.fiber.dispose();
  }
}

console.log(passed + " passed");
