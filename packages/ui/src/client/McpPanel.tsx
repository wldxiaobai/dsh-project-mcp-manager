/** MCP settings tab: layers, activation, delete, and per-tool switches. */

import { useEffect, useState, type CSSProperties } from "react";
import { Button, Menu, Modal, StateDot, Switch, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import { IconChevronDownOutlineRegular, IconFolderOpenOutlineRegular, IconTrashOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  MCP_UI_EVENTS_PATH,
  MCP_UI_OPEN_PATH,
  MCP_UI_SERVER_PATH,
  MCP_UI_STATE_PATH,
  MCP_UI_TOOL_PATH,
  MCP_UI_TOOLS_PATH,
  type McpUiResult,
  type McpUiServer,
  type McpUiState,
  type McpUiTool
} from "../wire.ts";
import type { McpUiLocaleKey } from "./locales.ts";
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

function skipDetail(reason: string | null, t: McpPanelProps["t"]): string {
  switch (reason) {
    case null:
    case "":
    case "idle":
      return t("statusIdleDetail");
    case "name-taken":
      return t("skipNameTaken");
    case "env-missing":
      return t("skipEnvMissing");
    case "env-invalid":
      return t("skipEnvInvalid");
    case "give-up":
      return t("skipGiveUp");
    case "config-invalid":
      return t("skipConfigInvalid");
    default:
      return t("skipOther", { reason: reason ?? "" });
  }
}

/** 一张卡片只说一句运行时状态。开关表达意图，这句话解释现在为什么跑或没跑。 */
function runtimeStatus(row: McpUiServer, t: McpPanelProps["t"]): { label: string; tip: string; dot: "done" | "error" | "idle" } {
  const source = SOURCE_LABEL[row.source] ?? fileName(row.filePath);
  const notes = [t("sourceDetail", { file: source })];
  if (row.needsYmlTakeover) notes.push(t("readOnlyDetail"));
  const tail = notes.join("");
  if (!row.enabled) {
    return { label: t("statusOff"), tip: `${t("statusOffDetail")}${tail}`, dot: "idle" };
  }
  if (row.fiberPhase === "failed") {
    return { label: t("statusFailed"), tip: `${skipDetail(row.skipReason, t)}${tail}`, dot: "error" };
  }
  if (row.active) {
    return { label: t("statusRunning"), tip: `${t("statusRunningDetail")}${tail}`, dot: "done" };
  }
  if (row.fiberPhase === "loading") {
    return { label: t("statusStarting"), tip: `${t("statusStartingDetail")}${tail}`, dot: "idle" };
  }
  if (row.skipReason === "idle" || row.skipReason == null || row.skipReason === "" || row.fiberPhase === "pending" || row.fiberPhase === null) {
    return { label: t("statusIdle"), tip: `${t("statusIdleDetail")}${tail}`, dot: "idle" };
  }
  return { label: t("statusUnmounted"), tip: `${skipDetail(row.skipReason, t)}${tail}`, dot: "error" };
}

export function McpPanel({ t }: McpPanelProps) {
  const [state, setState] = useState<McpUiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [toolsFor, setToolsFor] = useState<McpUiServer | null>(null);
  const [tools, setTools] = useState<McpUiTool[] | null>(null);

  const load = () => {
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
        if (!Array.isArray(payload.servers) || !Array.isArray(payload.openTargets)) {
          throw new Error(`响应缺少 servers/openTargets：${text.slice(0, 400)}`);
        }
        setState(payload);
        setError(null);
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        setError(`${t("error")} ${detail}`);
      });
  };

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

  const projects = new Map<string, McpUiServer[]>();
  const userRows: McpUiServer[] = [];
  for (const row of state?.servers ?? []) {
    if (row.layer === "user") userRows.push(row);
    else {
      const list = projects.get(row.projectRoot) ?? [];
      list.push(row);
      projects.set(row.projectRoot, list);
    }
  }

  const pendingWill = pending === null ? "" : pending.kind === "server" && pending.action === "remove" && !pending.row.needsYmlTakeover
    ? t("removeWill", { name: pending.row.serverName })
    : t("takeoverWill");
  const pendingWont = pending === null ? "" : pending.kind === "server" && pending.action === "remove" && !pending.row.needsYmlTakeover
    ? t("removeWont")
    : t("takeoverWont", { file: pending.row.filePath, yml: pending.row.managedPath ?? "" });

  return (
    <div className="dsh-mcp-ui">
      <p className="intro">{t("intro")}</p>
      <div className="toolbar">
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
              label: target.source === "dsh-user-yml" ? t("userFile") : target.source === "dsh-profile-user-yml" ? t("profileFile") : target.label
            }))
            : [{ id: "unavailable", label: error ?? t("loading"), disabled: true }]}
          anchor={(
            <Button variant="outline" size="sm" icon={<IconFolderOpenOutlineRegular size={16} />} disabled={busy} onClick={() => setMenuOpen(true)}>
              {t("open")}
              <IconChevronDownOutlineRegular size={14} />
            </Button>
          )}
        />
      </div>
      {error !== null && <p className="banner">{error}</p>}
      {state === null && error === null && <p className="empty">{t("loading")}</p>}
      {state !== null && state.servers.length === 0 && <p className="empty">{t("empty")}</p>}
      {state !== null && state.servers.length > 0 && <p className="hint">{t("addHint")}</p>}

      {[...projects.entries()].length > 0 && (
        <section className="section">
          <h3>{t("projectLayer")}</h3>
          {[...projects.entries()].map(([project, rows]) => (
            <div key={project}>
              <p className="project">{project}</p>
              {rows.map((row) => (
                <ServerCard key={row.source + row.serverName} row={row} busy={busy} t={t} onToggle={(enabled) => askOrRun({ kind: "server", action: enabled ? "enable" : "disable", row })} onRemove={() => askOrRun({ kind: "server", action: "remove", row })} onTools={() => void openTools(row)} />
              ))}
            </div>
          ))}
        </section>
      )}

      {userRows.length > 0 && (
        <section className="section">
          <h3>{t("userLayer")}</h3>
          {userRows.map((row) => (
            <ServerCard key={row.source + row.filePath + row.serverName} row={row} busy={busy} t={t} onToggle={(enabled) => askOrRun({ kind: "server", action: enabled ? "enable" : "disable", row })} onRemove={() => askOrRun({ kind: "server", action: "remove", row })} onTools={() => void openTools(row)} />
          ))}
        </section>
      )}

      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending?.kind === "server" && pending.action === "remove" && !pending.row.needsYmlTakeover ? t("removeTitle", { name: pending.row.serverName }) : t("takeoverTitle")}
        closeLabel={t("cancel")}
        description={pendingWill}
        footer={(
          <>
            <Button variant="ghost" size="sm" onClick={() => setPending(null)}>{t("cancel")}</Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => pending !== null && void commit(pending, true)}>{t("continueWrite")}</Button>
          </>
        )}
      >
        {pendingWont !== "" && <p className="dsh-mcp-confirm-note">{pendingWont}</p>}
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
            {tools.map((tool) => (
              <div className="dsh-mcp-tools-row" key={tool.name} style={TOOL_ROW_STYLE}>
                <span className="dsh-mcp-tools-name" title={tool.name} style={TOOL_NAME_STYLE}>{tool.name}</span>
                <Switch
                  className="dsh-mcp-tools-switch"
                  checked={tool.enabled}
                  disabled={busy || toolsFor === null}
                  label={t("toolEnableLabel", { name: tool.name })}
                  onChange={(enabled) => {
                    if (toolsFor === null) return;
                    askOrRun({ kind: "tool", row: toolsFor, tool: tool.name, enabled });
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}

function ServerCard({ row, busy, t, onToggle, onRemove, onTools }: {
  row: McpUiServer;
  busy: boolean;
  t: McpPanelProps["t"];
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
  onTools: () => void;
}) {
  const status = runtimeStatus(row, t);
  const endpointKind = row.endpoint.startsWith("http://") || row.endpoint.startsWith("https://") ? t("endpointUrl") : t("endpointCmd");
  return (
    <article className="card">
      <div className="row">
        <div className="identity">
          <StateDot state={status.dot} />
          <span className="name">{row.serverName}</span>
        </div>
        <Switch checked={row.enabled} disabled={busy} label={t("enableLabel")} onChange={onToggle} />
      </div>
      <Tooltip label={status.tip} side="bottom" portal maxWidth={360}>
        <p className={`status status-${status.dot}`}>{status.label}</p>
      </Tooltip>
      {row.endpoint !== "" && (
        <div className="endpoint" title={row.endpoint}>
          <span className="endpoint-kind">{endpointKind}</span>
          <span className="endpoint-value">{row.endpoint}</span>
        </div>
      )}
      <div className="actions">
        <Button variant="outline" size="sm" disabled={busy} onClick={onTools}>{row.toolCount > 0 ? t("toolsCount", { count: row.toolCount }) : t("tools")}</Button>
        <Button className="danger" variant="ghost" size="sm" disabled={busy} icon={<IconTrashOutlineRegular size={16} />} onClick={onRemove}>{t("remove")}</Button>
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
const TOOL_LIST_STYLE: CSSProperties = {
  display: "block",
  alignSelf: "stretch",
  boxSizing: "border-box",
  width: "100%",
  maxHeight: "min(420px, calc(100vh - 230px))",
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
