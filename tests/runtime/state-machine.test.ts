import { describe, expect, it } from "vitest";
import { run, get, type Database } from "../../src/store/db.js";
import { TRANSITIONS, transition, applyTransition, applyRollback, rollbackOf } from "../../src/runtime/state-machine.js";
import { countAudit, readAudit } from "../../src/store/audit.js";
import { freshDb, testClock } from "../helpers/fixtures.js";
import { RUN_STATES, type RunState } from "../../src/domain/models.js";

function insertRun(db: Database, runId: string, status: RunState): void {
  run(
    db,
    "INSERT INTO runs (run_id, incident_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    runId, `INC-${runId}`, status, "2026-11-09T00:00:00Z", "2026-11-09T00:00:00Z",
  );
}

/** T10：7 态状态机 + 非法转换拒绝 + 一级撤回。 */
describe("T10 状态机", () => {
  it("合法转换表中每条转换都通过", () => {
    for (const from of RUN_STATES) {
      for (const to of TRANSITIONS[from]) {
        expect(transition(from, to).ok).toBe(true);
      }
    }
  });

  it("非法转换全被拒且状态未改写", () => {
    const db = freshDb();
    insertRun(db, "r1", "written_back");
    const illegal: [RunState, RunState][] = [
      ["written_back", "new"],
      ["closed", "awaiting_grade"],
      ["new", "awaiting_grade"],
      ["awaiting_grade", "written_back"],
    ];
    for (const [from, to] of illegal) {
      const result = transition(from, to);
      expect(result.ok).toBe(false);
      expect(result.reason.length).toBeGreaterThan(0);
      applyTransition(db, { runId: "r1", from, to });
    }
    expect(get<{ status: string }>(db, "SELECT status FROM runs WHERE run_id = 'r1'")?.status).toBe("written_back");
  });

  it("撤回一级后 audit 新增 1 行且含前后状态", () => {
    const db = freshDb();
    const clock = testClock();
    insertRun(db, "r2", "remedying");
    expect(rollbackOf("remedying")).toBe("awaiting_grade");
    const before = countAudit(db);
    const result = applyRollback(db, { runId: "r2", operator: "王护士长", clock });
    expect(result.ok).toBe(true);
    expect(countAudit(db)).toBe(before + 1);
    const rows = readAudit(db, "r2");
    expect(rows[0]!.kind).toBe("rollback");
    expect(rows[0]!.from_state).toBe("remedying");
    expect(rows[0]!.to_state).toBe("awaiting_grade");
    expect(get<{ status: string }>(db, "SELECT status FROM runs WHERE run_id = 'r2'")?.status).toBe("awaiting_grade");
  });
});
