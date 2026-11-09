/**
 * 三个入口与「设置 → 通用」那一行的注册描述。组件由调用方提供，这里只出
 * 槽位、键、顺序与注入面，方便用假组件在 Node 里验证接线。
 */
import { backToWorkspace, type PanelNavigator } from "./entries-controller.ts";
import type { EntriesFormSnapshot, EntryOp } from "./entries-settings.ts";
import type { McpUiLocaleKey } from "./locales.ts";

/** 页面与设置分区共用的 id；主页侧栏行和它打开的 `main` 页面也共用。 */
export const PANEL_ID = "project-mcp";
/** 设置 → 通用 那一行的 id；它不属于三个入口，始终存在。 */
export const ENTRIES_ROW_ID = "mcp-entries";
/** 语言字典命名空间。 */
export const NS = "settings.projectMcp";

export type Translate = (key: McpUiLocaleKey, params?: Record<string, unknown>) => string;

/** 配置表单的最小可观察面（`ConfigForm` 的读写入口）。 */
export interface EntriesObservable {
  getSnapshot(): EntriesFormSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface EntriesRegistryDeps {
  readonly layout: PanelNavigator;
  readonly entries: EntriesObservable;
  readonly save: (ops: readonly EntryOp[]) => Promise<boolean>;
}

export interface EntryRegistrations {
  /** 主页左侧栏图标行。 */
  readonly sidebarRow: object;
  /** 主页页面；带返回按钮的注入面。 */
  readonly sidebarPage: object;
  /** 设置页左侧栏分区。 */
  readonly settingsSection: object;
  /** 设置页左侧栏图标，id 与分区相同。 */
  readonly settingsSectionIcon: object;
  /** 设置 → 插件 里的旧标签页。 */
  readonly settingsTab: object;
  /** 设置 → 通用 里的入口开关行。 */
  readonly generalRow: object;
}

export function entryRegistrations(t: Translate, deps: EntriesRegistryDeps): EntryRegistrations {
  return {
    sidebarRow: {
      name: "sidebar.panellist",
      id: PANEL_ID,
      order: 10,
      label: () => t("panelLabel"),
      locale: NS
    },
    sidebarPage: {
      name: "main",
      key: PANEL_ID,
      locale: NS,
      // 返回按钮只是一条导航命令，不拦截 Esc、不锁焦点。
      inject: () => ({ onBack: () => backToWorkspace(deps.layout) })
    },
    settingsSection: {
      name: "settings.section",
      id: PANEL_ID,
      order: 20,
      label: () => t("panelLabel"),
      locale: NS
    },
    settingsSectionIcon: {
      name: "settings.section.icon",
      id: PANEL_ID,
      locale: NS
    },
    settingsTab: {
      name: "settings.plugins.tab",
      id: "projectMcp",
      order: 30,
      label: () => t("tab"),
      locale: NS
    },
    generalRow: {
      name: "settings.general.item",
      id: ENTRIES_ROW_ID,
      order: 12,
      locale: NS,
      inject: () => ({ hooks: { entries: deps.entries }, save: deps.save })
    }
  };
}
