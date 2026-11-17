/**
 * 挂起等待：独立持久化 + 按事件匹配恢复（T15），挂起区间计时（T16）。
 *
 * pause 落 pauses 表，不占用内存等待；进程重启后从库读回，
 * 停留时长按「挂起区间」（paused_at → resumed_at / now）以 UTC 差值累计，
 * 跨天、休眠唤醒（时钟跳跃）、进程重启都不重置。
 */
import { utc, type Clock } from "../util/clock.js";
import { all, get, run, type Database } from "../store/db.js";
import { appendAudit } from "../store/audit.js";
import { newId } from "../util/hash.js";
import type { PauseRecord } from "../domain/models.js";
import type { QcPolicy } from "../domain/policy.js";

export interface CreatePauseArgs {
  runId: string;
  waitEvent: string;
  payloadKey: string;
  timeoutPolicy?: "等待人工" | "继续等待";
  operator?: string;
  clock?: Clock;
}

export function createPause(db: Database, args: CreatePauseArgs): PauseRecord {
  const at = utc(args.clock ? args.clock.now() : Date.now());
  const record: PauseRecord = {
    pause_id: newId("pause"),
    run_id: args.runId,
    wait_event: args.waitEvent,
    payload_key: args.payloadKey,
    timeout_policy: args.timeoutPolicy ?? "等待人工",
    paused_at: at,
    created_at: at,
    updated_at: at,
  };
  run(
    db,
    `INSERT INTO pauses (pause_id, run_id, wait_event, payload_key, timeout_policy, paused_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    record.pause_id,
    record.run_id,
    record.wait_event,
    record.payload_key,
    record.timeout_policy,
    record.paused_at,
    record.created_at,
    record.updated_at,
  );
  appendAudit(
    db,
    {
      runId: args.runId,
      operator: args.operator ?? "system",
      kind: "pause",
      detail: { wait_event: args.waitEvent, paused_at: at },
    },
    args.clock,
  );
  return record;
}

/**
 * SQLite 的 NULL 列会原样返回 null；领域模型用 `resumed_at?: string` 表示「尚未恢复」。
 * 在这里统一归一，避免 null / undefined 两套语义泄漏到业务层。
 */
function mapPause(row: Record<string, unknown>): PauseRecord {
  const resumed = row.resumed_at;
  return {
    pause_id: String(row.pause_id),
    run_id: String(row.run_id),
    wait_event: String(row.wait_event),
    payload_key: String(row.payload_key),
    timeout_policy: String(row.timeout_policy) as PauseRecord["timeout_policy"],
    paused_at: String(row.paused_at),
    ...(resumed !== null && resumed !== undefined ? { resumed_at: String(resumed) } : {}),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function findActivePause(db: Database, runId: string, waitEvent?: string): PauseRecord | undefined {
  const sql = waitEvent
    ? "SELECT * FROM pauses WHERE run_id = ? AND wait_event = ? AND resumed_at IS NULL ORDER BY paused_at ASC LIMIT 1"
    : "SELECT * FROM pauses WHERE run_id = ? AND resumed_at IS NULL ORDER BY paused_at ASC LIMIT 1";
  const row = waitEvent
    ? get<Record<string, unknown>>(db, sql, runId, waitEvent)
    : get<Record<string, unknown>>(db, sql, runId);
  return row ? mapPause(row) : undefined;
}

/** 只有事件名 + 载荷键都匹配的挂起项才被解除，其余不受影响。 */
export function findMatchingPause(db: Database, waitEvent: string, payloadKey: string): PauseRecord | undefined {
  const row = get<Record<string, unknown>>(
    db,
    "SELECT * FROM pauses WHERE wait_event = ? AND payload_key = ? AND resumed_at IS NULL ORDER BY paused_at ASC LIMIT 1",
    waitEvent,
    payloadKey,
  );
  return row ? mapPause(row) : undefined;
}

export function resolvePause(db: Database, pauseId: string, clock?: Clock, operator = "nurse_manager"): void {
  const at = utc(clock ? clock.now() : Date.now());
  run(db, "UPDATE pauses SET resumed_at = ?, updated_at = ? WHERE pause_id = ?", at, at, pauseId);
  const row = get<Record<string, unknown>>(db, "SELECT * FROM pauses WHERE pause_id = ?", pauseId);
  const pause = row ? mapPause(row) : undefined;
  if (pause) {
    appendAudit(
      db,
      {
        runId: pause.run_id,
        operator,
        kind: "pause_resolved",
        detail: { pause_id: pauseId, paused_at: pause.paused_at, resumed_at: at, duration_ms: pauseDurationMs(pause, clock?.now() ?? Date.now()) },
      },
      clock,
    );
  }
}

export function listActivePauses(db: Database): PauseRecord[] {
  return all<Record<string, unknown>>(db, "SELECT * FROM pauses WHERE resumed_at IS NULL ORDER BY paused_at ASC").map(mapPause);
}

/** 单个挂起区间的时长：已恢复用 resumed_at，否则用当前时刻。 */
export function pauseDurationMs(pause: PauseRecord, nowMs: number): number {
  const start = Date.parse(pause.paused_at);
  const end = pause.resumed_at ? Date.parse(pause.resumed_at) : nowMs;
  return Math.max(0, end - start);
}

/** 跨多次挂起的累计停留时长（历史区间 + 当前进行中的区间）。 */
export function accumulatedPauseMs(db: Database, runId: string, nowMs: number): number {
  const rows = all<Record<string, unknown>>(db, "SELECT * FROM pauses WHERE run_id = ? ORDER BY paused_at ASC", runId).map(mapPause);
  return rows.reduce((sum, pause) => sum + pauseDurationMs(pause, nowMs), 0);
}

/** 挂起是否超时；无时限配置返回 undefined（不判超期、不催办）。 */
export function isPauseTimedOut(
  policy: QcPolicy,
  pause: PauseRecord,
  nowMs: number,
  statusHours?: number,
): boolean | undefined {
  const hours = statusHours ?? policy.stepDueHours.value.awaiting_grade;
  if (hours === undefined || policy.stepDueHours.source !== "院内制度导入") return undefined;
  return pauseDurationMs(pause, nowMs) > hours * 3_600_000;
}

/**
 * 超时巡检：把已超时的挂起项按策略处理并写审计。
 * 「等待人工」→ 记一条等待人工事件；「继续等待」→ 记一条继续等待事件，都不自动推进状态。
 */
export function checkPauseTimeouts(
  db: Database,
  policy: QcPolicy,
  nowMs: number,
  clock?: Clock,
): { timedOut: string[]; skippedForNoDue: number } {
  const due = policy.stepDueHours.source === "院内制度导入" ? policy.stepDueHours.value : undefined;
  const active = listActivePauses(db);
  const timedOut: string[] = [];
  let skippedForNoDue = 0;
  for (const pause of active) {
    const hours = due?.awaiting_grade ?? due?.awaiting_review ?? due?.closed;
    if (hours === undefined) {
      skippedForNoDue += 1;
      continue;
    }
    if (pauseDurationMs(pause, nowMs) <= hours * 3_600_000) continue;
    if (pause.timeout_policy === "等待人工") {
      appendAudit(
        db,
        {
          runId: pause.run_id,
          operator: "scheduler",
          kind: "pause_timeout",
          detail: { pause_id: pause.pause_id, policy: "等待人工", hours_configured: hours },
        },
        clock,
      );
      timedOut.push(pause.run_id);
    } else {
      appendAudit(
        db,
        {
          runId: pause.run_id,
          operator: "scheduler",
          kind: "pause_timeout_keep_waiting",
          detail: { pause_id: pause.pause_id, policy: "继续等待", hours_configured: hours },
        },
        clock,
      );
    }
  }
  return { timedOut, skippedForNoDue };
}
