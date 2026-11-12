/**
 * 「当前工作区」抬头与工作区分组标记的纯函数。数据只来自 `state.activeProject`
 * / `state.activeProjectKey` 与 `state.servers`，不读文件、不依赖 React。
 *
 * 工作区身份一律用宿主算好的项目键（核心 `projectKeyOf()`：Windows 下小写化，
 * POSIX 保持大小写）。浏览器不自己对路径做规范化：浏览器可能远程访问另一个
 * 平台的宿主，用浏览器操作系统猜规则会把 POSIX 上大小写不同的两个工作区并成
 * 一个。当前工作区取 UI 宿主半区的 `writeTargets()` 项目项：有焦点时是当前
 * 工作区，只有一个已知工作区时也是它，多个工作区且无焦点时为空。
 */
import type { McpUiLocaleKey } from "./locales.ts";
import type { McpUiContextCost, McpUiResultCost, McpUiServer } from "../wire.ts";

export interface WorkspaceCounts {
  /** 该工作区里的全部行，含启动中、失败等不单列的状态。 */
  readonly total: number;
  readonly running: number;
  /** 已启用待使用：仅 active 的按需加载（Lazy）行可按需连接。 */
  readonly waiting: number;
  readonly disabled: number;
}

export interface WorkspaceCountSegment {
  readonly key: McpUiLocaleKey;
  readonly count: number;
}

export type WorkspaceGroupMarker = "current";

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

/** 两个工作区键相同才算同一个工作区；空键（全局层、未确定）永远不算。 */
export function sameWorkspace(key: string | null | undefined, activeKey: string | null | undefined): boolean {
  return key !== null && key !== undefined && key !== "" && key === activeKey;
}

/** 路径最后一段作为工作区名；`D:\` 这类根路径退回去掉尾分隔符的形式。只用做显示。 */
export function workspaceNameOf(projectRoot: string): string {
  const trimmed = projectRoot.trim();
  // Scan backwards: an unanchored /[\\/]+$/ retries every separator when a
  // long run is followed by a non-separator, producing quadratic backtracking.
  let end = trimmed.length;
  while (end > 0 && (trimmed[end - 1] === "/" || trimmed[end - 1] === "\\")) end -= 1;
  if (end === 0) return trimmed;
  const separator = Math.max(trimmed.lastIndexOf("/", end - 1), trimmed.lastIndexOf("\\", end - 1));
  return trimmed.slice(separator + 1, end);
}

/**
 * 只统计当前工作区的项目层行；运行中、待使用、已禁用互斥。全局层行不计入。
 * Lazy 的 active 表示可按需使用，并非实际连接状态，归入 waiting。
 */
export function workspaceCounts(servers: readonly McpUiServer[], activeProjectKey: string | null): WorkspaceCounts {
  if (activeProjectKey === null || activeProjectKey === "") return EMPTY_COUNTS;
  let total = 0;
  let running = 0;
  let waiting = 0;
  let disabled = 0;
  for (const row of servers) {
    if (row.layer !== "project") continue;
    if (!sameWorkspace(row.projectKey, activeProjectKey)) continue;
    total += 1;
    if (!row.enabled) {
      disabled += 1;
    } else if (row.active && row.mode !== "lazy") {
      running += 1;
    } else if (row.active) {
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
export function workspaceHeader(
  activeProject: string | null,
  activeProjectKey: string | null,
  servers: readonly McpUiServer[]
): WorkspaceHeaderModel {
  if (activeProject === null || activeProject === "") {
    return { ...EMPTY_COUNTS, known: false, name: "", path: null, segments: [] };
  }
  const counts = workspaceCounts(servers, activeProjectKey);
  return {
    ...counts,
    known: true,
    name: workspaceNameOf(activeProject),
    path: activeProject,
    segments: workspaceCountSegments(counts)
  };
}

/**
 * 工作区分组标记：只给当前工作区标「当前」，其它分组不标记。
 * 常驻挂载后不再有「空闲」分组（旧版按需挂载的 skipReason `idle`）。
 */
export function workspaceGroupMarker(
  projectKey: string,
  activeProjectKey: string | null
): WorkspaceGroupMarker | null {
  return sameWorkspace(projectKey, activeProjectKey) ? "current" : null;
}

/** 当前工作区那一组置顶，其余保持原有顺序。分组以宿主给的工作区键为键。 */
export function orderWorkspaceGroups<T>(
  groups: ReadonlyArray<readonly [string, T]>,
  activeProjectKey: string | null
): Array<readonly [string, T]> {
  if (activeProjectKey === null || activeProjectKey === "") return [...groups];
  const current: Array<readonly [string, T]> = [];
  const rest: Array<readonly [string, T]> = [];
  for (const group of groups) {
    if (sameWorkspace(group[0], activeProjectKey)) current.push(group);
    else rest.push(group);
  }
  return [...current, ...rest];
}

// ── 会话级 MCP 上下文占用抬头标签 ─────────────────────────────────────────

export interface ContextCostView {
  /** 紧凑数值：`820`、`3.4k`、`12k`。 */
  readonly tokens: string;
  /** 原始估算值，供「定义 + 结果」合计使用。 */
  readonly estTokens: number;
  /** 占上下文窗口的百分比（四舍五入、封顶 100）；窗口未知为 null。 */
  readonly percent: number | null;
  readonly level: McpUiContextCost["level"];
  /** 定义最大的几台服务器，供说明气泡分项列出。 */
  readonly top: readonly { name: string; kind?: "lazy-proxy"; tools: number; tokens: string }[];
}

/** 千位以上折成一位小数的 `k`；`3.0k` 写作 `3k`。 */
export function formatTokenCount(tokens: number): string {
  const rounded = Math.max(0, Math.round(tokens));
  if (rounded < 1_000) return String(rounded);
  if (rounded < 100_000) {
    const tenths = Math.round(rounded / 100) / 10;
    return `${Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1)}k`;
  }
  return `${String(Math.round(rounded / 1_000))}k`;
}

/**
 * 抬头标签的显示模型。没有会话、或会话里没有任何 MCP 工具时不显示（返回 null），
 * 免得每一页都挂一个恒为 0 的标签。
 */
export function contextCostView(cost: McpUiContextCost | undefined, topCount = 3): ContextCostView | null {
  if (cost === undefined || cost.sessionId === null || cost.tools === 0) return null;
  const percent = cost.contextWindow === undefined || cost.contextWindow <= 0
    ? null
    : Math.min(100, Math.round(cost.estTokens / cost.contextWindow * 100));
  return {
    tokens: formatTokenCount(cost.estTokens),
    estTokens: cost.estTokens,
    percent,
    level: cost.level,
    top: cost.servers.slice(0, topCount).map((server) => ({
      name: server.name,
      ...(server.kind === "lazy-proxy" ? { kind: server.kind } : {}),
      tools: server.tools,
      tokens: formatTokenCount(server.estTokens)
    }))
  };
}

// ── 会话级 MCP 工具调用结果标签 ──────────────────────────────────────────

export interface ResultCostView {
  /** 紧凑数值：`820`、`3.4k`、`12k`。 */
  readonly tokens: string;
  /** 原始估算值，供「定义 + 结果」合计使用。 */
  readonly estTokens: number;
  /** 占上下文窗口的百分比（四舍五入、封顶 100）；窗口未知为 null。 */
  readonly percent: number | null;
  /** 结果最大的几台服务器，供说明气泡分项列出。 */
  readonly top: readonly { name: string; kind?: "lazy" | "lazy-proxy"; calls: number; tokens: string }[];
}

/**
 * 「结果」标签的显示模型。没有会话、或当前 surface 上没有 MCP 结果时不显示；
 * 结果已经全部被裁剪或压缩掉时也不显示，免得挂一个恒为 0 的标签。
 */
export function resultCostView(cost: McpUiResultCost | undefined, topCount = 3): ResultCostView | null {
  if (cost === undefined || cost.sessionId === null || cost.calls === 0) return null;
  const percent = cost.contextWindow === undefined || cost.contextWindow <= 0
    ? null
    : Math.min(100, Math.round(cost.estTokens / cost.contextWindow * 100));
  return {
    tokens: formatTokenCount(cost.estTokens),
    estTokens: cost.estTokens,
    percent,
    top: cost.servers.slice(0, topCount).map((server) => ({
      name: server.name,
      ...(server.kind === undefined ? {} : { kind: server.kind }),
      calls: server.calls,
      tokens: formatTokenCount(server.estTokens)
    }))
  };
}