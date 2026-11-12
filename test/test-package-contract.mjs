import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
const builtFiles = ["../lib/index.js", "../lib/index.d.ts", "../packages/ui/lib/index.js", "../packages/ui/lib/index.d.ts", "../packages/ui/lib/client.js"];
const builtSources = await Promise.all(builtFiles.map((file) => readFile(new URL(file, import.meta.url), "utf8")));
for (const [index, source] of builtSources.entries()) {
  assert.ok(source.length > 0, `${builtFiles[index]} must be built before packaging`);
}
// Slot registrations are exercised behaviourally by test-ui-client-wiring.mjs
// against the built browser module; only package metadata belongs here.
assert.ok(ui.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings-plugins"), "the settings tab needs the slot package loaded first");
assert.ok(ui.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-sidebar"), "the sidebar row needs the panel slot package loaded first");
assert.ok(ui.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings"), "the settings entries need the settings slot package loaded first");
assert.ok(ui.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-layout"), "the back button needs the layout service package loaded first");
assert.ok(ui.dependencies["@deepseek-ai/schemastery"] !== undefined, "the host half declares the settings schema dependency");
const host = await readFile(new URL("../packages/ui/lib/index.js", import.meta.url), "utf8");
for (const field of ["sidebar", "settingsSection", "settingsTab"]) {
  assert.ok(host.includes(field), `UI Config must declare the ${field} entry`);
}

// Lazy imports the official client's HTTP and subprocess packages directly;
// their installed versions must stay exact and aligned with the official
// client's declared contract, and Eager/Lazy must never resolve different copies.
async function installedMetadata(resolver, name) {
  let directory = dirname(resolver.resolve(name));
  for (;;) {
    try {
      const value = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (value.name === name) return value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    assert.notEqual(parent, directory, `cannot locate metadata for ${name}`);
    directory = parent;
  }
}

const require = createRequire(import.meta.url);
const official = require("@deepseek-ai/dsh-mcp-client/package.json");
const fromOfficial = createRequire(require.resolve("@deepseek-ai/dsh-mcp-client"));
const lazyDependencies = ["@modelcontextprotocol/client", "@deepseek-ai/dsh-subprocess"];
const lazyMetadata = await Promise.all(lazyDependencies.map(async (name) => {
  const [direct, nested] = await Promise.all([installedMetadata(require, name), installedMetadata(fromOfficial, name)]);
  return { name, direct, nested };
}));
for (const { name, direct, nested } of lazyMetadata) {
  const declared = official.dependencies?.[name] ?? official.peerDependencies?.[name];
  assert.equal(root.dependencies[name], direct.version, `${name} is an explicit exact runtime dependency`);
  assert.equal(declared, direct.version, `${name} must match the official client's declared contract; review upgrades together`);
  assert.equal(nested.version, direct.version, `${name} must not drift between Eager and Lazy`);
  console.log(`PASS  ${name} stays exact at ${direct.version} for Eager and Lazy`);
}
console.log("PASS  default bundle ships loader and same-version UI components with built artifacts");
