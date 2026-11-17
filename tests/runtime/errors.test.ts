import { describe, expect, it } from "vitest";
import { classifyError, makeError, withRetry, backoffDelay } from "../../src/runtime/errors.js";
import { Engine } from "../../src/runtime/engine.js";
import { freshDb, makeIncident, testClock } from "../helpers/fixtures.js";

const sleep = () => Promise.resolve();

/** T13：错误分类与退避重试（4xx 不重试 / 5xx ≤3 次）。 */
describe("T13 错误分类与退避", () => {
  it("错误分类：4xx 永久失败，5xx / 429 / 网络错可重试，解析错按调用方定义", () => {
    expect(classifyError(makeError("bad", { status: 400 })).retryable).toBe(false);
    expect(classifyError(makeError("unauth", { status: 401 })).klass).toBe("permanent");
    expect(classifyError(makeError("rate", { status: 429 })).klass).toBe("retryable");
    expect(classifyError(makeError("boom", { status: 500 })).klass).toBe("retryable");
    expect(classifyError(new Error("fetch failed: network")).klass).toBe("retryable");
    expect(classifyError(makeError("parse", { klass: "parse" })).klass).toBe("parse");
    expect(backoffDelay(1, 100) > 0).toBe(true);
  });

  it("4xx 重试计数 = 0；5xx 重试计数 = 3", async () => {
    const four = await withRetry(async () => { throw makeError("bad request", { status: 400 }); }, { maxRetries: 3, sleep });
    expect(four.ok).toBe(false);
    expect(four.retryCount).toBe(0);

    const five = await withRetry(async () => { throw makeError("server error", { status: 500 }); }, { maxRetries: 3, sleep });
    expect(five.ok).toBe(false);
    expect(five.retryCount).toBe(3);
    expect(five.attempts).toBe(4);
  });

  it("耗尽重试后 run 停在失败步骤且状态未推进", async () => {
    const db = freshDb();
    const engine = new Engine({
      db,
      clock: testClock(),
      hooks: { onStep: async () => ({ ok: false, retryable: true, status: 500, reason: "服务不可用" }) },
      retryOptions: { maxRetries: 3, sleep },
    });
    const scheduled = engine.schedule(makeIncident({ incident_id: "INC-5XX" }));
    await engine.execute(scheduled.run.run_id);
    expect(engine.getRun(scheduled.run.run_id)!.status).toBe("new");
    const steps = engine.stepRecords(scheduled.run.run_id);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe("failed");
    expect(steps[0]!.retry_count).toBe(3);
    expect(engine.getRun(scheduled.run.run_id)!.last_error).toContain("服务不可用");
  });
});
