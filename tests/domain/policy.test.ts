import { describe, expect, it } from "vitest";
import { createPolicy, hasSource, isOverdue, buildReminderQueue, dueHoursFor } from "../../src/domain/policy.js";
import { HOUR_MS } from "../../src/util/clock.js";

/** T5：口径配置化 + 无时限时三态 + 配置项来源标注。 */
describe("T5 口径配置", () => {
  it("配置 4h 时限时挂起 5h 判超期", () => {
    const policy = createPolicy({
      stepDueHours: { value: { awaiting_grade: 4 }, source: "院内制度导入" },
    });
    expect(dueHoursFor(policy, "awaiting_grade")).toBe(4);
    expect(isOverdue(policy, "awaiting_grade", 5 * HOUR_MS)).toBe(true);
    expect(isOverdue(policy, "awaiting_grade", 3 * HOUR_MS)).toBe(false);
  });

  it("未配置时限时 isOverdue() === undefined 且催办队列长度为 0", () => {
    const policy = createPolicy();
    expect(isOverdue(policy, "awaiting_grade", 50 * HOUR_MS)).toBeUndefined();
    const queue = buildReminderQueue(policy, [
      { incident_id: "A", run_id: "r1", status: "awaiting_grade", elapsed_ms: 50 * HOUR_MS },
    ]);
    expect(queue).toHaveLength(0);
  });

  it("每个配置项都带非空 source，且无来源标注的默认值不进入超期判定", () => {
    const policy = createPolicy();
    expect(hasSource(policy)).toBe(true);
    for (const item of Object.values(policy)) {
      expect(typeof (item as { source: string }).source).toBe("string");
      expect((item as { source: string }).source.length).toBeGreaterThan(0);
    }
    expect(policy.stepDueHours.source).toBe("经验推断·待核验");
    expect(isOverdue(policy, "awaiting_review", 999 * HOUR_MS)).toBeUndefined();
  });
});
