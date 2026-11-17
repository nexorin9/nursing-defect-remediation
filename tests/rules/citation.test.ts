/** T33 · 引文回查：归一化比对，伪造引文标 hallucinated_citation 且不进 payload。 */
import { describe, it, expect } from "vitest";
import { normalizeForCitation, verifyCitations, sanitizePayload } from "../../src/rules/citation.js";
import { runGate } from "../../src/rules/index.js";
import { createPolicy } from "../../src/domain/policy.js";
import { freshDb } from "../helpers/fixtures.js";

const NARRATIVE = "交接班漏项，已按流程补记并上报。夜间巡视未按时完成。";

describe("守门层 · 引文回查", () => {
  it("归一化去除空白 / 标点 / 全半角差异，但不做语义改写", () => {
    expect(normalizeForCitation("交接班漏项， 已按流程补记并上报。")).toBe(
      normalizeForCitation("交接班漏项，已按流程补记并上报"),
    );
    expect(normalizeForCitation("ＡＢＣ１２，")).toBe("abc12");
    expect(normalizeForCitation("交接班漏项").includes("语义改写")).toBe(false);
  });

  it("确实出现在原文中的引文通过；原文里没有的判 hallucinated", () => {
    const check = verifyCitations(NARRATIVE, ["交接班漏项，已按流程补记并上报", "护士长已签字确认整改完成"]);
    expect(check.valid).toEqual(["交接班漏项，已按流程补记并上报"]);
    expect(check.hallucinated).toEqual(["护士长已签字确认整改完成"]);
    expect(check.ok).toBe(false);
  });

  it("全角 / 半角标点差异仍可命中；空引文判作废", () => {
    const check = verifyCitations(NARRATIVE, ["交接班漏项,已按流程补记并上报", "   "]);
    expect(check.valid).toHaveLength(1);
    expect(check.hallucinated).toHaveLength(1);
  });

  it("作废要素不进入回写 payload", () => {
    const payload = {
      review_result: "同意销号",
      grade: "Ⅱ级",
      remediation_plan: "补记翻身计划",
      plan_deadline: "2026-11-12",
      evidence_refs: ["交接班漏项", "伪造的原句"],
      revision: 1,
    };
    const { payload: clean, hallucinated } = sanitizePayload(payload, NARRATIVE);
    expect(hallucinated).toEqual(["伪造的原句"]);
    expect(clean.evidence_refs).toEqual(["交接班漏项"]);
    expect(payload.evidence_refs).toHaveLength(2);
  });

  it("闸门里伪造引文标 hallucinated_citation，且 sanitizedDraft 不含该引文", () => {
    const db = freshDb();
    const decision = runGate({
      policy: createPolicy(),
      db,
      runId: "run-citation",
      draft: {
        grade: "Ⅱ级",
        remediation_plan: "补记翻身计划",
        evidence_refs: ["交接班漏项", "护士长已签字确认整改完成"],
      },
      narrative: NARRATIVE,
      reportedAt: "2026-11-09T00:00:00.000Z",
      requiredFields: ["grade", "remediation_plan"],
    });
    expect(decision.ok).toBe(false);
    expect(decision.hallucinated).toHaveLength(1);
    expect(decision.violations.some((v) => v.rule === "hallucinated_citation")).toBe(true);
    expect(decision.sanitizedDraft.evidence_refs).toEqual(["交接班漏项"]);
    expect(JSON.stringify(decision.sanitizedDraft)).not.toContain("护士长已签字确认整改完成");
    expect(decision.reasons.some((r) => r.includes("引文回查未通过"))).toBe(true);
    expect(decision.auditWritten).toBe(true);
    db.close();
  });
});
