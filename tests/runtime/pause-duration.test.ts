import { describe, expect, it } from "vitest";
import { createPause, pauseDurationMs, accumulatedPauseMs, checkPauseTimeouts, isPauseTimedOut } from "../../src/runtime/pause.js";
import { createPolicy } from "../../src/domain/policy.js";
import { HOUR_MS } from "../../src/util/clock.js";
import { freshDb, testClock } from "../helpers/fixtures.js";

/** T16：挂起区间计时（跨天 / 休眠唤醒不重置）+ 超时策略 + 无时限不催办。 */
describe("T16 挂起区间计时", () => {
  it("注入固定时钟，挂起 25 小时跨天累计 = 25h", () => {
    const clock = testClock("2026-11-09T00:00:00.000Z");
    const db = freshDb();
    const pause = createPause(db, { runId: "r1", waitEvent: "confirm.grade", payloadKey: "INC-1", clock });
    clock.advance(25 * HOUR_MS);
    expect(pauseDurationMs(pause, clock.now())).toBe(25 * HOUR_MS);
    expect(accumulatedPauseMs(db, "r1", clock.now())).toBe(25 * HOUR_MS);
  });

  it("时钟跳跃 8h（休眠唤醒）区间连续且不重置", () => {
    const clock = testClock("2026-11-09T00:00:00.000Z");
    const db = freshDb();
    const pause = createPause(db, { runId: "r2", waitEvent: "confirm.grade", payloadKey: "INC-2", clock });
    clock.advance(2 * HOUR_MS);
    const first = pauseDurationMs(pause, clock.now());
    clock.advance(8 * HOUR_MS);
    const afterWake = pauseDurationMs(pause, clock.now());
    expect(afterWake).toBe(first + 8 * HOUR_MS);
    expect(afterWake).toBe(10 * HOUR_MS);
  });

  it("无时限配置时不产出超期条目；配置后按小时判定", () => {
    const clock = testClock("2026-11-09T00:00:00.000Z");
    const db = freshDb();
    createPause(db, { runId: "r3", waitEvent: "confirm.grade", payloadKey: "INC-3", clock });
    clock.advance(30 * HOUR_MS);
    expect(isPauseTimedOut(createPolicy(), { paused_at: new Date(Date.parse("2026-11-09T00:00:00Z")).toISOString() } as never, clock.now())).toBeUndefined();
    const none = checkPauseTimeouts(db, createPolicy(), clock.now(), clock);
    expect(none.timedOut).toHaveLength(0);
    expect(none.skippedForNoDue).toBeGreaterThan(0);

    const configured = createPolicy({ stepDueHours: { value: { awaiting_grade: 4 }, source: "院内制度导入" } });
    const timed = checkPauseTimeouts(db, configured, clock.now(), clock);
    expect(timed.timedOut).toContain("r3");
  });
});
