import assert from "node:assert/strict";
import { addPathForTarget, emptyDraft, partitionRows, validateAddDraft, confirmationCopy } from "../src/client/panel-helpers.ts";

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
console.log("panel helper tests passed");
