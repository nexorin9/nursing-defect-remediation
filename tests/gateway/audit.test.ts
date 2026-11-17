/** T30 · 模型调用留痕：call_id / token 用量 / 估算成本口径 / 按 run_id 汇总。 */
import { describe, it, expect } from "vitest";
import { createPolicy } from "../../src/domain/policy.js";
import { estimateCost, recordModelCall, summarizeModelCalls } from "../../src/gateway/ledger.js";
import { readAudit, auditSummary } from "../../src/store/audit.js";
import { buildSummary, renderSummaryHtml } from "../../src/ui/summary.js";
import { freshDb, testClock } from "../helpers/fixtures.js";

describe("模型调用留痕与成本口径", () => {
  it("按每百万 token 单价换算；单价缺失时成本为 undefined 而非 0", () => {
    const priced = createPolicy({ modelPricePerMillion: { value: { input: 10, output: 20 } } });
    expect(estimateCost(priced, 1000, 500)).toBe(0.02);
    expect(estimateCost(createPolicy(), 1000, 500)).toBeUndefined();
    expect(estimateCost(createPolicy(), 0, 0)).toBeUndefined();
  });

  it("审计新增 1 行含 call_id / 输入输出 token / 耗时 / 状态 / 估算成本", () => {
    const db = freshDb();
    recordModelCall(db, {
      callId: "call_001",
      runId: "run-1",
      model: "院内模型",
      inputTokens: 1000,
      outputTokens: 500,
      durationMs: 320,
      status: "ok",
      estimatedCost: 0.02,
    }, testClock());
    const rows = readAudit(db, "run-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("model_call");
    expect(rows[0]!.model_call_id).toBe("call_001");
    const detail = JSON.parse(rows[0]!.detail ?? "{}") as Record<string, unknown>;
    expect(detail.call_id).toBe("call_001");
    expect(detail.input_tokens).toBe(1000);
    expect(detail.output_tokens).toBe(500);
    expect(detail.duration_ms).toBe(320);
    expect(detail.estimated_cost).toBe(0.02);
    expect(detail.status).toBe("ok");
    db.close();
  });

  it("未配置单价时成本字段不写入，窗口显示「未配置单价」", () => {
    const db = freshDb();
    recordModelCall(db, {
      callId: "call_002",
      runId: "run-2",
      model: "院内模型",
      inputTokens: 20,
      outputTokens: 10,
      durationMs: 100,
      status: "degraded",
      estimatedCost: estimateCost(createPolicy(), 20, 10),
    }, testClock());
    const detail = JSON.parse(readAudit(db, "run-2")[0]!.detail ?? "{}") as { estimated_cost?: number };
    expect(detail.estimated_cost).toBeUndefined();
    const summary = summarizeModelCalls(db, "run-2");
    expect(summary.cost).toBeUndefined();
    expect(summary.priced).toBe(0);
    const view = buildSummary(auditSummary(db, "run-2"), summary);
    expect(view.costText).toBe("未配置单价");
    expect(renderSummaryHtml(view)).toContain("未配置单价");
    db.close();
  });

  it("按 run_id 汇总数与逐条留痕一致", () => {
    const db = freshDb();
    for (let i = 0; i < 3; i += 1) {
      recordModelCall(db, {
        callId: `call_${i}`,
        runId: "run-3",
        model: "院内模型",
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 10,
        status: i === 2 ? "degraded" : "ok",
        estimatedCost: 0.001,
      }, testClock());
    }
    recordModelCall(db, {
      callId: "call_other",
      runId: "run-other",
      model: "院内模型",
      inputTokens: 999,
      outputTokens: 999,
      durationMs: 10,
      status: "ok",
    }, testClock());
    const summary = summarizeModelCalls(db, "run-3");
    expect(summary.calls).toBe(3);
    expect(summary.inputTokens).toBe(300);
    expect(summary.outputTokens).toBe(150);
    expect(summary.cost).toBe(0.003);
    expect(auditSummary(db, "run-3").modelCalls).toBe(3);
    expect(buildSummary(auditSummary(db, "run-3"), summary).modelCalls).toBe(3);
    db.close();
  });
});
