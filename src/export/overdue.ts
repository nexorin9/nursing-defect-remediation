/**
 * 导出 · 超期清单 csv（T46）。
 * 按停留时长倒序；与窗口「超期」计数同源；默认脱敏，不含患者标识字段。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { redactText, containsPatientIdentifier } from "../domain/redact.js";

export interface OverdueRow {
  incident_id: string;
  dwell_minutes: number;
  current_step: string;
  assignee: string;
}

export const OVERDUE_HEADERS = ["上报单号", "停留时长(分钟)", "停在第几步", "责任人"] as const;

function cell(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function exportOverdueCsv(
  rows: OverdueRow[],
  outPath = "data/exports/超期清单.csv",
): { path: string; rowCount: number } {
  const sorted = [...rows].sort((a, b) => b.dwell_minutes - a.dwell_minutes);
  const lines = [OVERDUE_HEADERS.map(cell).join(",")];
  for (const row of sorted) {
    const values = [
      redactText(row.incident_id),
      row.dwell_minutes,
      redactText(row.current_step),
      redactText(row.assignee),
    ];
    for (const value of values) {
      if (typeof value === "string" && containsPatientIdentifier(value)) {
        throw new Error(`超期清单含患者标识字段，拒绝导出：${row.incident_id}`);
      }
    }
    lines.push(values.map(cell).join(","));
  }
  const full = resolve(outPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${lines.join("\n")}\n`, "utf8");
  return { path: full, rowCount: sorted.length };
}
