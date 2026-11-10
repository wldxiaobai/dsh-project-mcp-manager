import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Inspect installed metadata only; never deep-import implementation internals.
async function metadata(resolver, name) {
  let directory = dirname(resolver.resolve(name));
  for (;;) {
    try {
      const value = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (value.name === name) return value;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(directory);
    assert.notEqual(parent, directory, `cannot locate metadata for ${name}`);
    directory = parent;
  }
}

const require = createRequire(import.meta.url);
const manager = require("../package.json");
const official = require("@deepseek-ai/dsh-mcp-client/package.json");
const fromOfficial = createRequire(require.resolve("@deepseek-ai/dsh-mcp-client"));
for (const name of ["@modelcontextprotocol/client", "@deepseek-ai/dsh-subprocess"]) {
  const direct = await metadata(require, name);
  const nested = await metadata(fromOfficial, name);
  const expected = official.dependencies?.[name] ?? official.peerDependencies?.[name];
  assert.equal(manager.dependencies[name], direct.version, `${name} is an explicit exact runtime dependency`);
  assert.equal(expected, direct.version, `${name} must match the official client's declared contract; review upgrades together`);
  assert.equal(nested.version, direct.version, `${name} must not drift between Eager and Lazy`);
}
console.log("ALL LAZY DEPENDENCY CONTRACT TESTS PASSED");
