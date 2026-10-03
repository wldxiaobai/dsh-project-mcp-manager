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

console.log("\n" + passed + " passed, 0 failed");
console.log("ALL UI COLLAPSE TESTS PASSED");
