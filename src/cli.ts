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
import { CC_PROJECT_FILE, CLAUDE_USER_FILE, IGNORE_CLAUDE_JSON_ENV, readClaudeUserFile, readMcpJsonFile, type McpRowSource } from "./cc-file.js";
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

/** 被识别的选项；其余以 - 开头的 token 一律按位置参数（服务器命令行）处理。 */
const KNOWN_FLAGS = new Set(["--scope", "-s", "--transport", "-t", "--env", "-e", "--header", "-H", "--cwd", "-c", "--help", "-h"]);

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

export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const parsed: ParsedArgs = { positional: [], transport: "stdio", env: {}, headers: {}, help: false };
  let noMoreFlags = false;
  let parseError: string | undefined;
  // 单一游标：需要取值的选项用 `++cursor` 前移，避免被循环再次访问。
  for (let cursor = 0; cursor < argv.length && parseError === undefined; cursor++) {
    const token = argv[cursor];
    const needValue = (flag: string): string | undefined => {
      const next = argv[++cursor];
      if (next === undefined) parseError = `缺少 ${flag} 的值`;
      return next;
    };
    if (noMoreFlags) {
      parsed.positional.push(token);
      continue;
    }
    if (token === "--") {
      noMoreFlags = true;
      continue;
    }
    if (token === "-h" || token === "--help") {
      parsed.help = true;
      continue;
    }
    if (token === "--scope" || token === "-s") {
      const value = needValue(token);
      if (value === "project" || value === "user") parsed.scope = value;
      else if (value === "local") parseError = "本插件没有 local 作用域（CC 默认写 local）。请用 --scope user，或把条目放进 .mcp.json 交由只读兼容层装载";
      else parseError = `--scope 只支持 project|user，收到：${value}`;
      continue;
    }
    if (token === "--transport" || token === "-t") {
      const value = needValue(token);
      if (value === "stdio" || value === "http") parsed.transport = value;
      else if (value === "sse") parseError = "不支持 sse 传输：装载后端（dsh-mcp-client）只有 stdio 与 streamable-http";
      else if (value === "streamable-http") parsed.transport = "http";
      else parseError = `--transport 只支持 stdio|http（别名 streamable-http），收到：${value}`;
      continue;
    }
    if (token === "--env" || token === "-e") {
      const value = needValue(token);
      if (value !== undefined) {
        const kv = parseKv(value, "=", "env");
        if (typeof kv === "string") parseError = kv;
        else parsed.env[kv[0]] = kv[1];
      }
      continue;
    }
    if (token === "--header" || token === "-H") {
      const value = needValue(token);
      if (value !== undefined) {
        const kv = parseKv(value, ":", "header");
        if (typeof kv === "string") parseError = kv;
        else parsed.headers[kv[0].trim()] = kv[1].trim();
      }
      continue;
    }
    if (token === "--cwd" || token === "-c") {
      parsed.cwd = needValue(token);
      continue;
    }
    if (token.startsWith("-") && token !== "-" && !KNOWN_FLAGS.has(token)) {
      // 非已知选项的 dash 词元按位置参数收集（服务器自身的 -y/--verbose 等）。
      // 未知「选项」因此不再单独报错——这是刻意策略：宁可透传也不误伤 spawn 参数。
      parsed.positional.push(token);
      continue;
    }
    parsed.positional.push(token);
  }
  if (parseError !== undefined) return { error: parseError };
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

async function collectLayers(deps: CliDeps): Promise<LayerRows[]> {
  const cwd = process.cwd();
  const projectRoot = await (deps.resolveProjectRoot ?? ((p: string) => findProjectRoot(p)))(cwd);
  const home = deps.home ?? homedir();
  const layers: LayerRows[] = [];
  // 1) 项目原生 yml
  const ymlRows: { name: string; row: PatchRow }[] = [];
  let ymlNote: string | undefined;
  try {
    for (const row of extractManagedRows(await readPatchFile(join(projectRoot, ".dsh", "mcp.yml")))) {
      const name = nameOf(row);
      if (name !== undefined) ymlRows.push({ name, row });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ENOENT")) ymlNote = `读取失败：${message}`;
  }
  layers.push({ source: "yml", path: join(projectRoot, ".dsh", "mcp.yml"), rows: ymlRows, ...(ymlNote ? { note: ymlNote } : {}) });
  // 2) 项目 .mcp.json（只读兼容层）
  const cc = await readMcpJsonFile(join(projectRoot, CC_PROJECT_FILE), projectRoot);
  layers.push({
    source: "cc-project",
    path: join(projectRoot, CC_PROJECT_FILE),
    rows: cc.rows.map((r) => ({ name: r.rawName, row: r.row })),
    ...(cc.fileError ? { note: `读取失败：${cc.fileError}` } : cc.entryErrors.length > 0 ? { note: `坏条目：${cc.entryErrors.join("；")}` } : {})
  });
  // 3) 用户 ~/.dsh/mcp.yml
  const userYml: { name: string; row: PatchRow }[] = [];
  let userYmlNote: string | undefined;
  try {
    for (const row of extractManagedRows(await readPatchFile(join(home, ".dsh", "mcp.yml")))) {
      const name = nameOf(row);
      if (name !== undefined) userYml.push({ name, row });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ENOENT")) userYmlNote = `读取失败：${message}`;
  }
  layers.push({ source: "user-yml", path: join(home, ".dsh", "mcp.yml"), rows: userYml, ...(userYmlNote ? { note: userYmlNote } : {}) });
  // 4) 用户 ~/.claude.json（allowlist 只读；受 DSH_MCP_IGNORE_CLAUDE_JSON 开关控制）
  if (process.env[IGNORE_CLAUDE_JSON_ENV] !== "1") {
    const cu = await readClaudeUserFile(join(home, CLAUDE_USER_FILE));
    layers.push({
      source: "cc-user",
      path: join(home, CLAUDE_USER_FILE),
      rows: cu.rows.map((r) => ({ name: r.rawName, row: r.row })),
      ...(cu.fileError ? { note: `读取失败：${cu.fileError}` } : cu.entryErrors.length > 0 ? { note: `坏条目：${cu.entryErrors.join("；")}` } : {})
    });
  }
  return layers;
}

function describeTarget(row: PatchRow): string {
  const view = patchRowToView(row);
  if (view === undefined) return "(无效行)";
  const config = row.config ?? {};
  if (typeof config.url === "string") return `${config.url} (streamable-http)`;
  const args = Array.isArray(config.args) ? config.args.map(String).join(" ") : "";
  return [String(config.command ?? "?"), args].filter(Boolean).join(" ") + " (stdio)";
}

export async function runCli(argv: string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) return fail(io, parsed.error);
  const [command, ...rest] = parsed.positional;
  if (parsed.help || command === undefined || command === "help") {
    io.out(HELP);
    return command === undefined && !parsed.help ? fail(io, "缺少子命令（add|list|get|remove）") : 0;
  }
  const scopePaths = async (): Promise<{ ymlPath: string; root: string }> => {
    const home = deps.home ?? homedir();
    if (parsed.scope === "user") return { ymlPath: join(home, ".dsh", "mcp.yml"), root: home };
    const root = await (deps.resolveProjectRoot ?? ((p: string) => findProjectRoot(p)))(process.cwd());
    return { ymlPath: join(root, ".dsh", "mcp.yml"), root };
  };

  if (command === "add") {
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
      return fail(io, `配置无效${first ? `（${first.path.join(".")}：${first.message}）` : "）"}`);
    }
    const { ymlPath } = await scopePaths();
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

  if (command === "list") {
    const allLayers = await collectLayers(deps);
    const layers = parsed.scope === undefined
      ? allLayers
      : allLayers.filter((layer) => (parsed.scope === "project" ? layer.source === "yml" || layer.source === "cc-project" : layer.source === "user-yml" || layer.source === "cc-user"));
    const seen = new Map<string, McpRowSource>();
    let total = 0;
    for (const layer of layers) {
      if (layer.note !== undefined) io.out(`${layer.path}: ${layer.note}`);
      for (const { name, row } of layer.rows) {
        total++;
        const winner = seen.get(name);
        if (winner === undefined) seen.set(name, layer.source);
        const disabled = row.disabled === true ? ", disabled" : "";
        const shadow = winner !== undefined ? `（已被 ${SOURCE_LABEL[winner]} 遮蔽）` : SOURCE_LABEL[layer.source];
        io.out(`  ${name}: ${describeTarget(row)} -- ${shadow}${disabled}`);
      }
    }
    if (total === 0 && layers.every((layer) => layer.note === undefined)) io.out("未配置 MCP 服务器（dsh-mcp add 添加）。");
    return 0;
  }

  if (command === "get") {
    const name = rest[0];
    if (name === undefined) return fail(io, "用法：dsh-mcp get <name>");
    const layers = await collectLayers(deps);
    const found = layers.flatMap((layer) => layer.rows.filter((r) => r.name === name).map((r) => ({ ...r, layer })));
    if (found.length === 0) return fail(io, `未找到服务器 "${name}"（已查 .dsh/mcp.yml、${CC_PROJECT_FILE}、~/.dsh/mcp.yml、~/${CLAUDE_USER_FILE}）`);
    const winner = found[0];
    io.out(`Name:     ${name}`);
    io.out(`Source:   ${SOURCE_LABEL[winner.layer.source]}`);
    io.out(`File:     ${winner.layer.path}`);
    const config = winner.row.config ?? {};
    io.out(`Transport: ${config.transport === "streamable-http" ? "http (streamable-http)" : "stdio"}`);
    if (typeof config.url === "string") io.out(`URL:      ${config.url}`);
    else {
      io.out(`Command:  ${String(config.command ?? "")} ${(Array.isArray(config.args) ? config.args.map(String) : []).join(" ")}`.trimEnd());
      if (typeof config.cwd === "string") io.out(`CWD:      ${config.cwd}`);
    }
    const view = patchRowToView(winner.row);
    const renderKv = (keys: string[] | undefined): string => (keys ?? []).map((k) => `${k}=<configured>`).join(" ") || "(none)";
    if ((view?.envKeys?.length ?? 0) > 0) io.out(`Env:      ${renderKv(view?.envKeys)}`);
    if ((view?.headerKeys?.length ?? 0) > 0) io.out(`Headers:  ${renderKv(view?.headerKeys)}`);
    if (winner.row.disabled === true) io.out("注意：     该行被标记 disabled，不会装载。");
    for (const loser of found.slice(1)) io.out(`注意：     ${SOURCE_LABEL[loser.layer.source]} 中的同名 "${name}" 被上面来源遮蔽。`);
    return 0;
  }

  if (command === "remove") {
    const name = rest[0];
    if (name === undefined) return fail(io, "用法：dsh-mcp remove <name> [--scope project|user]");
    const { ymlPath } = await scopePaths();
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
      const layers = await collectLayers(deps);
      const readOnlyHit = layers.find((layer) => (layer.source === "cc-project" || layer.source === "cc-user") && layer.rows.some((r) => r.name === name));
      if (readOnlyHit !== undefined) return fail(io, `"${name}" 只在只读兼容层 ${readOnlyHit.path} 中；本 CLI 不改写 CC 格式文件，请直接编辑该文件`);
      return fail(io, `"${name}" 不在 ${ymlPath} 中`);
    }
    await writeManagedRows(ymlPath, kept);
    io.out(`已移除 "${name}"（${ymlPath}）。`);
    return 0;
  }

  return fail(io, `未知子命令：${command}（支持 add|list|get|remove，dsh-mcp --help 查看用法）`);
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
