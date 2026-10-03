/**
 * 把剪贴板里的一份 MCP 配置收成添加表单的字段。
 * 认 JSON，也认 YAML：单个条目、`mcpServers` / `servers` 映射、
 * 以及受管 yml 的 insert 行。保存位置不在这里决定。
 */
import { parseAllDocuments } from "yaml";

export interface PastedServerFields {
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  env: string;
  headers: string;
}

export type PasteConfigFailure = "empty" | "parse" | "none" | "sse" | "both" | "command" | "url" | "fields" | "transport";

export type PasteConfigResult =
  | { ok: true; fields: PastedServerFields; skipped: number }
  | { ok: false; reason: PasteConfigFailure };

interface Candidate {
  name: string;
  entry: Record<string, unknown>;
}

const MANAGED_ID_PREFIX = "panel-mcp-";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeServer(entry: Record<string, unknown>): boolean {
  return "command" in entry || "args" in entry || "url" in entry || "httpUrl" in entry
    || "headers" in entry || "type" in entry || "transport" in entry || "env" in entry;
}

function pushEntry(candidates: Candidate[], name: string, entry: unknown): void {
  if (!isRecord(entry) || entry.enabled === false) return;
  candidates.push({ name: name.trim(), entry });
}

function collectServerMap(map: unknown, candidates: Candidate[]): void {
  if (!isRecord(map)) return;
  for (const [name, entry] of Object.entries(map)) pushEntry(candidates, name, entry);
}

function managedCandidate(value: Record<string, unknown>): Candidate | undefined {
  const config = value.config;
  if (!isRecord(config) || (!looksLikeServer(config) && typeof config.serverName !== "string")) return undefined;
  const serverName = typeof config.serverName === "string" ? config.serverName.trim() : "";
  const id = typeof value.id === "string" && value.id.startsWith(MANAGED_ID_PREFIX) ? value.id.slice(MANAGED_ID_PREFIX.length) : "";
  return { name: serverName !== "" ? serverName : id, entry: config };
}

function collectRecord(value: Record<string, unknown>, candidates: Candidate[]): void {
  if ("mcpServers" in value || "servers" in value) {
    let map = value.mcpServers;
    if (!isRecord(map)) map = value.servers;
    collectServerMap(map, candidates);
    return;
  }
  if (Array.isArray(value.insert)) {
    collect(value.insert, candidates);
    return;
  }
  const managed = managedCandidate(value);
  if (managed !== undefined) {
    pushEntry(candidates, managed.name, managed.entry);
    return;
  }
  if (looksLikeServer(value)) {
    const serverName = typeof value.serverName === "string" ? value.serverName.trim() : "";
    pushEntry(candidates, serverName, value);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > 0 && entries.every(([, entry]) => isRecord(entry) && looksLikeServer(entry))) {
    collectServerMap(value, candidates);
  }
}

function collect(value: unknown, candidates: Candidate[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, candidates);
    return;
  }
  if (isRecord(value)) collectRecord(value, candidates);
}

type Declared = "stdio" | "http" | "sse" | "conflict" | "unknown" | undefined;

function mapTransport(raw: unknown): Declared {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "stdio") return "stdio";
  if (value === "http" || value === "streamable-http") return "http";
  if (value === "sse") return "sse";
  return "unknown";
}

function declaredTransport(entry: Record<string, unknown>): Declared {
  const fromType = mapTransport(entry.type);
  const fromTransport = mapTransport(entry.transport);
  if (fromType === "sse" || fromTransport === "sse") return "sse";
  if (fromType === "unknown" || fromTransport === "unknown") return "unknown";
  if (fromType !== undefined && fromTransport !== undefined && fromType !== fromTransport) return "conflict";
  return fromTransport ?? fromType;
}

function remoteUrl(entry: Record<string, unknown>): string {
  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  const httpUrl = typeof entry.httpUrl === "string" ? entry.httpUrl.trim() : "";
  if (url !== "" && httpUrl !== "" && url !== httpUrl) return "mismatch";
  return httpUrl !== "" ? httpUrl : url;
}

function argLines(args: unknown): string | undefined {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  if (!Array.isArray(args)) return undefined;
  const lines: string[] = [];
  for (const item of args) {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") return undefined;
    lines.push(String(item));
  }
  return lines.join("\n");
}

function pairLines(value: unknown, separator: "=" | ": "): string | undefined {
  if (value === undefined || value === null) return "";
  if (!isRecord(value)) return undefined;
  const lines: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") return undefined;
    lines.push(`${key}${separator}${String(item)}`);
  }
  return lines.join("\n");
}

function convert(candidate: Candidate): { ok: true; fields: PastedServerFields } | { ok: false; reason: PasteConfigFailure } {
  const entry = candidate.entry;
  const declared = declaredTransport(entry);
  if (declared === "sse") return { ok: false, reason: "sse" };
  if (declared === "conflict" || declared === "unknown") return { ok: false, reason: "transport" };
  const url = remoteUrl(entry);
  if (url === "mismatch") return { ok: false, reason: "fields" };
  const command = typeof entry.command === "string" ? entry.command.trim() : "";
  const http = declared === "http" || (declared === undefined && url !== "" && command === "");
  if (!http && declared === undefined && command !== "" && url !== "") return { ok: false, reason: "both" };
  const args = argLines(entry.args);
  const env = pairLines(entry.env, "=");
  const headers = pairLines(entry.headers, ": ");
  if (args === undefined || env === undefined || headers === undefined) return { ok: false, reason: "fields" };
  if (http) {
    if (url === "") return { ok: false, reason: "url" };
    return {
      ok: true,
      fields: { name: candidate.name, transport: "http", command: "", args: "", url, env: "", headers }
    };
  }
  if (command === "") return { ok: false, reason: "command" };
  return {
    ok: true,
    fields: { name: candidate.name, transport: "stdio", command, args, url: "", env, headers: "" }
  };
}

export function parsePastedConfig(text: string): PasteConfigResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  let documents;
  try {
    documents = parseAllDocuments(trimmed);
  } catch {
    return { ok: false, reason: "parse" };
  }
  const candidates: Candidate[] = [];
  let sawError = false;
  for (const document of documents) {
    if (document.errors.length > 0) {
      sawError = true;
      continue;
    }
    collect(document.toJS(), candidates);
  }
  if (candidates.length === 0) return { ok: false, reason: sawError ? "parse" : "none" };
  const filled: PastedServerFields[] = [];
  let firstFailure: PasteConfigFailure | undefined;
  for (const candidate of candidates) {
    const result = convert(candidate);
    if (result.ok) filled.push(result.fields);
    else firstFailure ??= result.reason;
  }
  const fields = filled[0];
  if (fields === undefined) return { ok: false, reason: firstFailure ?? "none" };
  return { ok: true, fields, skipped: filled.length - 1 };
}
