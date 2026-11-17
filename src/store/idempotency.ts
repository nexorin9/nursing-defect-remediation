/**
 * 回写幂等键（T8）：sha256(incident_id|review|revision) + 键版本号。
 *
 * 与 runtime 的步骤哈希分开：这里守的是「同一结论只回写质控系统一次」，
 * 那里守的是「同一步骤只执行一次副作用」。两者都依赖 outbox 的 dedupe_key 唯一约束。
 */
import { sha256, stableStringify } from "../util/hash.js";
import { utc, type Clock } from "../util/clock.js";
import { get, run, type Database } from "./db.js";
import type { ReviewPayload } from "../domain/models.js";

/** 输入格式变化时递增，让历史键与新键不会混淆。 */
export const REVIEW_KEY_VERSION = "rk1";

export function reviewIdempotencyKey(incidentId: string, review: string, revision: number): string {
  return sha256(`${incidentId}|${review}|${revision}`);
}

export function reviewKeyForPayload(incidentId: string, payload: ReviewPayload): string {
  return reviewIdempotencyKey(incidentId, payload.review_result, payload.revision);
}

/** 带版本号的去重键，写入 outbox.dedupe_key。 */
export function reviewDedupeKey(incidentId: string, review: string, revision: number): string {
  return `${REVIEW_KEY_VERSION}:${reviewIdempotencyKey(incidentId, review, revision)}`;
}

/** 按 key 查重：只读，不产生副作用。 */
export function hasReviewKey(db: Database, dedupeKey: string): boolean {
  return get<{ id: number }>(db, "SELECT id FROM outbox WHERE dedupe_key = ?", dedupeKey) !== undefined;
}

export function getReceiptByIncident(db: Database, incidentId: string): string | undefined {
  const row = get<{ receipt_id: string | null }>(
    db,
    "SELECT receipt_id FROM outbox WHERE kind = 'review' AND incident_id = ? ORDER BY id DESC LIMIT 1",
    incidentId,
  );
  return row?.receipt_id ?? undefined;
}

/** 登记回写结果（含回执号），供窗口 / 台账三处一致地反查。 */
export function rememberReview(
  db: Database,
  args: {
    dedupeKey: string;
    incidentId: string;
    batchId: string;
    payload: ReviewPayload;
    status: "pending" | "sent" | "failed";
    receiptId?: string;
    error?: string;
  },
  clock?: Clock,
): void {
  const at = utc(clock ? clock.now() : Date.now());
  run(
    db,
    `INSERT INTO outbox
       (kind, incident_id, batch_id, dedupe_key, payload, created_at, updated_at, status, receipt_id, error)
     VALUES ('review', ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
    args.incidentId,
    args.batchId,
    args.dedupeKey,
    stableStringify(args.payload),
    at,
    at,
    args.status,
    args.receiptId ?? null,
    args.error ?? null,
  );
}

export function setReviewReceipt(db: Database, dedupeKey: string, receiptId: string, clock?: Clock): void {
  const at = utc(clock ? clock.now() : Date.now());
  run(
    db,
    "UPDATE outbox SET status = 'sent', receipt_id = ?, updated_at = ? WHERE dedupe_key = ?",
    receiptId,
    at,
    dedupeKey,
  );
  run(
    db,
    "UPDATE runs SET receipt_id = ?, updated_at = ? WHERE incident_id = (SELECT incident_id FROM outbox WHERE dedupe_key = ?)",
    receiptId,
    at,
    dedupeKey,
  );
}
