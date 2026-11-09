/** Entry shells: the sidebar row glyph, the page it opens, and the settings section. */
import { Button, IconChevronLeftOutlineMedium, IconDatabaseOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import { McpPanel } from "./McpPanel.tsx";
import type { McpUiLocaleKey } from "./locales.ts";

export interface McpEntryProps {
  readonly t: (key: McpUiLocaleKey, params?: Record<string, unknown>) => string;
}

/** The sidebar page also receives the navigation command; the settings entries do not. */
export interface McpSidebarPageProps extends McpEntryProps {
  /** Select the conversation surface without changing the current session. */
  readonly onBack?: () => void;
}

/** The sidebar row's glyph; the shell asks for the square edge and reads the active state itself. */
export function McpPanelIcon({ size }: { size?: number }) {
  return <IconDatabaseOutlineRegular size={size ?? 16} />;
}

/** The sidebar page: page chrome around the shared panel, with no logic of its own. */
export function McpSidebarPage({ t, onBack }: McpSidebarPageProps) {
  return (
    <div className="dsh-mcp-page">
      <div className="dsh-mcp-page-inner">
        <div className="dsh-mcp-page-head">
          <h1 className="dsh-mcp-page-title">{t("panelLabel")}</h1>
          {onBack !== undefined && (
            <Button variant="outline" size="md" type="button" icon={<IconChevronLeftOutlineMedium size={16} />} onClick={onBack}>
              {t("backToWorkspace")}
            </Button>
          )}
        </div>
        <McpPanel t={t} />
      </div>
    </div>
  );
}

/** The settings sidebar entry: the settings shell already owns the title, close, and padding. */
export function McpSettingsSection({ t }: McpEntryProps) {
  return <McpPanel t={t} />;
}