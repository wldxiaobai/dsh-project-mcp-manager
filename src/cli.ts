#!/usr/bin/env node
/**
 * dsh-mcp —— Claude Code 风格的 MCP 命令行管理入口。
 *
 * 子命令：add / list / get / remove，均支持 `--scope project|user`（默认 project，
 * 与 CC 一致）。写操作只落在本插件的原生受管文件（project: `<root>/.dsh/mcp.yml`，
 * user: `~/.dsh/mcp.yml`）；`.mcp.json` 是遗留只读层，list/get
 * 会展示它，remove 遇到只读层的名字时给出指引而不是改文件。
 *
 * 不连接运行中的 dsh 宿主：纯静态读写配置文件，宿主经 watcher 热重载自动收敛。
 * 零新依赖（argv 手写解析）。`runCli(argv, io, deps)` 导出供测试注入。
 *
 * @module
 */
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readdir } from "node:fs/promises";
import { extractManagedRows, readPatchFile, updateManagedRows, type PatchRow } from "./mcp-file.js";
import { byCodeUnit, mcpServerInputSchema, parseCliTransport, patchRowToView, rowNameOf, toPatchRow, type McpServerInput } from "./model.js";
import { CC_PROJECT_FILE, IGNORE_MCP_JSON_ENV, JSON_MCP_FILE, mcpJsonLayerEnabled, readDshJsonFile, readMcpJsonFile, type JsonReadResult, type McpRowSource, type SourcedRow } from "./json-file.js";
import { MCP_YML_FILE, dshHomeFor, profileMcpJsonFile, userLayerPathsIn } from "./dsh-paths.js";
import { readJsonServers, toJsonEntry, updateJsonServers } from "./json-write.js";
import { mergeSourcedRows, projectDshJsonFile, projectMcpFile, projectMcpJsonFile, type IdentityShadow } from "./registry.js";
import { findProjectRoot } from "./project-root.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CliDeps {
  /** 用户主目录（测试注入）：给出时用户层固定为 `<home>/.dsh`，忽略 `$DSH_HOME`。 */
  home?: string;
  /** 项目根解析（默认向上找 .git，测试注入）。 */
  resolveProjectRoot?: (cwd: string) => Promise<string>;
}

/** 用户层根目录：`deps.home` 注入优先，否则 `$DSH_HOME`，再否则 `~/.dsh`。 */
function dshHomeOf(deps: CliDeps): string {
  return dshHomeFor(deps.home);
}

interface ParsedArgs {
  positional: string[];
  /** 未显式给出时为 undefined：list 展示全部层；add/remove/get 缺省按 project。 */
  scope?: "project" | "user" | "profile";
  /** 写入格式：缺省时取 DSH_MCP_CLI_FORMAT，再缺省 yml。 */
  format?: "yml" | "json";
  /** --scope profile 的目标 profile 名。 */
  profile?: string;
  transport: "stdio" | "http";
  env: Record<string, string>;
  headers: Record<string, string>;
  cwd?: string;
  help: boolean;
}

/** 短名 → 长名；其余以 - 开头的 token 一律按位置参数（服务器命令行）处理。 */
const FLAG_ALIASES: Record<string, string> = { "-s": "--scope", "-t": "--transport", "-e": "--env", "-H": "--header", "-c": "--cwd", "-f": "--format", "-p": "--profile", "-h": "--help" };
/** 需要取下一个 token 作值的选项名（长名形式）。 */
const VALUE_OPTIONS = new Set(["--scope", "--transport", "--env", "--header", "--cwd", "--format", "--profile"]);
/** CLI 写入格式的默认值开关：`yml`（默认）或 `json`；`--format` 优先。 */
export const CLI_FORMAT_ENV = "DSH_MCP_CLI_FORMAT";

const HELP = `dsh-mcp —— 项目/用户/profile 级 MCP 服务器管理（原生 yml 或 DSH JSON）

用法：
  dsh-mcp add <name> <command> [args...] [-e KEY=VALUE ...] [-c <cwd>] [--scope project|user|profile] [--format yml|json]
  dsh-mcp add --transport http <name> <url> [-H "Key: value" ...] [--scope project|user|profile] [--format yml|json]
  dsh-mcp list [--scope project|user]
  dsh-mcp get <name>
  dsh-mcp remove <name> [--scope project|user|profile] [--format yml|json]

写入位置：
  project（缺省）  <项目根>/.dsh/mcp.yml（--format json → <项目根>/.dsh/mcp.json）
  user             ~/.dsh/mcp.yml（--format json → ~/.dsh/mcp.json）
  profile          ~/.dsh/profiles/<name>/mcp.json（须配 --profile <name>；只支持 json）
  --format 缺省取 \${${CLI_FORMAT_ENV}}（yml|json），未设时按 yml；两者都不写时以 yml 为准。
  JSON 文件由本 CLI 独占：写入保留其他顶层键，但不保留注释与排版。

读取与优先序（逐行先到先得，同名/同服务只装载高优先层一条）：
  .dsh/mcp.yml > .dsh/mcp.json > .mcp.json（遗留只读） > profile json > ~/.dsh/mcp.yml > ~/.dsh/mcp.json
  用户层为全局装载（宿主级一条连接，所有项目可见）；项目层按会话隔离。

其他：
  -c 缺省：project 为 "."（相对项目根）；user/profile 为空（继承宿主 cwd）。
  值里的 \${VAR} 原样写入，装载时由插件从宿主环境展开（支持串内插值，凭据不落盘）。
  sse 为 MCP SSE 端点传输，不受支持（后端只支持 stdio 与 streamable-http；把 type 改为 http，或删除 type 只留 url）。
  list/get 展示全部来源层（含遗留只读层），不显示任何密钥值。`

function fail(io: CliIo, message: string): number {
  io.err(`错误：${message}`);
  return 1;
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
      if (value === "project" || value === "user" || value === "profile") {
        parsed.scope = value;
        return undefined;
      }
      if (value === "local") return "本插件没有 local 作用域（CC 默认写 local）。请用 --scope user，或把条目放进 .mcp.json 交由只读兼容层装载";
      return `--scope 只支持 project|user|profile，收到：${value}`;
    case "--format":
      if (value === "yml" || value === "json") {
        parsed.format = value;
        return undefined;
      }
      return `--format 只支持 yml|json，收到：${value}`;
    case "--profile":
      if (value === "") return "--profile 需要 profile 名";
      parsed.profile = value;
      return undefined;
    case "--transport": {
      const parsedTransport = parseCliTransport(value);
      if ("error" in parsedTransport) return parsedTransport.error;
      parsed.transport = parsedTransport.transport;
      return undefined;
    }
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
  "dsh-project": "project (.dsh/mcp.yml)",
  "dsh-project-json": "project (.dsh/mcp.json)",
  "cc-project": `project (${CC_PROJECT_FILE}, read-only)`,
  "dsh-profile-user": "profile (mcp.json)",
  "dsh-user-yml": "user (~/.dsh/mcp.yml)",
  "dsh-user": "user (~/.dsh/mcp.json)"
};

interface LayerRows {
  source: McpRowSource;
  path: string;
  rows: { name: string; row: PatchRow }[];
  note?: string;
  /** 覆盖 SOURCE_LABEL 的展示名（profile 层需要带 profile 名）。 */
  label?: string;
}

function makeLayer(source: McpRowSource, path: string, rows: LayerRows["rows"], note?: string, label?: string): LayerRows {
  return {
    source,
    path,
    rows,
    ...(note === undefined ? {} : { note }),
    ...(label === undefined ? {} : { label })
  };
}

/** 层的展示名：profile 层用带名 label，其余走固定表。 */
function sourceLabel(layer: LayerRows): string {
  return layer.label ?? SOURCE_LABEL[layer.source];
}

async function resolveProjectRootFor(deps: CliDeps): Promise<string> {
  const finder = deps.resolveProjectRoot ?? ((p: string) => findProjectRoot(p));
  return finder(process.cwd());
}

/** 读一个原生受管 yml 层：ENOENT 视为空层，其余错误转成 note（不抛）。 */
async function readNativeLayer(path: string, source: McpRowSource): Promise<LayerRows> {
  const rows: { name: string; row: PatchRow }[] = [];
  let note: string | undefined;
  try {
    for (const row of extractManagedRows(await readPatchFile(path))) {
      const name = rowNameOf(row);
      if (name !== undefined) rows.push({ name, row });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ENOENT")) note = `读取失败：${message}`;
  }
  return makeLayer(source, path, rows, note);
}

/** JSON 层（DSH 方言与遗留只读层同用）的错误注记：文件级优先，坏条目次之，两者皆无则 undefined。 */
function layerNote(result: { fileError?: string; entryErrors: string[] }): string | undefined {
  if (result.fileError !== undefined) return `读取失败：${result.fileError}`;
  if (result.entryErrors.length > 0) return `坏条目：${result.entryErrors.join("；")}`;
  return undefined;
}

/** 读一个 DSH 自有 JSON 层（缺文件=空层）。 */
async function readJsonLayer(path: string, source: McpRowSource, cwdPolicy: "project" | "host", projectRoot: string, label?: string): Promise<LayerRows> {
  const result: JsonReadResult = await readDshJsonFile(path, { source, cwdPolicy, projectRoot });
  return makeLayer(source, path, result.rows.map((r) => ({ name: r.rawName, row: r.row })), layerNote(result), label);
}

/** 枚举 `<dshHome>/profiles/<name>/mcp.json`：每个存在的 profile 各一层。 */
async function collectProfileLayers(profilesDir: string): Promise<LayerRows[]> {
  let names: string[] = [];
  try {
    names = (await readdir(profilesDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const out: LayerRows[] = [];
  // profile 名按码元序排（byCodeUnit）：与 Array#sort 默认等价，比较器显式化声明口径。
  names.sort(byCodeUnit);
  for (const name of names) {
    const path = profileMcpJsonFile(profilesDir, name);
    const layer = await readJsonLayer(path, "dsh-profile-user", "host", "", `profile (${name})`);
    if (layer.rows.length === 0 && layer.note === undefined) continue;
    out.push(layer);
  }
  return out;
}

async function collectLayers(deps: CliDeps): Promise<LayerRows[]> {
  const projectRoot = await resolveProjectRootFor(deps);
  const userPaths = userLayerPathsIn(dshHomeOf(deps));
  const layers: LayerRows[] = [];
  // 1) 项目原生 yml；2) 项目 .dsh/mcp.json（DSH 自有 JSON 方言）
  layers.push(
    await readNativeLayer(projectMcpFile(projectRoot), "dsh-project"),
    await readJsonLayer(projectDshJsonFile(projectRoot), "dsh-project-json", "project", projectRoot)
  );
  // 3) 项目 .mcp.json（遗留只读层；DSH_MCP_IGNORE_MCP_JSON=1 关闭后整层不出现）
  if (mcpJsonLayerEnabled()) {
    const ccPath = projectMcpJsonFile(projectRoot);
    const cc = await readMcpJsonFile(ccPath, projectRoot);
    layers.push(makeLayer("cc-project", ccPath, cc.rows.map((r) => ({ name: r.rawName, row: r.row })), layerNote(cc)));
  }
  // 4) profile 用户层（每个已存在的 profile 各一层）；5) 用户 <dshHome>/mcp.yml；6) 用户 <dshHome>/mcp.json
  // 单次 push：实参自左向右求值，层序（即影子优先序）与分开写完全一致。
  layers.push(
    ...await collectProfileLayers(userPaths.profilesDir),
    await readNativeLayer(userPaths.mcpYml, "dsh-user-yml"),
    await readJsonLayer(userPaths.mcpJson, "dsh-user", "host", "")
  );
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
  return source === "dsh-project" || source === "dsh-project-json" || source === "cc-project";
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

/** seen 存的是胜者层的展示名（不是 source 枚举）：profile 胜者要带 profile 名。 */
function printLayerRows(layer: LayerRows, seen: Map<string, string>, view: ShadowView, io: CliIo): number {
  if (layer.note !== undefined) io.out(`${layer.path}: ${layer.note}`);
  let count = 0;
  for (const { name, row } of layer.rows) {
    count++;
    const winner = seen.get(name);
    if (winner === undefined) seen.set(name, sourceLabel(layer));
    const disabled = row.disabled === true ? ", disabled" : "";
    let shadow = sourceLabel(layer);
    if (winner !== undefined) shadow = `（已被 ${winner} 遮蔽）`;
    else if (row.disabled !== true && !view.effective.has(row)) {
      const loss = view.identityLosses.get(name);
      if (loss !== undefined) shadow = `（${identityShadowNote(loss)}）`;
      else if (view.shadowedUser.has(name)) shadow = "（已被项目自身配置遮蔽）";
    }
    io.out(`  ${name}: ${describeTarget(row)} -- ${shadow}${disabled}`);
  }
  return count;
}

/** 写入格式：`--format` > `DSH_MCP_CLI_FORMAT` > yml。非法环境变量值即报错。 */
function resolveFormat(parsed: ParsedArgs): { format: "yml" | "json" } | { error: string } {
  if (parsed.format !== undefined) return { format: parsed.format };
  const raw = process.env[CLI_FORMAT_ENV];
  if (raw === undefined || raw === "") return { format: "yml" };
  if (raw === "yml" || raw === "json") return { format: raw };
  return { error: `${CLI_FORMAT_ENV} 只支持 yml|json，收到：${raw}` };
}

/** 一个可写目标：文件路径 + 方言（yml 受管块 / json 独占）。 */
interface WriteTarget {
  path: string;
  format: "yml" | "json";
  /** 展示用作用域名（错误信息里用）。 */
  scope: "project" | "user" | "profile";
}

/** profile 名 → 配置文件路径；未指定时列出可用 profile 供报错。 */
async function resolveProfileTarget(parsed: ParsedArgs, deps: CliDeps): Promise<WriteTarget | { error: string }> {
  const { profilesDir } = userLayerPathsIn(dshHomeOf(deps));
  let available: string[] = [];
  try {
    available = (await readdir(profilesDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    available = [];
  }
  const name = parsed.profile;
  if (name === undefined) {
    const list = available.length === 0 ? "（未发现任何 profile）" : available.join("、");
    return { error: `--scope profile 需要 --profile <name>；可用：${list}` };
  }
  if (!available.includes(name)) {
    const list = available.length === 0 ? "（未发现任何 profile）" : available.join("、");
    return { error: `profile "${name}" 不存在于 ${profilesDir}；可用：${list}` };
  }
  if (parsed.format === "yml") return { error: "--scope profile 只支持 json（profile 层没有 yml 文件）" };
  return { path: profileMcpJsonFile(profilesDir, name), format: "json", scope: "profile" };
}

/** 一个作用域目录（`<root>/.dsh` 或 `<dshHome>`）下的方言文件路径。 */
function targetIn(dir: string, format: "yml" | "json", scope: WriteTarget["scope"]): WriteTarget {
  return { path: join(dir, format === "json" ? JSON_MCP_FILE : MCP_YML_FILE), format, scope };
}

async function resolveWriteTarget(parsed: ParsedArgs, deps: CliDeps): Promise<WriteTarget | { error: string }> {
  const resolved = resolveFormat(parsed);
  if ("error" in resolved) return resolved;
  if (parsed.scope === "profile") return resolveProfileTarget(parsed, deps);
  if (parsed.scope === "user") return targetIn(dshHomeOf(deps), resolved.format, "user");
  return targetIn(join(await resolveProjectRootFor(deps), ".dsh"), resolved.format, "project");
}

/** 目标文件里已有的服务器名（按方言读；文件缺失/空 → 空集合）。 */
async function existingNames(target: WriteTarget): Promise<string[] | { error: string }> {
  if (target.format === "json") {
    try {
      return Object.keys(await readJsonServers(target.path));
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  try {
    return extractManagedRows(await readPatchFile(target.path)).map((row) => rowNameOf(row)).filter((name): name is string => name !== undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) return [];
    return { error: `现有配置不可用：${message}` };
  }
}

async function cmdAdd(parsed: ParsedArgs, rest: string[], io: CliIo, deps: CliDeps): Promise<number> {
  const [name, target, ...args] = rest;
  if (name === undefined || target === undefined) return fail(io, "用法：dsh-mcp add <name> <command|url> [args...]");
  let input: unknown;
  if (parsed.transport === "stdio") {
    // 全局作用域（user/profile）缺省 cwd 空串 = 继承宿主 cwd；
    // project scope 缺省 "." = 项目根。同一用户层不应被 CLI 行绑死在某个项目根。
    const globalScope = parsed.scope === "user" || parsed.scope === "profile";
    input = { serverName: name, transport: "stdio", command: target, args, env: parsed.env, cwd: parsed.cwd ?? (globalScope ? "" : ".") };
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
  const targetFile = await resolveWriteTarget(parsed, deps);
  if ("error" in targetFile) return fail(io, targetFile.error);
  const names = await existingNames(targetFile);
  if (!Array.isArray(names)) return fail(io, names.error);
  if (names.includes(name)) {
    const profileFlag = parsed.profile === undefined ? "" : ` --profile ${parsed.profile}`;
    return fail(io, `"${name}" 已存在于 ${targetFile.path}；先 dsh-mcp remove ${name} --scope ${targetFile.scope}${profileFlag}`);
  }
  const serverInput = validated.data as McpServerInput;
  if (targetFile.format === "json") {
    await mkdir(dirname(targetFile.path), { recursive: true });
    try {
      // 锁内读-改-写：并发 add 不会互相覆盖。
      await updateJsonServers(targetFile.path, (servers) => {
        if (servers[name] !== undefined) throw new Error(`"${name}" 已存在于 ${targetFile.path}`);
        servers[name] = toJsonEntry(serverInput);
      });
    } catch (error) {
      return fail(io, error instanceof Error ? error.message : String(error));
    }
  } else {
    try {
      // 锁内读-改-写：并发 add 不丢行；判重放进 mutate 里按锁内最新内容判定。
      await updateManagedRows(targetFile.path, (rows) => {
        if (rows.some((row) => rowNameOf(row) === name)) throw new Error(`"${name}" 已存在于 ${targetFile.path}`);
        return [...rows, toPatchRow(serverInput)];
      }, { createIfMissing: true });
    } catch (error) {
      return fail(io, error instanceof Error ? error.message : String(error));
    }
  }
  io.out(`已添加 ${parsed.transport === "stdio" ? "stdio" : "http"} 服务器 "${name}" → ${targetFile.path}`);
  io.out("运行中的 dsh 会话会经文件监听自动收敛（宿主未运行时下次启动生效）。");
  await warnAddShadowed(name, targetFile, io, deps);
  return 0;
}

/**
 * 写入成功后按装载器口径复核：新行是否会被更高优先层遮蔽（同名或同服务），
 * 以及同一作用域的另一方言文件里是否也有条目（"双真相"提示）。
 * 只提示不失败——文件已经写成功了。
 */
async function warnAddShadowed(name: string, target: WriteTarget, io: CliIo, deps: CliDeps): Promise<void> {
  const layers = await collectLayers(deps);
  const hit = layers.find((layer) => isSameLayerFile(layer.path, target.path))?.rows.find((row) => row.name === name);
  if (hit !== undefined) {
    const view = shadowViewOf(layers);
    if (!view.effective.has(hit.row)) {
      const loss = view.identityLosses.get(name);
      if (loss !== undefined) io.out(`注意：该行不会装载——${identityShadowNote(loss)}；确属不同服务器请改名或调整命令与参数。`);
      else {
        const winner = layers.find((layer) => !isSameLayerFile(layer.path, target.path) && layer.rows.some((row) => row.name === name));
        const where = winner === undefined ? "更高优先层" : sourceLabel(winner);
        io.out(`注意：该行不会装载——已被 ${where} 的同名定义遮蔽。`);
      }
    }
  }
  // 同作用域另一方言：两份文件同时有内容时，改错文件是常见事故（设计提案自述的「双真相」）。
  const other = target.format === "json"
    ? { path: join(dirname(target.path), MCP_YML_FILE), label: "yml" }
    : { path: join(dirname(target.path), JSON_MCP_FILE), label: "json" };
  const otherRows = layers.find((layer) => isSameLayerFile(layer.path, other.path))?.rows.length ?? 0;
  if (otherRows > 0) io.out(`提示：同作用域的 ${other.path} 还有 ${otherRows} 条服务器定义（本次写入 ${target.path}）。`);
}

/** 层文件路径比较（Windows 大小写不敏感）。 */
function isSameLayerFile(left: string, right: string): boolean {
  const norm = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
  return norm(left) === norm(right);
}

async function cmdList(parsed: ParsedArgs, io: CliIo, deps: CliDeps): Promise<number> {
  const allLayers = await collectLayers(deps);
  const view = shadowViewOf(allLayers);
  const layers = parsed.scope === undefined
    ? allLayers
    : allLayers.filter((layer) => isProjectSource(layer.source) === (parsed.scope === "project"));
  const seen = new Map<string, string>();
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
  io.out(`Source:   ${sourceLabel(hit.layer)}`);
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

/** 未命中提示：已查层由 collectLayers 的实际结果拼出（六层，不是写死的三层）。 */
function getMissMessage(name: string, layers: LayerRows[]): string {
  const offNotes: string[] = [];
  if (!mcpJsonLayerEnabled()) offNotes.push(`${CC_PROJECT_FILE} 层已停用（${IGNORE_MCP_JSON_ENV}=1）`);
  const tail = offNotes.length > 0 ? "；" + offNotes.join("；") : "";
  return `未找到服务器 "${name}"（已查 ${layers.map((layer) => layer.path).join("、")}${tail}）`;
}

async function cmdGet(rest: string[], io: CliIo, deps: CliDeps): Promise<number> {
  const name = rest[0];
  if (name === undefined) return fail(io, "用法：dsh-mcp get <name>");
  const layers = await collectLayers(deps);
  const found = layers.flatMap((layer) => layer.rows.filter((r) => r.name === name).map((r) => ({ ...r, layer })));
  if (found.length === 0) return fail(io, getMissMessage(name, layers));
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
  for (const loser of found.slice(1)) io.out(`注意：     ${sourceLabel(loser.layer)} 中的同名 "${name}" 被上面来源遮蔽。`);
  return 0;
}

/** remove 的候选目标：显式 --format 只查一个文件；否则按优先序查 yml 再查 json。 */
async function removeTargets(parsed: ParsedArgs, deps: CliDeps): Promise<WriteTarget[] | { error: string }> {
  if (parsed.scope === "profile") {
    const target = await resolveProfileTarget(parsed, deps);
    return "error" in target ? target : [target];
  }
  const scope = parsed.scope ?? "project";
  const dir = parsed.scope === "user" ? dshHomeOf(deps) : join(await resolveProjectRootFor(deps), ".dsh");
  const yml = targetIn(dir, "yml", scope);
  const json = targetIn(dir, "json", scope);
  if (parsed.format === "yml") return [yml];
  if (parsed.format === "json") return [json];
  return [yml, json];
}

/** remove 的单个目标处理结果：`removed` 已删、`absent` 该文件没有这行、`{ error }` 需上报。 */
type RemoveOutcome = "removed" | "absent" | { error: string };

/** 在一个目标文件里删掉 name；不拥有该 name 时返回 `absent` 让调用方继续找下一个目标。 */
async function removeFromTarget(target: WriteTarget, name: string, io: CliIo): Promise<RemoveOutcome> {
  const names = await existingNames(target);
  if (!Array.isArray(names)) return { error: names.error };
  if (!names.includes(name)) return "absent";
  try {
    if (target.format === "json") {
      await updateJsonServers(target.path, (servers) => {
        delete servers[name];
      });
    } else {
      // 锁内读-改-写：与并发 add 串行，不会把对方刚写的行覆盖掉。
      await updateManagedRows(target.path, (rows) => rows.filter((row) => rowNameOf(row) !== name));
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  io.out(`已移除 "${name}"（${target.path}）。`);
  return "removed";
}

async function cmdRemove(parsed: ParsedArgs, rest: string[], io: CliIo, deps: CliDeps): Promise<number> {
  const name = rest[0];
  if (name === undefined) return fail(io, "用法：dsh-mcp remove <name> [--scope project|user|profile]");
  const targets = await removeTargets(parsed, deps);
  if ("error" in targets) return fail(io, targets.error);
  for (let index = 0; index < targets.length; index++) {
    const outcome = await removeFromTarget(targets[index], name, io);
    if (outcome === "removed") {
      // 「首个命中即删」语义保留，但必须说清后果：另一方言里的同名行原本被
      // 遮蔽，删掉高优先层之后它会接管生效——静默顶替是最难查的一类事故。
      await warnRemoveTakeover(name, targets.slice(index + 1), io);
      return 0;
    }
    if (outcome !== "absent") return fail(io, outcome.error);
  }
  const readOnlyHit = await findReadOnlyLayerHit(name, deps);
  if (readOnlyHit !== undefined) return fail(io, `"${name}" 只在只读兼容层 ${readOnlyHit.path} 中；本 CLI 不改写 CC 格式文件，请直接编辑该文件`);
  return fail(io, `"${name}" 不在 ${targets.map((target) => target.path).join("、")} 中`);
}

/** 删除成功后，检查剩余候选目标里是否还有同名行会接管生效（只提示不失败）。 */
async function warnRemoveTakeover(name: string, remaining: WriteTarget[], io: CliIo): Promise<void> {
  for (const other of remaining) {
    const names = await existingNames(other);
    if (Array.isArray(names) && names.includes(name)) {
      io.out(`注意：${other.path} 中还有同名 "${name}"，删除后将由该定义接管生效。`);
    }
  }
}

async function findReadOnlyLayerHit(name: string, deps: CliDeps): Promise<LayerRows | undefined> {
  const layers = await collectLayers(deps);
  return layers.find((layer) => layer.source === "cc-project" && layer.rows.some((r) => r.name === name));
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
