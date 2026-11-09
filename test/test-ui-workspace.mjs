import assert from "node:assert/strict";
import {
  normalizeProjectPath,
  orderWorkspaceGroups,
  sameProjectPath,
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

function row(overrides) {
  return {
    serverName: "srv",
    source: "dsh-project",
    projectRoot: "D:\\work",
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
  assert.equal(normalizeProjectPath("D:\\Work\\"), "d:/work");
  assert.equal(sameProjectPath("D:\\Work", "d:/work/"), true);
  assert.equal(sameProjectPath("D:\\work", "D:\\other"), false);
  assert.equal(sameProjectPath("", ""), false);
  assert.equal(sameProjectPath(null, "D:\\work"), false);
  assert.equal(sameProjectPath(undefined, "D:\\work"), false);
  pass("workspace paths compare without separators or case");
}

{
  const servers = [
    row({ serverName: "run", active: true }),
    row({ serverName: "wait", skipReason: "idle" }),
    row({ serverName: "off", enabled: false, active: false }),
    row({ serverName: "broken", fiberPhase: "failed", skipReason: "env-missing" }),
    row({ serverName: "elsewhere", projectRoot: "D:\\other", active: true })
  ];
  assert.deepEqual(workspaceCounts(servers, "d:/work"), { total: 4, running: 1, waiting: 1, disabled: 1 });
  assert.deepEqual(workspaceCounts(servers, null), { total: 0, running: 0, waiting: 0, disabled: 0 });
  assert.deepEqual(workspaceCounts(servers, "D:\\none"), { total: 0, running: 0, waiting: 0, disabled: 0 });
  pass("counts only rows inside the active workspace, and failures stay in the total");
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
  const unknown = workspaceHeader(null, [row({ active: true })]);
  assert.equal(unknown.known, false);
  assert.equal(unknown.name, "");
  assert.equal(unknown.path, null);
  assert.deepEqual(unknown.segments, []);
  assert.equal(unknown.total, 0);

  const known = workspaceHeader("D:\\work", [row({ active: true }), row({ skipReason: "idle" })]);
  assert.equal(known.known, true);
  assert.equal(known.name, "work");
  assert.equal(known.path, "D:\\work");
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
  assert.equal(workspaceGroupMarker("D:\\work", idle, "D:\\work"), "current");
  assert.equal(workspaceGroupMarker("D:\\other", idle, "D:\\work"), "idle");
  assert.equal(workspaceGroupMarker("D:\\other", broken, "D:\\work"), null);
  assert.equal(workspaceGroupMarker("D:\\other", idle, null), "idle");
  assert.equal(workspaceGroupMarker("D:\\work", broken, null), null);
  pass("current group wins over idle, and a specific skip reason is not overridden");
}

{
  const groups = [["C:\\one", 1], ["D:\\work", 2], ["E:\\three", 3]];
  assert.deepEqual(orderWorkspaceGroups(groups, "d:/work/"), [["D:\\work", 2], ["C:\\one", 1], ["E:\\three", 3]]);
  assert.deepEqual(orderWorkspaceGroups(groups, "F:\\none"), groups);
  assert.deepEqual(orderWorkspaceGroups(groups, null), groups);
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
