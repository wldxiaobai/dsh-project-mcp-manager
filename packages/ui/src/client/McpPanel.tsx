/** MCP settings tab: layers, activation, delete, and per-tool switches. */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button, IconChevronDownOutlineRegular, IconFolderCloseRegular, IconInfoOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular, IconWarningOutlineRegular, Input, Menu, Modal, SegmentedControl, StateDot, Switch, Tag, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  MCP_UI_ADD_PATH,
  MCP_UI_EVENTS_PATH,
  MCP_UI_OPEN_PATH,
  MCP_UI_SERVER_PATH,
  MCP_UI_STATE_PATH,
  MCP_UI_TOOL_PATH,
  MCP_UI_TOOLS_PATH,
  type McpUiResult,
  type McpUiServer,
  type McpUiState,
  type McpUiTool,
  type McpUiWriteTarget
} from "../wire.ts";
import type { McpUiLocaleKey } from "./locales.ts";
import { collapseServers, partitionShadowed, type LogicalServer } from "./collapse.ts";
import { displayHomePath, profileNameFromFile, serverActionsOpen } from "./display.ts";
import { parsePastedConfig, type PasteConfigFailure } from "./paste-config.ts";
import { addPathForTarget, badgeTone, confirmationDisplay, emptyDraft, partitionRows, profileEnd, validateAddDraft, type AddDraft, type AddScope } from "./panel-helpers.ts";
import { PANEL_CSS } from "./style.ts";

export interface McpPanelProps {
  t: (key: McpUiLocaleKey, params?: Record<string, unknown>) => string;
}

type Pending =
  | { kind: "server"; action: "enable" | "disable" | "remove"; row: McpUiServer }
  | { kind: "tool"; row: McpUiServer; tool: string; enabled: boolean };

const SOURCE_LABEL: Record<string, string> = {
  "dsh-project": "mcp.yml",
  "dsh-project-json": "mcp.json",
  "cc-project": ".mcp.json",
  "dsh-profile-user-yml": "profile mcp.yml",
  "dsh-profile-user": "profile mcp.json",
  "dsh-user-yml": "mcp.yml",
  "dsh-user": "mcp.json"
};

async function readBody(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function post(path: string, body: Record<string, unknown>): Promise<McpUiResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const text = await readBody(response);
  if (text === "") return { ok: false, message: `HTTP ${String(response.status)}，响应为空（${path}）` };
  try {
    const payload = JSON.parse(text) as McpUiResult;
    if (!response.ok && payload.ok !== false) return { ok: false, message: `HTTP ${String(response.status)} ${text.slice(0, 400)}` };
    return payload;
  } catch {
    return { ok: false, message: `HTTP ${String(response.status)} ${text.slice(0, 400)}` };
  }
}

function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

type StatusTone = "running" | "waiting" | "starting" | "error" | "off";

interface RuntimeStatus {
  label: string;
  /** 状态行没说完的原因。空则卡片上不再加一行。来源和接管不放这里。 */
  detail: string | null;
  tone: StatusTone;
}

/** 失败或跳过时，状态行用短句，下面一行放完整原因。来源改由名字旁的标签承担。 */
function problemStatus(reason: string | null, t: McpPanelProps["t"]): { label: string; detail: string | null } {
  switch (reason) {
    case "name-taken":
      return { label: t("statusNameTaken"), detail: t("skipNameTaken") };
    case "env-missing":
      return { label: t("statusEnvMissing"), detail: t("skipEnvMissing") };
    case "env-invalid":
      return { label: t("statusEnvInvalid"), detail: t("skipEnvInvalid") };
    case "give-up":
      return { label: t("statusGiveUp"), detail: t("skipGiveUp") };
    case "config-invalid":
      return { label: t("statusConfigInvalid"), detail: t("skipConfigInvalid") };
    case null:
    case "":
    case "idle":
      return { label: t("statusFailed"), detail: null };
    default:
      return { label: t("statusUnmounted"), detail: t("skipOther", { reason: reason ?? "" }) };
  }
}

function runningLabel(count: number, t: McpPanelProps["t"]): string {
  if (count <= 0) return t("statusRunning");
  if (count === 1) return t("statusRunningOne");
  return t("statusRunningCount", { count });
}

/** 开关表达意图。这句话只说现在有没有在跑，不再把来源和写入策略拼进同一句。 */
function runtimeStatus(row: McpUiServer, t: McpPanelProps["t"]): RuntimeStatus {
  if (!row.enabled) return { label: t("statusOff"), detail: null, tone: "off" };
  if (row.fiberPhase === "failed") return { ...problemStatus(row.skipReason, t), tone: "error" };
  if (row.active) return { label: runningLabel(row.toolCount, t), detail: null, tone: "running" };
  if (row.fiberPhase === "loading") return { label: t("statusStarting"), detail: null, tone: "starting" };
  if (row.skipReason === "idle" || row.skipReason == null || row.skipReason === "" || row.fiberPhase === "pending" || row.fiberPhase === null) {
    return { label: t("statusIdle"), detail: null, tone: "waiting" };
  }
  return { ...problemStatus(row.skipReason, t), tone: "error" };
}

function sourceFileLabel(row: McpUiServer): string {
  return SOURCE_LABEL[row.source] ?? fileName(row.filePath);
}

function groupedLogical(rows: McpUiServer[], keyOf: (server: LogicalServer<McpUiServer>) => string): Array<[string, LogicalServer<McpUiServer>[]]> {
  const map = new Map<string, LogicalServer<McpUiServer>[]>();
  for (const server of collapseServers(rows)) {
    const key = keyOf(server);
    const list = map.get(key);
    if (list === undefined) map.set(key, [server]);
    else list.push(server);
  }
  return [...map.entries()];
}

export function McpPanel({ t }: McpPanelProps) {
  const [state, setState] = useState<McpUiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [toolsFor, setToolsFor] = useState<McpUiServer | null>(null);
  const [tools, setTools] = useState<McpUiTool[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addTargets, setAddTargets] = useState<McpUiWriteTarget[]>([]);
  const [draft, setDraft] = useState<AddDraft>(emptyDraft([]));
  const [formError, setFormError] = useState<string | null>(null);
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const loadRef = useRef<() => void>(() => {});
  const loadSeq = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  /** 连接多在对账结束之后才变成 active。事件若没送到，这里继续读，直到没有「正在启动」。 */
  const watchStartup = (servers: McpUiServer[]) => {
    const starting = servers.some((row) => row.enabled && row.fiberPhase === "loading");
    if (!starting) {
      if (settleTimer.current !== undefined) {
        clearInterval(settleTimer.current);
        settleTimer.current = undefined;
      }
      return;
    }
    if (settleTimer.current !== undefined) return;
    settleTimer.current = setInterval(() => loadRef.current(), 1000);
  };

  const load = () => {
    const seq = loadSeq.current + 1;
    loadSeq.current = seq;
    fetch(MCP_UI_STATE_PATH, { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(async (response) => {
        const text = await readBody(response);
        if (!response.ok) throw new Error(`HTTP ${String(response.status)} ${text.slice(0, 400) || "响应为空"}（${MCP_UI_STATE_PATH}）`);
        let payload: McpUiState;
        try {
          payload = JSON.parse(text) as McpUiState;
        } catch {
          throw new Error(`响应不是 JSON：${text.slice(0, 400) || "空"}（${MCP_UI_STATE_PATH}）`);
        }
        if (!Array.isArray(payload.servers) || !Array.isArray(payload.openTargets) || !Array.isArray(payload.writeTargets)) {
          throw new Error(`响应缺少 servers/openTargets/writeTargets：${text.slice(0, 400)}`);
        }
        if (loadSeq.current !== seq) return;
        setState(payload);
        setError(null);
        watchStartup(payload.servers);
      })
      .catch((error: unknown) => {
        if (loadSeq.current !== seq) return;
        const detail = error instanceof Error ? error.message : String(error);
        setError(`${t("error")} ${detail}`);
      });
  };
  loadRef.current = load;

  useEffect(() => {
    load();
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | undefined;
    const startPoll = () => {
      if (poll !== undefined) return;
      poll = setInterval(load, 8000);
    };
    try {
      source = new EventSource(MCP_UI_EVENTS_PATH);
      source.addEventListener("updated", () => load());
      source.onerror = () => {
        source?.close();
        source = null;
        startPoll();
      };
    } catch {
      startPoll();
    }
    return () => {
      source?.close();
      if (poll !== undefined) clearInterval(poll);
      if (settleTimer.current !== undefined) {
        clearInterval(settleTimer.current);
        settleTimer.current = undefined;
      }
    };
  }, []);

  const run = async (body: Record<string, unknown>, path: string) => {
    setBusy(true);
    try {
      const result = await post(path, body);
      if (!result.ok && result.code === "confirm-yml") return result;
      if (!result.ok) {
        const name = typeof body.serverName === "string" ? body.serverName : "";
        const message = "message" in result ? result.message : t("error");
        setError(name === "" ? message : `${name}：${message}`);
      }
      else setError(null);
      load();
      return result;
    } finally {
      setBusy(false);
    }
  };

  const askOrRun = (next: Pending) => {
    const takeover = next.row.needsYmlTakeover;
    if (takeover || next.kind === "server" && next.action === "remove") {
      setPending(next);
      return;
    }
    void commit(next, false);
  };

  const commit = async (next: Pending, acknowledge: boolean) => {
    const common = {
      source: next.row.source,
      projectRoot: next.row.projectRoot,
      serverName: next.row.serverName,
      filePath: next.row.filePath,
      acknowledge
    };
    if (next.kind === "tool") {
      await run({ ...common, tool: next.tool, enabled: next.enabled }, MCP_UI_TOOL_PATH);
    } else {
      await run({ ...common, action: next.action === "remove" ? "remove" : next.action }, MCP_UI_SERVER_PATH);
    }
    setPending(null);
    if (toolsFor?.serverName === next.row.serverName) void openTools(next.row);
  };

  const openTools = async (row: McpUiServer) => {
    setToolsFor(row);
    setTools(null);
    const result = await post(MCP_UI_TOOLS_PATH, { projectRoot: row.projectRoot, serverName: row.serverName });
    setTools(result.ok ? result.tools ?? [] : []);
  };

  const updateDraft = (patch: Partial<AddDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setFormError(null);
    setPasteNote(null);
  };

  const openAdd = () => {
    const targets = state?.writeTargets ?? [];
    setAddTargets(targets);
    setDraft(emptyDraft(targets));
    setFormError(null);
    setPasteNote(null);
    setAddOpen(true);
  };

  const pasteFailure = (reason: PasteConfigFailure): string => {
    switch (reason) {
      case "empty": return t("addPasteEmpty");
      case "parse": return t("addPasteParse");
      case "none": return t("addPasteNone");
      case "sse": return t("addPasteSse");
      case "both": return t("addPasteBoth");
      case "command": return t("addPasteCommand");
      case "url": return t("addPasteUrl");
      case "fields": return t("addPasteFields");
      case "transport": return t("addPasteTransport");
    }
  };

  const fillFromClipboard = async () => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setPasteNote(null);
      setFormError(t("addPasteDenied"));
      return;
    }
    const parsed = parsePastedConfig(text);
    if (!parsed.ok) {
      setPasteNote(null);
      setFormError(pasteFailure(parsed.reason));
      return;
    }
    setDraft((current) => ({ ...current, ...parsed.fields }));
    setFormError(null);
    setPasteNote(parsed.skipped > 0 ? t("addPasteSkipped", { count: parsed.skipped }) : null);
  };

  const submitAdd = async () => {
    const validation = validateAddDraft(draft, addTargets);
    if (!validation.ok) {
      const error = validation.error;
      if (error.kind === "target") setFormError(t("addNoTarget"));
      else if (error.kind === "name") setFormError(t("addNameInvalid"));
      else if (error.kind === "command") setFormError(t("addCommandRequired"));
      else if (error.kind === "url") setFormError(t("addUrlRequired"));
      else setFormError(t("addPairInvalid", { line: error.line }));
      return;
    }
    setBusy(true);
    try {
      const result = await post(MCP_UI_ADD_PATH, validation.body);
      if (!result.ok) {
        setFormError("message" in result ? result.message : t("error"));
        return;
      }
      setAddOpen(false);
      setError(null);
      load();
    } finally {
      setBusy(false);
    }
  };

  const openFile = async (target: McpUiState["openTargets"][number]) => {
    setMenuOpen(false);
    setBusy(true);
    try {
      const result = await post(MCP_UI_OPEN_PATH, { source: target.source, projectRoot: target.projectRoot });
      if (!result.ok && "message" in result) setError(result.message);
    } finally {
      setBusy(false);
    }
  };

  const homeDir = state?.homeDir;
  const showUserPath = (path: string) => displayHomePath(path, homeDir);
  const { projectRows, userRows, profileBuckets } = partitionRows(state?.servers ?? []);
  const projectGroups = groupedLogical(projectRows, (server) => server.winner.projectRoot);
  const userGroups = groupedLogical(userRows, (server) => showUserPath(server.winner.filePath));
  const profileTitle = (name: string) => name === "" ? t("profileLayerPlain") : t("profileLayer", { end: profileEnd(name, t) });
  const openLabel = (target: McpUiState["openTargets"][number]) => {
    if (target.source === "dsh-user-yml") return t("userFile");
    if (target.source === "dsh-profile-user-yml") {
      const name = profileNameFromFile(target.path);
      return name === undefined ? t("profileFile") : t("profileFileNamed", { end: profileEnd(name, t) });
    }
    if (target.source === "dsh-project") return t("projectFile");
    return target.label;
  };

  const addTarget = addTargets.find((item) => item.id === draft.scope);
  const scopeReady = (id: AddScope) => addTargets.some((item) => item.id === id);
  const addPath = addPathForTarget(addTarget, showUserPath);

  const { removes: pendingRemoves, title: pendingTitle, will: pendingWill, wont: pendingWont } = confirmationDisplay(pending, showUserPath, t);

  return (
    <div className="dsh-mcp-ui">
      <div className="intro">
        <p>{t("intro")}</p>
        <Tooltip label={t("introHelp")} side="right" portal maxWidth={420} openOnClick>
          <button type="button" className="intro-help" aria-label={t("introHelp")}>
            <IconInfoOutlineRegular size={14} />
          </button>
        </Tooltip>
      </div>
      <div className="toolbar">
        <Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={16} />} disabled={busy || state === null || state.writeTargets.length === 0} onClick={openAdd}>
          {t("add")}
        </Button>
        <Menu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          portal
          onSelect={(id) => {
            const target = state?.openTargets.find((item) => item.id === id);
            if (target !== undefined) void openFile(target);
          }}
          items={state !== null && state.openTargets.length > 0
            ? state.openTargets.map((target) => ({
              id: target.id,
              label: openLabel(target)
            }))
            : [{ id: "unavailable", label: error ?? t("loading"), disabled: true }]}
          anchor={(
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setMenuOpen(true)}>
              {t("open")}
              <IconChevronDownOutlineRegular size={14} />
            </Button>
          )}
        />
      </div>
      {error !== null && (
        <p className="dsh-mcp-banner" role="alert">
          <IconWarningOutlineRegular size={16} />
          <span>{error}</span>
        </p>
      )}
      {state === null && error === null && <p className="empty">{t("loading")}</p>}
      {state !== null && state.servers.length === 0 && <p className="empty">{t("empty")}</p>}

      <ServerGroups title={t("projectLayer")} groups={projectGroups} busy={busy} t={t} homeDir={homeDir} writeTargets={state?.writeTargets ?? []} onToggle={(row, enabled) => askOrRun({ kind: "server", action: enabled ? "enable" : "disable", row })} onRemove={(row) => askOrRun({ kind: "server", action: "remove", row })} onTools={(row) => void openTools(row)} />
      {profileBuckets.map(([name, rows]) => (
        <ServerGroups key={name === "" ? "profile" : name} title={profileTitle(name)} groups={groupedLogical(rows, (server) => showUserPath(server.winner.filePath))} busy={busy} t={t} homeDir={homeDir} writeTargets={state?.writeTargets ?? []} onToggle={(row, enabled) => askOrRun({ kind: "server", action: enabled ? "enable" : "disable", row })} onRemove={(row) => askOrRun({ kind: "server", action: "remove", row })} onTools={(row) => void openTools(row)} />
      ))}
      <ServerGroups title={t("userLayer")} groups={userGroups} busy={busy} t={t} homeDir={homeDir} writeTargets={state?.writeTargets ?? []} onToggle={(row, enabled) => askOrRun({ kind: "server", action: enabled ? "enable" : "disable", row })} onRemove={(row) => askOrRun({ kind: "server", action: "remove", row })} onTools={(row) => void openTools(row)} />

      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pendingTitle}
        closeLabel={t("cancel")}
        description={pendingWill}
        footer={(
          <>
            <Button variant="ghost" size="sm" onClick={() => setPending(null)}>{t("cancel")}</Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => pending !== null && void commit(pending, true)}>{pendingRemoves ? t("remove") : t("continueWrite")}</Button>
          </>
        )}
      >
        {pendingWont !== "" && <p className="dsh-mcp-confirm-note">{pendingWont}</p>}
      </Modal>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title={t("addTitle")}
        closeLabel={t("cancel")}
        description={t("addDescription")}
        className="dsh-mcp-add-dialog"
        contentClassName="dsh-mcp-add-content"
        footer={(
          <>
            <Button variant="ghost" size="sm" type="button" onClick={() => setAddOpen(false)}>{t("cancel")}</Button>
            <Button variant="primary" size="sm" type="submit" form="dsh-mcp-add-form" disabled={busy}>{t("addSubmit")}</Button>
          </>
        )}
      >
        <form id="dsh-mcp-add-form" style={ADD_FORM_STYLE} onSubmit={(event) => {
          event.preventDefault();
          void submitAdd();
        }}>
          <div className="dsh-mcp-add-field">
            <Button className="dsh-mcp-add-paste" variant="outline" size="sm" type="button" disabled={busy} onClick={() => void fillFromClipboard()}>
              {t("addPaste")}
            </Button>
            {pasteNote !== null && <p className="dsh-mcp-add-path">{pasteNote}</p>}
          </div>
          <div className="dsh-mcp-add-field">
            <span className="dsh-mcp-add-label" aria-hidden="true">{t("addScope")}</span>
            <SegmentedControl
              id="dsh-mcp-add-scope"
              label={t("addScope")}
              value={draft.scope}
              disabled={busy}
              onChange={(scope) => updateDraft({ scope })}
              options={[
                { value: "project", label: t("addScopeProject"), disabled: !scopeReady("project"), title: scopeReady("project") ? undefined : t("addNoWorkspace") },
                { value: "user", label: t("addScopeUser"), disabled: !scopeReady("user") },
                { value: "profile", label: t("addScopeProfile"), disabled: !scopeReady("profile"), title: scopeReady("profile") ? undefined : t("addNoProfile") }
              ]}
            />
            {addTarget !== undefined && <p className="dsh-mcp-add-path">{t("addWhere", { path: addPath })}</p>}
          </div>
          <div className="dsh-mcp-add-field">
            <label className="dsh-mcp-add-label" htmlFor="dsh-mcp-add-name">{t("addName")}</label>
            <Input id="dsh-mcp-add-name" className="dsh-mcp-add-input" value={draft.name} placeholder={t("addNamePlaceholder")} disabled={busy} autoComplete="off" spellCheck={false} data-modal-autofocus onChange={(event) => updateDraft({ name: event.target.value })} />
          </div>
          <div className="dsh-mcp-add-field">
            <span className="dsh-mcp-add-label" aria-hidden="true">{t("addTransport")}</span>
            <SegmentedControl
              id="dsh-mcp-add-transport"
              label={t("addTransport")}
              value={draft.transport}
              disabled={busy}
              onChange={(transport) => updateDraft({ transport })}
              options={[
                { value: "stdio", label: t("addTransportStdio") },
                { value: "http", label: t("addTransportHttp") }
              ]}
            />
          </div>
          {draft.transport === "stdio" ? (
            <>
              <div className="dsh-mcp-add-field">
                <label className="dsh-mcp-add-label" htmlFor="dsh-mcp-add-command">{t("addCommand")}</label>
                <Input id="dsh-mcp-add-command" className="dsh-mcp-add-input" value={draft.command} placeholder={t("addCommandPlaceholder")} disabled={busy} autoComplete="off" spellCheck={false} onChange={(event) => updateDraft({ command: event.target.value })} />
              </div>
              <div className="dsh-mcp-add-field">
                <label className="dsh-mcp-add-label" htmlFor="dsh-mcp-add-args">{t("addArgs")}</label>
                <textarea id="dsh-mcp-add-args" className="dsh-mcp-add-area" value={draft.args} placeholder={t("addArgsPlaceholder")} disabled={busy} autoComplete="off" spellCheck={false} onChange={(event) => updateDraft({ args: event.target.value })} />
              </div>
              <div className="dsh-mcp-add-field">
                <label className="dsh-mcp-add-label" htmlFor="dsh-mcp-add-env">{t("addEnv")}</label>
                <textarea id="dsh-mcp-add-env" className="dsh-mcp-add-area" value={draft.env} placeholder={t("addEnvPlaceholder")} disabled={busy} autoComplete="off" spellCheck={false} onChange={(event) => updateDraft({ env: event.target.value })} />
              </div>
            </>
          ) : (
            <>
              <div className="dsh-mcp-add-field">
                <label className="dsh-mcp-add-label" htmlFor="dsh-mcp-add-url">{t("addUrl")}</label>
                <Input id="dsh-mcp-add-url" className="dsh-mcp-add-input" value={draft.url} placeholder={t("addUrlPlaceholder")} disabled={busy} autoComplete="off" spellCheck={false} onChange={(event) => updateDraft({ url: event.target.value })} />
              </div>
              <div className="dsh-mcp-add-field">
                <label className="dsh-mcp-add-label" htmlFor="dsh-mcp-add-headers">{t("addHeaders")}</label>
                <textarea id="dsh-mcp-add-headers" className="dsh-mcp-add-area" value={draft.headers} placeholder={t("addHeadersPlaceholder")} disabled={busy} autoComplete="off" spellCheck={false} onChange={(event) => updateDraft({ headers: event.target.value })} />
              </div>
            </>
          )}
        </form>
        {formError !== null && (
          <p className="dsh-mcp-banner dsh-mcp-add-error" role="alert">
            <IconWarningOutlineRegular size={16} />
            <span>{formError}</span>
          </p>
        )}
      </Modal>

      <Modal
        open={toolsFor !== null}
        onClose={() => setToolsFor(null)}
        title={t("toolsTitle", { name: toolsFor?.serverName ?? "" })}
        closeLabel={t("toolsClose")}
        className="dsh-mcp-tools-dialog"
        contentClassName="dsh-mcp-tools-content"
        footer={<Button variant="ghost" size="sm" onClick={() => setToolsFor(null)}>{t("toolsClose")}</Button>}
      >
        {tools === null && <p className="dsh-mcp-tools-status">{t("loading")}</p>}
        {tools !== null && tools.length === 0 && <p className="dsh-mcp-tools-status">{t("toolsEmpty")}</p>}
        {tools !== null && tools.length > 0 && (
          <div className="dsh-mcp-tools-list" style={TOOL_LIST_STYLE}>
            {tools.map((tool) => {
              const toolsLocked = toolsFor !== null && !serverActionsOpen(toolsFor, state?.writeTargets ?? []);
              return (
                <div className="dsh-mcp-tools-row" key={tool.name} style={TOOL_ROW_STYLE}>
                  <span className="dsh-mcp-tools-name" title={tool.name} style={TOOL_NAME_STYLE}>{tool.name}</span>
                  <span title={toolsLocked ? t("workspaceLocked") : undefined}>
                    <Switch
                      className="dsh-mcp-tools-switch dsh-mcp-switch"
                      checked={tool.enabled}
                      disabled={busy || toolsFor === null || toolsLocked}
                      label={toolsLocked ? t("workspaceLocked") : t("toolEnableLabel", { name: tool.name })}
                      onChange={(enabled) => {
                        if (toolsFor === null || toolsLocked) return;
                        askOrRun({ kind: "tool", row: toolsFor, tool: tool.name, enabled });
                      }}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Modal>
    </div>
  );
}

function ServerGroups({ title, groups, busy, t, homeDir, writeTargets, onToggle, onRemove, onTools }: {
  title: string;
  groups: Array<[string, LogicalServer<McpUiServer>[]]>;
  busy: boolean;
  t: McpPanelProps["t"];
  homeDir: string | undefined;
  writeTargets: McpUiState["writeTargets"];
  onToggle: (row: McpUiServer, enabled: boolean) => void;
  onRemove: (row: McpUiServer) => void;
  onTools: (row: McpUiServer) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <section className="section">
      <h3>{title}</h3>
      <div className="groups">
        {groups.map(([label, servers]) => (
          <div className="group" key={label}>
            <div className="group-head">
              <IconFolderCloseRegular size={16} />
              <span className="group-path" title={label}>{label}</span>
              <span className="group-count">{t("serverCount", { count: servers.length })}</span>
            </div>
            {servers.map((server) => (
              <ServerCard key={server.winner.source + server.winner.filePath + server.winner.serverName} server={server} busy={busy} locked={!serverActionsOpen(server.winner, writeTargets)} t={t} homeDir={homeDir} onToggle={(enabled) => onToggle(server.winner, enabled)} onRemove={() => onRemove(server.winner)} onTools={() => onTools(server.winner)} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function ServerCard({ server, busy, locked, t, homeDir, onToggle, onRemove, onTools }: {
  server: LogicalServer<McpUiServer>;
  busy: boolean;
  locked: boolean;
  t: McpPanelProps["t"];
  homeDir: string | undefined;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
  onTools: () => void;
}) {
  const row = server.winner;
  const status = runtimeStatus(row, t);
  const source = sourceFileLabel(row);
  const fileLabel = row.layer === "user" ? displayHomePath(row.filePath, homeDir) : row.filePath;
  const endpointKind = row.endpoint.startsWith("http://") || row.endpoint.startsWith("https://") ? t("endpointUrl") : t("endpointCmd");
  const tone = badgeTone(row);
  const shadows = partitionShadowed(server);
  const shadowedFiles = [...new Set(shadows.named.map((item) => sourceFileLabel(item)))].join(", ");
  const identityNames = shadows.identity.map((item) => item.serverName).join(", ");
  return (
    <article className="card">
      <div className="head">
        <div className="identity">
          <span className="name">{row.serverName}</span>
          <span className="badge" title={row.needsYmlTakeover ? `${t("badgeTakeoverHint")} ${fileLabel}` : fileLabel}>
            <Tag tone={tone}>{row.needsYmlTakeover ? t("badgeTakeover", { file: source }) : source}</Tag>
          </span>
        </div>
        <span title={locked ? t("workspaceLocked") : undefined}>
          <Switch className={status.tone === "waiting" ? "dsh-mcp-switch dsh-mcp-switch-waiting" : "dsh-mcp-switch"} checked={row.enabled} disabled={busy || locked} label={locked ? t("workspaceLocked") : t("enableLabel")} onChange={onToggle} />
        </span>
      </div>
      <div className="meta">
        <p className={`status status-${status.tone}`}>
          {status.tone === "starting" && <StateDot state="ongoing" size={14} />}
          <span>{status.label}</span>
        </p>
        {row.endpoint !== "" && (
          <div className="endpoint" title={row.endpoint}>
            <span className="endpoint-kind">{endpointKind}</span>
            <span className="endpoint-value">{row.endpoint}</span>
          </div>
        )}
        {status.detail !== null && <p className="detail">{status.detail}</p>}
        {shadowedFiles !== "" && <p className="shadow-note">{t("shadowedNote", { files: shadowedFiles, winner: source })}</p>}
        {identityNames !== "" && <p className="shadow-note">{t("shadowedIdentityNote", { names: identityNames, winner: row.serverName })}</p>}
      </div>
      <div className="actions">
        <Button variant="outline" size="sm" disabled={busy} onClick={onTools}>{t("tools")}</Button>
        <span className="danger-wrap" title={locked ? t("workspaceLocked") : undefined}>
          <Button className="danger" variant="ghost" size="sm" disabled={busy || locked} icon={<IconTrashOutlineRegular size={16} />} onClick={onRemove}>{t("remove")}</Button>
        </span>
      </div>
    </article>
  );
}

export function installPanelStyle(): void {
  if (typeof document === "undefined") return;
  let tag = document.getElementById("dsh-project-mcp-ui");
  if (tag === null) {
    tag = document.createElement("style");
    tag.id = "dsh-project-mcp-ui";
    document.head.appendChild(tag);
  }
  if (tag.textContent !== PANEL_CSS) tag.textContent = PANEL_CSS;
}

/** Layout is inline because the dialog is portaled and its flex column shrinks children.
 *  A stale injected stylesheet must not be able to put the switch back beside the name. */
const ADD_FORM_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  boxSizing: "border-box",
  width: "100%",
  maxHeight: "min(480px, calc(100vh - 240px))",
  paddingRight: 16,
  overflowX: "hidden",
  overflowY: "auto",
  overscrollBehavior: "contain",
  scrollbarGutter: "stable"
};

const TOOL_LIST_STYLE: CSSProperties = {
  display: "block",
  alignSelf: "stretch",
  boxSizing: "border-box",
  width: "100%",
  maxHeight: "min(420px, calc(100vh - 230px))",
  paddingRight: 16,
  overflowX: "hidden",
  overflowY: "auto",
  overscrollBehavior: "contain",
  scrollbarGutter: "stable",
  flex: "0 0 auto"
};

const TOOL_ROW_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  columnGap: 16,
  boxSizing: "border-box",
  width: "100%",
  minHeight: 44,
  padding: "10px 0"
};

const TOOL_NAME_STYLE: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};
