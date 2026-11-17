/** T42 · 时间线视图：分段数与 runtime 一致、等待段时长、进行中标记、作废引文不渲染。 */
import { describe, it, expect } from "vitest";
import { buildTimeline } from "../../src/runtime/timeline.js";
import {
  buildTimelineView, renderTimelineSegment, stepSegmentCount,
  shouldRenderCitation, highlightQuotes,
} from "../../src/ui/timeline-view.js";
import type { StepTrace } from "../../src/domain/models.js";

const T0 = "2026-11-09T00:00:00.000Z";
const T1 = "2026-11-09T00:10:00.000Z";
const T2 = "2026-11-09T00:40:00.000Z";
const T3 = "2026-11-09T00:45:00.000Z";
const NOW = Date.parse("2026-11-09T01:00:00.000Z");

const TRACES: StepTrace[] = [
  { step_id: "s1", name: "上报接住", operator: "系统", queued_at: T0, started_at: T0, ended_at: T1, status: "done" },
  { step_id: "s2", name: "要素抽取", operator: "模型网关", queued_at: T1, started_at: T2, ended_at: T3, status: "done" },
  { step_id: "s3", name: "分级确认", operator: "护士长", queued_at: T3, started_at: T3, status: "running" },
];

describe("步骤时间线视图", () => {
  it("分段数与 runtime 纯函数输出一致，等待段单列且显示挂起时长", () => {
    const timeline = buildTimeline(TRACES, NOW);
    const view = buildTimelineView(timeline);
    expect(view).toHaveLength(timeline.segments.length);
    expect(stepSegmentCount(view)).toBe(timeline.step_count);
    expect(stepSegmentCount(view)).toBe(3);
    const waiting = view.filter((s) => s.kind === "waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.name).toBe("挂起等待");
    expect(waiting[0]!.label).toContain("等待 30m0s");
    expect(waiting[0]!.operator).toBe("等人回复");
    expect(renderTimelineSegment(waiting[0]!)).toContain("卡在等人，不是卡在系统");
  });

  it("进行中步骤标「进行中」；其余标已完成；等待段状态为 waiting", () => {
    const view = buildTimelineView(buildTimeline(TRACES, NOW));
    const running = view.find((s) => s.step_id === "s3")!;
    expect(running.status).toBe("running");
    expect(running.rendered).toContain("进行中");
    expect(running.confirmAnchor).toBe("confirm:s3");
    expect(view.find((s) => s.step_id === "s1")!.confirmAnchor).toBeUndefined();
    expect(view.find((s) => s.kind === "waiting")!.status).toBe("waiting");
    expect(view.find((s) => s.step_id === "s1")!.rendered).toContain("已完成");
  });

  it("依据原句高亮只标确实出现的原句；作废引文不渲染", () => {
    const narrative = "交接班漏项，已按流程补记并上报。";
    const valid = ["交接班漏项"];
    const hallucinated = ["护士长已签字确认"];
    expect(shouldRenderCitation(valid[0]!, hallucinated)).toBe(true);
    expect(shouldRenderCitation(hallucinated[0]!, hallucinated)).toBe(false);
    expect(shouldRenderCitation("   ", [])).toBe(false);
    const html = highlightQuotes(narrative, ["交接班漏项", "护士长已签字确认"], hallucinated);
    expect(html).toContain("<mark class=\"ndr-quote\">交接班漏项</mark>");
    expect(html).not.toContain("护士长已签字确认");
  });

  it("各段耗时之和不超过总时长（时间线不变量）", () => {
    const timeline = buildTimeline(TRACES, NOW);
    expect(timeline.sum_duration_ms).toBeLessThanOrEqual(timeline.total_duration_ms);
    const view = buildTimelineView(timeline);
    expect(view.every((s) => s.bar_width >= 0 && s.bar_width <= 1)).toBe(true);
  });
});
