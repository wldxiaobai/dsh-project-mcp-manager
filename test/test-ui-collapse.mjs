import assert from "node:assert/strict";
import { collapseServers } from "../packages/ui/src/client/collapse.ts";

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}

const row = (partial) => ({
  serverName: partial.serverName,
  source: partial.source,
  projectRoot: partial.projectRoot ?? "D:\\proj",
  layer: partial.layer ?? "project",
  needsYmlTakeover: partial.needsYmlTakeover ?? (!String(partial.source).endsWith("yml") && partial.source !== "dsh-project"),
  serviceKey: partial.serviceKey ?? null
});

const names = (logical) => logical.map((item) => item.winner.serverName);

{
  const godot = row({ serverName: "godot", source: "dsh-project", serviceKey: "s\0node\0godot.js" });
  const godot2 = row({ serverName: "godot2", source: "dsh-project-json", serviceKey: "s\0node\0godot.js" });
  const logical = collapseServers([godot2, godot]);
  assert.deepEqual(names(logical), ["godot"]);
  assert.deepEqual(logical[0].shadowed, []);
  pass("different name, same command: non-yml row is omitted");
}

{
  const yml = row({ serverName: "godot", source: "dsh-project", serviceKey: "s\0node\0a.js" });
  const json = row({ serverName: "godot", source: "dsh-project-json", serviceKey: "s\0node\0a.js" });
  const logical = collapseServers([json, yml]);
  assert.deepEqual(names(logical), ["godot"]);
  assert.equal(logical[0].winner.source, "dsh-project");
  assert.deepEqual(logical[0].shadowed.map((item) => item.source), ["dsh-project-json"]);
  pass("same normalized name stays on the card as a covered-by note");
}

{
  const a = row({ serverName: "godot", source: "dsh-project", serviceKey: "s\0node\0a.js" });
  const b = row({ serverName: "godot2", source: "dsh-project-json", serviceKey: "s\0node\0b.js" });
  assert.deepEqual(names(collapseServers([a, b])), ["godot", "godot2"]);
  pass("same command with different args stays two cards");
}

{
  const left = row({ serverName: "godot", source: "dsh-project", projectRoot: "D:\\a", serviceKey: "s\0node\0a.js" });
  const right = row({ serverName: "godot2", source: "dsh-project-json", projectRoot: "D:\\b", serviceKey: "s\0node\0a.js" });
  assert.deepEqual(names(collapseServers([left, right])), ["godot", "godot2"]);
  pass("identity collapse does not cross projects");
}

{
  const yml = row({ serverName: "kept", source: "dsh-profile-user-yml", layer: "user", projectRoot: "", serviceKey: "h\0https://mcp.example/mcp" });
  const json = row({ serverName: "alias", source: "dsh-user", layer: "user", projectRoot: "", serviceKey: "h\0https://mcp.example/mcp" });
  const logical = collapseServers([json, yml]);
  assert.deepEqual(names(logical), ["kept"]);
  assert.deepEqual(logical[0].shadowed, []);
  pass("user-layer http alias is omitted when the url matches");
}

{
  const kept = row({ serverName: "godot", source: "dsh-project", serviceKey: "s\0node\0a.js" });
  const other = row({ serverName: "godot2", source: "dsh-project", serviceKey: "s\0node\0a.js" });
  const logical = collapseServers([kept, other]);
  assert.deepEqual(names(logical), ["godot"]);
  assert.deepEqual(logical[0].shadowed.map((item) => item.serverName), ["godot2"]);
  pass("two yml rows with the same command share one card");
}

{
  const yml = row({ serverName: "godot", source: "dsh-project", serviceKey: "s\0node\0a.js" });
  const ymlAlias = row({ serverName: "godot2", source: "dsh-project", serviceKey: "s\0node\0a.js" });
  const json = row({ serverName: "godot2", source: "dsh-project-json", serviceKey: "s\0node\0b.js" });
  const logical = collapseServers([yml, ymlAlias, json]);
  assert.deepEqual(names(logical), ["godot", "godot2"]);
  assert.deepEqual(logical[0].shadowed.map((item) => item.serverName), ["godot2"]);
  assert.equal(logical[0].shadowed[0].source, "dsh-project");
  assert.equal(logical[1].winner.source, "dsh-project-json");
  assert.deepEqual(logical[1].shadowed, []);
  pass("a same-named json row with a different command stays its own card");
}

{
  const named = row({ serverName: "unityMCP", source: "dsh-project", serviceKey: "named-command" });
  const identity = row({ serverName: "other", source: "dsh-project", serviceKey: "other-command" });
  const exact = row({ serverName: "unityMCP", source: "dsh-project-json", serviceKey: "other-command" });
  const normalized = row({ serverName: "unity-mcp", source: "cc-project", serviceKey: "other-command" });
  const logical = collapseServers([named, identity, exact, normalized]);
  assert.deepEqual(logical.map((item) => item.winner), [named, identity]);
  assert.deepEqual(logical[0].shadowed, [exact, normalized]);
  assert.deepEqual(logical[1].shadowed, []);
  pass("exact and normalized name matches both take precedence over identity");
}

{
  const kept = row({ serverName: "kept", source: "dsh-project", serviceKey: "shared" });
  const omitted = row({ serverName: "alias", source: "dsh-project-json", serviceKey: "shared" });
  const independent = row({ serverName: "alias", source: "cc-project", serviceKey: "different" });
  const logical = collapseServers([kept, omitted, independent]);
  assert.deepEqual(logical.map((item) => item.winner), [kept, independent]);
  assert.deepEqual(logical[0].shadowed, []);
  pass("omitted identity alias does not register its name");
}

{
  const kept = row({ serverName: "unityMCP", source: "dsh-project", serviceKey: "original" });
  const covered = row({ serverName: "unity-mcp", source: "dsh-project-json", serviceKey: "different" });
  const independent = row({ serverName: "independent", source: "cc-project", serviceKey: "different" });
  const logical = collapseServers([kept, covered, independent]);
  assert.deepEqual(logical.map((item) => item.winner), [kept, independent]);
  assert.deepEqual(logical[0].shadowed, [covered]);
  pass("name shadow registers no new identity alias");
}

{
  const covered = row({ serverName: "unity-mcp", source: "dsh-project-json" });
  const middle = row({ serverName: "middle", source: "dsh-project" });
  const kept = row({ serverName: "unityMCP", source: "dsh-project" });
  const logical = collapseServers([covered, middle, kept]);
  assert.deepEqual(logical.map((item) => item.winner), [kept, middle]);
  assert.deepEqual(logical[0].shadowed, [covered]);
  pass("name shadow moves the anchor to its original input position");
}

{
  const alias = row({ serverName: "alias", source: "dsh-user-yml", layer: "user", serviceKey: "shared" });
  const middle = row({ serverName: "middle", source: "dsh-profile-user-yml", layer: "user" });
  const kept = row({ serverName: "kept", source: "dsh-profile-user-yml", layer: "user", serviceKey: "shared" });
  const logical = collapseServers([alias, middle, kept]);
  assert.deepEqual(logical.map((item) => item.winner), [middle, kept]);
  assert.deepEqual(logical[1].shadowed, [alias]);
  pass("identity-only yml shadow leaves the winner anchor unchanged");
}

{
  const a = row({ serverName: "---", source: "dsh-project", serviceKey: "" });
  const b = row({ serverName: "!!!", source: "dsh-project", serviceKey: "" });
  const exact = row({ serverName: "---", source: "dsh-project-json" });
  const logical = collapseServers([a, b, exact]);
  assert.deepEqual(logical.map((item) => item.winner), [a, b]);
  assert.deepEqual(logical[0].shadowed, [exact]);
  pass("empty normalized name and empty identity create no keys, but exact names still match");
}

{
  const project = row({ serverName: "same", source: "dsh-project", serviceKey: "shared" });
  const user = row({ serverName: "same", source: "dsh-user-yml", layer: "user", serviceKey: "shared" });
  const logical = collapseServers([project, user]);
  assert.deepEqual(logical.map((item) => item.winner), [project, user]);
  pass("name and identity keys do not cross project and user scopes");
}

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL UI COLLAPSE TESTS PASSED");
