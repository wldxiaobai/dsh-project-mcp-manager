/**
 * dsh-project-mcp-manager —— 项目锚点解析。
 *
 * 与 dsh 官方 skills 发现（@deepseek-ai/dsh-skill-filesystem）的项目根规则
 * 一致：向上找最近的含 .git 的祖先目录，找不到就退回 cwd 本身。
 */
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** 判断文件系统路径是否存在。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 项目锚点：向上找最近的含 .git 的祖先目录；找不到就退回 cwd 本身。 */
export async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd);
  while (true) {
    if (await pathExists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}
