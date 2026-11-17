/**
 * 导出 · 整改台账 xlsx（T46）。
 *
 * 列：上报单号 / 病区 / 班次 / 分级 / 整改措施 / 计划完成日 / 复核人 / 销号时刻 /
 *     回执号 / 当前步 / 停留时长；默认脱敏（过 redactText，不含患者姓名、住院号、床号）。
 * 回执号取自 runs / outbox 同一数据源，与窗口确认闸门回显、质控系统响应三处一致。
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ExcelJS from "exceljs";
import { redactText, containsPatientIdentifier } from "../domain/redact.js";
import { all, get, type Database } from "../store/db.js";
import { STATE_LABELS, type RunState } from "../domain/models.js";

export interface LedgerRow {
  incident_id: string;
  ward_code: string;
  shift_code: string;
  grade: string;
  remediation_plan: string;
  plan_deadline: string;
  reviewer: string;
  closed_at: string;
  receipt_id: string;
  current_step: string;
  dwell_minutes: number;
}

export const LEDGER_COLUMNS = [
  "上报单号", "病区", "班次", "分级", "整改措施", "计划完成日",
  "复核人", "销号时刻", "回执号", "当前步", "停留时长(分钟)",
] as const;

/** 从运行库读回闭环件（同一数据源，不另行拼装回执号）。 */
export function ledgerRowsFromDb(db: Database, nowMs = Date.now()): LedgerRow[] {
  const rows = all<Record<string, unknown>>(
    db,
    "SELECT * FROM runs WHERE status = 'written_back' ORDER BY created_at ASC",
  );
  return rows.map((row) => {
    const incidentId = String(row.incident_id);
    const review = get<{ payload: string; receipt_id: string | null }>(
      db,
      "SELECT payload, receipt_id FROM outbox WHERE kind = 'review' AND incident_id = ? ORDER BY id DESC LIMIT 1",
      incidentId,
    );
    let grade = "人工确认";
    let plan = redactText(String(row.narrative_redacted)).slice(0, 200);
    let deadline = "按院内整改计划";
    if (review) {
      try {
        const payload = JSON.parse(review.payload) as Record<string, unknown>;
        grade = redactText(String(payload.grade ?? grade));
        plan = redactText(String(payload.remediation_plan ?? plan)).slice(0, 200);
        deadline = String(payload.plan_deadline ?? deadline);
      } catch {
        /* 回写 payload 非结构化时回落到运行库字段 */
      }
    }
    return {
      incident_id: incidentId,
      ward_code: redactText(String(row.ward_code)),
      shift_code: redactText(String(row.shift_code)),
      grade,
      remediation_plan: plan,
      plan_deadline: deadline,
      reviewer: "病区护士长",
      closed_at: String(row.closed_at ?? row.updated_at),
      // 窗口回显、质控系统回执、台账三处取自同一 runs.receipt_id
      receipt_id: String(row.receipt_id ?? review?.receipt_id ?? ""),
      current_step: STATE_LABELS[String(row.status) as RunState] ?? String(row.status),
      dwell_minutes: Math.max(0, Math.floor((nowMs - Date.parse(String(row.created_at))) / 60_000)),
    };
  });
}

/** 导出前逐格过脱敏；出现患者标识即抛错，不静默写出。 */
export function assertLedgerRowsRedacted(rows: LedgerRow[]): void {
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (typeof value === "string" && containsPatientIdentifier(value)) {
        throw new Error(`台账行含患者标识字段，拒绝导出：${row.incident_id}`);
      }
    }
  }
}

export async function exportLedgerXlsx(
  rows: LedgerRow[],
  outPath = "data/exports/整改台账.xlsx",
): Promise<{ path: string; rowCount: number }> {
  assertLedgerRowsRedacted(rows);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "护理缺陷整改闭环系统";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("整改台账");
  sheet.columns = LEDGER_COLUMNS.map((header) => ({ header, key: header, width: 18 }));
  for (const row of rows) {
    sheet.addRow([
      row.incident_id, row.ward_code, row.shift_code, row.grade, row.remediation_plan,
      row.plan_deadline, row.reviewer, row.closed_at, row.receipt_id, row.current_step, row.dwell_minutes,
    ]);
  }
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  const full = resolve(outPath);
  mkdirSync(dirname(full), { recursive: true });
  await workbook.xlsx.writeFile(full);
  return { path: full, rowCount: rows.length };
}

/** 读回 xlsx 校验（供验收与测试）。 */
export async function readLedgerXlsx(path: string): Promise<{ headers: string[]; rows: unknown[][] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };
  const values = sheet.getSheetValues() as unknown[][];
  const headers = (values[1] ?? []).slice(1).map(String);
  const rows = values.slice(2).map((r) => r.slice(1));
  return { headers, rows };
}
