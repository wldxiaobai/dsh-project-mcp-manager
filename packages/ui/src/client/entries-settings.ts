/**
 * MCP 管理页三个入口的显隐配置。纯函数：浏览器、通用行与测试共用，
 * 不依赖 React 或 cordis。
 *
 * 值落宿主设置文档里 `mcp-project-ui` 这一条（`Config` 在 UI 宿主半区声明），
 * 浏览器经 `ctx.configForms.get("mcp-project-ui")` 读写。
 */

/** 宿主设置文档里的插件条目 id，同时是 settings 命名空间。 */
export const ENTRY_CONFIG_ID = "mcp-project-ui";

export interface EntryFlags {
  /** 主页左侧栏图标行 + 它打开的 `main` 页面。 */
  readonly sidebar: boolean;
  /** 设置页左侧栏分区 + 导航图标。 */
  readonly settingsSection: boolean;
  /** 设置 → 插件 里的旧标签页。 */
  readonly settingsTab: boolean;
}

/** 三个默认都显示，与 v0.11.1 的行为一致。 */
export const DEFAULT_ENTRY_FLAGS: EntryFlags = {
  sidebar: true,
  settingsSection: true,
  settingsTab: true
};

export const ENTRY_KEYS = ["sidebar", "settingsSection", "settingsTab"] as const;
export type EntryKey = (typeof ENTRY_KEYS)[number];

/** 浏览器侧看到的配置表单快照（`ConfigFormSnapshot` 的最小结构）。 */
export interface EntriesFormSnapshot {
  readonly status: "loading" | "ready" | "unavailable";
  readonly value: unknown;
  readonly base?: unknown;
  readonly user?: unknown;
  readonly revision?: number;
  readonly writable: boolean;
}

export type EntryOp = { readonly op: "set"; readonly path: readonly [EntryKey]; readonly value: boolean };

/**
 * 一次提交的结果。`revision` 是提交后快照里的 revision：宿主拒绝时会先重新
 * 加载最新配置，因此这个值可以直接作为下一次重试的 fence。
 */
export interface EntrySaveResult {
  readonly ok: boolean;
  readonly revision?: number;
}

/** 配置里不是布尔值的字段按默认值处理；缺字段也保持显示。 */
export function entryFlagsFrom(value: unknown): EntryFlags {
  const record = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const flags: Record<EntryKey, boolean> = { ...DEFAULT_ENTRY_FLAGS };
  for (const key of ENTRY_KEYS) {
    if (typeof record[key] === "boolean") flags[key] = record[key] as boolean;
  }
  return flags;
}

/** 只有表单 ready 时才信任配置值；加载中或命名空间不可用时按默认全显示。 */
export function entryFlagsFromSnapshot(snapshot: EntriesFormSnapshot | null | undefined): EntryFlags {
  if (snapshot === null || snapshot === undefined || snapshot.status !== "ready") return DEFAULT_ENTRY_FLAGS;
  return entryFlagsFrom(snapshot.value);
}

/** 三个勾选框是否禁用：表单没 ready 或当前页面没有写入权限时为 true。 */
export function entriesReadOnly(snapshot: EntriesFormSnapshot | null | undefined): boolean {
  return snapshot === null || snapshot === undefined || snapshot.status !== "ready" || snapshot.writable !== true;
}

/** 是否需要显示「没有修改权限」：加载中不显示，避免闪一句误导文案。 */
export function entriesReadOnlyNote(snapshot: EntriesFormSnapshot | null | undefined): boolean {
  return snapshot !== null && snapshot !== undefined && snapshot.status !== "loading" && snapshot.writable !== true;
}

/**
 * 只提交真正变化的字段；没有变化时返回空数组，调用方直接关闭弹窗。
 * 给了 `only` 时再限制到这些字段——调用方传弹窗里用户显式改过的项，这样
 * 别的窗口对未触碰字段的更新不会被旧草稿回写。`current` 是宿主当前的值
 * （提交瞬间可能已被别处更新），因此必须拿它比较，而不是打开弹窗时的旧值。
 */
export function entryOps(current: EntryFlags, next: EntryFlags, only?: readonly EntryKey[]): EntryOp[] {
  const ops: EntryOp[] = [];
  for (const key of ENTRY_KEYS) {
    if (only !== undefined && !only.includes(key)) continue;
    if (current[key] !== next[key]) ops.push({ op: "set", path: [key], value: next[key] });
  }
  return ops;
}
