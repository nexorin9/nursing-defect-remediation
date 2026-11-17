import { describe, expect, it } from "vitest";
import { KeyedGate } from "../../src/runtime/concurrency.js";
import { freshDb, testClock } from "../helpers/fixtures.js";

/** T17：按 key 限并发 + FIFO 排队不丢件 + 重启可继续。 */
describe("T17 并发闸门", () => {
  it("limit=2 时第 3 件排队不丢；槽位释放后自动出队", () => {
    const db = freshDb();
    const gate = new KeyedGate(db, 2, testClock());
    expect(gate.acquire("nurse:A", "r1").acquired).toBe(true);
    expect(gate.acquire("nurse:A", "r2").acquired).toBe(true);
    const third = gate.acquire("nurse:A", "r3");
    expect(third.queued).toBe(true);
    expect(third.acquired).toBe(false);
    expect(gate.activeCount("nurse:A")).toBe(2);
    expect(gate.pending("nurse:A")).toEqual(["r3"]);

    const next = gate.release("nurse:A", "r1");
    expect(next).toBe("r3");
    expect(gate.active("nurse:A")).toContain("r3");
    expect(gate.activeCount("nurse:A")).toBe(2);
    expect(gate.pending("nurse:A")).toHaveLength(0);
  });

  it("重启后队列与槽位仍可继续，同 key 并发数不超过 limit", () => {
    const db = freshDb();
    const clock = testClock();
    const first = new KeyedGate(db, 2, clock);
    first.acquire("nurse:B", "b1");
    first.acquire("nurse:B", "b2");
    first.acquire("nurse:B", "b3");
    first.acquire("nurse:B", "b4");
    const reopened = new KeyedGate(db, 2, clock);
    const restored = reopened.restore("nurse:B");
    expect(restored.active).toEqual(["b1", "b2"]);
    expect(restored.queued).toEqual(["b3", "b4"]);
    expect(reopened.activeCount("nurse:B")).toBe(2);
    expect(reopened.release("nurse:B", "b2")).toBe("b3");
    expect(reopened.release("nurse:B", "b1")).toBe("b4");
  });
});
