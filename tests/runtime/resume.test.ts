import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Engine } from "../../src/runtime/engine.js";
import { freshDb, makeIncident, testClock } from "../helpers/fixtures.js";

/** T14：Resume 单点入口 + 并发只推进一次 + 类型层面收敛状态写。 */
describe("T14 Resume 单点入口", () => {
  it("并发 50 次 resume 同一 run → 推进次数 = 1", async () => {
    const db = freshDb();
    const engine = new Engine({ db, clock: testClock() });
    const incident = makeIncident();
    const scheduled = engine.schedule(incident);
    await engine.execute(scheduled.run.run_id);
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        engine.resume(scheduled.run.run_id, { kind: "grade", confirmed: true, payloadKey: incident.incident_id }),
      ),
    );
    expect(results.filter((r) => r.advanced)).toHaveLength(1);
    expect(engine.getRun(scheduled.run.run_id)!.status).toBe("remedying");
  });

  it("非法信号 resume → advanced=false 且状态未变", async () => {
    const db = freshDb();
    const engine = new Engine({ db, clock: testClock() });
    const incident = makeIncident({ incident_id: "INC-ILLEGAL" });
    const scheduled = engine.schedule(incident);
    await engine.execute(scheduled.run.run_id);
    const before = engine.getRun(scheduled.run.run_id)!.status;
    const unconfirmed = await engine.resume(scheduled.run.run_id, { kind: "grade", confirmed: false });
    expect(unconfirmed.advanced).toBe(false);
    expect(unconfirmed.reason).toContain("未人工确认");
    expect(engine.getRun(scheduled.run.run_id)!.status).toBe(before);
    await engine.resume(scheduled.run.run_id, { kind: "grade", confirmed: true, payloadKey: incident.incident_id });
    const mismatch = await engine.resume(scheduled.run.run_id, { kind: "grade", confirmed: true, payloadKey: incident.incident_id });
    expect(mismatch.advanced).toBe(false);
    expect(engine.getRun(scheduled.run.run_id)!.status).toBe("remedying");
  });

  it("业务模块不直接改 run.status（状态写入口只在 state-machine）", () => {
    const engineSource = readFileSync(resolve(process.cwd(), "src/runtime/engine.ts"), "utf8");
    expect(engineSource).not.toContain("UPDATE runs SET status");
    const machineSource = readFileSync(resolve(process.cwd(), "src/runtime/state-machine.ts"), "utf8");
    expect(machineSource).toContain("UPDATE runs SET status");
  });
});
