/** T44 · 加载 / 空 / 错误三态 + toast + 凭据提示 + 运行摘要与审计计数一致。 */
import { describe, it, expect } from "vitest";
import {
  decideViewState, renderStateView, toastRules, missingCredentialsBanner,
} from "../../src/ui/states.js";
import { buildSummary, renderSummaryHtml } from "../../src/ui/summary.js";
import { appendAudit, auditSummary } from "../../src/store/audit.js";
import { recordModelCall, summarizeModelCalls } from "../../src/gateway/ledger.js";
import { freshDb, testClock } from "../helpers/fixtures.js";

describe("UI 三态与运行摘要", () => {
  it("加载 / 空 / 错误三态各自渲染", () => {
    expect(decideViewState({ loading: true, itemCount: 0 })).toBe("loading");
    expect(renderStateView("loading")).toContain("ndr-skeleton");
    expect(decideViewState({ loading: false, itemCount: 0 })).toBe("empty");
    expect(renderStateView("empty")).toContain("还没有收到新的护理缺陷上报");
    expect(renderStateView("empty")).toContain("立即巡检");
    expect(decideViewState({ loading: false, itemCount: 2, error: "拉取失败" })).toBe("error");
    expect(decideViewState({ loading: false, itemCount: 0 })).toBe("empty");
    expect(renderStateView("error", { error: "质控系统 503" })).toContain("质控系统 503");
    expect(renderStateView("ready")).toBe("");
  });

  it("错误态含可读原因与重试按钮；toast 有持续时间与堆叠规则", () => {
    const html = renderStateView("error", { missingEnv: ["NURSING_QC_TOKEN"] });
    expect(html).toContain("data-retry");
    expect(html).toContain("缺少环境变量：NURSING_QC_TOKEN");
    const rules = toastRules();
    expect(rules.durationMs).toBeGreaterThan(0);
    expect(rules.maxStack).toBeGreaterThan(0);
    expect(rules.kinds).toEqual(["success", "warning", "fail"]);
  });

  it("凭据缺失时显式提示变量名，不静默显示空列表", () => {
    expect(decideViewState({ loading: false, itemCount: 0, missingEnv: ["MODEL_API_KEY"] })).toBe("error");
    const banner = missingCredentialsBanner(["MODEL_API_KEY", "EMR_API_TOKEN"]);
    expect(banner).toContain("MODEL_API_KEY");
    expect(banner).toContain("EMR_API_TOKEN");
    expect(banner).toContain("role=\"alert\"");
    expect(missingCredentialsBanner([])).toBe("");
  });

  it("运行摘要的巡检 / 重试 / 模型调用次数与 audit 表计数一致", () => {
    const db = freshDb();
    const clock = testClock();
    appendAudit(db, { runId: "run-summary", operator: "scheduler", kind: "sweep" }, clock);
    appendAudit(db, { runId: "run-summary", operator: "scheduler", kind: "sweep" }, clock);
    appendAudit(db, { runId: "run-summary", operator: "engine", kind: "retry" }, clock);
    recordModelCall(db, {
      callId: "call-summary-1", runId: "run-summary", model: "院内模型",
      inputTokens: 100, outputTokens: 50, durationMs: 12, status: "ok",
    }, clock);
    const audit = auditSummary(db, "run-summary");
    const model = summarizeModelCalls(db, "run-summary");
    const view = buildSummary(audit, model);
    expect(view.sweeps).toBe(2);
    expect(view.retries).toBe(1);
    expect(view.modelCalls).toBe(1);
    expect(view.costText).toBe("未配置单价");
    expect(view.costUndefined).toBe(true);
    expect(renderSummaryHtml(view)).toContain("巡检 <strong>2</strong> 次");
    expect(renderSummaryHtml(view)).toContain("模型调用 <strong>1</strong> 次");
    db.close();
  });

  it("配置单价后成本来自留痕，不在 UI 侧另算一份", () => {
    const db = freshDb();
    recordModelCall(db, {
      callId: "call-priced", runId: "run-priced", model: "院内模型",
      inputTokens: 1000, outputTokens: 500, durationMs: 20, status: "ok", estimatedCost: 0.02,
    }, testClock());
    const view = buildSummary(auditSummary(db, "run-priced"), summarizeModelCalls(db, "run-priced"));
    expect(view.costText).toBe("¥0.02");
    expect(view.costUndefined).toBe(false);
    db.close();
  });
});
