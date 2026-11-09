/** 设置 → 通用 里的一行：三个入口的显隐开关。弹窗里是草稿，点「完成」一次提交。 */
import { useState } from "react";
import { Button, Checkbox, IconWarningOutlineRegular, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  entriesReadOnly,
  entriesReadOnlyNote,
  entryFlagsFromSnapshot,
  entryOps,
  type EntriesFormSnapshot,
  type EntryFlags,
  type EntryOp
} from "./entries-settings.ts";
import type { McpUiLocaleKey } from "./locales.ts";

export interface McpEntriesRowProps {
  t: (key: McpUiLocaleKey, params?: Record<string, unknown>) => string;
  /** 由槽位 `hooks` 合成的选择器；返回整个快照，保持引用稳定。 */
  useEntries: <S>(selector: (snapshot: EntriesFormSnapshot) => S) => S;
  /** 一次提交多个字段；返回宿主是否接受。 */
  save: (ops: readonly EntryOp[]) => Promise<boolean>;
}

export function McpEntriesRow({ t, useEntries, save }: McpEntriesRowProps) {
  const snapshot = useEntries((value) => value);
  const flags = entryFlagsFromSnapshot(snapshot);
  const readOnly = entriesReadOnly(snapshot);
  const showReadOnly = entriesReadOnlyNote(snapshot);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<EntryFlags>(flags);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const start = () => {
    setDraft(flags);
    setFailed(false);
    setOpen(true);
  };

  const update = (patch: Partial<EntryFlags>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setFailed(false);
  };

  const done = async () => {
    const ops = entryOps(flags, draft);
    if (ops.length === 0) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      if (await save(ops)) setOpen(false);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dsh-mcp-entries-row">
      <div className="dsh-mcp-entries-copy">
        <div className="dsh-mcp-entries-title">{t("entriesTitle")}</div>
        <div className="dsh-mcp-entries-description">{t("entriesHint")}</div>
      </div>
      <Button variant="outline" size="sm" type="button" onClick={start}>{t("entriesOpen")}</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("entriesDialogTitle")}
        closeLabel={t("cancel")}
        className="dsh-mcp-entries-dialog"
        footer={(
          <>
            <Button variant="ghost" size="sm" type="button" onClick={() => setOpen(false)}>{t("cancel")}</Button>
            <Button variant="primary" size="sm" type="button" disabled={busy || readOnly} onClick={() => void done()}>{t("entriesDone")}</Button>
          </>
        )}
      >
        <div className="dsh-mcp-entries-options">
          <Checkbox checked={draft.sidebar} disabled={busy || readOnly} label={t("entriesSidebar")} onChange={(next) => update({ sidebar: next })} />
          <Checkbox checked={draft.settingsSection} disabled={busy || readOnly} label={t("entriesSettingsSection")} onChange={(next) => update({ settingsSection: next })} />
          <Checkbox checked={draft.settingsTab} disabled={busy || readOnly} label={t("entriesSettingsTab")} onChange={(next) => update({ settingsTab: next })} />
        </div>
        {showReadOnly && <p className="dsh-mcp-entries-note">{t("entriesReadOnly")}</p>}
        {failed && (
          <p className="dsh-mcp-banner dsh-mcp-entries-error" role="alert">
            <IconWarningOutlineRegular size={16} />
            <span>{t("entriesWriteFailed")}</span>
          </p>
        )}
      </Modal>
    </div>
  );
}
