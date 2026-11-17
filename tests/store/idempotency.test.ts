import { describe, expect, it } from "vitest";
import {
  reviewIdempotencyKey, reviewDedupeKey, reviewKeyForPayload,
  hasReviewKey, rememberReview, setReviewReceipt, getReceiptByIncident, REVIEW_KEY_VERSION,
} from "../../src/store/idempotency.js";
import { freshDb } from "../helpers/fixtures.js";
import type { ReviewPayload } from "../../src/domain/models.js";

const payload: ReviewPayload = {
  review_result: "人工确认销号", grade: "Ⅱ级", remediation_plan: "补记翻身计划",
  plan_deadline: "2026-11-16T00:00:00Z", evidence_refs: ["交接班漏项"], revision: 1,
};

/** T8：sha256(incident_id|review|revision) 幂等键与查重。 */
describe("T8 回写幂等键", () => {
  it("同一 (incident_id, review, revision) 键相等，不同 revision 不等", () => {
    const a = reviewIdempotencyKey("INC-1", "人工确认销号", 1);
    const b = reviewIdempotencyKey("INC-1", "人工确认销号", 1);
    const c = reviewIdempotencyKey("INC-1", "人工确认销号", 2);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
    expect(reviewKeyForPayload("INC-1", payload)).toBe(a);
  });

  it("键版本号存在，且按 key 查重与回执反查成立", () => {
    expect(REVIEW_KEY_VERSION.length).toBeGreaterThan(0);
    const db = freshDb();
    const key = reviewDedupeKey("INC-1", payload.review_result, payload.revision);
    expect(key).toContain(REVIEW_KEY_VERSION);
    expect(hasReviewKey(db, key)).toBe(false);
    rememberReview(db, { dedupeKey: key, incidentId: "INC-1", batchId: "b1", payload, status: "pending" });
    expect(hasReviewKey(db, key)).toBe(true);
    setReviewReceipt(db, key, "RCP-001");
    expect(getReceiptByIncident(db, "INC-1")).toBe("RCP-001");
  });
});
