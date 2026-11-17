/** T33 · 时间序校验：措施 / 复核 / 销号不得早于上报，交接班记录按记录时间排序。 */
import { describe, it, expect } from "vitest";
import { validateTemporal, sortRecords } from "../../src/rules/temporal.js";
import { runGate } from "../../src/rules/index.js";
import { createPolicy } from "../../src/domain/policy.js";

const REPORTED = "2026-11-09T00:00:00.000Z";

describe("守门层 · 时间序", () => {
  it("顺序正常时放行", () => {
    const result = validateTemporal({
      reported_at: REPORTED,
      measure_at: "2026-11-09T01:00:00.000Z",
      review_at: "2026-11-09T02:00:00.000Z",
      close_at: "2026-11-09T03:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("措施 / 复核 / 销号早于上报时刻均被拒并给出字段级原因", () => {
    const result = validateTemporal({
      reported_at: REPORTED,
      measure_at: "2026-11-08T23:00:00.000Z",
      review_at: "2026-11-08T22:00:00.000Z",
      close_at: "2026-11-08T21:00:00.000Z",
    });
    expect(result.ok).toBe(false);
    expect(result.violations.filter((v) => v.rule === "temporal").map((v) => v.field)).toEqual(
      expect.arrayContaining(["measure_at", "review_at", "close_at"]),
    );
    expect(result.violations[0]!.expected).toContain("不早于上报时刻");
  });

  it("步骤之间时刻倒置被拒；上报时刻非法也被拒", () => {
    const inverted = validateTemporal({
      reported_at: REPORTED,
      measure_at: "2026-11-09T05:00:00.000Z",
      review_at: "2026-11-09T04:00:00.000Z",
    });
    expect(inverted.violations.some((v) => v.field === "review_at")).toBe(true);
    const badReported = validateTemporal({ reported_at: "不是时间" });
    expect(badReported.ok).toBe(false);
    expect(badReported.violations[0]!.field).toBe("reported_at");
  });

  it("交接班记录按记录时间稳定排序，不改原文", () => {
    const records = [
      { time: "2026-11-09T03:00:00.000Z", text: "销号", author_role: "护士长" },
      { time: "2026-11-09T01:00:00.000Z", text: "补记", author_role: "责任护士" },
      { time: "2026-11-09T02:00:00.000Z", text: "复核", author_role: "护理组长" },
    ];
    expect(sortRecords(records).map((r) => r.text)).toEqual(["补记", "复核", "销号"]);
    expect(records[0]!.text).toBe("销号");
  });

  it("闸门聚合中时间序倒置会导致停步", () => {
    const decision = runGate({
      policy: createPolicy(),
      draft: { grade: "Ⅱ级", remediation_plan: "补记翻身计划", evidence_refs: [] },
      narrative: "交接班漏项",
      reportedAt: REPORTED,
      requiredFields: ["grade", "remediation_plan"],
      measureAt: "2026-11-08T23:00:00.000Z",
    });
    expect(decision.ok).toBe(false);
    expect(decision.ruleResults.temporal).toBe(false);
    expect(decision.reasons.some((r) => r.includes("temporal"))).toBe(true);
  });
});
