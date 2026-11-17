import { describe, expect, it } from "vitest";
import { Engine } from "../../src/runtime/engine.js";
import { Scheduler } from "../../src/runtime/scheduler.js";
import { createPolicy } from "../../src/domain/policy.js";
import { freshDb, makeIncident, testClock } from "../helpers/fixtures.js";
import type { IncidentReport } from "../../src/domain/models.js";

/** T19：可注入时钟 60 秒轮询 / 增量水位 / 失败不静默。 */
describe("T19 调度器", () => {
  it("注入固定时钟后轮询按 60 秒触发，重复轮询不产生重复 run", async () => {
    const db = freshDb();
    const clock = testClock("2026-11-09T00:00:00.000Z");
    const engine = new Engine({ db, clock });
    const batch: IncidentReport[] = [
      makeIncident({ incident_id: "INC-POLL-1" }),
      makeIncident({ incident_id: "INC-POLL-2", reported_at: "2026-11-09T00:01:00.000Z" }),
    ];
    let calls = 0;
    const scheduler = new Scheduler({
      engine, db, clock, policy: createPolicy(), pollIntervalSec: 60,
      source: { listNew: async (since) => { calls += 1; return since ? batch.filter((r) => r.reported_at > since) : batch; } },
    });
    expect((await scheduler.tick(clock.now())).polled).toBe(true);
    expect(engine.countRuns()).toBe(2);
    expect(scheduler.currentWatermark).toBe("2026-11-09T00:01:00.000Z");

    clock.advance(30_000);
    expect((await scheduler.tick(clock.now())).polled).toBe(false);
    clock.advance(30_000);
    expect((await scheduler.tick(clock.now())).polled).toBe(true);
    expect(engine.countRuns()).toBe(2);
    expect(calls).toBe(2);
  });

  it("轮询失败时写错误日志且不推进状态", async () => {
    const db = freshDb();
    const clock = testClock("2026-11-09T00:00:00.000Z");
    const engine = new Engine({ db, clock });
    const scheduler = new Scheduler({
      engine, db, clock, policy: createPolicy(), pollIntervalSec: 60,
      source: { listNew: async () => { throw new Error("接口不可用"); } },
    });
    const result = await scheduler.poll();
    expect(result.error).toContain("轮询失败");
    expect(scheduler.logs.join("\n")).toContain("轮询失败");
    expect(engine.countRuns()).toBe(0);
  });
});
