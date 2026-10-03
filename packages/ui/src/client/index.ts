/** Browser half: one Plugins settings tab. */
import type { Context } from "@deepseek-ai/cordis";
import { McpPanel, installPanelStyle } from "./McpPanel.tsx";
import { en, zh, type McpUiLocaleKey } from "./locales.ts";

export const NS = "settings.projectMcp";
export const inject = ["slots", "locale"];

export function apply(ctx: Context): void {
  installPanelStyle();
  const locale = (ctx as Context & {
    locale: { register: (ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }) => () => void; bind: (ns: string) => (key: McpUiLocaleKey, params?: Record<string, unknown>) => string };
    slots: { inject: (name: string, effect: () => () => void) => () => void; register: (options: object, component: unknown) => () => void };
  }).locale;
  const slots = (ctx as Context & { slots: { inject: (name: string, effect: () => () => void) => () => void; register: (options: object, component: unknown) => () => void } }).slots;
  ctx.effect(() => locale.register(NS, { zh, en }), "dsh-project-mcp-ui: dictionaries");
  const t = locale.bind(NS);
  slots.inject("settings.plugins.tab", () => slots.register({
    name: "settings.plugins.tab",
    id: "projectMcp",
    order: 30,
    label: () => t("tab"),
    locale: NS
  }, McpPanel));
}
