import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectMcpRegistry, projectMcpFile, untrustedDiagMessage } from "../lib/registry.js";
import { projectTrustFile } from "../lib/dsh-paths.js";
import { writeManagedRows } from "../lib/mcp-file.js";
import { byCodeUnit, projectKeyOf } from "../lib/model.js";
import { runCli } from "../lib/cli.js";
import {
  emptyTrustDocument,
  isTrustedIn,
  parseProjectTrustMode,
  parseTrustDocument,
  readTrustFile,
  resolveProjectTrustMode,
  setTrustedIn,
  trustSignature,
  trustedRoots,
  updateTrustFile,
  writeTrustFile
} from "../lib/trust.js";
import { createReporter, diagFile, fakeAgent, fakeCtx, pathExists, readDiag, readDiagSummary, rmRetry, stdioRow } from "./helpers/registry-harness.mjs";

const { pass, report } = createReporter("PROJECT TRUST");

const userLayerPathsIn = (dshHome) => ({
  mcpYml: join(dshHome, "mcp.yml"),
  mcpJson: join(dshHome, "mcp.json"),
  profilesDir: join(dshHome, "profiles")
});

{
  // 纯函数：增删、大小写（Windows）、宽容解析、模式解析。
  const a = resolve("/trust/a");
  const b = resolve("/trust/b");
  const empty = emptyTrustDocument();
  const one = setTrustedIn(empty, a, true, "2026-01-01T00:00:00.000Z");
  assert.equal(isTrustedIn(one, a), true);
  assert.equal(isTrustedIn(one, b), false);
  assert.equal(isTrustedIn(empty, a), false, "setTrustedIn must not mutate its input");
  assert.equal(one.projects[projectKeyOf(a)].trustedAt, "2026-01-01T00:00:00.000Z");
  if (process.platform === "win32") {
    assert.equal(isTrustedIn(one, a.toUpperCase()), true, "Windows trust keys are case-insensitive");
  }
  const two = setTrustedIn(one, b, true);
  assert.notEqual(trustSignature(one), trustSignature(two));
  assert.deepEqual(trustedRoots(two), [a, b].sort(byCodeUnit));
  const removed = setTrustedIn(two, a, false);
  assert.equal(isTrustedIn(removed, a), false);
  assert.deepEqual(trustedRoots(removed), [b]);

  const tolerant = parseTrustDocument({ projects: { wrong: { root: a, trustedAt: 7 }, broken: null, nameless: { trustedAt: "x" }, missing: [] } });
  assert.equal(isTrustedIn(tolerant, a), true, "a record's key is re-derived from root");
  assert.equal(trustedRoots(tolerant).length, 1, "records without a usable root are dropped");

  assert.equal(parseProjectTrustMode("allowlist"), "allowlist");
  assert.equal(parseProjectTrustMode("ALLOWLIST"), undefined);
  assert.equal(resolveProjectTrustMode(undefined, {}), "inherit");
  assert.equal(resolveProjectTrustMode("allowlist", {}), "allowlist");
  assert.equal(resolveProjectTrustMode("inherit", { DSH_MCP_PROJECT_TRUST: "allowlist" }), "allowlist");
  assert.equal(resolveProjectTrustMode("allowlist", { DSH_MCP_PROJECT_TRUST: "bogus" }), "allowlist", "invalid env falls back to config");
  pass("trust store: add/remove, tolerant parse, mode resolution, Windows key casing");
}

{
  // 文件层：缺失 = 空表、写读往返、损坏 JSON 显式报错。
  const dir = await mkdtemp(join(tmpdir(), "dsh-mcp-trust-file-"));
  try {
    const file = projectTrustFile(dir);
    assert.deepEqual((await readTrustFile(file)).projects, {}, "a missing store is an empty table");
    const project = resolve(join(dir, "workspace"));
    await writeTrustFile(file, setTrustedIn(emptyTrustDocument(), project, true));
    const back = await readTrustFile(file);
    assert.equal(isTrustedIn(back, project), true);
    const text = await readFile(file, "utf8");
    assert.match(text, /"version": 1/);
    assert.match(text, /"projects"/);
    assert.equal(text.endsWith("\n"), true, "file ends with a newline");
    await writeFile(file, "{not json", "utf8");
    await assert.rejects(() => readTrustFile(file), /信任文件不是合法 JSON/);
    await assert.rejects(() => updateTrustFile(file, (doc) => setTrustedIn(doc, project, false)), /信任文件不是合法 JSON/);
    assert.equal(await readFile(file, "utf8"), "{not json", "a failed read must not overwrite the store");
    await writeTrustFile(file, emptyTrustDocument());
    const [left, right] = [resolve(join(dir, "left")), resolve(join(dir, "right"))];
    await Promise.all([
      updateTrustFile(file, (doc) => setTrustedIn(doc, left, true, "2026-01-01T00:00:00.000Z")),
      updateTrustFile(file, (doc) => setTrustedIn(doc, right, true, "2026-01-02T00:00:00.000Z"))
    ]);
    const merged = await readTrustFile(file);
    assert.equal(isTrustedIn(merged, left), true, "concurrent trust updates keep both workspaces");
    assert.equal(isTrustedIn(merged, right), true, "concurrent trust updates keep both workspaces");
  } finally {
    await rmRetry(dir);
  }
  pass("trust store: missing file is empty, writes round-trip, corrupt JSON rejects, locked updates merge");
}

{
  // CLI：trust / trusted / untrust / status 都只动信任表。
  const home = await mkdtemp(join(tmpdir(), "dsh-mcp-trust-cli-"));
  const project = await mkdtemp(join(tmpdir(), "dsh-mcp-trust-cli-proj-"));
  try {
    const io = { out: [], err: [], outLine(line) { this.out.push(line); }, errLine(line) { this.err.push(line); } };
    const sink = { out: (line) => io.outLine(line), err: (line) => io.errLine(line) };
    const deps = { home, resolveProjectRoot: async (path) => path };
    const file = join(home, ".dsh", "mcp-trust.json");

    assert.equal(await runCli(["trust", project], sink, deps), 0, "trust exits 0");
    assert.equal(await pathExists(file), true, "trust creates the store");
    assert.equal(isTrustedIn(await readTrustFile(file), project), true);
    assert.ok(io.out.some((line) => line.includes("已信任") && line.includes(project)));

    io.out = [];
    assert.equal(await runCli(["trusted"], sink, deps), 0);
    assert.ok(io.out.includes(resolve(project)), "trusted lists the workspace root");

    io.out = [];
    assert.equal(await runCli(["status"], sink, deps), 0);
    assert.ok(io.out.some((line) => line.includes("项目信任表")), "status prints the trust store");

    assert.equal(await runCli(["untrust", project], sink, deps), 0);
    assert.equal(isTrustedIn(await readTrustFile(file), project), false, "untrust removes the record");

    io.out = [];
    assert.equal(await runCli(["untrust", project], sink, deps), 0);
    assert.ok(io.out.some((line) => line.includes("未在信任表中")), "untrust of an absent root does not claim it was revoked");
    assert.equal(io.out.some((line) => line.includes("已取消信任")), false);

    io.out = [];
    assert.equal(await runCli(["trusted"], sink, deps), 0);
    assert.ok(io.out.some((line) => line.includes("（空")), "empty store is reported");

    const savedTrustEnv = process.env.DSH_MCP_PROJECT_TRUST;
    process.env.DSH_MCP_PROJECT_TRUST = "allowlist";
    try {
      io.out = [];
      assert.equal(await runCli(["status"], sink, deps), 0);
      const trustLine = io.out.find((line) => line.includes("项目信任表"));
      assert.ok(trustLine?.includes("allowlist"), "status reports the env trust mode");
      assert.equal(trustLine?.includes("缺省 inherit"), false);
    } finally {
      if (savedTrustEnv === undefined) delete process.env.DSH_MCP_PROJECT_TRUST;
      else process.env.DSH_MCP_PROJECT_TRUST = savedTrustEnv;
    }

    await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { hidden: { command: "node", args: ["secret.js"] } } }), "utf8");
    assert.equal(await runCli(["trust", project], sink, deps), 0);
    io.out = [];
    assert.equal(await runCli(["untrust", project], sink, deps), 0);
    const statusDeps = { home, resolveProjectRoot: async () => project };
    const blocked = { out: [], err: [] };
    assert.equal(await runCli(["status"], { out: (line) => blocked.out.push(line), err: (line) => blocked.err.push(line) }, statusDeps), 0);
    assert.ok(blocked.out.some((line) => line.includes("已拦截")), "untrust writes the workspace diagnostic without a running host");
    const diagText = await readFile(diagFile(join(home, ".dsh"), project), "utf8");
    assert.equal(diagText.includes("secret.js"), false, "the untrust diagnostic does not read config contents");
    assert.equal(diagText.includes("hidden"), false);
    assert.ok(diagText.includes(untrustedDiagMessage(project).slice(0, 12)));

    io.out = [];
    assert.equal(await runCli(["trust", project], sink, deps), 0);
    const cleared = { out: [], err: [] };
    assert.equal(await runCli(["status"], { out: (line) => cleared.out.push(line), err: (line) => cleared.err.push(line) }, statusDeps), 0);
    assert.equal(cleared.out.some((line) => line.includes("已拦截")), false, "trust clears the block line before the host reconciles");
    pass("cli: trust/trusted/untrust/status drive the store, the mode line, and workspace diagnostics");
  } finally {
    await rmRetry(home);
    await rmRetry(project);
  }
}

/**
 * 一个临时 home + workspace + fake host 的 registry 用例骨架。两个 registry 用例
 * 共用同一段 setup/teardown——重复的 18 行会被 Sonar 计入新增代码重复率。
 */
async function withTrustRegistry(options, run) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-mcp-trust-reg-"));
  const home = join(dir, "home");
  const project = join(dir, "proj");
  const savedCwd = process.cwd();
  let ctx;
  try {
    await mkdir(join(home, ".dsh"), { recursive: true });
    await mkdir(join(project, ".dsh"), { recursive: true });
    if (options.row !== undefined) {
      await writeManagedRows(projectMcpFile(project), [stdioRow(options.row)], { createIfMissing: true });
    }
    if (options.empty === true) {
      // 删光受管行后文件是合法的顶层空数组，仍然算「项目层配置还在」。
      await writeFile(projectMcpFile(project), "[]\n", "utf8");
    }
    if (options.disabled === true) {
      await writeManagedRows(projectMcpFile(project), [{ ...stdioRow("off"), disabled: true }], { createIfMissing: true });
    }
    if (options.ymlText !== undefined) {
      await writeFile(projectMcpFile(project), options.ymlText, "utf8");
    }
    if (options.mcpJsonText !== undefined) {
      await writeFile(join(project, ".mcp.json"), options.mcpJsonText, "utf8");
    }
    process.chdir(dir);
    ctx = fakeCtx();
    const registry = new ProjectMcpRegistry(ctx, {
      globalNames: async () => [],
      userLayerPaths: userLayerPathsIn(join(home, ".dsh")),
      ...(options.projectTrust === undefined ? {} : { projectTrust: options.projectTrust }),
      ...(options.providers ?? {})
    });
    ctx.agentsList.push(fakeAgent("session-trust", project));
    await registry.reconcileNow();
    return await run({ ctx, registry, project, home, dir });
  } finally {
    process.chdir(savedCwd);
    for (const disposer of ctx?.disposers ?? []) {
      try {
        const cleanup = disposer();
        if (typeof cleanup === "function") cleanup();
      } catch {
        // 清理尽力而为：失败也要继续删临时目录。
      }
    }
    await rmRetry(dir);
  }
}

// registry 集成：allowlist 下未信任的 workspace 不装载、不读；信任后装载，取消后卸载。
  await withTrustRegistry({ row: "guarded", projectTrust: "allowlist" }, async ({ ctx, registry, project, home, dir }) => {
    assert.equal(ctx.mounts.length, 0, "an untrusted workspace mounts nothing");
    assert.equal(registry.trustState(project).required, true);
    assert.equal(registry.trustState(project).trusted, false);
    const diagHome = join(home, ".dsh");
    const blocked = await readDiag(diagHome, project);
    assert.equal(blocked.filter((event) => event.kind === "untrusted").length, 1, "an untrusted workspace with a config file records one workspace-level event");
    assert.equal(JSON.stringify(blocked).includes("guarded"), false, "the diagnostic must not contain row contents that were not read");
    const blockedSummary = await readDiagSummary(diagHome, project);
    assert.equal(blockedSummary.untrusted, true);
    assert.equal(blockedSummary.rows, 0, "untrusted summary does not count unread rows");
    const readsBefore = registry.debugConfigReadCount;
    await registry.reconcileNow();
    assert.equal(registry.debugConfigReadCount, readsBefore, "an unchanged untrusted workspace skips the reread, including the user layer");
    const blockedAgain = await readDiag(diagHome, project);
    assert.equal(blockedAgain.filter((event) => event.kind === "untrusted").length, 1, "a repeat reconcile does not stack untrusted events");

    await registry.setProjectTrusted(project, true);
    assert.equal(ctx.mounts.length, 1, "trusting mounts the project rows");
    assert.equal(ctx.mounts[0].serverName, "guarded");
    assert.equal((await readDiagSummary(diagHome, project)).untrusted, undefined, "trusting clears the workspace-level block");
    assert.ok(registry.debugConfigReadCount > readsBefore, "trusting forces a config reread");
    const readsTrusted = registry.debugConfigReadCount;
    await registry.reconcileNow();
    assert.equal(registry.debugConfigReadCount, readsTrusted, "a trusted workspace with unchanged files skips the reread");
    assert.equal(registry.trustState(project).trusted, true);
    assert.equal(await pathExists(projectTrustFile(join(home, ".dsh"))), true);

    await registry.setProjectTrusted(project, false);
    assert.deepEqual(ctx.disposals, ["guarded"], "untrusting unmounts the rows");
    const snapshot = await registry.snapshot();
    assert.equal(snapshot.flatMap((file) => file.servers).length, 0, "untrusted snapshot exposes no servers");
    assert.equal(await pathExists(join(home, ".dsh", "mcp-trust.json")), true, "the store itself stays");
    assert.equal(await pathExists(diagFile(diagHome, project)), true, "untrust keeps a workspace-level diagnostic when config files remain");
    assert.equal((await readDiagSummary(diagHome, project)).untrusted, true);
    const status = { out: [], err: [] };
    assert.equal(await runCli(["status"], { out: (line) => status.out.push(line), err: (line) => status.err.push(line) }, { home, resolveProjectRoot: async () => project }), 0);
    assert.ok(status.out.some((line) => line.includes("已拦截")), "status reports the untrusted block");

    // 外部（CLI / 手改）写入信任表：下一次对账必须发现签名变化并重新读取，
    // 不能因为配置指纹未变而沿用上一轮的空期望。
    const store = join(home, ".dsh", "mcp-trust.json");
    await writeTrustFile(store, setTrustedIn(await readTrustFile(store), project, true));
    await registry.reconcileNow();
    assert.equal(ctx.mounts.length, 2, "an external trust write takes effect on the next reconcile");
    assert.equal(registry.trustState(project).trusted, true);

    await writeTrustFile(store, setTrustedIn(await readTrustFile(store), project, false));
    await registry.reconcileNow();
    assert.equal(registry.trustState(project).trusted, false);
    assert.equal((await readDiagSummary(diagHome, project)).untrusted, true, "an external untrust is applied on the next reconcile");
    assert.equal(ctx.disposals.at(-1), "guarded", "an external untrust unmounts the project row");

    await assert.rejects(() => registry.setProjectTrusted(join(dir, "elsewhere"), true), /未知的工作区/, "arbitrary paths are rejected");
    pass("registry: allowlist gates reads, trust mounts, untrust unmounts, unknown roots rejected");
  });

  // 缺省 inherit：与旧行为一致（不配置也照常装载）。
  await withTrustRegistry({ row: "legacy" }, async ({ ctx, registry, project, home }) => {
    assert.equal(ctx.mounts.length, 1, "inherit mode keeps the old always-mount behavior");
    assert.equal(registry.trustState(project).required, false);
    assert.equal(registry.trustState(project).trusted, true);
    assert.notEqual((await readDiagSummary(join(home, ".dsh"), project))?.untrusted, true, "inherit does not mark the workspace untrusted");
    pass("registry: inherit is the default and never consults the trust store");
  });

  await withTrustRegistry({ projectTrust: "allowlist" }, async ({ home, project }) => {
    assert.equal(await pathExists(diagFile(join(home, ".dsh"), project)), false, "an untrusted workspace with no project files leaves no diagnostic");
    pass("registry: untrusted workspace without config files stays traceless");
  });

  await withTrustRegistry({ projectTrust: "allowlist", empty: true }, async ({ registry, project, home }) => {
    const diagHome = join(home, ".dsh");
    assert.equal((await readDiagSummary(diagHome, project)).untrusted, true, "an empty managed file still counts as present");
    await registry.setProjectTrusted(project, true);
    assert.equal(await pathExists(diagFile(diagHome, project)), false, "trusting a workspace with no rows removes the stale untrusted diagnostic");
    const status = { out: [], err: [] };
    assert.equal(await runCli(["status"], { out: (line) => status.out.push(line), err: (line) => status.err.push(line) }, { home, resolveProjectRoot: async () => project }), 0);
    assert.equal(status.out.some((line) => line.includes("已拦截")), false, "status stops reporting the block after the empty workspace is trusted");
    pass("registry: trusting an empty config clears summary.untrusted");
  });

  await withTrustRegistry({ projectTrust: "allowlist", disabled: true }, async ({ registry, project, home, ctx }) => {
    const diagHome = join(home, ".dsh");
    assert.equal(ctx.mounts.length, 0, "a disabled placeholder is not mounted");
    assert.equal((await readDiagSummary(diagHome, project)).untrusted, true);
    await registry.setProjectTrusted(project, true);
    assert.equal(await pathExists(diagFile(diagHome, project)), false, "trusting a disabled-only workspace clears the stale block");
    assert.equal(ctx.mounts.length, 0, "trusting does not mount a disabled placeholder");
    pass("registry: a disabled-only file does not keep summary.untrusted after trust");
  });

  await withTrustRegistry({
    projectTrust: "allowlist",
    ymlText: "# >>> dsh-project-mcp-manager:mcp:begin\n- broken\n"
  }, async ({ registry, project, home }) => {
    const diagHome = join(home, ".dsh");
    assert.equal((await readDiagSummary(diagHome, project)).untrusted, true);
    await registry.setProjectTrusted(project, true);
    const summary = await readDiagSummary(diagHome, project);
    assert.notEqual(summary.untrusted, true, "a parse error replaces the untrusted summary instead of deleting the file");
    const events = await readDiag(diagHome, project);
    assert.ok(events.some((event) => event.kind === "scan"), "the parse failure is recorded");
    const status = { out: [], err: [] };
    assert.equal(await runCli(["status"], { out: (line) => status.out.push(line), err: (line) => status.err.push(line) }, { home, resolveProjectRoot: async () => project }), 0);
    assert.equal(status.out.some((line) => line.includes("已拦截")), false);
    pass("registry: a parse error after trust overwrites summary.untrusted");
  });

  await withTrustRegistry({
    projectTrust: "allowlist",
    mcpJsonText: JSON.stringify({ mcpServers: { secretmcp: { command: "node", args: ["secret.js"] } } })
  }, async ({ ctx, project, home }) => {
    const diagHome = join(home, ".dsh");
    assert.equal(ctx.mounts.length, 0);
    const text = await readFile(diagFile(diagHome, project), "utf8");
    assert.equal(JSON.parse(text).summary.untrusted, true, "a lone .mcp.json is enough to record the block");
    assert.equal(text.includes("secretmcp"), false, "the block diagnostic does not include unread .mcp.json contents");
    assert.equal(text.includes("secret.js"), false);
    pass("registry: an untrusted workspace with only .mcp.json records a workspace-level block");
  });

  const savedIgnore = process.env.DSH_MCP_IGNORE_MCP_JSON;
  process.env.DSH_MCP_IGNORE_MCP_JSON = "1";
  try {
    await withTrustRegistry({
      projectTrust: "allowlist",
      mcpJsonText: JSON.stringify({ mcpServers: { secretmcp: { command: "node", args: ["secret.js"] } } })
    }, async ({ home, project }) => {
      assert.equal(await pathExists(diagFile(join(home, ".dsh"), project)), false, "DSH_MCP_IGNORE_MCP_JSON=1 ignores .mcp.json for the trust gate");
      pass("registry: DSH_MCP_IGNORE_MCP_JSON=1 does not treat .mcp.json as a project file");
    });
  } finally {
    if (savedIgnore === undefined) delete process.env.DSH_MCP_IGNORE_MCP_JSON;
    else process.env.DSH_MCP_IGNORE_MCP_JSON = savedIgnore;
  }

  await withTrustRegistry({ projectTrust: "allowlist", row: "guarded" }, async ({ registry, project, home, ctx }) => {
    const store = projectTrustFile(join(home, ".dsh"));
    await assert.rejects(
      () => registry.addServer("dsh-project", project, { serverName: "bad name", transport: "stdio", command: "node" }),
      /配置无效/
    );
    assert.equal(isTrustedIn(await readTrustFile(store), project), false, "invalid add input does not trust the workspace");
    await assert.rejects(
      () => registry.addServer("dsh-project", project, { serverName: "guarded", transport: "stdio", command: "node" }),
      /已经写在这份 mcp\.yml 里/
    );
    assert.equal(isTrustedIn(await readTrustFile(store), project), false, "a duplicate name does not trust the workspace");
    assert.equal(ctx.mounts.length, 0, "rejected adds do not mount the pre-existing rows");
    await registry.addServer("dsh-project", project, { serverName: "fresh", transport: "stdio", command: "node" });
    assert.equal(isTrustedIn(await readTrustFile(store), project), true, "a successful add trusts the workspace after the row is written");
    await registry.reconcileNow();
    assert.ok(ctx.mounts.some((mount) => mount.serverName === "fresh"), "the added row mounts once the workspace is trusted");
    pass("registry: addServer trusts the workspace only after validation and the write succeed");
  });

  await withTrustRegistry({ projectTrust: "allowlist", row: "guarded" }, async ({ registry, project, home }) => {
    const store = projectTrustFile(join(home, ".dsh"));
    await writeFile(store, "{not json", "utf8");
    await assert.rejects(() => registry.setProjectTrusted(project, true), /信任文件不是合法 JSON/);
    assert.equal(await readFile(store, "utf8"), "{not json", "a corrupt trust store is not replaced from memory");
    assert.equal(registry.trustState(project).trusted, false);
    pass("registry: a corrupt trust store is rejected instead of overwritten");
  });

  await withTrustRegistry({
    projectTrust: "allowlist",
    providers: {
      statFile: async (path) => {
        const normalized = path.replaceAll("\\", "/");
        if (normalized.includes("/proj/")) {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return null;
      }
    }
  }, async ({ home, project }) => {
    const summary = await readDiagSummary(join(home, ".dsh"), project);
    assert.equal(summary.untrusted, true, "a non-ENOENT stat error is not treated as a missing config file");
    pass("registry: EACCES while stating project files keeps the untrusted diagnostic");
  });

{
  const dir = await mkdtemp(join(tmpdir(), "dsh-mcp-trust-inherit-"));
  const home = join(dir, "home");
  const project = join(dir, "proj");
  const savedCwd = process.cwd();
  let first;
  let second;
  try {
    await mkdir(join(home, ".dsh"), { recursive: true });
    await mkdir(join(project, ".dsh"), { recursive: true });
    await writeFile(projectMcpFile(project), "[]\n", "utf8");
    process.chdir(dir);
    first = fakeCtx();
    const blocked = new ProjectMcpRegistry(first, {
      globalNames: async () => [],
      userLayerPaths: userLayerPathsIn(join(home, ".dsh")),
      projectTrust: "allowlist"
    });
    first.agentsList.push(fakeAgent("session-inherit", project));
    await blocked.reconcileNow();
    assert.equal((await readDiagSummary(join(home, ".dsh"), project)).untrusted, true);
    for (const disposer of first.disposers) {
      const cleanup = disposer();
      if (typeof cleanup === "function") cleanup();
    }
    second = fakeCtx();
    const inherited = new ProjectMcpRegistry(second, {
      globalNames: async () => [],
      userLayerPaths: userLayerPathsIn(join(home, ".dsh"))
    });
    second.agentsList.push(fakeAgent("session-inherit", project));
    await inherited.reconcileNow();
    assert.equal(await pathExists(diagFile(join(home, ".dsh"), project)), false, "switching back to inherit removes a stale untrusted diagnostic when there are no rows");
    pass("registry: inherit startup clears a leftover untrusted diagnostic for an empty workspace");
  } finally {
    process.chdir(savedCwd);
    for (const ctx of [first, second]) {
      for (const disposer of ctx?.disposers ?? []) {
        try {
          const cleanup = disposer();
          if (typeof cleanup === "function") cleanup();
        } catch {
          // 清理尽力而为。
        }
      }
    }
    await rmRetry(dir);
  }
}

report();
