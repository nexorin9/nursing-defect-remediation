/**
 * 守门层 · 制度条款命中（T34）。
 * 每条命中带「文件名 + 节次 + 条序」；只做要素提取与缺项提示，不下合规结论。
 * 资产未覆盖的细节标 (经验推断 · 院内制度待核验)。
 */
import { CLAUSE_HITS, ASSET_GAPS, CONCLUSION_WORDS, type ClauseHit } from "../domain/clauses.js";

export interface ClauseView {
  ref: string;
  usage: string;
  missingPrompt: string;
  inferred: boolean;
}

export function clauseHitsFor(narrative: string): ClauseView[] {
  const matched = CLAUSE_HITS.filter((hit: ClauseHit) => hit.keywords.some((k) => narrative.includes(k)));
  return matched.map((hit) => ({
    ref: `${hit.file} · ${hit.section} ${hit.clauseNo}`,
    usage: hit.usage,
    missingPrompt: hit.missingPrompt,
    inferred: hit.inferred ?? false,
  }));
}

/** 资产缺口提示，供窗口显示「未设定时限 / 分级细则待核验」。 */
export function assetGapNotes(): string[] {
  return ASSET_GAPS.map((gap) => `${gap.item} ${gap.label}：${gap.reason}`);
}

export function hasComplianceConclusion(text: string): boolean {
  return CONCLUSION_WORDS.some((word) => text.includes(word));
}
