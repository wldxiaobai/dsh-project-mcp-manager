import { isProfileSource, profileNameFromFile } from "./display.ts";
import type { McpUiServer, McpUiWriteTarget } from "../wire.ts";

export type AddScope = McpUiWriteTarget["id"];
export type AddKind = "stdio" | "http";

export interface AddDraft {
  readonly scope: AddScope;
  readonly name: string;
  readonly transport: AddKind;
  readonly command: string;
  readonly args: string;
  readonly url: string;
  readonly env: string;
  readonly headers: string;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type AddValidationError =
  | { readonly kind: "target" }
  | { readonly kind: "name" }
  | { readonly kind: "command" }
  | { readonly kind: "url" }
  | { readonly kind: "pairs"; readonly line: string };

export type AddValidation =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly error: AddValidationError };

function linesOf(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
}

function pairsOf(text: string, kind: "env" | "header"): { readonly map: Record<string, string> } | { readonly line: string } {
  const map: Record<string, string> = {};
  for (const line of linesOf(text)) {
    const index = kind === "header" && line.includes(":") ? line.indexOf(":") : line.indexOf("=");
    if (index <= 0) return { line };
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key === "" || (kind === "env" && !ENV_KEY_RE.test(key))) return { line };
    map[key] = value;
  }
  return { map };
}

type FieldValidation = { readonly ok: true; readonly fields: Record<string, unknown> } | { readonly ok: false; readonly error: AddValidationError };

function validateStdio(draft: AddDraft): FieldValidation {
  const command = draft.command.trim();
  if (command === "") return { ok: false, error: { kind: "command" } };
  const env = pairsOf(draft.env, "env");
  if ("line" in env) return { ok: false, error: { kind: "pairs", line: env.line } };
  const fields: Record<string, unknown> = { command, args: linesOf(draft.args) };
  if (Object.keys(env.map).length > 0) fields.env = env.map;
  return { ok: true, fields };
}

function validateHttp(draft: AddDraft): FieldValidation {
  const url = draft.url.trim();
  if (url === "") return { ok: false, error: { kind: "url" } };
  const headers = pairsOf(draft.headers, "header");
  if ("line" in headers) return { ok: false, error: { kind: "pairs", line: headers.line } };
  const fields: Record<string, unknown> = { url };
  if (Object.keys(headers.map).length > 0) fields.headers = headers.map;
  return { ok: true, fields };
}

export function validateAddDraft(draft: AddDraft, targets: readonly McpUiWriteTarget[]): AddValidation {
  const target = targets.find((item) => item.id === draft.scope);
  if (target === undefined) return { ok: false, error: { kind: "target" } };
  const name = draft.name.trim();
  if (!NAME_RE.test(name)) return { ok: false, error: { kind: "name" } };
  const fields = draft.transport === "stdio" ? validateStdio(draft) : validateHttp(draft);
  if (!fields.ok) return fields;
  return {
    ok: true,
    body: {
      source: target.source,
      projectRoot: target.projectRoot,
      serverName: name,
      transport: draft.transport === "http" ? "streamable-http" : "stdio",
      ...fields.fields
    }
  };
}

export interface PanelGroups {
  readonly projectRows: McpUiServer[];
  readonly userRows: McpUiServer[];
  readonly profileBuckets: Array<[string, McpUiServer[]]>;
}

export function partitionRows(rows: readonly McpUiServer[]): PanelGroups {
  const projectRows: McpUiServer[] = [];
  const userRows: McpUiServer[] = [];
  const profileBuckets: Array<[string, McpUiServer[]]> = [];
  for (const row of rows) {
    if (row.layer === "user" && isProfileSource(row.source)) {
      const name = profileNameFromFile(row.filePath) ?? "";
      const bucket = profileBuckets.find((item) => item[0] === name);
      if (bucket === undefined) profileBuckets.push([name, [row]]);
      else bucket[1].push(row);
    } else if (row.layer === "user") userRows.push(row);
    else projectRows.push(row);
  }
  return { projectRows, userRows, profileBuckets };
}

export type ConfirmationCopy =
  | { readonly kind: "remove"; readonly name: string }
  | { readonly kind: "takeover"; readonly file: string; readonly yml: string };

export function confirmationCopy(pending: {
  readonly kind: "server" | "tool";
  readonly action?: "enable" | "disable" | "remove";
  readonly row: Pick<McpUiServer, "serverName" | "needsYmlTakeover">;
}, file: string, yml: string): ConfirmationCopy {
  if (pending.kind === "server" && pending.action === "remove" && !pending.row.needsYmlTakeover) {
    return { kind: "remove", name: pending.row.serverName };
  }
  return { kind: "takeover", file, yml };
}

export function addPathForTarget(target: McpUiWriteTarget | undefined, showUserPath: (path: string) => string): string {
  if (target === undefined) return "";
  if (target.id === "project") return target.path;
  return showUserPath(target.path);
}

export function defaultScope(targets: readonly McpUiWriteTarget[]): AddScope {
  if (targets.some((item) => item.id === "project")) return "project";
  if (targets.some((item) => item.id === "user")) return "user";
  return "profile";
}

export function emptyDraft(targets: readonly McpUiWriteTarget[]): AddDraft {
  return { scope: defaultScope(targets), name: "", transport: "stdio", command: "", args: "", url: "", env: "", headers: "" };
}
