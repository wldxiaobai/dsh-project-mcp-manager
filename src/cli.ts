#!/usr/bin/env node
/**
 * dsh-mcp —— Claude Code 风格的 MCP 命令行管理入口。
 *
 * 子命令：add / list / get / remove，均支持 `--scope project|user`（默认 project，
 * 与 CC 一致）。写操作只落在本插件的原生受管文件（project: `<root>/.dsh/mcp.yml`，
 * user: `~/.dsh/mcp.yml`）；`.mcp.json` 与 `~/.claude.json` 是只读兼容层，list/get
 * 会展示它们，remove 遇到只读层的名字时给出指引而不是改文件。
 *
 * 不连接运行中的 dsh 宿主：纯静态读写配置文件，宿主经 watcher 热重载自动收敛。
 * 零新依赖（argv 手写解析）。`runCli(argv, io, deps)` 导出供测试注入。
 *
 * @module
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { extractManagedRows, readPatchFile, writeManagedRows, type PatchRow } from "./mcp-file.js";
import { mcpServerInputSchema, patchRowToView, serverNameFromRowId, toPatchRow, type McpServerInput } from "./model.js";
import { CC_PROJECT_FILE, CLAUDE_USER_FILE, IGNORE_MCP_JSON_ENV, READ_CLAUDE_USER_ENV, claudeUserLayerEnabled, mcpJsonLayerEnabled, readClaudeUserFile, readMcpJsonFile, type McpRowSource, type SourcedRow } from "./cc-file.js";
import { mergeSourcedRows, type IdentityShadow } from "./registry.js";
import { findProjectRoot } from "./project-root.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CliDeps {
  /** 用户层根目录（默认 homedir()，测试注入）。 */
  home?: string;
  /** 项目根解析（默认向上找 .git，测试注入）。 */
  resolveProjectRoot?: (cwd: string) => Promise<string>;
}

interface ParsedArgs {
  positional: string[];
  /** 未显式给出时为 undefined：list 展示全部层；add/remove/get 缺省按 project。 */
  scope?: "project" | "user";
  transport: "stdio" | "http";
  env: Record<string, string>;
  headers: Record<string, string>;
  cwd?: string;
  help: boolean;
}

/** 短名 → 长名；其余以 - 开头的 token 一律按位置参数（服务器命令行）处理。 */
const FLAG_ALIASES: Record<string, string> = { "-s": "--scope", "-t": "--transport", "-e": "--env", "-H": "--header", "-c": "--cwd", "-h": "--help" };
/** 需要取下一个 token 作值的选项名（长名形式）。 */
const VALUE_OPTIONS = new Set(["--scope", "--transport", "--env", "--header", "--cwd"]);

const HELP = `dsh-mcp —— 项目/用户级 MCP 服务器管理（写入原生 .dsh/mcp.yml）

用法：
  dsh-mcp add <name> <command> [args...] [-e KEY=VALUE ...] [-c <cwd>] [--scope project|user]
  dsh-mcp add --transport http <name> <url> [-H "Key: value" ...] [--scope project|user]
  dsh-mcp list [--scope project|user]
  dsh-mcp get <name>
  dsh-mcp remove <name> [--scope project|user]

说明：
  --scope 缺省 project（写 <项目根>/.dsh/mcp.yml）；user 写 ~/.dsh/mcp.yml。
  -c 缺省：project 为 "."（相对项目根）；user 为空（继承会话宿主 cwd，与 CC user 行一致）。
  本项目没有 CC 的 local 作用域；CC 的 ` + "`claude mcp add`" + ` 默认落 local，
  迁移时请显式用 --scope user（或把条目写进 .mcp.json，插件只读兼容）。
  值里的 \${VAR} 原样写入，装载时由插件从宿主环境展开（支持串内插值，凭据不落盘）。
  sse 传输不受支持（后端只支持 stdio 与 streamable-http）。
  list/get 同时展示只读兼容层 .mcp.json 与 ~/.claude.json（不显示任何密钥值）。`

function fail(io: CliIo, message: string): number {
  io.err(`错误：${message}`);
  return 1;
}

function nameOf(row: PatchRow): string | undefined {
  const fromConfig = row.config?.serverName;
  if (typeof fromConfig === "string" && fromConfig !== "") return fromConfig;
  return serverNameFromRowId(row.id);
}

function parseKv(raw: string, separator: string, kind: string): [string, string] | string {
  const index = raw.indexOf(separator);
  if (index <= 0) return `${kind} 需写成 KEY${separator}VALUE：${raw}`;
  return [raw.slice(0, index), raw.slice(index + 1)];
}

/** 以 - 开头且非裸 "-" 的词元才按选项看待。 */
function isOptionLike(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

/** KEY=VALUE / Key: value 型选项落库；返回错误文案或 undefined（成功）。 */
function applyKvOption(target: Record<string, string>, value: string, separator: string, kind: string, trim: boolean): string | undefined {
  const kv = parseKv(value, separator, kind);
  if (typeof kv === "string") return kv;
  const key = trim ? kv[0].trim() : kv[0];
  const val = trim ? kv[1].trim() : kv[1];
  target[key] = val;
  return undefined;
}

/** 取值选项的取值→校验→落库分发（错误文案保持逐字不变）。 */
function applyOption(parsed: ParsedArgs, name: string, value: string): string | undefined {
  switch (name) {
    case "--scope":
      if (value === "project" || value === "user") {
        parsed.scope = value;
        return undefined;
      }
      if (value === "local") return "本插件没有 local 作用域（CC 默认写 local）。请用 --scope user，或把条目放进 .mcp.json 交由只读兼容层装载";
      return `--scope 只支持 project|user，收到：${value}`;
    case "--transport":
      if (value === "stdio" || value === "http") {
        parsed.transport = value;
        return undefined;
      }
      if (value === "sse") return "不支持 sse 传输：装载后端（dsh-mcp-client）只有 stdio 与 streamable-http";
      if (value === "streamable-http") {
        parsed.transport = "http";
        return undefined;
      }
      return `--transport 只支持 stdio|http（别名 streamable-http），收到：${value}`;
    case "--env":
      return applyKvOption(parsed.env, value, "=", "env", false);
    case "--header":
      return applyKvOption(parsed.headers, value, ":", "header", true);
    default:
      parsed.cwd = value;
      return undefined;
  }
}

/**
 * 手搓 argv 解析（零依赖）：`--` 之后全按位置参数；未知「选项」视为服务器命令行
 * token 透传（刻意策略：宁可透传也不误伤 spawn 参数）。
 */
export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const parsed: ParsedArgs = { positional: [], transport: "stdio", env: {}, headers: {}, help: false };
  let cursor = 0;
  let noMoreFlags = false;
  while (cursor < argv.length) {
    const token = argv[cursor++];
    if (noMoreFlags || !isOptionLike(token)) {
      parsed.positional.push(token);
      continue;
    }
    const name = FLAG_ALIASES[token] ?? token;
    if (name === "--") {
      noMoreFlags = true;
      continue;
    }
    if (name === "--help") {
      parsed.help = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) {
      parsed.positional.push(token);
      continue;
    }
    const value = argv[cursor++];
    const error = value === undefined ? `缺少 ${token} 的值` : applyOption(parsed, name, value);
    if (error !== undefined) return { error };
  }
  return parsed;
}

const SOURCE_LABEL: Record<McpRowSource, string> = {
  yml: "project (.dsh/mcp.yml)",
  "cc-project": `project (${CC_PROJECT_FILE})`,
  "user-yml": "user (~/.dsh/mcp.yml)",
  "cc-user": `user (${CLAUDE_USER_FILE})`
};

interface LayerRows {
  source: McpRowSource;
  path: string;
  rows: { name: string; row: PatchRow }[];
  note?: string;
}

function makeLayer(source: McpRowSource, path: string, rows: LayerRows["rows"], note?: string): LayerRows {
  return note === undefined ? { source, path, rows } : { source, path, rows, note };
}

async function resolveProjectRootFor(deps: CliDeps): Promise<string> {
  const finder = deps.resolveProjectRoot ?? ((p: string) => findProjectRoot(p));
  return finder(process.cwd());
}

/** 读一个原生受管 yml 层：ENOENT 视为空层，其余错误转成 note（不抛）。 */
async function readNativeLayer(path: string): Promise<LayerRows> {
  const rows: { name: string; row: PatchRow }[] = [];
  let note: string | undefined;
  try {
    for (const row of extractManagedRows(await readPatchFile(path))) {
      const name = nameOf(row);
      if (name !== undefined) rows.push({ name, row });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ENOENT")) note = `读取失败：${message}`;
  }
  return makeLayer("yml", path, rows, note);
}

/** 只读兼容层的错误注记：文件级优先，坏条目次之，两者皆无则 undefined。 */
function ccLayerNote(cc: { fileError?: string; entryErrors: string[] }): string | undefined {
  if (cc.fileError !== undefined) return `读取失败：${cc.fileError}`;
  if (cc.entryErrors.length > 0) return `坏条目：${cc.entryErrors.join("；")}`;
  return undefined;
}

async function collectLayers(deps: CliDeps): Promise<LayerRows[]> {
  const projectRoot = await resolveProjectRootFor(deps);
  const home = deps.home ?? homedir();
  const layers: LayerRows[] = [];
  // 1) 项目原生 yml
  const ymlPath = join(projectRoot, ".dsh", "mcp.yml");
  const ymlLayer = await readNativeLayer(ymlPath);
  layers.push(makeLayer("yml", ymlLayer.path, ymlLayer.rows, ymlLayer.note));
  // 2) 项目 .mcp.json（只读兼容层；DSH_MCP_IGNORE_MCP_JSON=1 关闭后整层不出现）
  if (mcpJsonLayerEnabled()) {
    const ccPath = join(projectRoot, CC_PROJECT_FILE);
    const cc = await readMcpJsonFile(ccPath, projectRoot);
    layers.push(makeLayer("cc-project", ccPath, cc.rows.map((r) => ({ name: r.rawName, row: r.row })), ccLayerNote(cc)));
  }
  // 3) 用户 ~/.dsh/mcp.yml
  const userYmlPath = join(home, ".dsh", "mcp.yml");
  const userLayer = await readNativeLayer(userYmlPath);
  layers.push(makeLayer("user-yml", userLayer.path, userLayer.rows, userLayer.note));
  // 4) 用户 ~/.claude.json（allowlist 只读；默认关闭，DSH_MCP_READ_CLAUDE_USER=1 启用，
  // 旧开关 DSH_MCP_IGNORE_CLAUDE_JSON=1 强制关闭）
  if (claudeUserLayerEnabled()) {
    const cuPath = join(home, CLAUDE_USER_FILE);
    const cu = await readClaudeUserFile(cuPath);
    layers.push(makeLayer("cc-user", cuPath, cu.rows.map((r) => ({ name: r.rawName, row: r.row })), ccLayerNote(cu)));
  }
  return layers;
}

function describeTarget(row: PatchRow): string {
  const view = patchRowToView(row);
  if (view === undefined) return "(无效行)";
  const config = row.config ?? {};
  if (typeof config.url === "string") return `${config.url} (streamable-http)`;
  const args = Array.isArray(config.args) ? config.args.map(String).join(" ") : "";
  const command = typeof config.command === "string" ? config.command : "?";
  return (args === "" ? command : `${command} ${args}`) + " (stdio)";
}

function isProjectSource(source: McpRowSource): boolean {
  return source === "yml" || source === "cc-project";
}

/** 装载器 mergeSourcedRows 的同一口径：哪些行真正生效、哪些被身份/归一名去重剔除。 */
interface ShadowView {
  /** 将进入装载集合的行对象（按引用；disabled 占名行不在其中）。 */
  effective: Set<PatchRow>;
  /** 被归一名/身份键去重剔除的行：原名 → 剔除明细（同名的先到先得走 seen，不在此列）。 */
  identityLosses: Map<string, IdentityShadow>;
  /** 被任一项目自身行遮蔽的用户层行原名（--scope user 单独展示时的兜底标注）。 */
  shadowedUser: Set<string>;
}

function shadowViewOf(layers: LayerRows[]): ShadowView {
  const merged = mergeSourcedRows(layers.map((layer) => layer.rows.map(({ name, row }): SourcedRow => ({
    rawName: name,
    row,
    source: layer.source,
    disabled: row.disabled === true
  }))));
  const identityLosses = new Map<string, IdentityShadow>();
  for (const shadow of merged.shadowedIdentity) {
    if (!identityLosses.has(shadow.name)) identityLosses.set(shadow.name, shadow);
  }
  return {
    effective: new Set(merged.rows.map((item) => item.row)),
    identityLosses,
    shadowedUser: new Set(merged.shadowedUser)
  };
}

/** 身份去重注记（与注册表告警同措辞），提示行未装载的原因与解法。 */
function identityShadowNote(shadow: IdentityShadow): string {
  return `与 "${shadow.winner}" 同一服务（${shadow.reason === "normname" ? "归一化名称" : "命令与参数"}相同），去重不装载`;
}

function printLayerRows(layer: LayerRows, seen: Map<string, McpRowSource>, view: ShadowView, io: CliIo): number {
  if (layer.note !== undefined) io.out(`${layer.path}: ${layer.note}`);
  let count = 0;
  for (const { name, row } of layer.rows) {
    count++;
    const winner = seen.get(name);
    if (winner === undefined) seen.set(name, layer.source);
    const disabled = row.disabled === true ? ", disabled" : "";
    let shadow = SOURCE_LABEL[layer.source];
    if (winner !== undefined) shadow = `（已被 ${SOURCE_LABEL[winner]} 遮蔽）`;
    else if (row.disabled !== true && !view.effective.has(row)) {
      const loss = view.identityLosses.get(name);
      if (loss !== undefined) shadow = `（${identityShadowNote(loss)}）`;
      else if (view.shadowedUser.has(name)) shadow = "（已被项目自身配置遮蔽）";
    }
    io.out(`  ${name}: ${describeTarget(row)} -- ${shadow}${disabled}`);
  }
  return count;
}

async function resolveScopePaths(scope: "project" | "user" | undefined, deps: CliDeps): Promise<{ ymlPath: string; root: string }> {
  const home = deps.home ?? homedir();
  if (scope === "user") return { ymlPath: join(home, ".dsh", "mcp.yml"), root: home };
  const root = await resolveProjectRootFor(deps);
  return { ymlPath: join(root, ".dsh", "mcp.yml"), root };
}

async function cmdAdd(parsed: ParsedArgs, rest: string[], io: CliIo, deps: CliDeps): Promise<number> {
  const [name, target, ...args] = rest;
  if (name === undefined || target === undefined) return fail(io, "用法：dsh-mcp add <name> <command|url> [args...]");
  let input: unknown;
  if (parsed.transport === "stdio") {
    // user scope 缺省 cwd 空串 = 继承宿主 cwd（对齐 CC 的 user 行语义）；
    // project scope 缺省 "." = 项目根。同一用户层不应被 CLI 行绑死在某个项目根。
    input = { serverName: name, transport: "stdio", command: target, args, env: parsed.env, cwd: parsed.cwd ?? (parsed.scope === "user" ? "" : ".") };
  } else {
    if (args.length > 0) return fail(io, "http 传输只接受一个 URL 参数");
    input = { serverName: name, transport: "streamable-http", url: target, headers: parsed.headers };
  }
  const validated = mcpServerInputSchema.safeParse(input);
  if (!validated.success) {
    const first = validated.error.issues[0];
    const detail = first === undefined ? "）" : `（${first.path.join(".")}：${first.message}）`;
    return fail(io, `配置无效${detail}`);
  }
  const { ymlPath } = await resolveScopePaths(parsed.scope, deps);
  let rows: PatchRow[] = [];
  try {
    rows = extractManagedRows(await readPatchFile(ymlPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ENOENT")) return fail(io, `现有配置不可用：${message}`);
  }
  if (rows.some((row) => nameOf(row) === name)) return fail(io, `"${name}" 已存在于 ${ymlPath}；先 dsh-mcp remove ${name} --scope ${parsed.scope ?? "project"}`);
  await mkdir(dirname(ymlPath), { recursive: true });
  await writeManagedRows(ymlPath, [...rows, toPatchRow(validated.data as McpServerInput)], { createIfMissing: true });
  io.out(`已添加 ${parsed.transport === "stdio" ? "stdio" : "http"} 服务器 "${name}" → ${ymlPath}`);
  io.out("运行中的 dsh 会话会经文件监听自动收敛（宿主未运行时下次启动生效）。");
  return 0;
}

async function cmdList(parsed: ParsedArgs, io: CliIo, deps: CliDeps): Promise<number> {
  const allLayers = await collectLayers(deps);
  const view = shadowViewOf(allLayers);
  const cu = allLayers.find((layer) => layer.source === "cc-user");
  if (cu !== undefined && cu.rows.length > 0) io.out(`提示：cc-user 层已启用（${READ_CLAUDE_USER_ENV}=1），~/${CLAUDE_USER_FILE} 的 ${cu.rows.length} 条服务器将并入各项目的生效集合。`);
  const layers = parsed.scope === undefined
    ? allLayers
    : allLayers.filter((layer) => isProjectSource(layer.source) === (parsed.scope === "project"));
  const seen = new Map<string, McpRowSource>();
  let total = 0;
  for (const layer of layers) total += printLayerRows(layer, seen, view, io);
  if (total === 0 && layers.every((layer) => layer.note === undefined)) io.out("未配置 MCP 服务器（dsh-mcp add 添加）。");
  return 0;
}

function commandLineOf(config: Record<string, unknown>): string {
  const command = typeof config.command === "string" ? config.command : "";
  const args = Array.isArray(config.args) ? config.args.map(String).join(" ") : "";
  return `Command:  ${command} ${args}`.trimEnd();
}

function kvLine(label: string, keys: string[] | undefined): string | undefined {
  if (keys === undefined || keys.length === 0) return undefined;
  return `${label}${keys.map((key) => `${key}=<configured>`).join(" ")}`;
}

function printServerDetails(hit: { name: string; row: PatchRow; layer: LayerRows }, io: CliIo): void {
  io.out(`Name:     ${hit.name}`);
  io.out(`Source:   ${SOURCE_LABEL[hit.layer.source]}`);
  io.out(`File:     ${hit.layer.path}`);
  const config = hit.row.config ?? {};
  io.out(`Transport: ${config.transport === "streamable-http" ? "http (streamable-http)" : "stdio"}`);
  if (typeof config.url === "string") io.out(`URL:      ${config.url}`);
  else {
    io.out(commandLineOf(config));
    if (typeof config.cwd === "string") io.out(`CWD:      ${config.cwd}`);
  }
  const view = patchRowToView(hit.row);
  const env = kvLine("Env:      ", view?.envKeys);
  if (env !== undefined) io.out(env);
  const headers = kvLine("Headers:  ", view?.headerKeys);
  if (headers !== undefined) io.out(headers);
  if (hit.row.disabled === true) io.out("注意：     该行被标记 disabled，不会装载。");
}

function getMissMessage(name: string): string {
  const offNotes: string[] = [];
  if (!mcpJsonLayerEnabled()) offNotes.push(`${CC_PROJECT_FILE} 层已停用（${IGNORE_MCP_JSON_ENV}=1）`);
  if (!claudeUserLayerEnabled()) offNotes.push(`~/${CLAUDE_USER_FILE} 层未启用（设 ${READ_CLAUDE_USER_ENV}=1 才读取）`);
  const tail = offNotes.length > 0 ? "；" + offNotes.join("；") : "";
  return `未找到服务器 "${name}"（已查 .dsh/mcp.yml、${CC_PROJECT_FILE}、~/.dsh/mcp.yml、~/${CLAUDE_USER_FILE}${tail}）`;
}

async function cmdGet(rest: string[], io: CliIo, deps: CliDeps): Promise<number> {
  const name = rest[0];
  if (name === undefined) return fail(io, "用法：dsh-mcp get <name>");
  const layers = await collectLayers(deps);
  const found = layers.flatMap((layer) => layer.rows.filter((r) => r.name === name).map((r) => ({ ...r, layer })));
  if (found.length === 0) return fail(io, getMissMessage(name));
  printServerDetails(found[0], io);
  // 与装载器同口径：详情展示的是文件里的定义，但该定义未必是生效的那条。
  const top = found[0];
  if (top.row.disabled !== true) {
    const view = shadowViewOf(layers);
    if (!view.effective.has(top.row)) {
      const loss = view.identityLosses.get(top.name);
      if (loss !== undefined) io.out(`注意：     该行未实际装载——${identityShadowNote(loss)}；确属不同服务器请改名或调整命令与参数。`);
      else if (view.shadowedUser.has(top.name)) io.out("注意：     该行未实际装载——已被项目自身配置的同名/同服务定义遮蔽。");
    }
  }
  for (const loser of found.slice(1)) io.out(`注意：     ${SOURCE_LABEL[loser.layer.source]} 中的同名 "${name}" 被上面来源遮蔽。`);
  return 0;
}

async function cmdRemove(parsed: ParsedArgs, rest: string[], io: CliIo, deps: CliDeps): Promise<number> {
  const name = rest[0];
  if (name === undefined) return fail(io, "用法：dsh-mcp remove <name> [--scope project|user]");
  const { ymlPath } = await resolveScopePaths(parsed.scope, deps);
  let rows: PatchRow[];
  try {
    rows = extractManagedRows(await readPatchFile(ymlPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) return fail(io, `${parsed.scope ?? "project"} 作用域下没有配置文件：${ymlPath}`);
    return fail(io, `配置文件不可读：${message}`);
  }
  const kept = rows.filter((row) => nameOf(row) !== name);
  if (kept.length === rows.length) {
    const readOnlyHit = await findReadOnlyLayerHit(name, deps);
    if (readOnlyHit !== undefined) return fail(io, `"${name}" 只在只读兼容层 ${readOnlyHit.path} 中；本 CLI 不改写 CC 格式文件，请直接编辑该文件`);
    return fail(io, `"${name}" 不在 ${ymlPath} 中`);
  }
  await writeManagedRows(ymlPath, kept);
  io.out(`已移除 "${name}"（${ymlPath}）。`);
  return 0;
}

async function findReadOnlyLayerHit(name: string, deps: CliDeps): Promise<LayerRows | undefined> {
  const layers = await collectLayers(deps);
  return layers.find((layer) => (layer.source === "cc-project" || layer.source === "cc-user") && layer.rows.some((r) => r.name === name));
}

export async function runCli(argv: string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) return fail(io, parsed.error);
  const [command, ...rest] = parsed.positional;
  if (parsed.help || command === undefined || command === "help") {
    io.out(HELP);
    return command === undefined && !parsed.help ? fail(io, "缺少子命令（add|list|get|remove）") : 0;
  }
  switch (command) {
    case "add":
      return cmdAdd(parsed, rest, io, deps);
    case "list":
      return cmdList(parsed, io, deps);
    case "get":
      return cmdGet(rest, io, deps);
    case "remove":
      return cmdRemove(parsed, rest, io, deps);
    default:
      return fail(io, `未知子命令：${command}（支持 add|list|get|remove，dsh-mcp --help 查看用法）`);
  }
}

// 直接执行入口（node lib/cli.js … 或 npm bin shim）
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const code = await runCli(process.argv.slice(2), {
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n")
  });
  process.exitCode = code;
}
