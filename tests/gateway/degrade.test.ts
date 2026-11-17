/** T29 · 超时 / 退避 / 降级：degraded=true，停在当前步，不推进、不回写、不销号。 */
import { describe, it, expect } from "vitest";
import { callWithDegrade, ruleCoarseGrade } from "../../src/gateway/degrade.js";
import { OpenAiCompatibleGateway } from "../../src/gateway/model-gateway.js";
import { createFetchStub, chatResponse } from "../helpers/fetch-stub.js";
import { Engine } from "../../src/runtime/engine.js";
import { readAudit } from "../../src/store/audit.js";
import { freshDb, makeIncident, makeTestConfig, testClock } from "../helpers/fixtures.js";

describe("模型降级", () => {
  it("5xx 按配置退避重试后全部失败，返回 degraded=true 与可读原因", async () => {
    const stub = createFetchStub([{ status: 503, body: { error: "unavailable" } }]);
    const gateway = new OpenAiCompatibleGateway(makeTestConfig({ modelMaxRetries: 2 }), {
      fetchImpl: stub.fetchImpl,
      maxRetries: 2,
    });
    const outcome = await callWithDegrade(gateway, { messages: [{ role: "user", content: "跌倒" }] }, { narrative: "患者夜间跌倒" });
    expect(outcome.ok).toBe(false);
    expect(outcome.degraded).toBe(true);
    expect(outcome.reason).toContain("模型不可达，已用规则初判，待人工确认");
    expect(outcome.coarseGrade).toContain("跌倒类");
    // 首次 + 2 次退避重试
    expect(stub.calls.length).toBe(3);
  });

  it("规则粗分级只给参考，不下合规结论", () => {
    expect(ruleCoarseGrade("压疮")).toContain("压力性损伤");
    expect(ruleCoarseGrade("给药核对")).toContain("给药核对");
    expect(ruleCoarseGrade("无关键词")).toContain("规则初判不足");
  });

  it("超时错误同样降级，窗口文案与审计如实留痕", async () => {
    const stub = createFetchStub([{ timeout: true }]);
    const gateway = new OpenAiCompatibleGateway(makeTestConfig({ modelMaxRetries: 1 }), {
      fetchImpl: stub.fetchImpl,
      maxRetries: 1,
    });
    const db = freshDb();
    let writebackCalls = 0;
    const engine = new Engine({
      db,
      clock: testClock(),
      hooks: {
        onStep: async () => {
          const outcome = await callWithDegrade(gateway, { messages: [{ role: "user", content: "跌倒" }] }, { narrative: "夜间跌倒" });
          return { ok: false, degraded: true, reason: outcome.reason, callId: outcome.callId ?? "call-timeout" };
        },
        onWriteback: async () => {
          writebackCalls += 1;
          return { ok: true };
        },
      },
    });
    const scheduled = engine.schedule(makeIncident());
    const before = engine.getRun(scheduled.run.run_id)?.status;
    await engine.execute(scheduled.run.run_id);
    expect(engine.getRun(scheduled.run.run_id)?.status).toBe(before);
    expect(engine.countSteps(scheduled.run.run_id)).toBe(0);
    expect(writebackCalls).toBe(0);
    const degraded = readAudit(db, scheduled.run.run_id).filter((r) => r.kind === "model_degraded");
    expect(degraded).toHaveLength(1);
    const detail = JSON.parse(degraded[0]!.detail ?? "{}") as { call_id?: string; reason?: string };
    expect(detail.call_id).toBeTruthy();
    expect(detail.reason).toContain("模型不可达");
    db.close();
  });

  it("模型正常返回时不降级", async () => {
    const stub = createFetchStub([chatResponse("正常结构化文本")]);
    const gateway = new OpenAiCompatibleGateway(makeTestConfig(), { fetchImpl: stub.fetchImpl, maxRetries: 0 });
    const outcome = await callWithDegrade(gateway, { messages: [{ role: "user", content: "x" }] });
    expect(outcome.degraded).toBe(false);
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe("正常结构化文本");
  });
});
