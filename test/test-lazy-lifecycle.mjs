import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { LazyServer } from "../lib/lazy/connection.js";
import { mcpServerInputSchema, toOfficialConfig } from "../lib/model.js";
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json");
const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);
const root = await mkdtemp(join(tmpdir(), "dsh-lazy-life-"));
const script = join(root, "server.mjs");
await writeFile(script, String.raw`
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [trace, scenario] = process.argv.slice(2);
const log = (event) => appendFileSync(trace, JSON.stringify({ event, pid: process.pid }) + "\n");
log("start");
process.on("exit", () => log("exit"));
const answer = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
for await (const line of createInterface({ input: process.stdin })) {
  const { method, id, params } = JSON.parse(line);
  if (id === undefined) continue;
  log(method);
  if (method === "server/discover") {
    if (scenario !== "probe-hang") console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "legacy fixture" } }));
  } else if (method === "initialize") {
    log("version:" + params.clientInfo.version);
    const send = () => answer(id, { protocolVersion: params.protocolVersion, serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } });
    if (scenario === "connect-delay") setTimeout(send, 150);
    else if (scenario !== "connect-hang") send();
  } else if (method === "tools/list") {
    const send = () => answer(id, { tools: [{ name: "echo", inputSchema: { type: "object" } }] });
    if (scenario === "list-delay") setTimeout(send, 150);
    else if (scenario !== "list-hang") send();
  } else if (method === "tools/call") {
    if (scenario !== "call-hang") answer(id, { content: [{ type: "text", text: "ok" }] });
  }
}
`);

const instances = [];
let serial = 0;
const make = (scenario = "normal", timeout = 1000) => {
  const trace = join(root, `trace-${++serial}.jsonl`);
  const config = toOfficialConfig(mcpServerInputSchema.parse({
    serverName: "fixture", transport: "stdio", command: process.execPath,
    args: [script, trace, scenario], toolCallTimeoutMs: timeout
  }));
  const server = new LazyServer(config);
  instances.push(server);
  return { server, trace };
};
const signal = () => new AbortController().signal;
const lines = async (path) => {
  try {
    const rows = [];
    for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        rows.push(JSON.parse(line));
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
    return rows;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};
const until = async (check, label) => {
  const deadline = Date.now() + 5000;
  // Poll sequentially: each observation follows the previous check and delay.
  while (!await check()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const seen = (trace, event) => until(async () => (await lines(trace)).some((row) => row.event === event), `missing ${event}`);
const starts = async (trace) => (await lines(trace)).filter((row) => row.event === "start");
const pidDead = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
};
const reaped = (trace) => until(async () => (await starts(trace)).every(({ pid }) => pidDead(pid)), "all fixture/probe children must exit");
/** Reap, then keep the trace quiet long enough that a late spawn would be observed. */
const reapedStable = async (trace) => {
  await reaped(trace);
  const before = (await starts(trace)).length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await starts(trace)).length, before, "no late spawn after reaping");
  await reaped(trace);
};
const catalog = (server, sig = signal()) => server.withClient(sig, (connection) => server.listTools(connection));

try {
  // Pre-aborted requests never connect or spawn.
  {
    const { server, trace } = make();
    await assert.rejects(catalog(server, AbortSignal.abort()), { name: "AbortError" });
    assert.deepEqual(await lines(trace), []);
    await server.dispose();
  }
  // One connection/catalog shared by simultaneous callers. Caller timeout is not
  // the discovery timeout: a small tool deadline must not abort initialization.
  {
    const { server, trace } = make("connect-delay", 5);
    const [a, b] = await Promise.all([catalog(server), catalog(server)]);
    assert.equal(a[0].name, "echo");
    assert.strictEqual(a, b);
    const events = await lines(trace);
    assert.equal(events.filter(({ event }) => event === "initialize").length, 1);
    assert.equal(events.filter(({ event }) => event === "tools/list").length, 1);
    assert.ok(events.some(({ event }) => event === `version:${version}`));
    await server.dispose();
    await reaped(trace);
  }
  // Cancel one shared waiter promptly without killing the other caller.
  for (const [scenario, event] of [["connect-delay", "initialize"], ["list-delay", "tools/list"]]) {
    const { server, trace } = make(scenario);
    const abort = new AbortController();
    const cancelled = catalog(server, abort.signal);
    const rejected = assert.rejects(cancelled, { name: "AbortError" });
    const survivor = catalog(server);
    await seen(trace, event);
    abort.abort();
    await rejected;
    assert.equal((await survivor)[0].name, "echo");
    assert.equal((await lines(trace)).filter(({ event }) => event === "initialize").length, 1);
    await server.dispose();
    await reaped(trace);
  }
  // The final cancelled caller cancels pending probe, handshake, list or call.
  for (const [scenario, event] of [["probe-hang", "server/discover"], ["connect-hang", "initialize"], ["list-hang", "tools/list"], ["call-hang", "tools/call"]]) {
    const { server, trace } = make(scenario);
    const abort = new AbortController();
    const work = scenario === "call-hang"
      ? server.withClient(abort.signal, async (connection) => server.callTool(connection, (await server.listTools(connection))[0], {}, abort.signal))
      : catalog(server, abort.signal);
    const rejected = assert.rejects(work, { name: "AbortError" });
    await seen(trace, event);
    abort.abort();
    await rejected;
    await server.dispose();
    await reaped(trace);
    if (scenario === "probe-hang") assert.ok(!(await lines(trace)).some(({ event }) => event === "initialize"));
  }
  // Dispose during SDK's disposable sibling probe, and during an established
  // connection. Repeated dispose waits for the same shutdown, never reconnects.
  for (const scenario of ["probe-hang", "normal"]) {
    const { server, trace } = make(scenario);
    const work = catalog(server);
    const outcome = work.catch(() => undefined);
    await seen(trace, scenario === "probe-hang" ? "server/discover" : "tools/list");
    const first = server.dispose();
    assert.strictEqual(server.dispose(), first);
    await first;
    await outcome;
    await reaped(trace);
    const before = await lines(trace);
    await assert.rejects(catalog(server), /configuration changed/);
    assert.deepEqual(await lines(trace), before);
  }
  // An activated session retains its connection beyond the former idle window.
  {
    const { server, trace } = make();
    await catalog(server);
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      mock.timers.tick(30 * 60_000);
    } finally { mock.timers.reset(); }
    assert.equal((await catalog(server))[0].name, "echo");
    assert.equal((await lines(trace)).filter(({ event }) => event === "initialize").length, 1);
    await server.dispose();
    await reapedStable(trace);
  }
  // Pause the real StdioClientTransport.start for the session transport before it
  // spawns. Dispose first, then release start: any late session spawn must be
  // reaped before/at disposal, and no new start may appear afterwards.
  {
    const { server, trace } = make();
    const originalStart = StdioClientTransport.prototype.start;
    let releaseStart;
    let pausedResolve;
    let sessionPaused = false;
    const release = new Promise((resolve) => { releaseStart = resolve; });
    const paused = new Promise((resolve) => { pausedResolve = resolve; });
    const startMock = mock.method(StdioClientTransport.prototype, "start", async function (...args) {
      // The SDK's disposable probe sibling is created with stderr:"ignore"; gate
      // only the real session transport.
      if (!sessionPaused && this?._serverParams?.stderr !== "ignore") {
        sessionPaused = true;
        pausedResolve();
        await release;
      }
      return originalStart.apply(this, args);
    });
    try {
      const work = catalog(server);
      const outcome = work.catch(() => undefined);
      await paused;
      const disposal = server.dispose();
      releaseStart();
      await disposal;
      await outcome;
      const afterDispose = (await starts(trace)).length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal((await starts(trace)).length, afterDispose, "no session spawn after dispose resolved");
      await reapedStable(trace);
    } finally {
      startMock.mock.restore();
    }
  }
  // A failed spawn must not poison subsequent attempts or leave rejections unhandled.
  {
    const config = toOfficialConfig(mcpServerInputSchema.parse({ serverName: "missing", transport: "stdio", command: join(root, "missing-executable") }));
    const server = new LazyServer(config);
    instances.push(server);
    await assert.rejects(catalog(server), /Unable to connect/);
    await assert.rejects(catalog(server), /Unable to connect/);
    await server.dispose();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, [], "no unhandled rejections");
  console.log("ALL LAZY LIFECYCLE TESTS PASSED (abort, concurrency, keep-alive, failure, disposal, process reaping)");
} finally {
  process.off("unhandledRejection", onUnhandled);
  mock.timers.reset();
  await Promise.all(instances.map((server) => server.dispose()));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
