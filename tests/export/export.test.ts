/** T46 · 导出：xlsx 台账读回断言、csv 倒序与脱敏、回执号与窗口同源。 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, run } from "../../src/store/db.js";
import { reviewDedupeKey, rememberReview, setReviewReceipt, getReceiptByIncident } from "../../src/store/idempotency.js";
import {
  ledgerRowsFromDb, exportLedgerXlsx, readLedgerXlsx,
  assertLedgerRowsRedacted, LEDGER_COLUMNS,
} from "../../src/export/ledger.js";
import { exportOverdueCsv, OVERDUE_HEADERS } from "../../src/export/overdue.js";
import { containsPatientIdentifier, PATIENT_IDENTIFIER_FIELDS } from "../../src/domain/redact.js";
import type { ReviewPayload } from "../../src/domain/models.js";
import { testClock } from "../helpers/fixtures.js";

const RECEIPT = "RCP-EXPORT-0001";
const PAYLOAD: ReviewPayload = {
  review_result: "同意销号",
  grade: "Ⅱ级",
  remediation_plan: "补记翻身计划并双人核对",
  plan_deadline: "2026-11-12",
  evidence_refs: ["交接班漏项"],
  revision: 1,
};

function seedDb() {
  const db = openDatabase(":memory:");
  const clock = testClock();
  const at = "2026-11-09T00:00:00.000Z";
  run(db, `INSERT INTO runs (run_id, incident_id, status, revision, ward_code, shift_code, narrative_redacted, assignee_key, step_cursor, created_at, updated_at, closed_at)
           VALUES ('run-export', 'INC-EXPORT-1', 'written_back', 1, '内科三病区', '白班', '交接班漏项，已按流程补记并上报。', 'nurse:内科三病区:白班', 6, ?, ?, ?)`, at, at, at);
  const dedupeKey = reviewDedupeKey("INC-EXPORT-1", PAYLOAD.review_result, PAYLOAD.revision);
  rememberReview(db, { dedupeKey, incidentId: "INC-EXPORT-1", batchId: "review-1", payload: PAYLOAD, status: "pending" }, clock);
  setReviewReceipt(db, dedupeKey, RECEIPT, clock);
  return db;
}

describe("导出 · 整改台账与超期清单", () => {
  it("运行库 → 台账行，回执号与窗口反查同源", () => {
    const db = seedDb();
    const rows = ledgerRowsFromDb(db, Date.parse("2026-11-09T02:00:00.000Z"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.receipt_id).toBe(RECEIPT);
    expect(getReceiptByIncident(db, "INC-EXPORT-1")).toBe(RECEIPT);
    expect(rows[0]!.grade).toBe("Ⅱ级");
    expect(rows[0]!.remediation_plan).toContain("补记翻身计划");
    expect(rows[0]!.dwell_minutes).toBe(120);
    expect(containsPatientIdentifier(JSON.stringify(rows[0]))).toBe(false);
    db.close();
  });

  it("xlsx 生成后可读回列名与行数，且不含患者标识字段", async () => {
    const db = seedDb();
    const dir = mkdtempSync(join(tmpdir(), "ndr-export-"));
    try {
      const path = join(dir, "整改台账.xlsx");
      const rows = ledgerRowsFromDb(db);
      const result = await exportLedgerXlsx(rows, path);
      expect(result.rowCount).toBe(rows.length);
      const readBack = await readLedgerXlsx(path);
      expect(readBack.headers).toEqual([...LEDGER_COLUMNS]);
      expect(readBack.rows).toHaveLength(rows.length);
      expect(String(readBack.rows[0]![8])).toBe(RECEIPT);
      const allText = JSON.stringify(readBack);
      for (const field of PATIENT_IDENTIFIER_FIELDS) expect(allText).not.toContain(field);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
    }
  });

  it("导出前逐格脱敏断言：含患者标识字段即拒绝写出", async () => {
    const db = seedDb();
    const rows = ledgerRowsFromDb(db);
    expect(() => assertLedgerRowsRedacted(rows)).not.toThrow();
    expect(() => assertLedgerRowsRedacted([{ ...rows[0]!, remediation_plan: "患者姓名" }])).toThrow(/拒绝导出/);
    const dir = mkdtempSync(join(tmpdir(), "ndr-export-"));
    try {
      await expect(exportLedgerXlsx([{ ...rows[0]!, remediation_plan: "住院号：AB123456" }], join(dir, "bad.xlsx")))
        .rejects.toThrow(/拒绝导出/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
    }
  });

  it("超期清单按停留时长倒序，文件不含患者标识字段", () => {
    const db = seedDb();
    const dir = mkdtempSync(join(tmpdir(), "ndr-export-"));
    try {
      const path = join(dir, "超期清单.csv");
      const result = exportOverdueCsv([
        { incident_id: "INC-A", dwell_minutes: 30, current_step: "待分级", assignee: "nurse:A:白班" },
        { incident_id: "INC-B", dwell_minutes: 180, current_step: "措施待复核", assignee: "nurse:B:白班" },
        { incident_id: "INC-C", dwell_minutes: 90, current_step: "待销号", assignee: "nurse:C:白班" },
      ], path);
      expect(result.rowCount).toBe(3);
      const text = readFileSync(path, "utf8");
      const lines = text.trim().split("\n");
      expect(lines[0]).toContain([...OVERDUE_HEADERS].join("\",\""));
      const dwell = lines.slice(1).map((line) => Number(line.split("\",\"")[1]?.replace(/"/g, "")));
      expect(dwell).toEqual([180, 90, 30]);
      expect(containsPatientIdentifier(text)).toBe(false);
      for (const field of PATIENT_IDENTIFIER_FIELDS) expect(text).not.toContain(field);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
    }
  });
});
