/**
 * 模型调用留痕与成本口径（T30）。
 *
 * 每次调用记 call_id / 模型名 / 输入输出 token / 耗时 / 状态 / 估算成本，落 audit；
 * 单价按每百万 token 配置换算（对齐 input_cost_per_token / output_cost_per_token 的口径）。
 * 单价缺失时成本为 undefined（窗口显示「未配置单价」），绝不伪造 0。
 */
import { utc, type Clock } from "../util/clock.js";
import { appendAudit, readAudit } from "../store/audit.js";
import type { Database } from "../store/db.js";
import type { QcPolicy } from "../domain/policy.js";

export interface ModelCallRecord {
  callId: string;
  runId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  status: "ok" | "failed" | "degraded";
  estimatedCost?: number;
  reason?: string;
  attempts?: number;
}

export function estimateCost(policy: QcPolicy, inputTokens: number, outputTokens: number): number | undefined {
  const price = policy.modelPricePerMillion.value;
  if (!price) return undefined;
  const cost = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

export function recordModelCall(db: Database, record: ModelCallRecord, clock?: Clock): void {
  appendAudit(
    db,
    {
      runId: record.runId,
      operator: "model_gateway",
      kind: "model_call",
      modelCallId: record.callId,
      detail: {
        call_id: record.callId,
        model: record.model,
        input_tokens: record.inputTokens,
        output_tokens: record.outputTokens,
        duration_ms: record.durationMs,
        status: record.status,
        estimated_cost: record.estimatedCost,
        reason: record.reason ?? "",
        attempts: record.attempts ?? 1,
      },
    },
    clock,
  );
}

export interface ModelCallSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number | undefined;
  priced: number;
}

/** 按 run_id 汇总，供窗口底部运行摘要读取（与逐条留痕一致）。 */
export function summarizeModelCalls(db: Database, runId?: string): ModelCallSummary {
  const rows = readAudit(db, runId).filter((r) => r.kind === "model_call");
  let input = 0;
  let output = 0;
  let cost = 0;
  let priced = 0;
  for (const row of rows) {
    try {
      const detail = JSON.parse(row.detail ?? "{}") as {
        input_tokens?: number;
        output_tokens?: number;
        estimated_cost?: number;
      };
      input += detail.input_tokens ?? 0;
      output += detail.output_tokens ?? 0;
      if (typeof detail.estimated_cost === "number") {
        cost += detail.estimated_cost;
        priced += 1;
      }
    } catch {
      /* 非结构化留痕不参与汇总 */
    }
  }
  return {
    calls: rows.length,
    inputTokens: input,
    outputTokens: output,
    cost: priced > 0 ? Math.round(cost * 1e6) / 1e6 : undefined,
    priced,
  };
}
