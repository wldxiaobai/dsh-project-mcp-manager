import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectMcpRegistry, projectMcpFile } from "../lib/registry.js";
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
  writeTrustFile
} from "../lib/trust.js";
import { createReporter, fakeAgent, fakeCtx, pathExists, rmRetry, stdioRow } from "./helpers/registry-harness.mjs";

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
  } finally {
    await rmRetry(dir);
  }
  pass("trust store: missing file is empty, writes round-trip, corrupt JSON rejects");
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
    assert.equal(await runCli(["trusted"], sink, deps), 0);
    assert.ok(io.out.some((line) => line.includes("（空")), "empty store is reported");
    pass("cli: trust/trusted/untrust/status drive mcp-trust.json only");
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
    await writeManagedRows(projectMcpFile(project), [stdioRow(options.row)], { createIfMissing: true });
    process.chdir(dir);
    ctx = fakeCtx();
    const registry = new ProjectMcpRegistry(ctx, {
      globalNames: async () => [],
      userLayerPaths: userLayerPathsIn(join(home, ".dsh")),
      ...(options.projectTrust === undefined ? {} : { projectTrust: options.projectTrust })
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
    const readsBefore = registry.debugConfigReadCount;
    await registry.reconcileNow();
    assert.equal(registry.debugConfigReadCount, readsBefore, "an untrusted workspace is not re-read either");

    await registry.setProjectTrusted(project, true);
    assert.equal(ctx.mounts.length, 1, "trusting mounts the project rows");
    assert.equal(ctx.mounts[0].serverName, "guarded");
    assert.ok(registry.debugConfigReadCount > readsBefore, "trusting forces a config reread");
    assert.equal(registry.trustState(project).trusted, true);
    assert.equal(await pathExists(projectTrustFile(join(home, ".dsh"))), true);

    await registry.setProjectTrusted(project, false);
    assert.deepEqual(ctx.disposals, ["guarded"], "untrusting unmounts the rows");
    const snapshot = await registry.snapshot();
    assert.equal(snapshot.flatMap((file) => file.servers).length, 0, "untrusted snapshot exposes no servers");
    assert.equal(await pathExists(join(home, ".dsh", "mcp-trust.json")), true, "the store itself stays");

    // 外部（CLI / 手改）写入信任表：下一次对账必须发现签名变化并重新读取，
    // 不能因为配置指纹未变而沿用上一轮的空期望。
    const store = join(home, ".dsh", "mcp-trust.json");
    await writeTrustFile(store, setTrustedIn(await readTrustFile(store), project, true));
    await registry.reconcileNow();
    assert.equal(ctx.mounts.length, 2, "an external trust write takes effect on the next reconcile");
    assert.equal(registry.trustState(project).trusted, true);

    await assert.rejects(() => registry.setProjectTrusted(join(dir, "elsewhere"), true), /未知的工作区/, "arbitrary paths are rejected");
    pass("registry: allowlist gates reads, trust mounts, untrust unmounts, unknown roots rejected");
  });

  // 缺省 inherit：与旧行为一致（不配置也照常装载）。
  await withTrustRegistry({ row: "legacy" }, async ({ ctx, registry, project }) => {
    assert.equal(ctx.mounts.length, 1, "inherit mode keeps the old always-mount behavior");
    assert.equal(registry.trustState(project).required, false);
    assert.equal(registry.trustState(project).trusted, true);
    pass("registry: inherit is the default and never consults the trust store");
  });

report();
