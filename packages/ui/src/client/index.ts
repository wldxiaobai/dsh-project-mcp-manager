/** Browser half: the sidebar row plus the settings tab that opens the same panel. */
import type { Context } from "@deepseek-ai/cordis";
import { McpPanel, installPanelStyle } from "./McpPanel.tsx";
import { McpPanelIcon, McpSidebarPage } from "./entries.tsx";
import { en, zh, type McpUiLocaleKey } from "./locales.ts";

export const NS = "settings.projectMcp";
export const inject = ["slots", "locale"];

/** One id addresses the sidebar row and the page it opens. */
export const PANEL_ID = "project-mcp";

export function apply(ctx: Context): void {
  installPanelStyle();
  const locale = (ctx as Context & {
    locale: { register: (ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }) => () => void; bind: (ns: string) => (key: McpUiLocaleKey, params?: Record<string, unknown>) => string };
    slots: { inject: (name: string, effect: () => () => void) => () => void; register: (options: object, component: unknown) => () => void };
  }).locale;
  const slots = (ctx as Context & { slots: { inject: (name: string, effect: () => () => void) => () => void; register: (options: object, component: unknown) => () => void } }).slots;
  ctx.effect(() => locale.register(NS, { zh, en }), "dsh-project-mcp-ui: dictionaries");
  const t = locale.bind(NS);
  // Both entries stay: the settings tab opens the panel in place, the sidebar row
  // opens the same panel as a main page. Both render the one McpPanel instance.
  slots.inject("settings.plugins.tab", () => slots.register({
    name: "settings.plugins.tab",
    id: "projectMcp",
    order: 30,
    label: () => t("tab"),
    locale: NS
  }, McpPanel));
  slots.inject("sidebar.panellist", () => slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: 10,
    label: () => t("panelLabel"),
    locale: NS
  }, McpPanelIcon));
  slots.inject("main", () => slots.register({
    name: "main",
    key: PANEL_ID,
    locale: NS
  }, McpSidebarPage));
}