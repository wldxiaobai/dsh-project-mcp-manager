/** 设置 → 通用 与插件管理页共用的一行：三个入口的显隐开关。弹窗里是草稿，点「完成」一次提交。 */
import { useState } from "react";
import { Button, Checkbox, IconWarningOutlineRegular, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  entriesReadOnly,
  entriesReadOnlyNote,
  entryFlagsFromSnapshot,
  entryOps,
  type EntriesFormSnapshot,
  type EntryFlags,
  type EntryKey,
  type EntryOp,
  type EntrySaveResult
} from "./entries-settings.ts";
import type { McpUiLocaleKey } from "./locales.ts";

export interface McpEntriesRowProps {
  readonly t: (key: McpUiLocaleKey, params?: Record<string, unknown>) => string;
  /** 由槽位 `hooks` 合成的选择器；返回整个快照，保持引用稳定。 */
  readonly useEntries: <S>(selector: (snapshot: EntriesFormSnapshot) => S) => S;
  /**
   * 一次提交多个字段；返回宿主是否接受。`revision` 是打开弹窗时（冲突后是
   * 重新加载后）读到的版本，必须原样交给宿主作写入 fence，不能在接线层换成
   * 提交瞬间的最新版本。
   */
  readonly save: (ops: readonly EntryOp[], revision: number | undefined) => Promise<EntrySaveResult>;
  /** `settings` 保留通用行的分隔线与内边距；`page` 作为插件页里的普通内容块。 */
  readonly variant?: "settings" | "page";
}

export function McpEntriesRow({ t, useEntries, save, variant = "settings" }: McpEntriesRowProps) {
  const snapshot = useEntries((value) => value);
  const flags = entryFlagsFromSnapshot(snapshot);
  const readOnly = entriesReadOnly(snapshot);
  const showReadOnly = entriesReadOnlyNote(snapshot);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<EntryFlags>(flags);
  /** 用户在弹窗里显式改过的字段：提交只写这些，别处对其它字段的更新不会被旧草稿覆盖。 */
  const [touched, setTouched] = useState<readonly EntryKey[]>([]);
  /** 写入 fence：打开弹窗时读到的 revision，冲突后换成宿主重新加载后的值。 */
  const [baseRevision, setBaseRevision] = useState<number | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const start = () => {
    setDraft(flags);
    setTouched([]);
    setBaseRevision(snapshot.revision);
    setConflict(false);
    setFailed(false);
    setOpen(true);
  };

  const update = (patch: Partial<EntryFlags>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setTouched((current) => {
      const keys = current.slice();
      for (const key of Object.keys(patch) as EntryKey[]) {
        if (!keys.includes(key)) keys.push(key);
      }
      return keys;
    });
    setFailed(false);
  };

  const done = async () => {
    // 只提交用户改过的字段，且拿宿主当前值作比较基线：弹窗开着时别处写进来的
    // 值不会被旧草稿回滚。写入仍用打开时的 revision 作 fence——别处已经写过
    // 时宿主会拒绝，而不是让这次写入假装是最新的。
    const ops = entryOps(flags, draft, touched);
    if (ops.length === 0) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      const result = await save(ops, baseRevision);
      if (result.ok) {
        setConflict(false);
        setOpen(false);
        return;
      }
      // 宿主拒绝：多半是别处先写过，表单已重新加载最新配置。保留草稿，把新
      // revision 作为下一次确认的 fence；再点「完成」仍只写用户改过的项。
      setBaseRevision(result.revision);
      setConflict(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={variant === "page" ? "dsh-mcp-entries-row dsh-mcp-entries-row-page" : "dsh-mcp-entries-row"}>
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
        {conflict && !failed && <p className="dsh-mcp-entries-note"><output>{t("entriesConflict")}</output></p>}
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

/** 插件管理页 → dsh-project-mcp-manager 页面里的同一行，去掉通用行的分隔线与内边距。 */
export function McpPluginEntriesRow(props: McpEntriesRowProps) {
  return <McpEntriesRow {...props} variant="page" />;
}
