import { describe, expect, it } from "vitest";
import { runReplay } from "../../scripts/replay-scale.js";
import { generateIncidents } from "../../scripts/generate-incidents.js";
import { Engine } from "../../src/runtime/engine.js";
import { readAudit } from "../../src/store/audit.js";
import { run } from "../../src/store/db.js";
import { reviewIdempotencyKey } from "../../src/store/idempotency.js";
import { makeIncident, freshDb, testClock } from "../helpers/fixtures.js";
import type { IncidentReport } from "../../src/domain/models.js";
import type { Database } from "../../src/store/db.js";

/** T25：正确率回归（幂等 / 恢复 / 回写恰好一次）+ 首个不一致件定位。 */
function findInconsistent(db: Database, engine: Engine, reports: IncidentReport[]): string | undefined {
  for (const report of reports) {
    const current = engine.getRunByIncident(report.incident_id);
    if (!current || current.status !== "written_back") return report.incident_id;
    const stepCount = engine.stepRecords(current.run_id).filter((s) => s.status === "done").length;
    const auditCount = readAudit(db, current.run_id).filter((a) => a.kind === "step").length;
    if (stepCount !== auditCount || !current.receipt_id) return report.incident_id;
  }
  return undefined;
}

describe("T25 正确率回归套件", () => {
  it("200 条规模回放：幂等命中率 100%、恢复正确率 100%、回写调用数 = 去重后条数", async () => {
    const input = generateIncidents(200);
    const metrics = await runReplay({ input });
    expect(metrics.records).toBe(200);
    expect(metrics.idempotent_hit_rate).toBe(100);
    expect(metrics.recovery_rate).toBe(100);
    expect(metrics.writeback_calls).toBe(metrics.unique);
    expect(metrics.created_second_pass).toBe(0);
  }, 60_000);

  it("三表状态与回写记录一致；人为破坏后定位首个不一致件 id", async () => {
    const db = freshDb();
    const engine = new Engine({
      db, clock: testClock(),
      hooks: { onWriteback: async () => ({ ok: true, receipt_id: "RCP-REG" }) },
      retryOptions: { maxRetries: 0, sleep: () => Promise.resolve() },
    });
    const reports = ["R1", "R2", "R3"].map((id) => makeIncident({ incident_id: `INC-REG-${id}` }));
    for (const report of reports) {
      const scheduled = engine.schedule(report);
      await engine.execute(scheduled.run.run_id);
      for (const kind of ["grade", "remedy", "review", "close"] as const) {
        await engine.resume(scheduled.run.run_id, { kind, confirmed: true, payloadKey: report.incident_id });
      }
    }
    expect(findInconsistent(db, engine, reports)).toBeUndefined();

    // 人为破坏：删掉一条已完成步骤，三表一致性立刻不成立并打印首个不一致件
    run(db, "DELETE FROM steps WHERE rowid = (SELECT MIN(rowid) FROM steps)");
    const brokenId = findInconsistent(db, engine, reports);
    expect(brokenId).toBeDefined();
    expect(reports.map((r) => r.incident_id)).toContain(brokenId);
  });

  it("幂等键被破坏（同输入产生不同键）时能被检出", () => {
    const key = (revision: number) => reviewIdempotencyKey("INC-REG-R1", "人工确认销号", revision);
    expect(key(1)).toBe(key(1));
    const broken = key(2);
    expect(broken).not.toBe(key(1));
    expect(broken.length).toBe(64);
  });
});
