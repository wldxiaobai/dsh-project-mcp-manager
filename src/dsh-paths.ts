/**
 * dsh-project-mcp-manager —— dsh 家目录与用户层文件路径解析（单一真相）。
 *
 * 宿主支持用 `DSH_HOME` 重定位 dsh 家目录（README.md / docs/README.zh.md：
 * 「dshHome 默认为 `%USERPROFILE%\.dsh`（设置了 `DSH_HOME` 则用其值）」，宿主进程
 * 环境实测含该变量）。注册表与 CLI 必须走同一份解析：否则重定位后用户层三个文件
 * （`mcp.yml`/`mcp.json`/`profiles/<name>/mcp.json`）与全局诊断会整体落到
 * `~/.dsh` 而**静默失效**——文件缺失在本插件里是合法的「零配置」状态，不报错。
 *
 * 纯路径计算，无 I/O；env 与 home 均可注入，便于测试。
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { JSON_MCP_FILE, FOREIGN_MCP_JSON_FILE } from "./json-file.js";

/** dsh 家目录重定位环境变量。 */
export const DSH_HOME_ENV = "DSH_HOME";
/** 显式指定 profile 名的环境变量（覆盖自动解析；CLI/无 profile 启动场景用）。 */
export const PROFILE_ENV = "DSH_MCP_PROFILE";
/** 原生受管块文件名（项目层 `<root>/.dsh/mcp.yml` 与用户层 `<dshHome>/mcp.yml` 同名）。 */
export const MCP_YML_FILE = "mcp.yml";
/** 项目/用户层配置目录名（项目层为 `<root>/.dsh`）。 */
export const DSH_DIR = ".dsh";
/** 诊断文件名（项目层写 `<root>/.dsh/`，全局层写 `<dshHome>/`）。 */
export const DIAG_FILE = ".mcp-diag.json";

/**
 * dsh 家目录：`DSH_HOME` 非空则取其绝对化值，否则 `<home>/.dsh`。
 * 显式传入的 home 只影响缺省分支——注入方（测试/CLI `--home`）想完全接管路径时
 * 应直接给 dshHome。
 */
export function dshHomeDir(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[DSH_HOME_ENV];
  return typeof fromEnv === "string" && fromEnv !== "" ? resolve(fromEnv) : join(home, DSH_DIR);
}

/**
 * 注入优先的 dsh 家目录：显式给出的 home（CLI `deps.home`、测试注入）视为完整接管，
 * 直接取 `<home>/.dsh`；未给出时才解析 `DSH_HOME`。注入点若被 env 反超，注入就失去
 * 隔离意义（测试会读到真实用户配置）。
 */
export function dshHomeFor(home: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return home === undefined ? dshHomeDir(homedir(), env) : join(home, DSH_DIR);
}

/** 用户层（全局装载）三个来源文件的路径。 */
export interface UserLayerPaths {
  mcpYml: string;
  mcpJson: string;
  profilesDir: string;
}

/** dsh 家目录 → 用户层三个来源路径。 */
export function userLayerPathsIn(dshHome: string): UserLayerPaths {
  return {
    mcpYml: join(dshHome, MCP_YML_FILE),
    mcpJson: join(dshHome, JSON_MCP_FILE),
    profilesDir: join(dshHome, "profiles")
  };
}

/** profile 层配置文件路径（`<dshHome>/profiles/<name>/mcp.json`）。 */
export function profileMcpJsonFile(profilesDir: string, profile: string): string {
  return join(profilesDir, profile, JSON_MCP_FILE);
}

/** 对方插件全局存储路径（`$DSH_HOME/dsh-mcp.json`）；本插件不读取内容，只在存在时诊断。 */
export function foreignUserMcpJsonFile(dshHome: string): string {
  return join(dshHome, FOREIGN_MCP_JSON_FILE);
}

/**
 * 合法 profile 名：字母数字开头，其后允许字母数字、`.`、`_`、`-`。
 * 用于把外部输入（`DSH_MCP_PROFILE`）挡在 profiles 目录内——`..`、
 * `../../somewhere`、绝对路径都会被拒。
 */
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** profile 名是否可安全拼进 profiles 目录（显式拒绝 `.` 与 `..`）。 */
export function isValidProfileName(name: string): boolean {
  if (name === "." || name === "..") return false;
  return PROFILE_NAME_RE.test(name);
}
