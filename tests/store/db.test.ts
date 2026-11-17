import { describe, expect, it } from "vitest";
import { openDatabase, migrate, tableNames, getSchemaVersion, run, SCHEMA_VERSION } from "../../src/store/db.js";
import { makeIncident } from "../helpers/fixtures.js";

/** T7：五张表、唯一约束、向前迁移。 */
describe("T7 SQLite 运行态底座", () => {
  it("建库后 runs / steps / pauses / audit / outbox 五表存在", () => {
    const db = openDatabase(":memory:");
    const names = tableNames(db);
    for (const table of ["runs", "steps", "pauses", "audit", "outbox"]) {
      expect(names).toContain(table);
    }
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("重复插入同一 incident_id 的 run 被唯一约束拒绝", () => {
    const db = openDatabase(":memory:");
    const insert = () => run(
      db,
      `INSERT INTO runs (run_id, incident_id, status, created_at, updated_at) VALUES (?, ?, 'new', ?, ?)`,
      `run_${Math.random()}`, "INC-DUP", "2026-11-09T00:00:00Z", "2026-11-09T00:00:00Z",
    );
    insert();
    expect(insert).toThrow();
    db.close();
  });

  it("迁移函数可在 v1 旧库上升级到 v2", () => {
    const db = openDatabase(":memory:", { migrateTo: 1 });
    expect(getSchemaVersion(db)).toBe(1);
    expect(tableNames(db)).not.toContain("pauses");
    expect(migrate(db, 2)).toBe(2);
    expect(tableNames(db)).toContain("pauses");
    expect(tableNames(db)).toContain("outbox");
    db.close();
  });
});
