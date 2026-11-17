/**
 * adapters · 质控回写（T37）：幂等键 + revision 乐观并发 + 回执落库对账。
 *
 * POST {NURSING_QC_BASE_URL}/api/v1/nursing-incidents/{incident_id}/review
 * 头 idempotency-key = sha256(incident_id|review|revision)；
 * 409 = 版本冲突，返回可读错误并提示人工处理，不静默重试；
 * 回执号落库，可按 incident_id 反查（窗口 / 质控系统 / 台账三处一致）。
 *
 * 回写前必须已通过 rules 闸门与人工确认（ui 侧按钮禁用，根本不会发请求）——
 * 本函数额外要求 confirmed 参数，双重守住「未确认不发 POST」。
 */
import { utc, systemClock, type Clock } from "../util/clock.js";
import { get, run, type Database } from "../store/db.js";
import { appendAudit } from "../store/audit.js";
import {
  reviewKeyForPayload,
  reviewDedupeKey,
  hasReviewKey,
  rememberReview,
  setReviewReceipt,
  getReceiptByIncident,
  REVIEW_KEY_VERSION,
} from "../store/idempotency.js";
import type { ReviewPayload } from "../domain/models.js";
import type { OutboundHttp } from "./http.js";

export interface WritebackDeps {
  http: OutboundHttp;
  db: Database;
  clock?: Clock;
  runId?: string;
}

export interface WritebackResult {
  ok: boolean;
  receipt_id?: string;
  reason?: string;
  status?: number;
  /** 本次是否真的发出了 POST（重复触发应为 false） */
  sent: boolean;
  idempotency_key: string;
}

export async function submitReview(
  incidentId: string,
  payload: ReviewPayload,
  deps: WritebackDeps,
  options: { confirmed: boolean } = { confirmed: true },
): Promise<WritebackResult> {
  const clock = deps.clock ?? systemClock;
  const idempotencyKey = reviewDedupeKey(incidentId, payload.review_result, payload.revision);
  const rawKey = reviewKeyForPayload(incidentId, payload);
  if (!options.confirmed) {
    return { ok: false, reason: "未人工确认，不发回写请求", sent: false, idempotency_key: rawKey };
  }
  if (hasReviewKey(deps.db, idempotencyKey)) {
    const existing = getReceiptByIncident(deps.db, incidentId);
    return {
      ok: existing !== undefined,
      ...(existing ? { receipt_id: existing } : {}),
      reason: "相同结论已回写过，幂等命中，不再发第二次 POST",
      sent: false,
      idempotency_key: rawKey,
    };
  }
  rememberReview(
    deps.db,
    {
      dedupeKey: idempotencyKey,
      incidentId,
      batchId: `review-${payload.revision}-${utc(clock.now()).slice(0, 10)}`,
      payload,
      status: "pending",
    },
    clock,
  );
  const base = deps.http.runtimeConfig.nursingQcBaseUrl;
  const url = `${base}/api/v1/nursing-incidents/${encodeURIComponent(incidentId)}/review`;
  const response = await deps.http.request<{ receipt_id?: string }>(
    {
      method: "POST",
      url,
      token: deps.http.runtimeConfig.nursingQcToken,
      headers: {
        "idempotency-key": rawKey,
        "X-Key-Version": REVIEW_KEY_VERSION,
      },
      body: payload,
      kind: "submit_review",
      runId: deps.runId,
      maxRetries: 0,
    },
  );
  if (!response.ok) {
    const reason = response.status === 409
      ? `revision 版本冲突（409）：质控系统当前版本与本地 revision ${payload.revision} 不一致，请人工核对后处理，不静默重试`
      : `回写失败：${response.error?.message ?? "未知错误"}`;
    run(
      deps.db,
      "UPDATE outbox SET status = 'failed', error = ?, updated_at = ? WHERE dedupe_key = ?",
      reason,
      utc(clock.now()),
      idempotencyKey,
    );
    appendAudit(
      deps.db,
      { runId: deps.runId ?? "adapters", operator: "writeback", kind: "writeback_failed", detail: { incident_id: incidentId, reason, status: response.status ?? 0 } },
      clock,
    );
    return { ok: false, reason, status: response.status, sent: true, idempotency_key: rawKey };
  }
  const receiptId = response.data?.receipt_id;
  if (!receiptId) {
    return { ok: false, reason: "回写响应缺 receipt_id，不视为成功", status: response.status, sent: true, idempotency_key: rawKey };
  }
  setReviewReceipt(deps.db, idempotencyKey, receiptId, clock);
  appendAudit(
    deps.db,
    { runId: deps.runId ?? "adapters", operator: "writeback", kind: "writeback_ok", detail: { incident_id: incidentId, receipt_id: receiptId, idempotency_key: rawKey } },
    clock,
  );
  return { ok: true, receipt_id: receiptId, status: response.status, sent: true, idempotency_key: rawKey };
}
