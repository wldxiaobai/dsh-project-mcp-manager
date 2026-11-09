/**
 * 「当前工作区」抬头与工作区分组标记的纯函数。数据只来自 `state.activeProject`
 * 与 `state.servers`，不读文件、不依赖 React。
 *
 * 当前工作区取 UI 宿主半区的 `writeTargets()` 项目项：有焦点时是当前工作区，
 * 只有一个已知工作区时也是它，多个工作区且无焦点时为空。
 */
import type { McpUiLocaleKey } from "./locales.ts";
import type { McpUiServer } from "../wire.ts";

export interface WorkspaceCounts {
  /** 该工作区里的全部行，含启动中、失败等不单列的状态。 */
  readonly total: number;
  readonly running: number;
  /** 已启用但还在等会话（`skipReason === "idle"`）。 */
  readonly waiting: number;
  readonly disabled: number;
}

export interface WorkspaceCountSegment {
  readonly key: McpUiLocaleKey;
  readonly count: number;
}

export type WorkspaceGroupMarker = "current" | "idle";

export interface WorkspaceHeaderModel extends WorkspaceCounts {
  /** 是否已经知道当前工作区。 */
  readonly known: boolean;
  /** 工作区名；未确定时为空串。 */
  readonly name: string;
  /** 完整路径；未确定时为 null。 */
  readonly path: string | null;
  /** 状态行片段，只含非零项；未确定时为空。 */
  readonly segments: WorkspaceCountSegment[];
}

const EMPTY_COUNTS: WorkspaceCounts = { total: 0, running: 0, waiting: 0, disabled: 0 };

/** 比较用的工作区路径：分隔符统一、去尾分隔符、忽略大小写（Windows 盘符与目录名不区分大小写）。 */
export function normalizeProjectPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function sameProjectPath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left == null || right == null || left === "" || right === "") return false;
  return normalizeProjectPath(left) === normalizeProjectPath(right);
}

/** 路径最后一段作为工作区名；`D:\` 这类根路径退回去掉尾分隔符的形式。 */
export function workspaceNameOf(projectRoot: string): string {
  const trimmed = projectRoot.trim().replace(/[\\/]+$/, "");
  if (trimmed === "") return projectRoot.trim();
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

/** 只统计属于当前工作区的行；运行中、待会话、已禁用互斥。 */
export function workspaceCounts(servers: readonly McpUiServer[], activeProject: string | null): WorkspaceCounts {
  if (activeProject === null || activeProject === "") return EMPTY_COUNTS;
  let total = 0;
  let running = 0;
  let waiting = 0;
  let disabled = 0;
  for (const row of servers) {
    if (!sameProjectPath(row.projectRoot, activeProject)) continue;
    total += 1;
    if (!row.enabled) {
      disabled += 1;
    } else if (row.active) {
      running += 1;
    } else if (row.skipReason === "idle") {
      waiting += 1;
    }
  }
  return { total, running, waiting, disabled };
}

/** 状态行片段：只显示非零项，总数排在最前。 */
export function workspaceCountSegments(counts: WorkspaceCounts): WorkspaceCountSegment[] {
  const segments: WorkspaceCountSegment[] = [];
  if (counts.total > 0) {
    segments.push({ key: counts.total === 1 ? "workspaceServerCountOne" : "workspaceServerCount", count: counts.total });
  }
  if (counts.running > 0) segments.push({ key: "workspaceRunningCount", count: counts.running });
  if (counts.waiting > 0) segments.push({ key: "workspaceWaitingCount", count: counts.waiting });
  if (counts.disabled > 0) segments.push({ key: "workspaceDisabledCount", count: counts.disabled });
  return segments;
}

/** 抬头模型：未确定时不给名称、路径和计数，由组件换成「未确定」文案。 */
export function workspaceHeader(activeProject: string | null, servers: readonly McpUiServer[]): WorkspaceHeaderModel {
  if (activeProject === null || activeProject === "") {
    return { ...EMPTY_COUNTS, known: false, name: "", path: null, segments: [] };
  }
  const counts = workspaceCounts(servers, activeProject);
  return {
    ...counts,
    known: true,
    name: workspaceNameOf(activeProject),
    path: activeProject,
    segments: workspaceCountSegments(counts)
  };
}

/**
 * 工作区分组标记：当前工作区标「当前」；其它工作区只要还有行在等会话就标「空闲」。
 * 已有更具体的跳过原因（env-missing、env-invalid、name-taken 等）不覆盖这个判断。
 */
export function workspaceGroupMarker(
  projectRoot: string,
  rows: readonly Pick<McpUiServer, "skipReason">[],
  activeProject: string | null
): WorkspaceGroupMarker | null {
  if (sameProjectPath(projectRoot, activeProject)) return "current";
  return rows.some((row) => row.skipReason === "idle") ? "idle" : null;
}

/** 当前工作区那一组置顶，其余保持原有顺序。 */
export function orderWorkspaceGroups<T>(
  groups: ReadonlyArray<readonly [string, T]>,
  activeProject: string | null
): Array<readonly [string, T]> {
  if (activeProject === null || activeProject === "") return [...groups];
  const current: Array<readonly [string, T]> = [];
  const rest: Array<readonly [string, T]> = [];
  for (const group of groups) {
    if (sameProjectPath(group[0], activeProject)) current.push(group);
    else rest.push(group);
  }
  return [...current, ...rest];
}
