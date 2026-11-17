import { describe, expect, it } from "vitest";
import { Engine } from "../../src/runtime/engine.js";
import { drain, resumeAfterDrain } from "../../src/runtime/drain.js";
import { readAudit } from "../../src/store/audit.js";
import { freshDb, makeIncident, testClock } from "../helpers/fixtures.js";

/** T18：竞态互斥 / 回复晚到 / resume 与 drain 不互相踩状态。 */
describe("T18 竞态互斥", () => {
  it("并发 resume 后 steps 新增行数 = 1", async () => {
    const db = freshDb();
    const engine = new Engine({ db, clock: testClock() });
    const incident = makeIncident();
    const run = engine.schedule(incident);
    await engine.execute(run.run.run_id);
    const before = engine.countSteps(run.run.run_id);
    await Promise.all(
      Array.from({ length: 50 }, () =>
        engine.resume(run.run.run_id, { kind: "grade", confirmed: true, payloadKey: incident.incident_id }),
      ),
    );
    expect(engine.countSteps(run.run.run_id) - before).toBe(1);
  });

  it("resume 与 drain 交错执行无状态错乱且无重复回写", async () => {
    const db = freshDb();
    const clock = testClock();
    let writebacks = 0;
    const engine = new Engine({
      db, clock,
      hooks: { onWriteback: async () => { writebacks += 1; return { ok: true, receipt_id: "RCP-RACE" }; } },
    });
    const run = engine.schedule(makeIncident({ incident_id: "INC-RACE" }));
    await engine.execute(run.run.run_id);
    const statusBefore = engine.getRun(run.run.run_id)!.status;
    const [, resumed] = await Promise.all([
      drain({ db, engine, clock, waitForIdle: async () => true }),
      engine.resume(run.run.run_id, { kind: "grade", confirmed: true, payloadKey: "INC-RACE" }),
    ]);
    expect(resumed.advanced).toBe(false);
    expect(engine.getRun(run.run.run_id)!.status).toBe(statusBefore);
    expect(writebacks).toBe(0);
    resumeAfterDrain(engine, db, clock);
  });

  it("迟到回复不改变已生效状态与回写次数", async () => {
    const db = freshDb();
    const clock = testClock();
    let writebacks = 0;
    const engine = new Engine({
      db, clock,
      hooks: { onWriteback: async () => { writebacks += 1; return { ok: true, receipt_id: "RCP-LATE" }; } },
    });
    const incident = makeIncident({ incident_id: "INC-LATE" });
    const run = engine.schedule(incident);
    await engine.execute(run.run.run_id);
    for (const kind of ["grade", "remedy", "review", "close"] as const) {
      await engine.resume(run.run.run_id, { kind, confirmed: true, payloadKey: incident.incident_id });
    }
    expect(engine.getRun(run.run.run_id)!.status).toBe("written_back");
    expect(writebacks).toBe(1);
    const late = await engine.resume(run.run.run_id, { kind: "grade", confirmed: true, payloadKey: incident.incident_id });
    expect(late.advanced).toBe(false);
    expect(late.reason).toContain("迟到");
    expect(engine.getRun(run.run.run_id)!.status).toBe("written_back");
    expect(writebacks).toBe(1);
    expect(readAudit(db, run.run.run_id).some((r) => r.kind === "late_reply")).toBe(true);
  });
});
