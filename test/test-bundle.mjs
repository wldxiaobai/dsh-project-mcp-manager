import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const ui = JSON.parse(await readFile(new URL("../packages/ui/package.json", import.meta.url), "utf8"));
const patch = parse(await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8"));

assert.equal(ui.version, root.version, "loader and UI must be released together");
assert.equal(root.dependencies[ui.name], `workspace:${root.version}`, "pack must resolve an exact UI dependency, not an optional dependency or a range");
assert.equal(ui.peerDependencies[root.name], root.version, "UI must consume the matching service contract");
assert.equal(root.optionalDependencies?.[ui.name], undefined, "UI is shipped by default, not optional");
assert.equal(root.dsh.bundle.patch, "./cordis.patch.yml");
assert.ok(root.files.includes("cordis.patch.yml"));
assert.equal(ui.dsh.bundle, undefined, "UI must not insert another independently selected bundle layer");
assert.ok(!ui.files.includes("cordis.patch.yml"));
assert.deepEqual(patch.flatMap((item) => item.insert ?? []).map(({ id, name, disabled }) => ({ id, name, disabled })), [
  { id: "mcp-project", name: root.name, disabled: undefined },
  { id: "mcp-project-ui", name: ui.name, disabled: undefined }
]);
assert.equal(ui.dsh.client.platform, "web");
assert.equal(ui.exports["./client"], "./lib/client.js");
assert.ok(ui.files.includes("lib"));

// Build the loader first: UI consumes its declarations and root-level npm
// lifecycle scripts must not rely on topological order in a cyclic workspace.
assert.equal(root.scripts.build, "npm run build:core && npm --prefix packages/ui run build");
for (const file of ["../lib/index.js", "../lib/index.d.ts", "../packages/ui/lib/index.js", "../packages/ui/lib/index.d.ts", "../packages/ui/lib/client.js"]) {
  assert.ok((await readFile(new URL(file, import.meta.url), "utf8")).length > 0, `${file} must be built before packaging`);
}
const client = await readFile(new URL("../packages/ui/lib/client.js", import.meta.url), "utf8");
assert.ok(client.includes('id: "dsh-project-mcp-ui"'), "browser module identity must stay on the full UI package name");
console.log("PASS  default bundle ships loader and same-version UI components with built artifacts");
