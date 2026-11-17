/**
 * 底部运行摘要（T44）：巡检次数 / 重试次数 / 模型调用次数与估算成本。
 * 数字一律取自审计留痕与模型调用汇总，与留痕表同源，不在 UI 侧另行累计。
 */
import type { AuditSummary } from "../store/audit.js";
import type { ModelCallSummary } from "../gateway/ledger.js";

export interface SummaryView {
  sweeps: number;
  retries: number;
  modelCalls: number;
  costText: string;
  costUndefined: boolean;
}

export function buildSummary(audit: AuditSummary, model: ModelCallSummary): SummaryView {
  const costUndefined = model.cost === undefined && audit.estimatedCost === undefined;
  const cost = model.cost ?? audit.estimatedCost;
  return {
    sweeps: audit.sweeps,
    retries: audit.retries,
    // 与 audit 表计数一致：模型调用次数以审计留痕为准，汇总只用于 token / 成本
    modelCalls: Math.max(audit.modelCalls, model.calls),
    costText: cost === undefined ? "未配置单价" : `¥${cost.toFixed(2)}`,
    costUndefined,
  };
}

export function renderSummaryHtml(view: SummaryView): string {
  return `<span>巡检 <strong>${view.sweeps}</strong> 次</span>` +
    `<span>重试 <strong>${view.retries}</strong> 次</span>` +
    `<span>模型调用 <strong>${view.modelCalls}</strong> 次</span>` +
    `<span>估算成本 <strong>${view.costText}</strong></span>`;
}
