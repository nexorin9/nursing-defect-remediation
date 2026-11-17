import { describe, expect, it } from "vitest";
import { Engine } from "../../src/runtime/engine.js";
import { STEP_DEFS, stepDefById } from "../../src/runtime/steps.js";
import { freshDb, makeIncident, testClock } from "../helpers/fixtures.js";

/** T11：schedule / execute / 命名步骤三时刻 / 失败即停。 */
describe("T11 引擎骨架", () => {
  it("schedule 后 runs 新增 1 行且状态为 new，execute 后每步含三时刻", async () => {
    const db = freshDb();
    const engine = new Engine({ db, clock: testClock() });
    const scheduled = engine.schedule(makeIncident());
    expect(scheduled.created).toBe(true);
    expect(engine.countRuns()).toBe(1);
    expect(scheduled.run.status).toBe("new");

    const result = await engine.execute(scheduled.run.run_id);
    expect(result.status).toBe("awaiting_grade");
    const steps = engine.stepRecords(scheduled.run.run_id);
    expect(steps.length).toBe(2);
    for (const step of steps) {
      expect(step.queued_at).toBeTruthy();
      expect(step.started_at).toBeTruthy();
      expect(step.ended_at).toBeTruthy();
      expect(step.status).toBe("done");
    }
  });

  it("步骤定义表集中管理业务步骤，注入失败步骤后其后步骤无记录", async () => {
    const db = freshDb();
    const engine = new Engine({
      db,
      clock: testClock(),
      hooks: {
        onStep: async (ctx) =>
          ctx.def.id === "extract" ? { ok: false, reason: "要素抽取失败（注入）" } : { ok: true },
      },
      retryOptions: { maxRetries: 0, sleep: () => Promise.resolve() },
    });
    const scheduled = engine.schedule(makeIncident({ incident_id: "INC-FAIL-1" }));
    const result = await engine.execute(scheduled.run.run_id);
    expect(result.executed).toBe(1);
    expect(engine.getRun(scheduled.run.run_id)!.status).toBe("extracting");
    const ids = engine.stepRecords(scheduled.run.run_id).map((s) => s.step_id);
    expect(ids.some((id) => id.includes(":grade:"))).toBe(false);
    expect(STEP_DEFS.length).toBe(6);
    expect(stepDefById("close")?.requiresConfirmation).toBe(true);
  });
});
