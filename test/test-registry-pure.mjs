import assert from "node:assert/strict";
import { mergeSourcedRows, planProjectChanges, profileNameFromConfigPath } from "../lib/registry.js";
import { createReporter } from "./helpers/registry-harness.mjs";

const { pass, report } = createReporter("PROJECT REGISTRY PURE");

// 纯函数：profile 名解析、跨来源同服务去重、连接字段变更规划。
// ── profile 名解析（纯函数，宿主内部路径形态）──────────────────────────────
{
  // 无关路径用例只要求「解析不出 profile」，用中性的虚构挂载点，避免踩
  // 公共可写目录（/tmp 等）的安全规则——这里根本不碰文件系统。
  const profilePathCases = [
    { config: "file:///C:/Users/x/.dsh/profiles/web/cordis.yml", expected: "web", note: "file URL config path" },
    { config: String.raw`C:\Users\x\.dsh\profiles\headless\cordis.snapshot.yml`, expected: "headless", note: "windows path + replay basename" },
    { config: "file:///home/u/.dsh/profiles/tui/", expected: "tui", note: "baseUrl directory form" },
    { config: "/srv/apps/cordis.yml", expected: undefined, note: "unrelated path yields no profile" },
    { config: undefined, expected: undefined, note: "missing config path" }
  ];
  for (const testCase of profilePathCases) {
    assert.equal(profileNameFromConfigPath(testCase.config), testCase.expected, testCase.note);
  }
  pass("profileNameFromConfigPath resolves the running profile from host-internal paths");
}

// ── 0. mergeSourcedRows 跨来源同服务去重（纯函数）──────────────────────────
{
  const srow = (rawName, source, config, disabled = false) => ({
    rawName,
    source,
    ...(disabled ? { disabled: true } : {}),
    row: { id: "panel-mcp-" + rawName, name: "@deepseek-ai/dsh-mcp-client", ...(disabled ? { disabled: true } : {}), ...(config === undefined ? {} : { config }) }
  });
  const stdioCfg = (serverName, command, args) => ({ serverName, transport: "stdio", command, args, env: {}, cwd: "" });
  const httpCfg = (serverName, url) => ({ serverName, transport: "streamable-http", url, headers: {} });

  // 0.1 事故对：同名服务两种写法（args 差 --offline）→ 归一名键命中，高层胜出
  {
    const m = mergeSourcedRows([
      [srow("unityMCP", "dsh-project", stdioCfg("unityMCP", String.raw`C:\uvx.exe`, ["--from", "mcpforunityserver==10.1.0", "mcp-for-unity", "--transport", "stdio"]))],
      [],
      [],
      [srow("unity-mcp", "dsh-user", stdioCfg("unity-mcp", String.raw`C:\uvx.exe`, ["--offline", "--from", "mcpforunityserver==10.1.0", "mcp-for-unity", "--transport", "stdio"]))]
    ]);
    assert.deepEqual(m.rows.map((r) => r.rawName), ["unityMCP"], "normname dup drops the low-priority twin");
    assert.deepEqual(m.shadowedIdentity, [{ name: "unity-mcp", winner: "unityMCP", reason: "normname", source: "dsh-user", winnerSource: "dsh-project" }], "identity shadow reports the incident pair with both layers");
    assert.deepEqual(m.shadowedUser, ["unity-mcp"], "the dropped user-layer row also counts as project-shadowed user row");
  }
  // 0.2 完全相同的 command+args（名字归一后不同）→ 身份键命中
  {
    const m = mergeSourcedRows([
      [srow("pencilA", "dsh-project", stdioCfg("pencilA", String.raw`C:\pencil\mcp-server.exe`, ["--agent", "cli"]))],
      [],
      [srow("pencil-user", "dsh-user-yml", stdioCfg("pencil-user", String.raw`C:\pencil\mcp-server.exe`, ["--agent", "cli"]))]
    ]);
    assert.deepEqual(m.rows.map((r) => r.rawName), ["pencilA"], "identity dup keeps the yml row");
    assert.deepEqual(m.shadowedIdentity, [{ name: "pencil-user", winner: "pencilA", reason: "identity", source: "dsh-user-yml", winnerSource: "dsh-project" }]);
  }
  // 0.3 同 command 不同 args 是不同服务：node a.js 与 node b.js 不许互杀
  {
    const m = mergeSourcedRows([
      [srow("aa", "dsh-project", stdioCfg("aa", "node", ["a.js"])), srow("bb", "dsh-project", stdioCfg("bb", "node", ["b.js"]))]
    ]);
    assert.equal(m.rows.length, 2, "same command, different args are different services");
    assert.equal(m.shadowedIdentity.length, 0);
  }
  // 0.4 http 用 url 做身份键
  {
    const m = mergeSourcedRows([
      [srow("remote", "dsh-project", httpCfg("remote", "https://mcp.example/api"))],
      [],
      [],
      [srow("remote2", "dsh-user", httpCfg("remote2", "https://mcp.example/api"))]
    ]);
    assert.deepEqual(m.rows.map((r) => r.rawName), ["remote"]);
    assert.deepEqual(m.shadowedIdentity, [{ name: "remote2", winner: "remote", reason: "identity", source: "dsh-user", winnerSource: "dsh-project" }]);
  }
  // 0.5 disabled 占名行注册归一名键：给用户层行提供占名退出手段
  {
    const m = mergeSourcedRows([
      [srow("gamma", "dsh-project", undefined, true)],
      [],
      [],
      [srow("Gamma", "dsh-user", stdioCfg("Gamma", "node", ["g.js"]))]
    ]);
    assert.equal(m.rows.length, 0, "disabled placeholder mounts nothing and its normname twin stays shadowed");
    assert.deepEqual(m.shadowedIdentity, [{ name: "Gamma", winner: "gamma", reason: "normname", source: "dsh-user", winnerSource: "dsh-project" }]);
  }
  // 0.6 空 command 的行不注册身份键（两行都无 config 时不得互杀）
  {
    const m = mergeSourcedRows([
      [],
      [],
      [srow("uc-a", "dsh-user-yml", stdioCfg("uc-a", "", []))],
      [srow("uc-b", "dsh-user", stdioCfg("uc-b", "", []))]
    ]);
    assert.equal(m.rows.length, 2, "rows without a command never claim the identity key");
    assert.equal(m.shadowedIdentity.length, 0);
  }
  // 0.7 精确同名遮蔽仍先到先得，且不重复记入 shadowedIdentity
  {
    const m = mergeSourcedRows([
      [srow("dup", "dsh-project", stdioCfg("dup", "node", ["x.js"]))],
      [srow("dup", "cc-project", stdioCfg("dup", "node", ["other.js"]))]
    ]);
    assert.deepEqual(m.shadowedOwnCc, ["dup"]);
    assert.equal(m.shadowedIdentity.length, 0, "exact-name shadow is not an identity shadow");
  }
  pass("mergeSourcedRows dedups same service across layers by normalized name and identity, disabled rows hold the name");
}

// ── 0.8 planProjectChanges：连接字段 vs 非连接字段（纯函数）──────────────────
{
  const rowOf = (config) => ({ id: "panel-mcp-alpha", name: "@deepseek-ai/dsh-mcp-client", config });
  const baseConfig = {
    serverName: "alpha",
    transport: "stdio",
    command: "node",
    args: ["a.js"],
    env: {},
    cwd: "",
    toolCallTimeoutMs: 60000,
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }
  };
  const projectKey = "proj-key-for-plan";
  const effective = new Map([[projectKey + "\u0000alpha", "alpha"]]);
  const current = [{ rawName: "alpha", effectiveName: "alpha", row: rowOf(baseConfig) }];
  const desired = (config) => [{ rawName: "alpha", source: "dsh-project", row: rowOf(config) }];
  assert.deepEqual(
    planProjectChanges(current, desired(baseConfig), effective, projectKey),
    { toUnmount: [], toMount: [] },
    "an unchanged row is left alone"
  );
  // tools.allow/deny 只影响 restrict（就地换 state.row），不是连接字段。
  assert.deepEqual(
    planProjectChanges(current, desired({ ...baseConfig, tools: { deny: ["echo_*"] } }), effective, projectKey),
    { toUnmount: [], toMount: [] },
    "tools-only edit keeps the fiber"
  );
  // maxInstructionBytes 只在连接时被官方读取：改它必须拆连接，顺序（先 unmount 再 mount）由 reconcileContainer 保证。
  const plan = planProjectChanges(current, desired({ ...baseConfig, maxInstructionBytes: 4096 }), effective, projectKey);
  assert.deepEqual(plan.toUnmount, ["alpha"], "connection-field change unmounts first");
  assert.deepEqual(plan.toMount.map((item) => item.rawName), ["alpha"], "and mounts the same rawName back with the new row");
  // 生效名变化同样拆连接（原名不变时全局冲突会让项目行改名）。
  const renamed = planProjectChanges(current, desired(baseConfig), new Map([[projectKey + "\u0000alpha", "p123abc_alpha"]]), projectKey);
  assert.deepEqual(renamed.toUnmount, ["alpha"]);
  assert.deepEqual(renamed.toMount.map((item) => item.rawName), ["alpha"]);
  pass("planProjectChanges remounts on connection-field and effective-name changes but not for tools-only edits");
}

report();
