import { describe, expect, it } from "vitest";
import { run } from "../../src/store/db.js";
import { runDailySweep, sweepBatchId, pendingReminders } from "../../src/runtime/sweep.js";
import { createPolicy } from "../../src/domain/policy.js";
import { HOUR_MS } from "../../src/util/clock.js";
import { freshDb, testClock } from "../helpers/fixtures.js";

function insertAwaiting(db: ReturnType<typeof freshDb>, incidentId: string, updatedAt: string): void {
  run(
    db,
    `INSERT INTO runs (run_id, incident_id, status, created_at, updated_at, ward_code, shift_code)
     VALUES (?, ?, 'awaiting_grade', ?, ?, '内科三病区', '白班')`,
    `run_${incidentId}`, incidentId, "2026-11-08T00:00:00Z", updatedAt,
  );
}

/** T20：08:00 巡检 + 催办去重键 + 倒序超期条目 + 无时限标注。 */
describe("T20 每日超期巡检", () => {
  it("08:00 触发巡检且超期件倒序；同批次重复巡检队列长度不变", () => {
    const clock = testClock("2026-11-09T08:00:00.000Z");
    const now = clock.now();
    const db = freshDb();
    insertAwaiting(db, "INC-SWEEP-1", new Date(now - 5 * HOUR_MS).toISOString());
    insertAwaiting(db, "INC-SWEEP-2", new Date(now - 7 * HOUR_MS).toISOString());
    const policy = createPolicy({ stepDueHours: { value: { awaiting_grade: 4 }, source: "院内制度导入" }, dailySweepAt: { value: "08:00", source: "院内制度导入" } });
    expect(sweepBatchId(now, "08:00")).toContain("2026-11-09");

    const first = runDailySweep({ db, policy, nowMs: now, clock });
    expect(first.items).toHaveLength(2);
    expect(first.items[0]!.elapsed_ms).toBeGreaterThan(first.items[1]!.elapsed_ms);
    expect(first.items[0]!.incident_id).toBe("INC-SWEEP-2");
    const second = runDailySweep({ db, policy, nowMs: now, clock });
    expect(second.queue_length).toBe(first.queue_length);
    expect(pendingReminders(db).map((i) => i.incident_id)).toEqual(["INC-SWEEP-2", "INC-SWEEP-1"]);
  });

  it("无时限配置的件不进队列，巡检结果显式标注未设定时限件数", () => {
    const clock = testClock("2026-11-09T08:00:00.000Z");
    const db = freshDb();
    insertAwaiting(db, "INC-NO-DUE", "2026-11-01T00:00:00Z");
    const result = runDailySweep({ db, policy: createPolicy(), nowMs: clock.now(), clock });
    expect(result.items).toHaveLength(0);
    expect(result.unconfigured_due_count).toBe(1);
  });
});
