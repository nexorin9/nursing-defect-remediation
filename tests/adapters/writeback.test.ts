/** T37 · 质控回写：幂等键 + revision 乐观并发 + 回执落库对账 + 恰好一次 POST。 */
import { describe, it, expect } from "vitest";
import { OutboundHttp } from "../../src/adapters/http.js";
import { submitReview } from "../../src/adapters/writeback.js";
import { reviewKeyForPayload, reviewDedupeKey, getReceiptByIncident } from "../../src/store/idempotency.js";
import { sha256 } from "../../src/util/hash.js";
import { readAudit } from "../../src/store/audit.js";
import type { ReviewPayload } from "../../src/domain/models.js";
import { createFetchStub, type StubResponse } from "../helpers/fetch-stub.js";
import { freshDb, makeTestConfig, testClock } from "../helpers/fixtures.js";

const PAYLOAD: ReviewPayload = {
  review_result: "同意销号",
  grade: "Ⅱ级",
  remediation_plan: "补记翻身计划并双人核对",
  plan_deadline: "2026-11-12",
  evidence_refs: ["交接班漏项"],
  revision: 3,
};

function setup(spec: StubResponse) {
  const stub = createFetchStub([spec]);
  const db = freshDb();
  const http = new OutboundHttp(makeTestConfig(), { fetchImpl: stub.fetchImpl, clock: testClock(), db });
  return { stub, db, http };
}

describe("adapters · 质控回写", () => {
  it("幂等键 = sha256(incident_id|review|revision)，请求头与 body 按契约", async () => {
    const { stub, db, http } = setup({ status: 200, body: { receipt_id: "RCP-2026-0001" } });
    const result = await submitReview("INC-1", PAYLOAD, { http, db, clock: testClock(), runId: "run-wb" });
    expect(result.ok).toBe(true);
    expect(result.sent).toBe(true);
    expect(result.receipt_id).toBe("RCP-2026-0001");
    expect(result.idempotency_key).toBe(reviewKeyForPayload("INC-1", PAYLOAD));
    expect(result.idempotency_key).toBe(sha256(`INC-1|${PAYLOAD.review_result}|${PAYLOAD.revision}`));
    expect(reviewDedupeKey("INC-1", PAYLOAD.review_result, PAYLOAD.revision)).toContain("rk1:");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.url).toBe("https://qc.internal.test/api/v1/nursing-incidents/INC-1/review");
    const headers = stub.calls[0]!.init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe(reviewKeyForPayload("INC-1", PAYLOAD));
    expect(headers["X-Key-Version"]).toBe("rk1");
    const body = JSON.parse(String(stub.calls[0]!.init.body)) as Record<string, unknown>;
    for (const field of ["review_result", "grade", "remediation_plan", "plan_deadline", "evidence_refs", "revision"]) {
      expect(body[field]).toEqual(PAYLOAD[field as keyof ReviewPayload]);
    }
    db.close();
  });

  it("重复触发只产生 1 次 POST；receipt_id 落库并可反查", async () => {
    const { stub, db, http } = setup({ status: 200, body: { receipt_id: "RCP-2026-0002" } });
    const first = await submitReview("INC-2", PAYLOAD, { http, db, clock: testClock() });
    const second = await submitReview("INC-2", PAYLOAD, { http, db, clock: testClock() });
    expect(first.sent).toBe(true);
    expect(second.sent).toBe(false);
    expect(second.reason).toContain("幂等命中");
    expect(stub.calls).toHaveLength(1);
    expect(getReceiptByIncident(db, "INC-2")).toBe("RCP-2026-0002");
    expect(second.receipt_id).toBe("RCP-2026-0002");
    expect(readAudit(db).filter((r) => r.kind === "writeback_ok")).toHaveLength(1);
    db.close();
  });

  it("revision 版本冲突按 409 返回可读错误，不静默重试、不静默改数据", async () => {
    const { stub, db, http } = setup({ status: 409, body: { error: "revision mismatch" } });
    const result = await submitReview("INC-3", PAYLOAD, { http, db, clock: testClock(), runId: "run-409" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.reason).toContain("409");
    expect(result.reason).toContain("人工");
    expect(stub.calls).toHaveLength(1);
    expect(getReceiptByIncident(db, "INC-3")).toBeUndefined();
    const failed = readAudit(db, "run-409").filter((r) => r.kind === "writeback_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.detail).toContain("409");
    db.close();
  });

  it("未经人工确认根本不发 POST", async () => {
    const { stub, db, http } = setup({ status: 200, body: { receipt_id: "RCP-X" } });
    const result = await submitReview("INC-4", PAYLOAD, { http, db }, { confirmed: false });
    expect(result.ok).toBe(false);
    expect(result.sent).toBe(false);
    expect(stub.calls).toHaveLength(0);
    db.close();
  });

  it("响应缺 receipt_id 不视为成功，不写回执", async () => {
    const { db, http } = setup({ status: 200, body: { ok: true } });
    const result = await submitReview("INC-5", PAYLOAD, { http, db });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("receipt_id");
    expect(getReceiptByIncident(db, "INC-5")).toBeUndefined();
    db.close();
  });
});
