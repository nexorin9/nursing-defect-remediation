/** T41 · 三栏工作台：入参校验 / 分栏筛选 / 分页 / 增量刷新保留旧数据 / 无患者标识。 */
import { describe, it, expect } from "vitest";
import {
  WORKBENCH_COLUMNS, validateFilters, buildWorkbenchView, refreshWorkbench,
  renderItemRow, keyboardAttrs, renderLongNarrative, type WorkbenchItem,
} from "../../src/ui/workbench.js";
import { PATIENT_IDENTIFIER_FIELDS } from "../../src/domain/redact.js";

function item(id: string, status: string, dwell: number, overdue = false): WorkbenchItem {
  return {
    incident_id: id,
    ward_code: "内科三病区",
    shift_code: "白班",
    status,
    statusLabel: "待分级",
    dwellMinutes: dwell,
    overdue,
  };
}

const ITEMS: WorkbenchItem[] = [
  item("INC-1", "awaiting_grade", 10),
  item("INC-2", "awaiting_grade", 200, true),
  item("INC-3", "awaiting_review", 30),
  item("INC-4", "closed", 50),
  item("INC-5", "written_back", 90),
];

describe("在办工作台视图模型", () => {
  it("分栏集合与页头在办 / 超期计数", () => {
    expect(WORKBENCH_COLUMNS).toEqual(["all", "awaiting_grade", "awaiting_review", "closed", "written_back"]);
    const view = buildWorkbenchView(ITEMS, {}, 1440);
    expect(view.header).toEqual({ open: 4, overdue: 1 });
    expect(view.counts.awaiting_grade).toBe(2);
    expect(view.total).toBe(5);
    expect(view.layout).toBe("three");
  });

  it("入参校验：非法分栏 / 页码 / 每页数回落安全值", () => {
    expect(validateFilters({ column: "unknown", page: -3, pageSize: 999 }).column).toBe("all");
    expect(validateFilters({ page: 0 }).page).toBe(1);
    expect(validateFilters({ pageSize: 0 }).pageSize).toBe(20);
    expect(validateFilters({ minDwell: -5 }).minDwell).toBe(0);
    expect(validateFilters({ column: "closed", pageSize: 2, page: 99 })).toMatchObject({ column: "closed", pageSize: 2, page: 99 });
  });

  it("筛选（分栏 / 病区 / 超期 / 停留时长）与分页生效", () => {
    const filtered = buildWorkbenchView(ITEMS, { column: "awaiting_grade", overdueOnly: true, minDwell: 100 });
    expect(filtered.items.map((i) => i.incident_id)).toEqual(["INC-2"]);
    const paged = buildWorkbenchView(ITEMS, { pageSize: 2, page: 2 }, 1024);
    expect(paged.page).toBe(2);
    expect(paged.totalPages).toBe(3);
    expect(paged.items.map((i) => i.incident_id)).toEqual(["INC-3", "INC-4"]);
    expect(paged.layout).toBe("two");
    const clamped = buildWorkbenchView(ITEMS, { pageSize: 2, page: 99 });
    expect(clamped.page).toBe(3);
  });

  it("60 秒增量轮询：新数据覆盖旧数据，其余旧内容不闪空", () => {
    const merged = refreshWorkbench(ITEMS, [item("INC-2", "awaiting_review", 210, true)]);
    expect(merged).toHaveLength(5);
    expect(merged.find((i) => i.incident_id === "INC-1")).toBeDefined();
    expect(merged.find((i) => i.incident_id === "INC-2")?.status).toBe("awaiting_review");
    expect(refreshWorkbench(ITEMS, [])).toHaveLength(5);
  });

  it("列表项只含业务字段，可 Tab 聚焦并回车触发", () => {
    const html = renderItemRow(ITEMS[0]!, true);
    expect(html).toContain("INC-1");
    expect(html).toContain("tabindex=\"0\"");
    expect(html).toContain("role=\"button\"");
    for (const field of PATIENT_IDENTIFIER_FIELDS) expect(html).not.toContain(field);
    expect(keyboardAttrs(ITEMS[0]!)).toMatchObject({ tabindex: "0", role: "button", "data-key": "INC-1" });
  });

  it("长叙述与生僻字混编在卡片里走截断策略，不破版", () => {
    const long = "交接班漏项，㐀𠮷妧𠀀㒰；".repeat(60);
    const rendered = renderLongNarrative(long, 120);
    expect(rendered.truncated).toBe(true);
    expect(rendered.html).toContain("ndr-narrative");
    expect(rendered.html.length).toBeLessThan(long.length);
  });
});
