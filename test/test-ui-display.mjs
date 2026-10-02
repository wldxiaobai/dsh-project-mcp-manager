import assert from "node:assert/strict";
import { displayHomePath, isProfileSource, profileEndKind, profileNameFromFile } from "../packages/ui/src/client/display.ts";
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
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  assert.equal(zh.profileLayer, "profile层：{end}");
  assert.equal(zh.profileDesktop, "桌面端");
  assert.equal(zh.profileWeb, "web端");
  assert.equal(zh.profileNamed, "{name}端");
  assert.equal(zh.remove, "删除");
  assert.equal(zh.continueWrite, "写入 yml");
  for (const value of [zh.introHelp, zh.addDescription, zh.takeoverTitle, zh.removeWill, zh.badgeTakeoverHint]) {
    assert.equal(value.includes("受mcp-manager插件管理的mcp.yml"), true);
  }
  assert.equal(zh.takeoverWill.includes("受管 yml"), true);
  pass("locale keys match and the first managed-yml phrase is expanded");
}

console.log(passed + " passed");
