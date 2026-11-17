import { describe, expect, it } from "vitest";
import { Engine } from "../../src/runtime/engine.js";
import { stepDefById } from "../../src/runtime/steps.js";
import { stepHash, stepInputDigest, STEP_HASH_VERSION, hasStepHash } from "../../src/runtime/idempotency.js";
import { freshDb, makeIncident, testClock } from "../helpers/fixtures.js";

/** T12：步骤哈希幂等 + golden 对照守住源「%s:%d」语义不漂移。 */
describe("T12 步骤哈希幂等", () => {
  it("golden 哈希值固定（源语义 runId:stepId:idx + hash version）", () => {
    expect(STEP_HASH_VERSION).toBe(1);
    expect(stepHash("run-1", "extract", 1, "digest-abc")).toBe(
      "v1:06f548555706467970531c85561b36437e2d5d6e45d872e3601ee3f008a9aa07",
    );
    expect(stepHash("r1", "grade", 2, "digest-xyz")).toBe(
      "v1:2cd20d4720299d8b8de7da79e24cc75939e23b28e510647892ddfa83b29a965a",
    );
  });

  it("仅时间戳 / 重试次数变化时哈希不变；输入摘要变化则哈希变化", () => {
    const a = stepHash("run-1", "extract", 1, stepInputDigest({ a: 1 }));
    const b = stepHash("run-1", "extract", 1, stepInputDigest({ a: 1 }));
    const c = stepHash("run-1", "extract", 1, stepInputDigest({ a: 2 }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("同一输入两次 execute 副作用计数 = 1；改输入后允许再执行", async () => {
    const db = freshDb();
    let effects = 0;
    const engine = new Engine({
      db,
      clock: testClock(),
      hooks: { onStep: async () => { effects += 1; return { ok: true, output: { effects } }; } },
      retryOptions: { maxRetries: 0, sleep: () => Promise.resolve() },
    });
    const scheduled = engine.schedule(makeIncident());
    const def = stepDefById("intake")!;
    const first = await engine.runStep(scheduled.run.run_id, def);
    const second = await engine.runStep(scheduled.run.run_id, def);
    expect(first.ok).toBe(true);
    expect(second.reused).toBe(true);
    expect(effects).toBe(1);
    expect(hasStepHash(db, "v1:" + "x")).toBe(false);

    await engine.runStep(scheduled.run.run_id, def, { kind: "grade", confirmed: true, note: "输入已变化" });
    expect(effects).toBe(2);
  });
});
