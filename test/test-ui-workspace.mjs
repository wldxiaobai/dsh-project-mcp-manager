import assert from "node:assert/strict";
import {
  orderWorkspaceGroups,
  sameWorkspace,
  workspaceCountSegments,
  workspaceCounts,
  workspaceGroupMarker,
  workspaceHeader,
  workspaceNameOf
} from "../packages/ui/src/client/workspace.ts";
import { en, zh } from "../packages/ui/src/client/locales.ts";

// Keep deterministic UTF-16 code-unit order, independent of the host locale.
const byCodeUnit = (a, b) => a < b ? -1 : a > b ? 1 : 0;

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
    row({ serverName: "wait", skipReason: "idle" }),
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
    row({ serverName: "lower", projectRoot: "/workspace/app", projectKey: "/workspace/app", skipReason: "idle" })
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

  const known = workspaceHeader(String.raw`D:\Work`, String.raw`d:\work`, [row({ active: true }), row({ skipReason: "idle" })]);
  assert.equal(known.known, true);
  assert.equal(known.name, "Work", "the displayed path keeps the host's original casing");
  assert.equal(known.path, String.raw`D:\Work`);
  assert.deepEqual(known.segments, [
    { key: "workspaceServerCount", count: 2 },
    { key: "workspaceRunningCount", count: 1 },
    { key: "workspaceWaitingCount", count: 1 }
  ]);
});

test("current group wins over idle, and a specific skip reason is not overridden", () => {
  const idle = [row({ skipReason: "idle" })];
  const broken = [row({ skipReason: "env-missing" })];
  assert.equal(workspaceGroupMarker(String.raw`d:\work`, idle, String.raw`d:\work`), "current");
  assert.equal(workspaceGroupMarker(String.raw`d:\other`, idle, String.raw`d:\work`), "idle");
  assert.equal(workspaceGroupMarker(String.raw`d:\other`, broken, String.raw`d:\work`), null);
  assert.equal(workspaceGroupMarker(String.raw`d:\other`, idle, null), "idle");
  assert.equal(workspaceGroupMarker(String.raw`d:\work`, broken, null), null);
  // POSIX：大小写不同的键不是当前工作区。
  assert.equal(workspaceGroupMarker("/workspace/app", idle, "/workspace/App"), "idle");
  assert.equal(workspaceGroupMarker("/workspace/App", idle, "/workspace/App"), "current");
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

test("workspace copy exists in both languages", () => {
  assert.deepEqual(Object.keys(en).sort(byCodeUnit), Object.keys(zh).sort(byCodeUnit));
  assert.equal(zh.currentWorkspace, "当前工作区");
  assert.equal(zh.workspaceUnknown, "当前工作区未确定");
  assert.equal(zh.workspaceUnknownHint, "打开一个会话或发送一条消息后确定。");
  assert.equal(zh.workspaceScopeNote, "将自动装载当前所在工作区的 MCP 服务器。");
  assert.equal(zh.workspaceCurrent, "当前");
  assert.equal(zh.workspaceIdle, "空闲");
  assert.equal(zh.workspaceIdleHint, "切到该工作区时装载。");
  assert.equal(zh.workspaceServerCountOne, "1 个服务器");
  assert.equal(zh.workspaceServerCount, "{count} 个服务器");
  assert.equal(zh.workspaceRunningCount, "{count} 运行中");
  assert.equal(zh.workspaceWaitingCount, "{count} 待会话");
  assert.equal(zh.workspaceDisabledCount, "{count} 已禁用");
  assert.equal(en.workspaceServerCountOne, "1 server");
  assert.equal(en.workspaceServerCount, "{count} servers");
});

console.log(passed + " passed");