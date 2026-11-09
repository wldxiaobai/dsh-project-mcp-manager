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
import { ENTRIES_ROW_ID, entryRegistrations, MANAGER_BUNDLE, NS, PANEL_ID } from "../packages/ui/src/client/entries-registry.ts";
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
  // R1：弹窗打开时的草稿只写用户显式改过的字段。
  // 窗口 A 打开弹窗（三个都是 true），只取消 sidebar；窗口 B 随后把
  // settingsTab 设为 false，宿主同步把 A 的快照推进到 revision 2。
  const touched = ["sidebar"];
  const draft = { sidebar: false, settingsSection: true, settingsTab: true };
  const reloaded = { sidebar: true, settingsSection: true, settingsTab: false };

  assert.deepEqual(entryOps(reloaded, draft, touched), [{ op: "set", path: ["sidebar"], value: false }],
    "an untouched field never rides the commit, even after another client changed it");
  assert.deepEqual(entryOps(reloaded, { ...reloaded, sidebar: false }, touched), [{ op: "set", path: ["sidebar"], value: false }],
    "after a conflict the same rule reapplies against the reloaded values");
  assert.deepEqual(entryOps(reloaded, draft, []), [],
    "opening and closing without edits writes nothing, so the other client keeps its change");
  assert.deepEqual(entryOps(reloaded, { ...reloaded, settingsTab: true }, ["sidebar"]), [],
    "a touched field already equal to the current value is not rewritten");
  assert.deepEqual(entryOps({ sidebar: true, settingsSection: true, settingsTab: true }, { sidebar: false, settingsSection: true, settingsTab: false }, ["settingsTab", "sidebar"]), [
    { op: "set", path: ["sidebar"], value: false },
    { op: "set", path: ["settingsTab"], value: false }
  ], "touched fields are listed in the canonical entry order");
  assert.deepEqual(entryOps(reloaded, draft), [{ op: "set", path: ["sidebar"], value: false }, { op: "set", path: ["settingsTab"], value: true }],
    "without a touched set the helper still diffs every field (pure form)");
  pass("a stale draft never rewrites fields another client changed");
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
  const save = async () => ({ ok: true });
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
  assert.equal(MANAGER_BUNDLE, "dsh-project-mcp-manager");
  assert.deepEqual([reg.pluginEntries.name, reg.pluginEntries.key, reg.pluginEntries.locale], ["plugins.bundle.config", MANAGER_BUNDLE, NS]);
  const pluginFace = reg.pluginEntries.inject();
  assert.equal(pluginFace.hooks.entries, form, "the plugin page row subscribes to the same form");
  assert.equal(pluginFace.save, save, "the plugin page row writes through the same command");
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
  assert.equal(zh.entriesConflict, "这些设置已在别处更新。再次点「完成」只会提交你改动过的项。");
  assert.equal(en.entriesConflict, "These settings changed elsewhere. Press Done again to write only the fields you changed.");
  assert.equal(en.entriesOpen, "Configure…");
  pass("entry copy exists in both languages");
}

console.log(passed + " passed");
