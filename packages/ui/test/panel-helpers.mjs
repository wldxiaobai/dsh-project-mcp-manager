import assert from "node:assert/strict";
import { addPathForTarget, badgeTone, confirmationDisplay, emptyDraft, partitionRows, profileEnd, validateAddDraft, confirmationCopy } from "../src/client/panel-helpers.ts";

const target = { id: "project", source: "dsh-project", projectRoot: "/p", path: "/p/.dsh/mcp.yml", label: "workspace" };
const draft = { ...emptyDraft([target]), name: "demo", command: "node", args: "--x\n y", env: "FOO=bar" };
const valid = validateAddDraft(draft, [target]);
assert.equal(valid.ok, true);
if (valid.ok) assert.deepEqual(valid.body, { source: "dsh-project", projectRoot: "/p", serverName: "demo", transport: "stdio", command: "node", args: ["--x", "y"], env: { FOO: "bar" } });
const noTargetDraft = { ...draft, name: "bad name" };
assert.deepEqual(validateAddDraft(noTargetDraft, []), { ok: false, error: { kind: "target" } });
assert.deepEqual(validateAddDraft({ ...draft, command: "", env: "BAD LINE" }, [target]), { ok: false, error: { kind: "command" } });
assert.deepEqual(validateAddDraft({ ...draft, command: "node", env: "" }, [target]), { ok: true, body: { source: "dsh-project", projectRoot: "/p", serverName: "demo", transport: "stdio", command: "node", args: ["--x", "y"] } });
assert.deepEqual(validateAddDraft({ ...draft, transport: "http", url: "", headers: "BAD" }, [target]), { ok: false, error: { kind: "url" } });
assert.deepEqual(validateAddDraft({ ...draft, name: "bad name" }, [target]), { ok: false, error: { kind: "name" } });
assert.deepEqual(validateAddDraft({ ...draft, command: "node", env: "BAD-NAME=x" }, [target]), { ok: false, error: { kind: "pairs", line: "BAD-NAME=x" } });
const http = validateAddDraft({ ...draft, transport: "http", url: "https://example.test", headers: "Authorization: Bearer x" }, [target]);
assert.equal(http.ok, true);
if (http.ok) assert.deepEqual(http.body.headers, { Authorization: "Bearer x" });
assert.deepEqual(confirmationCopy({ kind: "server", action: "remove", row: { serverName: "x", needsYmlTakeover: false } }, "", ""), { kind: "remove", name: "x" });
assert.deepEqual(confirmationCopy({ kind: "server", action: "remove", row: { serverName: "x", needsYmlTakeover: true } }, "a", "b"), { kind: "takeover", file: "a", yml: "b" });
assert.deepEqual(confirmationCopy({ kind: "tool", row: { serverName: "x", needsYmlTakeover: true } }, "a", "b"), { kind: "takeover", file: "a", yml: "b" });
assert.equal(addPathForTarget(target, (path) => `~${path}`), "/p/.dsh/mcp.yml");
assert.equal(addPathForTarget({ ...target, id: "user", path: "/home/u/mcp.yml" }, (path) => `~${path}`), "~/home/u/mcp.yml");
const rows = [
  { layer: "user", source: "dsh-profile-user", filePath: "/profiles/a/mcp.json" },
  { layer: "user", source: "dsh-user", filePath: "/mcp.json" },
  { layer: "user", source: "dsh-profile-user-suffix", filePath: "/profiles/b/mcp.json" },
  { layer: "project", source: "dsh-profile-user", filePath: "/p/mcp.json" }
];
const groups = partitionRows(rows);
assert.equal(groups.profileBuckets[0]?.[0], "a");
assert.equal(groups.userRows.length, 2);
assert.equal(groups.projectRows.length, 1);
const t = (key, params) => params === undefined ? key : `${key}:${JSON.stringify(params)}`;
const projectRow = { serverName: "demo", needsYmlTakeover: true, layer: "project", filePath: "/p/.mcp.json", managedPath: "/p/.dsh/mcp.yml" };
const shownPaths = [];
const showUserPath = (path) => { shownPaths.push(path); return `~${path}`; };
assert.deepEqual(confirmationDisplay(null, showUserPath, t), { removes: false, title: "takeoverTitle", will: "", wont: "" });
assert.deepEqual(shownPaths, []);
assert.deepEqual(confirmationDisplay({ kind: "server", action: "enable", row: projectRow }, showUserPath, t), {
  removes: false, title: "takeoverTitle", will: "takeoverWill", wont: t("takeoverWont", { file: projectRow.filePath, yml: projectRow.managedPath })
});
assert.deepEqual(shownPaths, []); // Project paths are never shortened.
const userRow = { ...projectRow, layer: "user", filePath: "/home/u/mcp.json", managedPath: "/home/u/mcp.yml" };
assert.deepEqual(confirmationDisplay({ kind: "server", action: "disable", row: userRow }, showUserPath, t), {
  removes: false, title: "takeoverTitle", will: "takeoverWill", wont: t("takeoverWont", { file: "~/home/u/mcp.json", yml: "~/home/u/mcp.yml" })
});
assert.deepEqual(shownPaths, [userRow.filePath, userRow.managedPath]);
assert.deepEqual(confirmationDisplay({ kind: "server", action: "remove", row: { ...projectRow, needsYmlTakeover: false } }, showUserPath, t), {
  removes: true, title: t("removeTitle", { name: "demo" }), will: t("removeWill", { name: "demo" }), wont: "removeWont"
});
assert.deepEqual(confirmationDisplay({ kind: "server", action: "remove", row: projectRow }, showUserPath, t), {
  removes: true, title: "takeoverTitle", will: "takeoverWill", wont: t("takeoverWont", { file: projectRow.filePath, yml: projectRow.managedPath })
}); // Takeover removal still uses the remove button, but not the remove title/copy.
for (const enabled of [true, false]) {
  assert.deepEqual(confirmationDisplay({ kind: "tool", row: userRow, tool: "read", enabled }, showUserPath, t), {
    removes: false, title: "takeoverTitle", will: "takeoverWill", wont: t("takeoverWont", { file: "~/home/u/mcp.json", yml: "~/home/u/mcp.yml" })
  });
}
assert.deepEqual(confirmationDisplay({ kind: "tool", row: { ...projectRow, managedPath: null } }, showUserPath, t), {
  removes: false, title: "takeoverTitle", will: "takeoverWill", wont: t("takeoverWont", { file: projectRow.filePath, yml: "" })
});
assert.deepEqual(confirmationDisplay({ kind: "tool", row: { ...userRow, managedPath: undefined } }, showUserPath, t), {
  removes: false, title: "takeoverTitle", will: "takeoverWill", wont: t("takeoverWont", { file: "~/home/u/mcp.json", yml: "~" })
});
assert.equal(profileEnd("desktop", t), "profileDesktop");
assert.equal(profileEnd("web", t), "profileWeb");
assert.equal(profileEnd("custom", t), t("profileNamed", { name: "custom" }));
assert.equal(badgeTone({ needsYmlTakeover: true, active: true }), "warning");
assert.equal(badgeTone({ needsYmlTakeover: true, active: false }), "warning");
assert.equal(badgeTone({ needsYmlTakeover: false, active: true }), "success");
assert.equal(badgeTone({ needsYmlTakeover: false, active: false }), "neutral");
console.log("panel helper tests passed");
