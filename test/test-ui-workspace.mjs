import assert from "node:assert/strict";
import {
  contextCostView,
  formatTokenCount,
  orderWorkspaceGroups,
  resultCostView,
  sameWorkspace,
  workspaceCountSegments,
  workspaceCounts,
  workspaceGroupMarker,
  workspaceHeader,
  workspaceNameOf
} from "../packages/ui/src/client/workspace.ts";
import { en, zh } from "../packages/ui/src/client/locales.ts";

/** 一份完整的上下文占用载荷；只覆盖用例关心的字段。 */
function cost(overrides) {
  return {
    sessionId: "session-a",
    tools: 3,
    estTokens: 0,
    level: "ok",
    servers: [],
    warnTokens: 5000,
    alertTokens: 10000,
    ...overrides
  };
}

/** 一份完整的结果占用载荷；只覆盖用例关心的字段。 */
function resultCost(overrides) {
  return {
    sessionId: "session-a",
    calls: 2,
    estTokens: 0,
    servers: [],
    ...overrides
  };
}

// Keep deterministic UTF-16 code-unit order, independent of the host locale.
function byCodeUnit(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log("PASS  " + name);
}

/**
 * 一行服务器。`projectKey` 是宿主用 projectKeyOf() 算好的身份：Windows 夹具
 * 已小写化，POSIX 夹具保持大小写——测试不自己规范化路径。
 */
function row(overrides) {
  return {
    serverName: "srv",
    source: "dsh-project",
    projectRoot: String.raw`D:\work`,
    projectKey: String.raw`d:\work`,
    filePath: String.raw`D:\work\.dsh\mcp.yml`,
    managedPath: String.raw`D:\work\.dsh\mcp.yml`,
    needsYmlTakeover: false,
    layer: "project",
    enabled: true,
    active: false,
    fiberPhase: null,
    skipReason: null,
    toolCount: 0,
    endpoint: "npx",
    serviceKey: null,
    ...overrides
  };
}

test("workspace name uses the last path segment", () => {
  assert.equal(workspaceNameOf(String.raw`D:\Projects\Agent\dsh-mcp-project`), "dsh-mcp-project");
  assert.equal(workspaceNameOf("D:\\Projects\\Agent\\dsh-mcp-project\\"), "dsh-mcp-project");
  assert.equal(workspaceNameOf("/Users/haima/code/app"), "app");
  assert.equal(workspaceNameOf("/Users/haima///"), "haima");
  assert.equal(workspaceNameOf("D:\\"), "D:");
  assert.equal(workspaceNameOf("/"), "/");
  assert.equal(workspaceNameOf(String.raw`  D:\work  `), "work");
  // Long separator runs in the middle used to trigger quadratic regex retries.
  const forwardSeparators = "/".repeat(100_000);
  const backwardSeparators = "\\".repeat(100_000);
  assert.equal(workspaceNameOf(`root${forwardSeparators}leaf`), "leaf");
  assert.equal(workspaceNameOf(`root${backwardSeparators}leaf`), "leaf");
  assert.equal(workspaceNameOf(`root/leaf${forwardSeparators}`), "leaf");
  assert.equal(workspaceNameOf(`root${backwardSeparators}leaf${backwardSeparators}`), "leaf");
  assert.equal(workspaceNameOf(forwardSeparators), forwardSeparators, "all separators preserve the root display");
  assert.equal(workspaceNameOf(backwardSeparators), backwardSeparators, "backslash-only roots are preserved too");
});

test("workspace identity is the host project key, not a browser-side path guess", () => {
  // 宿主给的是项目键：Windows 上已小写化，同一个工作区的不同写法比较相等。
  assert.equal(sameWorkspace(String.raw`d:\work`, String.raw`d:\work`), true);
  assert.equal(sameWorkspace(String.raw`D:\Work`, String.raw`d:\work`), false, "the browser must not fold case itself");
  // POSIX 宿主大小写敏感：两个不同的合法工作区不能并成一个。
  assert.equal(sameWorkspace("/workspace/App", "/workspace/app"), false);
  // POSIX 目录名里的反斜杠与前后空白都是合法字符，不能当成路径分隔符或裁掉。
  assert.equal(sameWorkspace(String.raw`/workspace/a\b`, "/workspace/ab"), false);
  assert.equal(sameWorkspace(" /workspace/app", "/workspace/app"), false);
  // 空键是全局层 / 未确定，永远不算同一个工作区。
  assert.equal(sameWorkspace("", ""), false);
  assert.equal(sameWorkspace(null, null), false);
  assert.equal(sameWorkspace(String.raw`d:\work`, null), false);
  assert.equal(sameWorkspace(undefined, String.raw`d:\work`), false);
});

test("counts only project rows of the active workspace, and failures stay in the total", () => {
  const servers = [
    row({ serverName: "run", active: true }),
    row({ serverName: "wait", active: true, mode: "lazy" }),
    row({ serverName: "off", enabled: false, active: false }),
    row({ serverName: "broken", fiberPhase: "failed", skipReason: "env-missing" }),
    row({ serverName: "elsewhere", projectRoot: String.raw`D:\other`, projectKey: String.raw`d:\other`, active: true })
  ];
  assert.deepEqual(workspaceCounts(servers, String.raw`d:\work`), { total: 4, running: 1, waiting: 1, disabled: 1 });
  assert.deepEqual(workspaceCounts(servers, String.raw`d:\Work`), { total: 0, running: 0, waiting: 0, disabled: 0 },
    "a key that differs only in case is another workspace on a case-sensitive host");
  assert.deepEqual(workspaceCounts(servers, null), { total: 0, running: 0, waiting: 0, disabled: 0 });
  assert.deepEqual(workspaceCounts(servers, String.raw`d:\none`), { total: 0, running: 0, waiting: 0, disabled: 0 });
  // 同一工作区另一路写法（盘符大小写不同）在宿主那里是同一个键。
  assert.deepEqual(workspaceCounts([row({ projectRoot: String.raw`D:\Work`, active: true })], String.raw`d:\work`),
    { total: 1, running: 1, waiting: 0, disabled: 0 });
});

test("active Lazy rows count as waiting, not running", () => {
  const servers = [
    row({ serverName: "eager", active: true }),
    row({ serverName: "lazy-connected", active: true, mode: "lazy" }),
    row({ serverName: "lazy-not-mounted", enabled: true, mode: "lazy" }),
    row({ serverName: "lazy-off", enabled: false, mode: "lazy" })
  ];
  assert.deepEqual(workspaceCounts(servers, String.raw`d:\work`),
    { total: 4, running: 1, waiting: 1, disabled: 1 },
    "only an active Lazy row is available on demand; an unmounted one is not waiting");
  assert.deepEqual(workspaceHeader(String.raw`D:\Work`, String.raw`d:\work`, servers).segments, [
    { key: "workspaceServerCount", count: 4 },
    { key: "workspaceRunningCount", count: 1 },
    { key: "workspaceWaitingCount", count: 1 },
    { key: "workspaceDisabledCount", count: 1 }
  ]);
});

test("global rows never count as the current workspace", () => {
  // R3：用户层 / profile 行的 projectRoot 是配置文件目录，恰好等于当前工作区
  // 路径时不能计入「本工作区」。
  const globalRows = [
    row({ serverName: "user-yml", source: "dsh-user-yml", layer: "user", projectKey: "", active: true, fiberPhase: "active" }),
    row({ serverName: "profile-json", source: "dsh-profile-user", layer: "user", projectKey: "", active: true, fiberPhase: "active" }),
    row({ serverName: "user-json-off", source: "dsh-user", layer: "user", projectKey: "", enabled: false })
  ];
  assert.deepEqual(workspaceCounts(globalRows, String.raw`d:\work`), { total: 0, running: 0, waiting: 0, disabled: 0 });
  assert.deepEqual(workspaceCounts([...globalRows, row({ active: true })], String.raw`d:\work`),
    { total: 1, running: 1, waiting: 0, disabled: 0 }, "a real project row still counts");
  // 防御：即使全局行的键与当前工作区相同，也只认项目层。
  assert.deepEqual(workspaceCounts([row({ layer: "user", projectKey: String.raw`d:\work`, active: true })], String.raw`d:\work`),
    { total: 0, running: 0, waiting: 0, disabled: 0 }, "the layer filter does not depend on the key being empty");
});

test("case-sensitive hosts keep two workspaces apart in the counts", () => {
  // POSIX 宿主：两个大小写不同的工作区各自统计。
  const rows = [
    row({ serverName: "upper", projectRoot: "/workspace/App", projectKey: "/workspace/App", active: true }),
    row({ serverName: "lower", projectRoot: "/workspace/app", projectKey: "/workspace/app", active: true, mode: "lazy" })
  ];
  assert.deepEqual(workspaceCounts(rows, "/workspace/App"), { total: 1, running: 1, waiting: 0, disabled: 0 });
  assert.deepEqual(workspaceCounts(rows, "/workspace/app"), { total: 1, running: 0, waiting: 1, disabled: 0 });
});

test("status line lists only non-zero counts, total first", () => {
  assert.deepEqual(workspaceCountSegments({ total: 1, running: 0, waiting: 0, disabled: 0 }), [
    { key: "workspaceServerCountOne", count: 1 }
  ]);
  assert.deepEqual(workspaceCountSegments({ total: 4, running: 2, waiting: 0, disabled: 1 }), [
    { key: "workspaceServerCount", count: 4 },
    { key: "workspaceRunningCount", count: 2 },
    { key: "workspaceDisabledCount", count: 1 }
  ]);
  assert.deepEqual(workspaceCountSegments({ total: 0, running: 0, waiting: 0, disabled: 0 }), []);
});

test("header model distinguishes a known workspace from an undetermined one", () => {
  const unknown = workspaceHeader(null, null, [row({ active: true })]);
  assert.equal(unknown.known, false);
  assert.equal(unknown.name, "");
  assert.equal(unknown.path, null);
  assert.deepEqual(unknown.segments, []);
  assert.equal(unknown.total, 0);

  const known = workspaceHeader(String.raw`D:\Work`, String.raw`d:\work`, [row({ active: true }), row({ active: true, mode: "lazy" })]);
  assert.equal(known.known, true);
  assert.equal(known.name, "Work", "the displayed path keeps the host's original casing");
  assert.equal(known.path, String.raw`D:\Work`);
  assert.deepEqual(known.segments, [
    { key: "workspaceServerCount", count: 2 },
    { key: "workspaceRunningCount", count: 1 },
    { key: "workspaceWaitingCount", count: 1 }
  ]);
});

test("only the current workspace group carries a marker", () => {
  assert.equal(workspaceGroupMarker(String.raw`d:\work`, String.raw`d:\work`), "current");
  assert.equal(workspaceGroupMarker(String.raw`d:\other`, String.raw`d:\work`), null,
    "a background workspace has no idle marker after permanent mounting");
  assert.equal(workspaceGroupMarker(String.raw`d:\other`, null), null);
  assert.equal(workspaceGroupMarker(String.raw`d:\work`, null), null);
  // POSIX：大小写不同的键不是当前工作区。
  assert.equal(workspaceGroupMarker("/workspace/app", "/workspace/App"), null);
  assert.equal(workspaceGroupMarker("/workspace/App", "/workspace/App"), "current");
});

test("the active workspace group moves to the top and the rest keep their order", () => {
  const groups = [[String.raw`c:\one`, 1], [String.raw`d:\work`, 2], [String.raw`e:\three`, 3]];
  assert.deepEqual(orderWorkspaceGroups(groups, String.raw`d:\work`), [[String.raw`d:\work`, 2], [String.raw`c:\one`, 1], [String.raw`e:\three`, 3]]);
  assert.deepEqual(orderWorkspaceGroups(groups, String.raw`f:\none`), groups);
  assert.deepEqual(orderWorkspaceGroups(groups, null), groups);
  // POSIX：只把键完全相同的组置顶，大小写不同的保持原位。
  assert.deepEqual(orderWorkspaceGroups([["/workspace/app", 1], ["/workspace/App", 2]], "/workspace/App"),
    [["/workspace/App", 2], ["/workspace/app", 1]]);
});

test("token counts fold to a compact label", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(820), "820");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1000), "1k", "a whole thousand drops the decimal");
  assert.equal(formatTokenCount(3400), "3.4k");
  assert.equal(formatTokenCount(9999), "10k", "rounding may reach the next thousand");
  assert.equal(formatTokenCount(12345), "12.3k", "below 100k keeps one decimal");
  assert.equal(formatTokenCount(123456), "123k", "from 100k on the label drops the decimal");
  assert.equal(formatTokenCount(-5), "0", "never shows a negative count");
});

test("contextCostView hides itself when there is no session or no MCP tool", () => {
  assert.equal(contextCostView(undefined), null);
  assert.equal(contextCostView(cost({ sessionId: null, tools: 0 })), null, "no session means no label");
  assert.equal(contextCostView(cost({ tools: 0, servers: [] })), null, "a session without MCP tools shows nothing");
});

test("contextCostView includes a Lazy-only session and keeps the shared proxy marker", () => {
  const view = contextCostView(cost({
    tools: 3,
    estTokens: 400,
    servers: [{ name: "[lazy proxies]", kind: "lazy-proxy", tools: 3, estTokens: 400 }]
  }));
  assert.ok(view !== null, "a Lazy-only session still has MCP tool definitions");
  assert.equal(view.tokens, "400");
  assert.deepEqual(view.top, [{ name: "[lazy proxies]", kind: "lazy-proxy", tools: 3, tokens: "400" }]);
  assert.equal(zh.contextCostLazyProxies, "Lazy 代理（共享）");
  assert.equal(en.contextCostLazyProxies, "Lazy proxies (shared)");
});

test("contextCostView keeps the value short and the breakdown capped", () => {
  const view = contextCostView(cost({
    estTokens: 3400,
    contextWindow: 200000,
    servers: [
      { name: "alpha", tools: 12, estTokens: 2400 },
      { name: "beta", tools: 4, estTokens: 800 },
      { name: "gamma", tools: 2, estTokens: 200 },
      { name: "delta", tools: 1, estTokens: 100 }
    ]
  }));
  assert.equal(view.tokens, "3.4k");
  assert.equal(view.percent, 2, "3400 / 200000 rounds to 2%");
  assert.equal(view.level, "ok");
  assert.deepEqual(view.top, [
    { name: "alpha", tools: 12, tokens: "2.4k" },
    { name: "beta", tools: 4, tokens: "800" },
    { name: "gamma", tools: 2, tokens: "200" }
  ], "the bubble lists the three largest servers");
});

test("contextCostView carries the level through and drops an unknown window", () => {
  assert.equal(contextCostView(cost({ estTokens: 6000, level: "warn" })).percent, null, "no window means no percentage");
  assert.equal(contextCostView(cost({ estTokens: 6000, level: "warn" })).level, "warn", "the level is the host's, not re-derived here");
  const alert = contextCostView(cost({ estTokens: 12000, level: "alert", contextWindow: 64000 }));
  assert.equal(alert.level, "alert");
  assert.equal(alert.percent, 19, "12000 / 64000 rounds to 19%");
  assert.equal(contextCostView(cost({ estTokens: 999999, contextWindow: 1000 })).percent, 100, "the share is capped at 100");
});

test("resultCostView hides itself when there is no session or no retained result", () => {
  assert.equal(resultCostView(undefined), null);
  assert.equal(resultCostView(resultCost({ sessionId: null, calls: 0 })), null, "no session means no label");
  assert.equal(resultCostView(resultCost({ calls: 0, servers: [] })), null, "a session without retained results shows nothing");
});

test("resultCostView keeps Lazy attribution and the shared proxy marker", () => {
  const view = resultCostView(resultCost({
    calls: 3,
    estTokens: 1200,
    contextWindow: 200000,
    servers: [
      { name: "demo", kind: "lazy", calls: 2, estTokens: 900 },
      { name: "[lazy proxies]", kind: "lazy-proxy", calls: 1, estTokens: 300 }
    ]
  }));
  assert.ok(view !== null);
  assert.equal(view.tokens, "1.2k");
  assert.equal(view.estTokens, 1200);
  assert.equal(view.percent, 1);
  assert.deepEqual(view.top, [
    { name: "demo", kind: "lazy", calls: 2, tokens: "900" },
    { name: "[lazy proxies]", kind: "lazy-proxy", calls: 1, tokens: "300" }
  ]);
});

test("resultCostView caps the breakdown and drops an unknown window", () => {
  const view = resultCostView(resultCost({
    calls: 4,
    estTokens: 12000,
    servers: [
      { name: "a", calls: 1, estTokens: 9000 },
      { name: "b", kind: "lazy", calls: 1, estTokens: 2000 },
      { name: "c", calls: 1, estTokens: 700 },
      { name: "d", calls: 1, estTokens: 300 }
    ]
  }));
  assert.equal(view.percent, null, "no window means no percentage");
  assert.deepEqual(view.top.map((server) => server.name), ["a", "b", "c"], "the bubble lists the three largest groups");
  assert.equal(resultCostView(resultCost({ estTokens: 999999, contextWindow: 1000 })).percent, 100, "the share is capped at 100");
});

test("workspace copy exists in both languages", () => {
  assert.deepEqual(Object.keys(en).sort(byCodeUnit), Object.keys(zh).sort(byCodeUnit));
  assert.equal(zh.currentWorkspace, "当前工作区");
  assert.equal(zh.workspaceUnknown, "当前工作区未确定");
  assert.equal(zh.workspaceUnknownHint, "打开一个会话或发送一条消息后确定。");
  assert.equal(zh.workspaceScopeNote, "将自动装载当前所在工作区的 MCP 服务器。");
  assert.equal(zh.workspaceCurrent, "当前");
  assert.equal(zh.workspaceServerCountOne, "1 个服务器");
  assert.equal(zh.workspaceServerCount, "{count} 个服务器");
  assert.equal(zh.workspaceRunningCount, "{count} 运行中");
  assert.equal(zh.workspaceWaitingCount, "{count} 待使用");
  assert.equal(zh.workspaceDisabledCount, "{count} 已禁用");
  assert.equal(en.workspaceServerCountOne, "1 server");
  assert.equal(en.workspaceServerCount, "{count} servers");
  assert.equal(zh.contextResultTag, "结果 {tokens}");
  assert.equal(en.contextResultTag, "Results {tokens}");
  assert.equal(zh.contextResultServerLine, "{name} · {count} 次调用 · {tokens}");
  assert.equal(en.contextResultServerLine, "{name} · {count} calls · {tokens}");
});

console.log(passed + " passed");