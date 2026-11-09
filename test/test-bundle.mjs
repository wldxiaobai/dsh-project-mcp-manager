import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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

// The plugin manager reads a bundle's detail document by display language:
// `locale/<language>.json` `meta.detail` names the Markdown file, falling back
// to the root README. Chinese gets the Chinese README; other languages fall
// through to `en` and the English README.
assert.ok(root.files.includes("locale"), "localised bundle metadata must be packed");
assert.ok(root.files.includes("docs"), "the Chinese README lives under docs/ and must be packed");
assert.ok(root.files.includes("README.md"));
await Promise.all([["en", "README.md"], ["zh", "docs/README.zh.md"]].map(async ([language, detail]) => {
  const locale = JSON.parse(await readFile(new URL(`../locale/${language}.json`, import.meta.url), "utf8"));
  assert.equal(locale.meta.detail, detail, `locale/${language}.json must name ${detail}`);
  await access(new URL(`../${detail}`, import.meta.url));
}));

// Build the loader first: UI consumes its declarations and root-level npm
// lifecycle scripts must not rely on topological order in a cyclic workspace.
assert.equal(root.scripts.build, "npm run build:core && npm --prefix packages/ui run build");
for (const file of ["../lib/index.js", "../lib/index.d.ts", "../packages/ui/lib/index.js", "../packages/ui/lib/index.d.ts", "../packages/ui/lib/client.js"]) {
  assert.ok((await readFile(new URL(file, import.meta.url), "utf8")).length > 0, `${file} must be built before packaging`);
}
const client = await readFile(new URL("../packages/ui/lib/client.js", import.meta.url), "utf8");
assert.ok(client.includes('id: "dsh-project-mcp-ui"'), "browser module identity must stay on the full UI package name");
for (const slot of ['name: "settings.plugins.tab"', 'name: "sidebar.panellist"', 'name: "main"', 'name: "settings.section"', 'name: "settings.section.icon"', 'name: "settings.general.item"', 'name: "plugins.bundle.config"']) {
  assert.ok(client.includes(slot), `client bundle must keep the ${slot} registration`);
}
assert.ok(client.includes('"project-mcp"'), "the sidebar row and the main page must share one id");
for (const service of ['"slots"', '"locale"', '"layout"', '"configForms"']) {
  assert.ok(client.includes(service), `client bundle must inject ${service}`);
}
assert.ok(client.includes('"mcp-project-ui"'), "the visibility form reads the UI plugin entry id");
assert.ok(client.includes('"dsh-project-mcp-manager"'), "the plugin page row is addressed by the manager bundle name");
assert.ok(ui.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings-plugins"), "the settings tab needs the slot package loaded first");
assert.ok(ui.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-sidebar"), "the sidebar row needs the panel slot package loaded first");
assert.ok(ui.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings"), "the settings entries need the settings slot package loaded first");
assert.ok(ui.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-layout"), "the back button needs the layout service package loaded first");
assert.ok(ui.dependencies["@deepseek-ai/schemastery"] !== undefined, "the host half declares the settings schema dependency");
const host = await readFile(new URL("../packages/ui/lib/index.js", import.meta.url), "utf8");
for (const field of ["sidebar", "settingsSection", "settingsTab"]) {
  assert.ok(host.includes(field), `UI Config must declare the ${field} entry`);
}
console.log("PASS  default bundle ships loader and same-version UI components with built artifacts");
