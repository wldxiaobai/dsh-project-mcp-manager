/** Entry shells: the same panel behind the sidebar page and the temporary settings tab. */
import { IconDatabaseOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import { McpPanel } from "./McpPanel.tsx";
import type { McpUiLocaleKey } from "./locales.ts";

export interface McpEntryProps {
  t: (key: McpUiLocaleKey, params?: Record<string, unknown>) => string;
}

/** The sidebar row's glyph; the shell asks for the square edge and reads the active state itself. */
export function McpPanelIcon({ size }: { size?: number }) {
  return <IconDatabaseOutlineRegular size={size ?? 16} />;
}

/** The sidebar page: page chrome around the shared panel, with no logic of its own. */
export function McpSidebarPage({ t }: McpEntryProps) {
  return (
    <div className="dsh-mcp-page">
      <div className="dsh-mcp-page-inner">
        <h1 className="dsh-mcp-page-title">{t("panelLabel")}</h1>
        <p className="dsh-mcp-notice">{t("entryNoticeNew")}</p>
        <McpPanel t={t} />
      </div>
    </div>
  );
}

/** The settings tab kept for one release after the sidebar entry lands. */
export function McpSettingsTab({ t }: McpEntryProps) {
  return (
    <div className="dsh-mcp-entry">
      <p className="dsh-mcp-notice">{t("entryNoticeOld")}</p>
      <McpPanel t={t} />
    </div>
  );
}
