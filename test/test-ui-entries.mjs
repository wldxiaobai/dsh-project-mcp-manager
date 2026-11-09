import assert from "node:assert/strict";
import {
  DEFAULT_ENTRY_FLAGS,
  ENTRY_CONFIG_ID,
  entriesReadOnly,
  entriesReadOnlyNote,
  entryFlagsFrom,
  entryFlagsFromSnapshot,
  entryOps
} from "../packages/ui/src/client/entries-settings.ts";
import { backToWorkspace, createEntriesController, leavePanelIfOpen } from "../packages/ui/src/client/entries-controller.ts";
import { ENTRIES_ROW_ID, entryRegistrations, NS, PANEL_ID } from "../packages/ui/src/client/entries-registry.ts";
import { en, zh } from "../packages/ui/src/client/locales.ts";

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}

function snapshot(overrides) {
  return { status: "ready", value: undefined, writable: true, ...overrides };
}

{
  assert.equal(ENTRY_CONFIG_ID, "mcp-project-ui", "the form reads the UI plugin entry");
  assert.deepEqual(entryFlagsFrom({}), DEFAULT_ENTRY_FLAGS);
  assert.deepEqual(entryFlagsFrom(undefined), DEFAULT_ENTRY_FLAGS);
  assert.deepEqual(entryFlagsFrom({ sidebar: false }), { sidebar: false, settingsSection: true, settingsTab: true });
  assert.deepEqual(entryFlagsFrom({ sidebar: "no", settingsSection: 0, settingsTab: null }), DEFAULT_ENTRY_FLAGS);
  assert.deepEqual(entryFlagsFrom({ sidebar: false, settingsSection: false, settingsTab: false }), { sidebar: false, settingsSection: false, settingsTab: false });
  pass("entry flags default to visible and ignore non-boolean values");
}

{
  assert.deepEqual(entryFlagsFromSnapshot(null), DEFAULT_ENTRY_FLAGS);
  assert.deepEqual(entryFlagsFromSnapshot(snapshot({ status: "loading" })), DEFAULT_ENTRY_FLAGS);
  assert.deepEqual(entryFlagsFromSnapshot(snapshot({ status: "unavailable" })), DEFAULT_ENTRY_FLAGS);
  assert.deepEqual(entryFlagsFromSnapshot(snapshot({ value: { sidebar: false } })), { sidebar: false, settingsSection: true, settingsTab: true });
  pass("only a ready snapshot contributes a value");
}

{
  assert.equal(entriesReadOnly(null), true);
  assert.equal(entriesReadOnly(snapshot({ status: "loading" })), true);
  assert.equal(entriesReadOnly(snapshot({ writable: false })), true);
  assert.equal(entriesReadOnly(snapshot({})), false);
  assert.equal(entriesReadOnlyNote(snapshot({ status: "loading", writable: false })), false);
  assert.equal(entriesReadOnlyNote(snapshot({ writable: false })), true);
  assert.equal(entriesReadOnlyNote(snapshot({})), false);
  pass("read-only state disables the checkboxes and has its own note condition");
}

{
  const current = { sidebar: true, settingsSection: true, settingsTab: true };
  assert.deepEqual(entryOps(current, current), []);
  assert.deepEqual(entryOps(current, { ...current, settingsTab: false }), [{ op: "set", path: ["settingsTab"], value: false }]);
  assert.deepEqual(
    entryOps(current, { sidebar: false, settingsSection: true, settingsTab: false }),
    [{ op: "set", path: ["sidebar"], value: false }, { op: "set", path: ["settingsTab"], value: false }]
  );
  pass("only changed fields ride one commit");
}

{
  const calls = [];
  const detach = { sidebar: [], settingsSection: [], settingsTab: [] };
  const attachments = Object.fromEntries(["sidebar", "settingsSection", "settingsTab"].map((key) => [key, {
    attach() {
      calls.push("attach:" + key);
      return () => calls.push("detach:" + key);
    },
    onDetach() {
      calls.push("leave:" + key);
    }
  }]));
  const controller = createEntriesController({ attachments });
  controller.apply(DEFAULT_ENTRY_FLAGS);
  assert.deepEqual(calls, ["attach:sidebar", "attach:settingsSection", "attach:settingsTab"]);
  controller.apply(DEFAULT_ENTRY_FLAGS);
  assert.equal(calls.length, 3, "re-applying the same flags must not register twice");

  calls.length = 0;
  controller.apply({ sidebar: false, settingsSection: true, settingsTab: false });
  assert.deepEqual(calls, ["leave:sidebar", "detach:sidebar", "leave:settingsTab", "detach:settingsTab"]);
  calls.length = 0;
  controller.apply({ sidebar: false, settingsSection: true, settingsTab: false });
  assert.deepEqual(calls, [], "disabled entries are not released twice");

  controller.apply({ sidebar: true, settingsSection: false, settingsTab: true });
  assert.deepEqual(calls, ["attach:sidebar", "leave:settingsSection", "detach:settingsSection", "attach:settingsTab"]);
  calls.length = 0;
  controller.dispose();
  assert.deepEqual(calls, ["detach:sidebar", "detach:settingsTab"]);
  calls.length = 0;
  controller.dispose();
  assert.deepEqual(calls, [], "dispose is idempotent");
  pass("controller adds and removes registrations exactly once, leaving the panel first");
}

{
  const calls = [];
  const navigator = {
    panelInfo: { getSnapshot: () => ({ activePanelId: "project-mcp" }) },
    selectPanel(id) {
      calls.push(id);
    }
  };
  backToWorkspace(navigator);
  assert.deepEqual(calls, [null], "the back button selects the conversation");
  assert.equal(leavePanelIfOpen(navigator, "project-mcp"), true);
  assert.deepEqual(calls, [null, null]);
  assert.equal(leavePanelIfOpen(navigator, "other-panel"), false);
  assert.deepEqual(calls, [null, null]);
  const elsewhere = {
    panelInfo: { getSnapshot: () => ({ activePanelId: "conversation" }) },
    selectPanel() {
      throw new Error("must not switch panels");
    }
  };
  assert.equal(leavePanelIfOpen(elsewhere, "project-mcp"), false);
  pass("back and disable only leave the main panel when it is ours");
}

{
  const calls = [];
  const layout = {
    panelInfo: { getSnapshot: () => ({ activePanelId: null }) },
    selectPanel(id) {
      calls.push(id);
    }
  };
  const form = {
    getSnapshot: () => snapshot({ value: {} }),
    subscribe: () => () => {}
  };
  const save = async () => true;
  const t = (key) => "t:" + key;
  const reg = entryRegistrations(t, { layout, entries: form, save });
  assert.equal(PANEL_ID, "project-mcp");
  assert.equal(NS, "settings.projectMcp");
  assert.equal(ENTRIES_ROW_ID, "mcp-entries");
  assert.deepEqual(
    [reg.sidebarRow.name, reg.sidebarRow.id, reg.sidebarRow.order, reg.sidebarRow.locale],
    ["sidebar.panellist", PANEL_ID, 10, NS]
  );
  assert.equal(reg.sidebarRow.label(), "t:panelLabel");
  assert.deepEqual([reg.sidebarPage.name, reg.sidebarPage.key, reg.sidebarPage.locale], ["main", PANEL_ID, NS]);
  reg.sidebarPage.inject().onBack();
  assert.deepEqual(calls, [null], "the page's inject face wires the return command");
  assert.deepEqual(
    [reg.settingsSection.name, reg.settingsSection.id, reg.settingsSection.order],
    ["settings.section", PANEL_ID, 20]
  );
  assert.equal(reg.settingsSection.label(), "t:panelLabel");
  assert.deepEqual([reg.settingsSectionIcon.name, reg.settingsSectionIcon.id], ["settings.section.icon", PANEL_ID]);
  assert.deepEqual([reg.settingsTab.name, reg.settingsTab.id, reg.settingsTab.order], ["settings.plugins.tab", "projectMcp", 30]);
  assert.equal(reg.settingsTab.label(), "t:tab");
  assert.deepEqual([reg.generalRow.name, reg.generalRow.id, reg.generalRow.order], ["settings.general.item", ENTRIES_ROW_ID, 12]);
  const face = reg.generalRow.inject();
  assert.equal(face.hooks.entries, form, "the row subscribes to the entry config form");
  assert.equal(face.save, save, "the row writes through the one submit command");
  pass("registrations carry the documented slots, keys, orders and inject faces");
}

{
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  assert.equal(zh.backToWorkspace, "回到当前工作区");
  assert.equal(zh.entriesTitle, "MCP 管理页入口");
  assert.equal(zh.entriesHint, "选择在哪些位置显示 MCP 管理页。");
  assert.equal(zh.entriesOpen, "设置…");
  assert.equal(zh.entriesDialogTitle, "MCP 管理页入口设置");
  assert.equal(zh.entriesSidebar, "主页左侧栏");
  assert.equal(zh.entriesSettingsSection, "设置页左侧栏");
  assert.equal(zh.entriesSettingsTab, "设置页「内置插件」标签页");
  assert.equal(zh.entriesDone, "完成");
  assert.equal(zh.entriesReadOnly, "当前页面没有修改权限。");
  assert.equal(zh.entriesWriteFailed, "保存失败，请重试。");
  assert.equal(en.entriesOpen, "Configure…");
  pass("entry copy exists in both languages");
}

console.log(passed + " passed");
