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

let passed = 0;
function pass(name) {
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
    projectRoot: "D:\\work",
    projectKey: "d:\\work",
    filePath: "D:\\work\\.dsh\\mcp.yml",
    managedPath: "D:\\work\\.dsh\\mcp.yml",
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

{
  assert.equal(workspaceNameOf("D:\\Projects\\Agent\\dsh-mcp-project"), "dsh-mcp-project");
  assert.equal(workspaceNameOf("D:\\Projects\\Agent\\dsh-mcp-project\\"), "dsh-mcp-project");
  assert.equal(workspaceNameOf("/Users/haima/code/app"), "app");
  assert.equal(workspaceNameOf("/Users/haima///"), "haima");
  assert.equal(workspaceNameOf("D:\\"), "D:");
  assert.equal(workspaceNameOf("/"), "/");
  assert.equal(workspaceNameOf("  D:\\work  "), "work");
  pass("workspace name uses the last path segment");
}

{
  // 宿主给的是项目键：Windows 上已小写化，同一个工作区的不同写法比较相等。
  assert.equal(sameWorkspace("d:\\work", "d:\\work"), true);
  assert.equal(sameWorkspace("D:\\Work", "d:\\work"), false, "the browser must not fold case itself");
  // POSIX 宿主大小写敏感：两个不同的合法工作区不能并成一个。
  assert.equal(sameWorkspace("/workspace/App", "/workspace/app"), false);
  // POSIX 目录名里的反斜杠与前后空白都是合法字符，不能当成路径分隔符或裁掉。
  assert.equal(sameWorkspace("/workspace/a\\b", "/workspace/ab"), false);
  assert.equal(sameWorkspace(" /workspace/app", "/workspace/app"), false);
  // 空键是全局层 / 未确定，永远不算同一个工作区。
  assert.equal(sameWorkspace("", ""), false);
  assert.equal(sameWorkspace(null, null), false);
  assert.equal(sameWorkspace("d:\\work", null), false);
  assert.equal(sameWorkspace(undefined, "d:\\work"), false);
  pass("workspace identity is the host project key, not a browser-side path guess");
}

{
  const servers = [
    row({ serverName: "run", active: true }),
    row({ serverName: "wait", skipReason: "idle" }),
    row({ serverName: "off", enabled: false, active: false }),
    row({ serverName: "broken", fiberPhase: "failed", skipReason: "env-missing" }),
    row({ serverName: "elsewhere", projectRoot: "D:\\other", projectKey: "d:\\other", active: true })
  ];
  assert.deepEqual(workspaceCounts(servers, "d:\\work"), { total: 4, running: 1, waiting: 1, disabled: 1 });
  assert.deepEqual(workspaceCounts(servers, "d:\\Work"), { total: 0, running: 0, waiting: 0, disabled: 0 },
    "a key that differs only in case is another workspace on a case-sensitive host");
  assert.deepEqual(workspaceCounts(servers, null), { total: 0, running: 0, waiting: 0, disabled: 0 });
  assert.deepEqual(workspaceCounts(servers, "d:\\none"), { total: 0, running: 0, waiting: 0, disabled: 0 });
  // 同一工作区另一路写法（盘符大小写不同）在宿主那里是同一个键。
  assert.deepEqual(workspaceCounts([row({ projectRoot: "D:\\Work", active: true })], "d:\\work"),
    { total: 1, running: 1, waiting: 0, disabled: 0 });
  pass("counts only project rows of the active workspace, and failures stay in the total");
}

{
  // R3：用户层 / profile 行的 projectRoot 是配置文件目录，恰好等于当前工作区
  // 路径时不能计入「本工作区」。
  const globalRows = [
    row({ serverName: "user-yml", source: "dsh-user-yml", layer: "user", projectKey: "", active: true, fiberPhase: "active" }),
    row({ serverName: "profile-json", source: "dsh-profile-user", layer: "user", projectKey: "", active: true, fiberPhase: "active" }),
    row({ serverName: "user-json-off", source: "dsh-user", layer: "user", projectKey: "", enabled: false })
  ];
  assert.deepEqual(workspaceCounts(globalRows, "d:\\work"), { total: 0, running: 0, waiting: 0, disabled: 0 });
  assert.deepEqual(workspaceCounts([...globalRows, row({ active: true })], "d:\\work"),
    { total: 1, running: 1, waiting: 0, disabled: 0 }, "a real project row still counts");
  // 防御：即使全局行的键与当前工作区相同，也只认项目层。
  assert.deepEqual(workspaceCounts([row({ layer: "user", projectKey: "d:\\work", active: true })], "d:\\work"),
    { total: 0, running: 0, waiting: 0, disabled: 0 }, "the layer filter does not depend on the key being empty");
  pass("global rows never count as the current workspace");
}

{
  // POSIX 宿主：两个大小写不同的工作区各自统计。
  const rows = [
    row({ serverName: "upper", projectRoot: "/workspace/App", projectKey: "/workspace/App", active: true }),
    row({ serverName: "lower", projectRoot: "/workspace/app", projectKey: "/workspace/app", skipReason: "idle" })
  ];
  assert.deepEqual(workspaceCounts(rows, "/workspace/App"), { total: 1, running: 1, waiting: 0, disabled: 0 });
  assert.deepEqual(workspaceCounts(rows, "/workspace/app"), { total: 1, running: 0, waiting: 1, disabled: 0 });
  pass("case-sensitive hosts keep two workspaces apart in the counts");
}

{
  assert.deepEqual(workspaceCountSegments({ total: 1, running: 0, waiting: 0, disabled: 0 }), [
    { key: "workspaceServerCountOne", count: 1 }
  ]);
  assert.deepEqual(workspaceCountSegments({ total: 4, running: 2, waiting: 0, disabled: 1 }), [
    { key: "workspaceServerCount", count: 4 },
    { key: "workspaceRunningCount", count: 2 },
    { key: "workspaceDisabledCount", count: 1 }
  ]);
  assert.deepEqual(workspaceCountSegments({ total: 0, running: 0, waiting: 0, disabled: 0 }), []);
  pass("status line lists only non-zero counts, total first");
}

{
  const unknown = workspaceHeader(null, null, [row({ active: true })]);
  assert.equal(unknown.known, false);
  assert.equal(unknown.name, "");
  assert.equal(unknown.path, null);
  assert.deepEqual(unknown.segments, []);
  assert.equal(unknown.total, 0);

  const known = workspaceHeader("D:\\Work", "d:\\work", [row({ active: true }), row({ skipReason: "idle" })]);
  assert.equal(known.known, true);
  assert.equal(known.name, "Work", "the displayed path keeps the host's original casing");
  assert.equal(known.path, "D:\\Work");
  assert.deepEqual(known.segments, [
    { key: "workspaceServerCount", count: 2 },
    { key: "workspaceRunningCount", count: 1 },
    { key: "workspaceWaitingCount", count: 1 }
  ]);
  pass("header model distinguishes a known workspace from an undetermined one");
}

{
  const idle = [row({ skipReason: "idle" })];
  const broken = [row({ skipReason: "env-missing" })];
  assert.equal(workspaceGroupMarker("d:\\work", idle, "d:\\work"), "current");
  assert.equal(workspaceGroupMarker("d:\\other", idle, "d:\\work"), "idle");
  assert.equal(workspaceGroupMarker("d:\\other", broken, "d:\\work"), null);
  assert.equal(workspaceGroupMarker("d:\\other", idle, null), "idle");
  assert.equal(workspaceGroupMarker("d:\\work", broken, null), null);
  // POSIX：大小写不同的键不是当前工作区。
  assert.equal(workspaceGroupMarker("/workspace/app", idle, "/workspace/App"), "idle");
  assert.equal(workspaceGroupMarker("/workspace/App", idle, "/workspace/App"), "current");
  pass("current group wins over idle, and a specific skip reason is not overridden");
}

{
  const groups = [["c:\\one", 1], ["d:\\work", 2], ["e:\\three", 3]];
  assert.deepEqual(orderWorkspaceGroups(groups, "d:\\work"), [["d:\\work", 2], ["c:\\one", 1], ["e:\\three", 3]]);
  assert.deepEqual(orderWorkspaceGroups(groups, "f:\\none"), groups);
  assert.deepEqual(orderWorkspaceGroups(groups, null), groups);
  // POSIX：只把键完全相同的组置顶，大小写不同的保持原位。
  assert.deepEqual(orderWorkspaceGroups([["/workspace/app", 1], ["/workspace/App", 2]], "/workspace/App"),
    [["/workspace/App", 2], ["/workspace/app", 1]]);
  pass("the active workspace group moves to the top and the rest keep their order");
}

{
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
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
  pass("workspace copy exists in both languages");
}

console.log(passed + " passed");