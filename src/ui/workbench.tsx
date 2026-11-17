/**
 * 在办工作台视图模型（T41）。
 *
 * 三栏主工作台：左在办列表 / 中步骤时间线 / 右确认与回写；
 * 入参在进入列表前统一校验（对齐成熟中后台「服务端函数 + inputValidator」的分栏校验写法）；
 * 增量轮询刷新保留前一次数据（keepPreviousData），不闪空。
 * 列表项只含业务字段，不含患者可识别信息。
 */
import { layoutFor, truncateText } from "./tokens.js";

export const WORKBENCH_COLUMNS = ["all", "awaiting_grade", "awaiting_review", "closed", "written_back"] as const;
export type WorkbenchColumn = (typeof WORKBENCH_COLUMNS)[number];

export interface WorkbenchItem {
  incident_id: string;
  ward_code: string;
  shift_code: string;
  status: string;
  statusLabel: string;
  dwellMinutes: number;
  overdue: boolean;
  assignee?: string;
}

export interface WorkbenchFilters {
  column?: string;
  ward?: string;
  overdueOnly?: boolean;
  minDwell?: number;
  page?: number;
  pageSize?: number;
}

export interface WorkbenchView {
  items: WorkbenchItem[];
  counts: Record<string, number>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  header: { open: number; overdue: number };
  layout: "three" | "two" | "one";
}

/** 入参校验：非法分栏 / 页码 / 每页数一律回落安全值，不让坏参数进列表。 */
export function validateFilters(filters: WorkbenchFilters): Required<WorkbenchFilters> {
  const column = (WORKBENCH_COLUMNS as readonly string[]).includes(filters.column ?? "")
    ? (filters.column as WorkbenchColumn)
    : "all";
  const pageSize = Number.isFinite(filters.pageSize) && (filters.pageSize ?? 0) >= 1 && (filters.pageSize ?? 0) <= 100
    ? Math.floor(filters.pageSize!)
    : 20;
  const page = Number.isFinite(filters.page) && (filters.page ?? 0) >= 1 ? Math.floor(filters.page!) : 1;
  const minDwell = Number.isFinite(filters.minDwell) && (filters.minDwell ?? 0) >= 0 ? Math.floor(filters.minDwell!) : 0;
  return {
    column,
    ward: filters.ward ?? "",
    overdueOnly: filters.overdueOnly === true,
    minDwell,
    page,
    pageSize,
  };
}

export function buildWorkbenchView(
  items: WorkbenchItem[],
  filters: WorkbenchFilters = {},
  viewportWidth = 1440,
): WorkbenchView {
  const f = validateFilters(filters);
  const filtered = items.filter((item) => {
    if (f.column !== "all" && item.status !== f.column) return false;
    if (f.ward !== "" && item.ward_code !== f.ward) return false;
    if (f.overdueOnly && !item.overdue) return false;
    if (item.dwellMinutes < f.minDwell) return false;
    return true;
  });
  const counts: Record<string, number> = { all: items.length };
  for (const column of WORKBENCH_COLUMNS.slice(1)) {
    counts[column] = items.filter((i) => i.status === column).length;
  }
  const totalPages = Math.max(1, Math.ceil(filtered.length / f.pageSize));
  const page = Math.min(f.page, totalPages);
  return {
    items: filtered.slice((page - 1) * f.pageSize, page * f.pageSize),
    counts,
    total: filtered.length,
    page,
    pageSize: f.pageSize,
    totalPages,
    header: {
      open: items.filter((i) => i.status !== "written_back").length,
      overdue: items.filter((i) => i.overdue).length,
    },
    layout: layoutFor(viewportWidth),
  };
}

/** 60 秒增量轮询：按 incident_id 合并，新数据覆盖旧数据，其余旧内容不闪空。 */
export function refreshWorkbench(previous: WorkbenchItem[], incoming: WorkbenchItem[]): WorkbenchItem[] {
  const merged = new Map(previous.map((item) => [item.incident_id, item]));
  for (const item of incoming) merged.set(item.incident_id, item);
  return [...merged.values()];
}

/** 列表卡片 HTML（长叙述在卡片里走截断策略，不破版）。 */
export function renderItemRow(item: WorkbenchItem, selected = false): string {
  const tag = item.overdue ? "ndr-tag--overdue" : item.status === "written_back" ? "ndr-tag--success" : "ndr-tag--todo";
  return `<article class="ndr-card ${item.overdue ? "ndr-card--overdue" : ""} ${selected ? "is-selected" : ""}" tabindex="0" role="button" data-id="${item.incident_id}" aria-label="打开 ${item.incident_id} 处置单">
    <span class="ndr-card__id">${item.incident_id}</span>
    <span class="ndr-tag ${tag}">${item.statusLabel}</span>
    <span>${item.ward_code}</span><span>${item.shift_code}</span>
    <span class="ndr-card__dwell">停留 ${item.dwellMinutes} 分钟</span>
  </article>`;
}

/** 键盘可达性：列表项可 Tab 聚焦并回车触发。 */
export function keyboardAttrs(item: WorkbenchItem): Record<string, string> {
  return {
    tabindex: "0",
    role: "button",
    "aria-label": `打开 ${item.incident_id} 处置单`,
    "data-key": item.incident_id,
  };
}

/** 超长字段 / 生僻字混编的显示策略：归一化空白后按字数截断，中文可断行。 */
export function renderLongNarrative(narrative: string, max = 120): { html: string; truncated: boolean } {
  const result = truncateText(narrative, max);
  return { html: `<div class="ndr-narrative">${result.text}</div>`, truncated: result.truncated };
}
