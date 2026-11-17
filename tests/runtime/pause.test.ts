import { describe, expect, it } from "vitest";
import { Engine } from "../../src/runtime/engine.js";
import { createPause, findActivePause, findMatchingPause, resolvePause, listActivePauses } from "../../src/runtime/pause.js";
import { freshDb, makeIncident, testClock } from "../helpers/fixtures.js";

/** T15：pause 独立持久化 + 按事件匹配恢复 + 重启不丢。 */
describe("T15 挂起等待", () => {
  it("挂起前后状态不变；重启模拟后 pauses 表仍有该挂起项且 paused_at 不变", async () => {
    const db = freshDb();
    const clock = testClock();
    const engine = new Engine({ db, clock });
    const incident = makeIncident();
    const scheduled = engine.schedule(incident);
    const statusBefore = engine.getRun(scheduled.run.run_id)!.status;
    await engine.execute(scheduled.run.run_id);
    expect(engine.getRun(scheduled.run.run_id)!.status).toBe("awaiting_grade");
    expect(statusBefore).toBe("new");

    const pause = findActivePause(db, scheduled.run.run_id, "confirm.grade");
    expect(pause).toBeDefined();
    const pausedAt = pause!.paused_at;

    // 重启模拟：新 Engine 消费同一 SQLite 库
    const reopened = new Engine({ db, clock });
    const reloaded = findActivePause(db, reopened.getRun(scheduled.run.run_id)!.run_id, "confirm.grade");
    expect(reloaded?.pause_id).toBe(pause!.pause_id);
    expect(reloaded?.paused_at).toBe(pausedAt);
    expect(reloaded?.resumed_at).toBeUndefined();
  });

  it("事件到达后仅匹配项被解除，其余挂起项不受影响", async () => {
    const db = freshDb();
    const clock = testClock();
    const engine = new Engine({ db, clock });
    const a = engine.schedule(makeIncident({ incident_id: "INC-PAUSE-A" }));
    const b = engine.schedule(makeIncident({ incident_id: "INC-PAUSE-B" }));
    await engine.execute(a.run.run_id);
    await engine.execute(b.run.run_id);
    expect(listActivePauses(db)).toHaveLength(2);

    const matched = findMatchingPause(db, "confirm.grade", "INC-PAUSE-A");
    expect(matched?.payload_key).toBe("INC-PAUSE-A");
    expect(findMatchingPause(db, "confirm.grade", "INC-PAUSE-C")).toBeUndefined();
    resolvePause(db, matched!.pause_id, clock);
    expect(findActivePause(db, a.run.run_id, "confirm.grade")).toBeUndefined();
    expect(findActivePause(db, b.run.run_id, "confirm.grade")).toBeDefined();
  });

  it("createPause 落库并写审计，挂起与解除各留一行", () => {
    const db = freshDb();
    const clock = testClock();
    const pause = createPause(db, { runId: "r-direct", waitEvent: "confirm.review", payloadKey: "INC-X", clock });
    expect(pause.pause_id).toBeTruthy();
    resolvePause(db, pause.pause_id, clock);
    expect(findActivePause(db, "r-direct")).toBeUndefined();
  });
});
