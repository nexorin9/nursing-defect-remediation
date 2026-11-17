/**
 * 最窄端到端切片（T2）：一条命令核对
 * 上报到达 → 建处置单 → 走一步 → 停在待分级 → 在办清单 CSV + 审计行。
 *
 * 运行态落 app-data/slice.db（固定库），重复跑同一输入不产生第二条处置单。
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDatabase, all } from "../src/store/db.js";
import { Engine } from "../src/runtime/engine.js";
import { STATE_LABELS, type IncidentReport } from "../src/domain/models.js";
import { redactIncident } from "../src/domain/redact.js";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function main(): Promise<number> {
  const input = resolve(arg("input", "fixtures/slice-sample.jsonl"));
  const dbPath = resolve(arg("db", "app-data/slice.db"));
  const outDir = resolve(arg("out", "data/out"));
  if (!existsSync(input)) {
    process.stderr.write(`找不到输入样例：${input}\n`);
    return 2;
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const reports = readFileSync(input, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as IncidentReport);

  const db = openDatabase(dbPath);
  const engine = new Engine({ db });
  let created = 0;
  for (const report of reports) {
    const scheduled = engine.schedule(report);
    if (scheduled.created) created += 1;
    await engine.execute(scheduled.run.run_id);
  }

  const runs = all<Record<string, unknown>>(db, "SELECT * FROM runs ORDER BY created_at ASC");
  const now = Date.now();
  const lines = ["上报单号,病区,班次,当前步,停留时长,上报时刻,缺住院号"];
  for (const row of runs) {
    const incidentId = String(row.incident_id);
    const report = reports.find((r) => r.incident_id === incidentId);
    const redacted = report ? redactIncident(report) : undefined;
    lines.push(
      [
        incidentId,
        String(row.ward_code),
        String(row.shift_code),
        STATE_LABELS[String(row.status) as keyof typeof STATE_LABELS] ?? String(row.status),
        `${Math.max(0, Math.floor((now - Date.parse(String(row.created_at))) / 60_000))} 分钟`,
        String(row.created_at),
        redacted?.missing_encounter_id ? "是" : "否",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const csvPath = resolve(outDir, "在办清单.csv");
  writeFileSync(csvPath, `${lines.join("\n")}\n`, "utf8");

  const auditRows = all<Record<string, unknown>>(db, "SELECT * FROM audit ORDER BY id ASC");
  const auditLines = ["时刻,处置单,操作人,类型,输入哈希,输出哈希,前状态,后状态,详情"];
  for (const row of auditRows) {
    auditLines.push(
      [
        String(row.at),
        String(row.run_id),
        String(row.operator),
        String(row.kind),
        String(row.input_hash),
        String(row.output_hash),
        String(row.from_state ?? ""),
        String(row.to_state ?? ""),
        String(row.detail ?? "").replace(/"/g, "'"),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const auditPath = resolve(outDir, "审计行.csv");
  writeFileSync(auditPath, `${auditLines.join("\n")}\n`, "utf8");

  const stepCount = all<{ c: number }>(db, "SELECT COUNT(*) AS c FROM steps")[0]?.c ?? 0;
  process.stdout.write(`最窄端到端切片完成\n`);
  process.stdout.write(`  输入上报         ${reports.length} 条\n`);
  process.stdout.write(`  本次新建处置单   ${created} 条（重复跑应为 0）\n`);
  process.stdout.write(`  runs 表行数      ${runs.length}\n`);
  process.stdout.write(`  steps 表行数     ${stepCount}\n`);
  process.stdout.write(`  audit 表行数     ${auditRows.length}\n`);
  process.stdout.write(`  当前步           ${runs.map((r) => STATE_LABELS[String(r.status) as keyof typeof STATE_LABELS]).join(" / ")}\n`);
  process.stdout.write(`  产物             ${csvPath}\n`);
  process.stdout.write(`  产物             ${auditPath}\n`);
  db.close();
  return 0;
}

process.exitCode = await main();
