/**
 * 每日 08:00 超期巡检（T20）。
 *
 * 遍历 awaiting_* 状态的件，按 policy.stepDueHours 判定是否超期；
 * 催办去重键 = incident_id + 巡检批次号，同批次只催办一次，跨批次复查才允许重推；
 * 超期件按停留时长倒序；无时限配置的件不参与判定，结果显式标注「未设定时限」件数。
 */
import { utc, type Clock } from "../util/clock.js";
import { all, get, run, type Database } from "../store/db.js";
import { appendAudit } from "../store/audit.js";
import { accumulatedPauseMs } from "./pause.js";
import { AWAITING_STATES, STATE_LABELS, type RunState } from "../domain/models.js";
import { isOverdue, sweepMinuteOfDay, type QcPolicy } from "../domain/policy.js";

export interface SweepItem {
  incident_id: string;
  run_id: string;
  status: RunState;
  ward_code: string;
  shift_code: string;
  current_step: string;
  elapsed_ms: number;
  dedupe_key: string;
}

export interface SweepResult {
  batch_id: string;
  /** 新增入队的催办条目（倒序） */
  items: SweepItem[];
  /** 队列中已有的条目数（含本次与历史） */
  queue_length: number;
  unconfigured_due_count: number;
  scanned: number;
}

/** 巡检批次号：按巡检日切分，跨批次复查才允许重推。 */
export function sweepBatchId(nowMs: number, dailySweepAt: string): string {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return `${day}-${String(sweepMinuteOfDay(dailySweepAt)).padStart(4, "0")}`;
}

export interface SweepArgs {
  db: Database;
  policy: QcPolicy;
  nowMs: number;
  clock?: Clock;
  batchId?: string;
}

export function runDailySweep(args: SweepArgs): SweepResult {
  const { db, policy, nowMs } = args;
  const batchId = args.batchId ?? sweepBatchId(nowMs, policy.dailySweepAt.value);
  const at = utc(nowMs);
  const placeholders = AWAITING_STATES.map(() => "?").join(",");
  const rows = all<Record<string, unknown>>(
    db,
    `SELECT * FROM runs WHERE status IN (${placeholders}) ORDER BY updated_at ASC`,
    ...AWAITING_STATES,
  );

  const candidates: SweepItem[] = [];
  let unconfigured = 0;
  for (const row of rows) {
    const runId = String(row.run_id);
    const incidentId = String(row.incident_id);
    const status = String(row.status) as RunState;
    const elapsedMs = accumulatedPauseMs(db, runId, nowMs) ||
      Math.max(0, nowMs - Date.parse(String(row.updated_at)));
    const overdue = isOverdue(policy, status, elapsedMs);
    if (overdue === undefined) {
      unconfigured += 1;
      continue;
    }
    if (!overdue) continue;
    candidates.push({
      incident_id: incidentId,
      run_id: runId,
      status,
      ward_code: String(row.ward_code),
      shift_code: String(row.shift_code),
      current_step: STATE_LABELS[status],
      elapsed_ms: elapsedMs,
      dedupe_key: `${incidentId}|${batchId}`,
    });
  }
  candidates.sort((a, b) => b.elapsed_ms - a.elapsed_ms);

  let inserted = 0;
  for (const item of candidates) {
    const result = run(
      db,
      `INSERT OR IGNORE INTO outbox
         (kind, incident_id, batch_id, dedupe_key, payload, created_at, updated_at, status)
       VALUES ('wecom', ?, ?, ?, ?, ?, ?, 'pending')`,
      item.incident_id,
      batchId,
      item.dedupe_key,
      JSON.stringify({
        incident_id: item.incident_id,
        ward_code: item.ward_code,
        shift_code: item.shift_code,
        current_step: item.current_step,
        elapsed_ms: item.elapsed_ms,
      }),
      at,
      at,
    );
    if (result.changes === 1) inserted += 1;
  }
  appendAudit(
    db,
    {
      runId: "scheduler",
      operator: "scheduler",
      kind: "sweep",
      detail: { batch_id: batchId, scanned: rows.length, enqueued: inserted, unconfigured_due_count: unconfigured },
    },
    args.clock,
  );
  const queueLength = get<{ c: number }>(db, "SELECT COUNT(*) AS c FROM outbox WHERE kind = 'wecom'")?.c ?? 0;
  return {
    batch_id: batchId,
    items: candidates,
    queue_length: queueLength,
    unconfigured_due_count: unconfigured,
    scanned: rows.length,
  };
}

/** 待推送的催办队列（按停留时长倒序），供 adapters 消费。 */
export function pendingReminders(db: Database, batchId?: string): SweepItem[] {
  const rows = batchId
    ? all<Record<string, unknown>>(
        db,
        "SELECT * FROM outbox WHERE kind = 'wecom' AND batch_id = ? AND status = 'pending' ORDER BY id ASC",
        batchId,
      )
    : all<Record<string, unknown>>(
        db,
        "SELECT * FROM outbox WHERE kind = 'wecom' AND status = 'pending' ORDER BY id ASC",
      );
  return rows
    .map((r) => {
      try {
        return { ...(JSON.parse(String(r.payload)) as object), dedupe_key: String(r.dedupe_key), run_id: "", status: "awaiting_grade" as RunState, current_step: "" } as SweepItem;
      } catch {
        return undefined;
      }
    })
    .filter((x): x is SweepItem => x !== undefined)
    .sort((a, b) => b.elapsed_ms - a.elapsed_ms);
}
