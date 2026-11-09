/**
 * End-to-end wiring of the built browser bundle: load `packages/ui/lib/client.js`
 * with a fake module loader, then drive `apply()` against fake cordis services.
 *
 * This covers what the pure-model tests cannot: which registrations the plugin
 * adds, how a config snapshot change adds/removes them, and the inject faces of
 * the main page and the Settings → General row.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

// Keep deterministic UTF-16 code-unit order, independent of the host locale.
function byCodeUnit(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}

const requireFromUi = createRequire(new URL("../packages/ui/package.json", import.meta.url));
const react = requireFromUi("react");
const jsxRuntime = requireFromUi("react/jsx-runtime");
const source = await readFile(new URL("../packages/ui/lib/client.js", import.meta.url), "utf8");
let definition;
// The browser loader shim: evaluate the bundle with a `window` that captures
// the module definition, then call its factory like the real loader does.
// Only execute our fixed local build artifact, never request data or an arbitrary path.
// This intentionally tests the browser module wrapper; node:vm is not a security boundary.
new Function("window", source)({
  __ModuleLoader__: {
    load(candidate) {
      definition = candidate;
    }
  }
});
assert.equal(definition?.id, "dsh-project-mcp-ui", "the bundle declares its module identity");

const stub = () => null;
// Components are never rendered here; named imports only need to resolve.
const primitives = new Proxy({}, { get: () => stub });
const client = definition.factory((id) => {
  if (id === "react") return react;
  if (id === "react/jsx-runtime") return jsxRuntime;
  if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
  throw new Error("unexpected external module: " + id);
});
assert.deepEqual(client.inject, ["slots", "locale", "layout", "configForms"]);

function harness(initialValue = {}) {
  const entries = new Map();
  const listeners = new Set();
  const mutations = [];
  const calls = [];
  const unsubscribers = [];
  let snapshot = { status: "ready", value: initialValue, writable: true, revision: 1 };
  let activePanelId = null;
  let mutateResult = true;

  const form = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async mutate(ops, revision) {
      mutations.push({ ops, revision });
      return mutateResult;
    }
  };

  const slots = {
    inject(_name, effect) {
      const dispose = effect();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        calls.push("inject-dispose");
        dispose();
      };
    },
    register(options, component) {
      const key = options.name + ":" + String(options.id ?? options.key ?? "");
      entries.set(key, { options, component });
      let done = false;
      return () => {
        if (done) return;
        done = true;
        entries.delete(key);
        calls.push("release:" + key);
      };
    }
  };

  const layout = {
    panelInfo: { getSnapshot: () => ({ activePanelId }) },
    selectPanel(id) {
      calls.push("selectPanel:" + String(id));
      activePanelId = id;
    }
  };

  const ctx = {
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") unsubscribers.push(disposer);
      return disposer;
    },
    slots,
    locale: {
      register: () => () => {},
      bind: () => (key) => "t:" + key
    },
    layout,
    configForms: { get: () => form }
  };

  return {
    ctx,
    entries,
    mutations,
    calls,
    layout,
    setValue(value) {
      snapshot = { ...snapshot, value, revision: snapshot.revision + 1 };
      for (const listener of listeners) listener();
    },
    setSnapshot(next) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    setMutateResult(next) {
      mutateResult = next;
    },
    setActivePanel(id) {
      activePanelId = id;
    },
    unsubscribers
  };
}

const keys = (entries) => [...entries.keys()].sort(byCodeUnit);
const ALL_KEYS = [
  "main:project-mcp",
  "plugins.bundle.config:dsh-project-mcp-manager",
  "settings.general.item:mcp-entries",
  "settings.plugins.tab:projectMcp",
  "settings.section.icon:project-mcp",
  "settings.section:project-mcp",
  "sidebar.panellist:project-mcp"
];

{
  const h = harness();
  client.apply(h.ctx);
  assert.deepEqual(keys(h.entries), ALL_KEYS, "all entries default to visible, plus the General row");
  assert.deepEqual(h.entries.get("settings.plugins.tab:projectMcp").options.label(), "t:tab");
  assert.deepEqual(h.entries.get("main:project-mcp").options.key, "project-mcp");
  pass("apply registers three entries and both config rows by default");
}

{
  const h = harness();
  client.apply(h.ctx);

  const page = h.entries.get("main:project-mcp").options.inject();
  page.onBack();
  assert.deepEqual(h.calls, ["selectPanel:null"], "the page's back command returns to the conversation");

  const row = h.entries.get("settings.general.item:mcp-entries").options.inject();
  assert.equal(typeof row.hooks.entries.getSnapshot, "function");
  assert.equal(typeof row.save, "function");
  const pluginRow = h.entries.get("plugins.bundle.config:dsh-project-mcp-manager").options.inject();
  assert.equal(pluginRow.hooks.entries, row.hooks.entries, "both rows share the one config form");
  assert.equal(pluginRow.save, row.save, "both rows share the one write path");

  const accepted = await row.save([{ op: "set", path: ["sidebar"], value: false }], 1);
  assert.deepEqual(accepted, { ok: true, revision: 1 }, "an accepted write reports the snapshot revision");
  assert.deepEqual(h.mutations[0].ops, [{ op: "set", path: ["sidebar"], value: false }]);
  assert.equal(h.mutations[0].revision, 1, "the editor's baseline revision is the write fence");

  // 另一个客户端写入后快照前进到 revision 2：fence 仍是编辑器打开时读到的 1。
  h.setValue({ sidebar: false });
  const second = await row.save([{ op: "set", path: ["settingsSection"], value: false }], 1);
  assert.equal(h.mutations[1].revision, 1, "a newer snapshot must not replace the editor's revision");
  assert.equal(second.revision, 2, "the result carries the reloaded revision for a retry");

  h.setMutateResult(false);
  const refused = await row.save([{ op: "set", path: ["sidebar"], value: true }], 2);
  assert.deepEqual(refused, { ok: false, revision: 2 }, "a refused write reports the revision to retry with");
  pass("the page and both config rows expose their inject faces");
}

{
  const h = harness();
  client.apply(h.ctx);

  h.setValue({ sidebar: false });
  assert.deepEqual(keys(h.entries), ALL_KEYS.filter((key) => !key.startsWith("main:") && !key.startsWith("sidebar.")));
  assert.equal(h.calls.includes("selectPanel:null"), false, "closing while another panel is selected must not navigate");

  h.setActivePanel("project-mcp");
  h.setValue({ sidebar: true });
  assert.ok(h.entries.has("main:project-mcp") && h.entries.has("sidebar.panellist:project-mcp"));
  h.setActivePanel("project-mcp");
  const before = h.calls.length;
  h.setValue({ sidebar: false, settingsSection: true, settingsTab: true });
  const added = h.calls.slice(before);
  assert.equal(added[0], "selectPanel:null", "the page is left before its registration is released");
  const navigationIndex = added.indexOf("selectPanel:null");
  for (const release of ["release:main:project-mcp", "release:sidebar.panellist:project-mcp"]) {
    const releaseIndex = added.indexOf(release);
    assert.notEqual(releaseIndex, -1, `${release} must occur`);
    assert.ok(releaseIndex > navigationIndex, `${release} must follow navigation`);
  }
  pass("closing the main entry leaves the panel first, then releases the row and page");
}

{
  const h = harness();
  client.apply(h.ctx);
  h.setValue({ sidebar: false, settingsSection: false, settingsTab: false });
  assert.deepEqual(keys(h.entries), ["plugins.bundle.config:dsh-project-mcp-manager", "settings.general.item:mcp-entries"], "both config rows always survive");
  h.setValue({ sidebar: true, settingsSection: true, settingsTab: true });
  assert.deepEqual(keys(h.entries), ALL_KEYS, "entries come back without a reload");
  pass("all three entries can be closed and restored");
}

{
  const h = harness();
  client.apply(h.ctx);
  h.setValue({ settingsSection: false });
  assert.equal(h.entries.has("settings.section:project-mcp"), false);
  assert.equal(h.entries.has("settings.section.icon:project-mcp"), false);
  assert.equal(h.entries.has("settings.plugins.tab:projectMcp"), true);
  h.setValue({ settingsSection: true });
  assert.ok(h.entries.has("settings.section:project-mcp") && h.entries.has("settings.section.icon:project-mcp"));
  pass("the settings section and its glyph are added and removed together");
}

{
  const h = harness({ sidebar: false });
  client.apply(h.ctx);
  assert.equal(h.entries.has("main:project-mcp"), false, "the first snapshot already hides the sidebar entry");
  h.setSnapshot({ status: "loading", value: undefined, writable: false, revision: 2 });
  assert.deepEqual(keys(h.entries), ALL_KEYS, "a non-ready snapshot falls back to all-visible defaults");
  pass("the initial snapshot and a loading fallback drive the registrations");
}

{
  const h = harness();
  client.apply(h.ctx);
  for (const dispose of h.unsubscribers) dispose();
  assert.deepEqual(keys(h.entries), ["plugins.bundle.config:dsh-project-mcp-manager", "settings.general.item:mcp-entries"], "controller-owned entries are released on teardown");
  pass("teardown releases every managed entry once");
}

console.log(passed + " passed");
