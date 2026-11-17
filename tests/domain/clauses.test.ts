import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CLAUSE_HITS, ASSET_GAPS, renderClauseHits, containsConclusion, findClauseHits, SOURCE_ASSET_NAME } from "../../src/domain/clauses.js";

/** T6：条款命中集带文件名 + 节次 + 条序，资产缺口标注，不下合规结论。 */
describe("T6 制度条款命中集", () => {
  it("每条 clauseRef 三要素齐全且 file 指向真实资产文件", () => {
    expect(CLAUSE_HITS.length).toBeGreaterThan(0);
    for (const hit of CLAUSE_HITS) {
      expect(hit.file.length).toBeGreaterThan(0);
      expect(hit.section.length).toBeGreaterThan(0);
      expect(hit.clauseNo.length).toBeGreaterThan(0);
      expect(hit.quote.length).toBeGreaterThan(0);
      expect(existsSync(resolve(process.cwd(), hit.file))).toBe(true);
    }
    expect(SOURCE_ASSET_NAME).toContain("core_systems_18");
  });

  it("资产缺口显式标 (经验推断) 且输出文本不含合规结论词", () => {
    const inferred = ASSET_GAPS.filter((g) => g.label.includes("经验推断"));
    expect(inferred.length).toBeGreaterThan(0);
    const text = renderClauseHits(CLAUSE_HITS);
    expect(text).toContain("经验推断");
    expect(containsConclusion(text)).toBe(false);
    expect(text).not.toContain("符合规定");
    expect(text).not.toContain("违规");
  });

  it("命中范围限定在节录资产条款，按关键词只做要素提取", () => {
    const hits = findClauseHits("交接班漏项，给药核对遗漏");
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.file).toBe(CLAUSE_HITS[0]!.file);
    expect(findClauseHits("无相关叙述")).toHaveLength(0);
  });
});
