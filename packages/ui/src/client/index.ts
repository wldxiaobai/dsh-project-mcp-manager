/**
 * Browser half: three places that open the same MCP panel, plus one row in
 * Settings → General that decides which of the three are shown.
 *
 * The visibility values live in the Host settings document for the
 * `mcp-project-ui` entry (`Config` in the host half); the browser reads and
 * writes them through `ctx.configForms`. Every entry is registered through a
 * disposable registration so switching a checkbox can add or remove one
 * without reloading the page.
 */
import type { Context } from "@deepseek-ai/cordis";
import { McpPanel, installPanelStyle } from "./McpPanel.tsx";
import { McpEntriesRow } from "./entries-row.tsx";
import { McpPanelIcon, McpSettingsSection, McpSidebarPage } from "./entries.tsx";
import { createEntriesController, leavePanelIfOpen, type PanelNavigator } from "./entries-controller.ts";
import { entryRegistrations, NS, PANEL_ID, type EntriesObservable } from "./entries-registry.ts";
import { ENTRY_CONFIG_ID, entryFlagsFromSnapshot, type EntriesFormSnapshot, type EntryOp } from "./entries-settings.ts";
import { en, zh, type McpUiLocaleKey } from "./locales.ts";

export { NS, PANEL_ID };
/** The three services the entries are built from; all ship with DSH Web. */
export const inject = ["slots", "locale", "layout", "configForms"];

interface LocaleBound {
  register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void;
  bind(namespace: string): (key: McpUiLocaleKey, params?: Record<string, unknown>) => string;
}

interface SlotService {
  inject(name: string, effect: () => () => void): () => void;
  register(options: object, component: unknown): () => void;
}

interface EntriesForm extends EntriesObservable {
  mutate(ops: readonly EntryOp[], revision?: number): Promise<boolean>;
}

interface ConfigFormsService {
  get(entryId: string): EntriesForm;
}

export function apply(ctx: Context): void {
  installPanelStyle();
  const services = ctx as Context & {
    locale: LocaleBound;
    slots: SlotService;
    layout: PanelNavigator;
    configForms: ConfigFormsService;
  };
  const { locale, slots, layout, configForms } = services;
  ctx.effect(() => locale.register(NS, { zh, en }), "dsh-project-mcp-ui: dictionaries");
  const t = locale.bind(NS);

  const form = configForms.get(ENTRY_CONFIG_ID);
  const entriesObservable: EntriesObservable = {
    getSnapshot: () => form.getSnapshot(),
    subscribe: (listener) => form.subscribe(listener)
  };
  const saveEntries = (ops: readonly EntryOp[]): Promise<boolean> => {
    const snapshot: EntriesFormSnapshot = form.getSnapshot();
    return form.mutate(ops, snapshot.revision);
  };
  const registrations = entryRegistrations(t, { layout, entries: entriesObservable, save: saveEntries });

  const controller = createEntriesController({
    attachments: {
      sidebar: {
        // The row and the page are one entry: closing the row must not leave
        // `main` pointing at an unregistered key.
        attach: () => {
          const row = slots.inject("sidebar.panellist", () => slots.register(registrations.sidebarRow, McpPanelIcon));
          const page = slots.inject("main", () => slots.register(registrations.sidebarPage, McpSidebarPage));
          return () => {
            row();
            page();
          };
        },
        onDetach: () => {
          leavePanelIfOpen(layout, PANEL_ID);
        }
      },
      settingsSection: {
        // The nav row and its glyph are addressed by the same id; both go together.
        attach: () => {
          const section = slots.inject("settings.section", () => slots.register(registrations.settingsSection, McpSettingsSection));
          const icon = slots.inject("settings.section.icon", () => slots.register(registrations.settingsSectionIcon, McpPanelIcon));
          return () => {
            section();
            icon();
          };
        }
      },
      settingsTab: {
        // No shell around the panel, so no back button: the settings panel's own
        // close button is the way out.
        attach: () => slots.inject("settings.plugins.tab", () => slots.register(registrations.settingsTab, McpPanel))
      }
    }
  });

  controller.apply(entryFlagsFromSnapshot(form.getSnapshot()));
  ctx.effect(
    () => form.subscribe(() => controller.apply(entryFlagsFromSnapshot(form.getSnapshot()))),
    "dsh-project-mcp-ui: entry visibility"
  );
  ctx.effect(() => () => controller.dispose(), "dsh-project-mcp-ui: entry registrations");

  // The General row always exists, whatever the three checkboxes say: it is the
  // only way to bring a hidden entry back from inside the page.
  slots.inject("settings.general.item", () => slots.register(registrations.generalRow, McpEntriesRow));
}
