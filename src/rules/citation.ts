/**
 * 守门层 · 引文回查（T33）。
 *
 * 模型引用的原句必须确实出现在输入文本中，否则该条要素作废并标
 * hallucinated_citation；归一化只去空白 / 标点 / 全半角差异，**不做**语义改写。
 * 作废的要素不得进入确认闸门，也不得进入回写 payload。
 */
export interface CitationCheck {
  valid: string[];
  hallucinated: string[];
  ok: boolean;
}

/** 归一化比对：全角转半角、去空白与标点、统一大小写。 */
export function normalizeForCitation(text: string): string {
  const halfWidth = text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, " ");
  return halfWidth
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLocaleLowerCase();
}

export function verifyCitations(narrative: string, refs: readonly string[]): CitationCheck {
  const normalizedNarrative = normalizeForCitation(narrative);
  const valid: string[] = [];
  const hallucinated: string[] = [];
  for (const ref of refs) {
    const needle = normalizeForCitation(ref);
    if (needle.length > 0 && normalizedNarrative.includes(needle)) valid.push(ref);
    else hallucinated.push(ref);
  }
  return { valid, hallucinated, ok: hallucinated.length === 0 };
}

/** 过滤回写 payload 里的引文，附作废标记。 */
export function sanitizePayload<T extends { evidence_refs?: string[] }>(
  payload: T,
  narrative: string,
): { payload: T; hallucinated: string[] } {
  const check = verifyCitations(narrative, payload.evidence_refs ?? []);
  return { payload: { ...payload, evidence_refs: check.valid }, hallucinated: check.hallucinated };
}
