/** T34 · 制度条款命中 + 闸门聚合 + 可读停步原因 + 审计留痕。 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runGate } from "../../src/rules/index.js";
import { clauseHitsFor, hasComplianceConclusion, assetGapNotes } from "../../src/rules/clause-hit.js";
import { CLAUSE_ASSET_FILE } from "../../src/domain/clauses.js";
import { createPolicy } from "../../src/domain/policy.js";
import { readAudit } from "../../src/store/audit.js";
import { freshDb, testClock } from "../helpers/fixtures.js";

const NARRATIVE = "交接班漏项，给药核对未双人签字，已按流程补记并上报。";
const REPORTED = "2026-11-09T00:00:00.000Z";

describe("守门层 · 条款命中与闸门聚合", () => {
  it("每条命中带文件名 + 节次 + 条序，且条款文件真实存在", () => {
    expect(existsSync(resolve(process.cwd(), CLAUSE_ASSET_FILE))).toBe(true);
    const hits = clauseHitsFor(NARRATIVE);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (const hit of hits) {
      expect(hit.ref).toContain(CLAUSE_ASSET_FILE);
      expect(hit.ref).toMatch(/第 \d+ 条/);
      expect(hit.missingPrompt.length).toBeGreaterThan(0);
      expect(hasComplianceConclusion(hit.missingPrompt)).toBe(false);
    }
    const corpus = readFileSync(resolve(process.cwd(), CLAUSE_ASSET_FILE), "utf8");
    expect(corpus).toContain("交接班");
    expect(assetGapNotes().length).toBeGreaterThan(0);
  });

  it("只做要素提取与缺项提示，不下合规结论", () => {
    expect(hasComplianceConclusion("请补全：交接班专册记录号")).toBe(false);
    expect(hasComplianceConclusion("符合规定，未违规")).toBe(true);
    expect(clauseHitsFor(NARRATIVE).some((h) => h.ref.includes("五、值班和交接班制度"))).toBe(true);
  });

  it("多规则同时失败时聚合结果列出全部失败项与可读原因", () => {
    const decision = runGate({
      policy: createPolicy(),
      draft: { grade: "Ⅴ级", evidence_refs: ["伪造的原句"] },
      narrative: NARRATIVE,
      reportedAt: REPORTED,
      requiredFields: ["grade", "remediation_plan"],
      closeAt: "2026-11-08T00:00:00.000Z",
    });
    expect(decision.ok).toBe(false);
    expect(decision.ruleResults.schema).toBe(false);
    expect(decision.ruleResults.temporal).toBe(false);
    expect(decision.ruleResults.citation).toBe(false);
    const rules = decision.violations.map((v) => v.rule);
    expect(rules).toContain("enum");
    expect(rules).toContain("required");
    expect(rules).toContain("temporal");
    expect(rules).toContain("hallucinated_citation");
    expect(decision.reasons.length).toBeGreaterThanOrEqual(5);
    expect(decision.reasons.every((r) => r.length > 8)).toBe(true);
    expect(decision.sanitizedDraft.evidence_refs).toEqual([]);
    expect(decision.auditWritten).toBe(false);
  });

  it("全部通过时放行，且审计新增 1 行含输入 / 输出哈希与各规则结论", () => {
    const db = freshDb();
    const decision = runGate({
      policy: createPolicy(),
      db,
      runId: "run-gate",
      operator: "护士长",
      clock: testClock(),
      draft: {
        grade: "Ⅱ级",
        remediation_plan: "补记翻身计划并双人核对",
        evidence_refs: ["交接班漏项"],
      },
      narrative: NARRATIVE,
      reportedAt: REPORTED,
      requiredFields: ["grade", "remediation_plan"],
      measureAt: "2026-11-09T01:00:00.000Z",
    });
    expect(decision.ok).toBe(true);
    expect(decision.reasons.every((r) => r.includes("制度提示"))).toBe(true);
    expect(decision.ruleResults).toEqual({ schema: true, temporal: true, citation: true, clause_hit: true });
    expect(decision.auditWritten).toBe(true);
    const rows = readAudit(db, "run-gate");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("gate");
    expect(rows[0]!.input_hash.length).toBeGreaterThan(10);
    expect(rows[0]!.output_hash.length).toBeGreaterThan(10);
    const detail = JSON.parse(rows[0]!.detail ?? "{}") as { rule_results: Record<string, boolean>; ok: boolean };
    expect(detail.ok).toBe(true);
    expect(detail.rule_results.schema).toBe(true);
    db.close();
  });
});
