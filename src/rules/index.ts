/**
 * 守门层 · 闸门聚合（T34）。
 *
 * 枚举 / 必填 / 时间序 / 引文回查 / 制度条款命中全部通过 → 放行推进；
 * 任一不过 → 停在当前步 + 给出可读原因列表（哪条规则 + 哪个字段 + 怎么改），
 * 结果写审计（输入哈希 + 输出哈希 + 各规则结论）。
 */
import { digest } from "../util/hash.js";
import { appendAudit } from "../store/audit.js";
import type { Database } from "../store/db.js";
import type { Clock } from "../util/clock.js";
import type { QcPolicy } from "../domain/policy.js";
import { validateDraft, type RuleViolation } from "./schema.js";
import { validateTemporal } from "./temporal.js";
import { verifyCitations } from "./citation.js";
import { clauseHitsFor, assetGapNotes, type ClauseView } from "./clause-hit.js";

export interface GateInput {
  policy: QcPolicy;
  draft: Record<string, unknown>;
  narrative: string;
  reportedAt: string;
  requiredFields: readonly string[];
  measureAt?: string;
  reviewAt?: string;
  closeAt?: string;
  db?: Database;
  runId?: string;
  operator?: string;
  clock?: Clock;
}

export interface GateDecision {
  ok: boolean;
  reasons: string[];
  violations: RuleViolation[];
  clauseHits: ClauseView[];
  hallucinated: string[];
  assetGaps: string[];
  sanitizedDraft: Record<string, unknown>;
  ruleResults: Record<string, boolean>;
  auditWritten: boolean;
}

export function runGate(input: GateInput): GateDecision {
  const schemaCheck = validateDraft(input.policy, input.draft, input.requiredFields);
  const temporalCheck = validateTemporal({
    reported_at: input.reportedAt,
    ...(input.measureAt ? { measure_at: input.measureAt } : {}),
    ...(input.reviewAt ? { review_at: input.reviewAt } : {}),
    ...(input.closeAt ? { close_at: input.closeAt } : {}),
  });
  const refs = Array.isArray(input.draft.evidence_refs)
    ? (input.draft.evidence_refs as unknown[]).map(String)
    : [];
  const citationCheck = verifyCitations(input.narrative, refs);
  const clauseHits = clauseHitsFor(input.narrative);

  const violations = [...schemaCheck.violations, ...temporalCheck.violations];
  const reasons = violations.map(
    (v) => `规则 ${v.rule} · 字段 ${v.field}：期望 ${v.expected}，实际 ${v.actual}；请修正后重新确认`,
  );
  for (const ref of citationCheck.hallucinated) {
    violations.push({ rule: "hallucinated_citation", field: "evidence_refs", expected: "原句须出现在上报叙述中", actual: ref });
    reasons.push(`引文回查未通过 · evidence_refs：原句「${ref}」未出现在上报叙述中，该要素作废，请删除或改用原文`);
  }
  for (const hit of clauseHits) {
    reasons.push(`制度提示 · ${hit.ref}：${hit.missingPrompt}`);
  }

  const ruleResults: Record<string, boolean> = {
    schema: schemaCheck.ok,
    temporal: temporalCheck.ok,
    citation: citationCheck.ok,
    clause_hit: true,
  };
  const ok = schemaCheck.ok && temporalCheck.ok && citationCheck.ok;
  const sanitizedDraft = { ...input.draft, evidence_refs: citationCheck.valid };
  let auditWritten = false;
  if (input.db && input.runId) {
    appendAudit(
      input.db,
      {
        runId: input.runId,
        operator: input.operator ?? "rules_gate",
        kind: "gate",
        inputHash: digest({ draft: input.draft, narrative: input.narrative }),
        outputHash: digest({ ok, reasons, sanitizedDraft }),
        detail: { ok, rule_results: ruleResults, violations, hallucinated: citationCheck.hallucinated, clause_hits: clauseHits.length },
      },
      input.clock,
    );
    auditWritten = true;
  }
  return {
    ok,
    reasons,
    violations,
    clauseHits,
    hallucinated: citationCheck.hallucinated,
    assetGaps: assetGapNotes(),
    sanitizedDraft,
    ruleResults,
    auditWritten,
  };
}
