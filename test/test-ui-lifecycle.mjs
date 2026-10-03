import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { Context } from "@deepseek-ai/cordis";
// The host entry imports ./wire.js, so exercise its compiled output after the root build.
import * as ui from "../packages/ui/lib/index.js";

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

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}

function mockProjectMcp() {
  const listeners = new Set();
  const counts = { subscribed: 0, unsubscribed: 0 };
  const service = {
    snapshot: async () => [],
    managedPathFor: () => undefined,
    writeTargets: () => [],
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
  assert.deepEqual([...connection.routes.keys()].sort(), expectedRoutes.map(([path]) => path).sort());
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
    assert.equal(typeof state.homeDir, "string");
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

console.log(passed + " passed");
