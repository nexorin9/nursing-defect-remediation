import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appendAudit, countAudit, readAudit } from "../../src/store/audit.js";
import { Engine } from "../../src/runtime/engine.js";
import { auditFailingDb, freshDb, makeIncident, testClock } from "../helpers/fixtures.js";

/** T8：只增不改审计链 + 幂等键 + 审计失败阻断状态推进。 */
describe("T8 审计链", () => {
  it("追加 100 条后行数 = 100 且再次读取内容一致", () => {
    const db = freshDb();
    for (let i = 0; i < 100; i += 1) {
      appendAudit(db, { runId: "r1", operator: "tester", kind: "step", detail: { i } });
    }
    expect(countAudit(db)).toBe(100);
    const rows = readAudit(db);
    expect(rows).toHaveLength(100);
    expect(rows[0]!.operator).toBe("tester");
    expect(rows[99]!.detail).toContain('"i":99');
    expect(readAudit(db, "r1")).toHaveLength(100);
  });

  it("审计源码不含针对 audit 表的变更 / 移除语句", () => {
    const source = readFileSync(resolve(process.cwd(), "src/store/audit.ts"), "utf8");
    expect(source).not.toMatch(/UPDATE\s+audit/i);
    expect(source).not.toMatch(/DELETE\s+FROM\s+audit/i);
  });

  it("审计写入失败时状态推进被阻断（失败不静默改数据）", async () => {
    const real = freshDb();
    const clock = testClock();
    const engine = new Engine({ db: real, clock });
    const incident = makeIncident();
    const scheduled = engine.schedule(incident);
    await engine.execute(scheduled.run.run_id);
    expect(engine.getRun(scheduled.run.run_id)!.status).toBe("awaiting_grade");

    const broken = new Engine({ db: auditFailingDb(real), clock });
    await expect(
      broken.resume(scheduled.run.run_id, { kind: "grade", confirmed: true, payloadKey: incident.incident_id }),
    ).rejects.toThrow(/audit write failed/);
    expect(engine.getRun(scheduled.run.run_id)!.status).toBe("awaiting_grade");
  });
});
