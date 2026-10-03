import assert from "node:assert/strict";
import { displayHomePath, isProfileSource, profileEndKind, profileNameFromFile, serverActionsOpen } from "../packages/ui/src/client/display.ts";
import { en, zh } from "../packages/ui/src/client/locales.ts";

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}

const home = "C:\\Users\\haima";

{
  assert.equal(
    displayHomePath("C:\\Users\\haima\\.dsh\\profiles\\desktop\\mcp.yml", home),
    "~/.dsh/profiles/desktop/mcp.yml"
  );
  assert.equal(displayHomePath("C:\\Users\\haima\\.dsh\\mcp.yml", home), "~/.dsh/mcp.yml");
  assert.equal(displayHomePath("c:\\users\\haima\\.dsh\\mcp.json", home), "~/.dsh/mcp.json");
  pass("windows user and profile paths use ~");
}

{
  assert.equal(
    displayHomePath("D:\\GameDesign\\GameProjects\\Godot\\测试项目", home),
    "D:\\GameDesign\\GameProjects\\Godot\\测试项目"
  );
  assert.equal(displayHomePath("C:\\Users\\haima-extra\\.dsh\\mcp.yml", home), "C:\\Users\\haima-extra\\.dsh\\mcp.yml");
  assert.equal(displayHomePath("C:\\Users\\haima\\.dsh\\mcp.yml", ""), "C:\\Users\\haima\\.dsh\\mcp.yml");
  assert.equal(displayHomePath("C:\\Users\\haima\\.dsh\\mcp.yml", undefined), "C:\\Users\\haima\\.dsh\\mcp.yml");
  pass("paths outside the home stay absolute");
}

{
  assert.equal(displayHomePath("/Users/haima/.dsh/mcp.yml", "/Users/haima"), "~/.dsh/mcp.yml");
  assert.equal(displayHomePath("/Users/haima/.dsh/mcp.yml", "/Users/haima/"), "~/.dsh/mcp.yml");
  assert.equal(displayHomePath("/Users/haima2/.dsh/mcp.yml", "/Users/haima"), "/Users/haima2/.dsh/mcp.yml");
  pass("posix home prefix uses ~ and does not match a longer name");
}

{
  assert.equal(profileNameFromFile("C:\\Users\\haima\\.dsh\\profiles\\desktop\\mcp.yml"), "desktop");
  assert.equal(profileNameFromFile("C:/Users/haima/.dsh/profiles/web/mcp.json"), "web");
  assert.equal(profileNameFromFile("C:\\Users\\haima\\.dsh\\mcp.yml"), undefined);
  assert.equal(profileNameFromFile("C:\\Users\\haima\\.dsh\\profiles\\..\\mcp.yml"), undefined);
  assert.equal(profileEndKind("desktop"), "desktop");
  assert.equal(profileEndKind("Desktop"), "desktop");
  assert.equal(profileEndKind("web"), "web");
  assert.equal(profileEndKind("job"), "named");
  assert.equal(isProfileSource("dsh-profile-user-yml"), true);
  assert.equal(isProfileSource("dsh-profile-user"), true);
  assert.equal(isProfileSource("dsh-user-yml"), false);
  pass("profile folder name and source");
}

{
  const targets = [{ id: "project", projectRoot: "D:\\work" }, { id: "user", projectRoot: "" }];
  assert.equal(serverActionsOpen({ layer: "project", projectRoot: "D:\\work" }, targets), true);
  assert.equal(serverActionsOpen({ layer: "project", projectRoot: "D:\\other" }, targets), false);
  assert.equal(serverActionsOpen({ layer: "user", projectRoot: "" }, targets), true);
  pass("only the focused workspace can be edited");
}

{
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  assert.equal(zh.projectLayer, "工作区层");
  assert.equal(zh.addScopeProject, "工作区");
  assert.equal(zh.profileLayer, "profile 层：{end}");
  assert.equal(zh.profileDesktop, "桌面端");
  assert.equal(zh.profileWeb, "web 端");
  assert.equal(zh.profileNamed, "{name} 端");
  assert.equal(zh.remove, "删除");
  assert.equal(zh.continueWrite, "写入 mcp.yml");
  assert.equal(zh.enableLabel, "启用");
  assert.equal(zh.workspaceLocked, "这个工作区当前不能改");
  assert.equal(zh.statusIdle, "已启用 · 等待会话启动");
  assert.equal(zh.statusOff, "已禁用");
  for (const value of [zh.introHelp, zh.addDescription, zh.takeoverTitle, zh.removeWill, zh.badgeTakeoverHint]) {
    assert.equal(value.includes("受 mcp-manager 插件管理的 mcp.yml"), true);
  }
  assert.equal(zh.takeoverWill.includes("受管 mcp.yml"), true);
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(/受管 yml|这份 yml|已开|已关闭/.test(value), false, `zh.${key} uses a retired term: ${value}`);
    assert.equal(/[\u4e00-\u9fff][A-Za-z]|[A-Za-z][\u4e00-\u9fff]/.test(value), false, `zh.${key} needs a space between Chinese and Latin text: ${value}`);
  }
  for (const [key, value] of Object.entries(en)) {
    assert.equal(/\byml\b/.test(value.replace(/mcp\.yml|\{\w+\}/g, "")), false, `en.${key} uses bare "yml": ${value}`);
    assert.equal(/\bOn\b|\bOff\b/.test(value), false, `en.${key} should say Enabled/Disabled: ${value}`);
  }
  pass("locale keys match and terms stay consistent");
}

console.log(passed + " passed");
