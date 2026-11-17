import { describe, expect, it } from "vitest";
import { Engine } from "../../src/runtime/engine.js";
import { drain, resumeAfterDrain } from "../../src/runtime/drain.js";
import { readAudit } from "../../src/store/audit.js";
import { findActivePause, accumulatedPauseMs, pauseDurationMs } from "../../src/runtime/pause.js";
import { HOUR_MS } from "../../src/util/clock.js";
import { freshDb, makeIncident, testClock } from "../helpers/fixtures.js";

/** T22：关停排空 + 断点续跑 + 与 resume 互斥 + 超时未收口清单。 */
describe("T22 关停排空", () => {
  it("重启后挂起件仍在且停留时长连续", async () => {
    const db = freshDb();
    const clock = testClock();
    const engine = new Engine({ db, clock });
    const scheduled = engine.schedule(makeIncident());
    await engine.execute(scheduled.run.run_id);
    const pause = findActivePause(db, scheduled.run.run_id, "confirm.grade")!;
    clock.advance(3 * HOUR_MS);
    const beforeDuration = accumulatedPauseMs(db, scheduled.run.run_id, clock.now());

    await drain({ db, engine, clock, waitForIdle: async () => true });
    const reopened = new Engine({ db, clock });
    const after = findActivePause(db, reopened.getRun(scheduled.run.run_id)!.run_id, "confirm.grade");
    expect(after?.pause_id).toBe(pause.pause_id);
    expect(accumulatedPauseMs(db, scheduled.run.run_id, clock.now())).toBe(beforeDuration);
    expect(pauseDurationMs(after!, clock.now())).toBe(3 * HOUR_MS);
    resumeAfterDrain(reopened, db, clock);
  });

  it("关停期间 resume 不产生状态推进", async () => {
    const db = freshDb();
    const clock = testClock();
    const engine = new Engine({ db, clock });
    const incident = makeIncident({ incident_id: "INC-DRAIN" });
    const run = engine.schedule(incident);
    await engine.execute(run.run.run_id);
    const before = engine.getRun(run.run.run_id)!.status;
    const draining = drain({ db, engine, clock, waitForIdle: async () => true });
    const resumed = await engine.resume(run.run.run_id, { kind: "grade", confirmed: true, payloadKey: incident.incident_id });
    await draining;
    expect(resumed.advanced).toBe(false);
    expect(engine.getRun(run.run.run_id)!.status).toBe(before);
  });

  it("关停超时后审计含未收口件清单", async () => {
    const db = freshDb();
    const clock = testClock();
    const engine = new Engine({ db, clock });
    const run = engine.schedule(makeIncident({ incident_id: "INC-TIMEOUT" }));
    await engine.execute(run.run.run_id);
    const result = await drain({ db, engine, clock, forceTimeout: true });
    expect(result.timed_out).toBe(true);
    const rows = readAudit(db).filter((r) => r.kind === "drain_timeout");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toContain("unsettled");
    expect(rows[0]!.detail).toContain("超过配置秒数");
  });
});
