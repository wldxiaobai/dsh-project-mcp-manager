/** MCP settings tab: layers, activation, delete, and per-tool switches. */

import { useEffect, useState } from "react";
import { Button, Menu, Modal, StateDot, Switch, Tag } from "@deepseek-ai/dsh-client-ui-primitives";
import { IconFolderOpenOutlineRegular, IconTrashOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import {
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
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, []);

  const run = async (body: Record<string, unknown>, path: string) => {
    setBusy(true);
    try {
      const result = await post(path, body);
      if (!result.ok && result.code === "confirm-yml") return result;
      if (!result.ok) setError("message" in result ? result.message : t("error"));
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

  const pendingBody = pending === null ? "" : pending.kind === "server" && pending.action === "remove" && !pending.row.needsYmlTakeover
    ? t("removeBody", { name: pending.row.serverName, yml: pending.row.managedPath ?? pending.row.filePath })
    : t("takeoverBody", {
      name: pending.kind === "tool" ? pending.tool : pending.row.serverName,
      file: pending.row.filePath,
      yml: pending.row.managedPath ?? ""
    });

  return (
    <div className="dsh-mcp-ui">
      <h2>{t("title")}</h2>
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
            </Button>
          )}
        />
        <Button variant="ghost" size="sm" disabled={busy} onClick={load}>{t("refresh")}</Button>
      </div>
      {error !== null && <p className="banner">{error}</p>}
      {state === null && error === null && <p className="empty">{t("loading")}</p>}
      {state !== null && state.servers.length === 0 && <p className="empty">{t("empty")}</p>}

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
        title={pending?.kind === "server" && pending.action === "remove" ? t("removeTitle", { name: pending.row.serverName }) : t("takeoverTitle")}
        closeLabel={t("cancel")}
        description={pendingBody}
        footer={(
          <>
            <Button variant="ghost" size="sm" onClick={() => setPending(null)}>{t("cancel")}</Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => pending !== null && void commit(pending, true)}>{t("continueWrite")}</Button>
          </>
        )}
      />

      <Modal
        open={toolsFor !== null}
        onClose={() => setToolsFor(null)}
        title={t("toolsTitle", { name: toolsFor?.serverName ?? "" })}
        closeLabel={t("toolsClose")}
        footer={<Button variant="ghost" size="sm" onClick={() => setToolsFor(null)}>{t("toolsClose")}</Button>}
      >
        {tools === null && <p className="hint">{t("loading")}</p>}
        {tools !== null && tools.length === 0 && <p className="hint">{t("toolsEmpty")}</p>}
        {tools !== null && tools.length > 0 && (
          <div className="tools">
            {tools.map((tool) => (
              <div className="tool" key={tool.name}>
                <code>{tool.name}</code>
                <Switch
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
  return (
    <article className="card">
      <div className="row">
        <div className="identity">
          <StateDot state={row.active ? "done" : row.fiberPhase === "failed" ? "error" : "idle"} />
          <span className="name">{row.serverName}</span>
        </div>
        <Switch checked={row.enabled} disabled={busy} label={t("enableLabel")} onChange={onToggle} />
      </div>
      <div className="meta">
        <Tag tone={row.layer === "project" ? "info" : "neutral"}>{row.layer === "project" ? t("projectLayer") : t("userLayer")}</Tag>
        <Tag tone={row.active ? "success" : "outline"}>{row.active ? t("active") : t("inactive")}</Tag>
        <Tag tone="quiet">{SOURCE_LABEL[row.source] ?? fileName(row.filePath)}</Tag>
        {row.needsYmlTakeover && <Tag tone="warning">{t("readOnlySource")}</Tag>}
        {row.skipReason != null && row.skipReason !== "" && <Tag tone="outline">{row.skipReason}</Tag>}
      </div>
      {row.endpoint !== "" && <div className="endpoint">{row.endpoint}</div>}
      <div className="actions">
        <Button variant="outline" size="sm" disabled={busy} onClick={onTools}>{t("tools")}</Button>
        <Button variant="ghost" size="sm" disabled={busy} icon={<IconTrashOutlineRegular size={16} />} onClick={onRemove}>{t("remove")}</Button>
      </div>
    </article>
  );
}

export function installPanelStyle(): void {
  if (typeof document === "undefined" || document.getElementById("dsh-project-mcp-ui") !== null) return;
  const tag = document.createElement("style");
  tag.id = "dsh-project-mcp-ui";
  tag.textContent = PANEL_CSS;
  document.head.appendChild(tag);
}
