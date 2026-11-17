/**
 * 关停排空 drain + 断点续跑（T22）。
 *
 * 语义对齐连接网关的 draining 标志与竞态测试写法：
 * 关停时置 draining（与 resume 互斥）→ 把在办步骤状态落库 → 等待在办收口 →
 * 超时强制结束并写审计（含未收口清单）。重开时状态本来就在 SQLite，
 * 挂起区间按 paused_at 连续计量，不因进程重启或休眠唤醒重置。
 */
import { utc, systemClock, type Clock } from "../util/clock.js";
import { all, get, run, type Database } from "../store/db.js";
import { appendAudit } from "../store/audit.js";
import { createPolicy, type QcPolicy } from "../domain/policy.js";
import type { Engine } from "./engine.js";

export interface DrainOptions {
  db: Database;
  engine: Engine;
  clock?: Clock;
  policy?: QcPolicy;
  /** 超时秒数，来自 policy.drainTimeoutSec */
  timeoutSec?: number;
  /** 确定性测试注入：直接模拟关停超时 */
  forceTimeout?: boolean;
  /** 等待在办收口的钩子（默认检查是否还有 running 步骤） */
  waitForIdle?: (timeoutMs: number) => Promise<boolean>;
}

export interface DrainResult {
  drained_at: string;
  checkpointed: number;
  unsettled: string[];
  timed_out: boolean;
}

/** 把在办步骤状态落库：逐件写一条可复核的检查点审计。 */
export function checkpoint(engine: Engine, db: Database, clock: Clock): number {
  const rows = all<{ run_id: string; status: string; step_cursor: number }>(
    db,
    "SELECT run_id, status, step_cursor FROM runs WHERE status <> 'written_back' ORDER BY created_at ASC",
  );
  for (const row of rows) {
    appendAudit(
      db,
      {
        runId: row.run_id,
        operator: "drain",
        kind: "drain_checkpoint",
        detail: { status: row.status, step_cursor: row.step_cursor, note: "状态已在库，重开即从此处继续" },
      },
      clock,
    );
  }
  const at = utc(clock.now());
  run(db, "UPDATE runs SET updated_at = ? WHERE status <> 'written_back'", at);
  return rows.length;
}

export async function drain(options: DrainOptions): Promise<DrainResult> {
  const { db, engine } = options;
  const clock = options.clock ?? systemClock;
  const policy = options.policy ?? createPolicy();
  const timeoutSec = options.timeoutSec ?? policy.drainTimeoutSec.value;
  engine.setDraining(true);
  const checkpointed = checkpoint(engine, db, clock);
  const unsettled = all<{ run_id: string }>(
    db,
    "SELECT DISTINCT run_id FROM steps WHERE status = 'running' OR status = 'queued'",
  ).map((r) => r.run_id);

  let timedOut = options.forceTimeout ?? false;
  if (!timedOut && options.waitForIdle) {
    timedOut = !(await options.waitForIdle(timeoutSec * 1000));
  } else if (!timedOut && unsettled.length > 0) {
    // 真实关停：先把互斥锁排空，再复核一次是否仍有在办步骤
    await engine.mutex.runExclusive(async () => undefined);
    const stillRunning = get<{ c: number }>(
      db,
      "SELECT COUNT(*) AS c FROM steps WHERE status = 'running'",
    )?.c ?? 0;
    timedOut = stillRunning > 0;
  }

  appendAudit(
    db,
    {
      runId: "runtime",
      operator: "drain",
      kind: timedOut ? "drain_timeout" : "drain_complete",
      detail: {
        checkpointed,
        timed_out: timedOut,
        timeout_sec: timeoutSec,
        unsettled,
        note: timedOut ? "超过配置秒数强制结束，以下件未收口，重开后继续" : "在办步骤已落库",
      },
    },
    clock,
  );
  return { drained_at: utc(clock.now()), checkpointed, unsettled, timed_out: timedOut };
}

/** 重开后恢复接单（新 Engine 实例天然 draining=false；此函数用于同一实例的断点续跑）。 */
export function resumeAfterDrain(engine: Engine, db: Database, clock: Clock = systemClock): { pending: number } {
  engine.setDraining(false);
  appendAudit(db, { runId: "runtime", operator: "drain", kind: "drain_resume", detail: { note: "重开接单" } }, clock);
  const pending = get<{ c: number }>(db, "SELECT COUNT(*) AS c FROM runs WHERE status <> 'written_back'")?.c ?? 0;
  return { pending };
}
