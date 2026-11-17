import { describe, expect, it } from "vitest";
import { buildTimeline, calculateDuration, formatTimelineDuration } from "../../src/runtime/timeline.js";
import type { StepTrace } from "../../src/domain/models.js";

const base = Date.parse("2026-11-09T00:00:00.000Z");
const iso = (ms: number) => new Date(base + ms).toISOString();
const NOW = base + 200_000;

function trace(stepId: string, startMs: number, endMs: number | undefined, status: StepTrace["status"]): StepTrace {
  return {
    step_id: stepId, name: stepId, operator: "system",
    queued_at: iso(startMs - 500), started_at: iso(startMs),
    ...(endMs !== undefined ? { ended_at: iso(endMs) } : {}),
    status,
  };
}

/** T21：trace → 分段纯函数，等待段单列，进行中不按 0 计。 */
describe("T21 运行时间线", () => {
  const traces: StepTrace[] = [
    trace("intake", 1_000, 2_000, "done"),
    trace("extract", 5_000, 7_000, "done"),
    trace("grade", 80_000, 82_000, "done"),
    trace("remedy", 90_000, 92_000, "done"),
    trace("review", 100_000, 102_000, "done"),
    trace("close", 110_000, undefined, "running"),
  ];

  it("分段数与状态机步数一致，耗时之和 ≤ 总时长", () => {
    const timeline = buildTimeline(traces, NOW);
    expect(timeline.step_count).toBe(traces.length);
    const sum = timeline.segments.reduce((acc, s) => acc + s.duration_ms, 0);
    expect(sum).toBeLessThanOrEqual(timeline.total_duration_ms);
    expect(timeline.sum_duration_ms).toBeLessThanOrEqual(timeline.total_duration_ms);
  });

  it("进行中步骤标「进行中」且不按 0 计；等待段单列并标出时长", () => {
    const timeline = buildTimeline(traces, NOW);
    const running = timeline.segments.find((s) => s.step_id === "close");
    expect(running?.status).toBe("running");
    expect(running?.label).toBe("进行中");
    expect(running?.duration_ms).toBeGreaterThan(0);
    const waits = timeline.segments.filter((s) => s.kind === "waiting");
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0]!.label).toContain("等待");
    expect(waits[0]!.duration_ms).toBeGreaterThan(0);
  });

  it("calculateDuration / formatTimelineDuration 与缺 ended 语义一致", () => {
    expect(calculateDuration(iso(1_000), iso(3_000), iso(0), NOW).status).toBe("done");
    expect(calculateDuration(iso(1_000), undefined, iso(0), NOW).status).toBe("running");
    expect(formatTimelineDuration(1_500)).toBe("1.5s");
    expect(formatTimelineDuration(65_000)).toContain("m");
  });
});
