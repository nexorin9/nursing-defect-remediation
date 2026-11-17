/**
 * 规模回放（T23）：批量回放 1000 条脱敏上报，驱动真实 engine（临时 SQLite 库）。
 *
 * 统计：幂等命中率 / 恢复正确率 / 回写调用数 / 总耗时 / 运行态体积；
 * 阈值写成脚本常量。可注入时钟保证确定性；同一输入两次回放的核心指标一致
 * （--summary-only 输出可比对的结构化摘要，含 fingerprint）。
 *
 * 说明：回放里的「回写」是协议计数替身（记录调用次数与回执号），不发起真实院内请求；
 * 真实外发路径在 src/adapters/，凭据位来自环境变量。
 */
import { existsSync, readFileSync, statSync, mkdtempSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openDatabase } from "../src/store/db.js";
import { Engine } from "../src/runtime/engine.js";
import { fixedClock, HOUR_MS } from "../src/util/clock.js";
import { sha256 } from "../src/util/hash.js";
import { generateIncidents } from "./generate-incidents.js";
import type { IncidentReport, RunState } from "../src/domain/models.js";

/** 验收阈值（脚本常量）。 */
export const THRESHOLDS = {
  idempotentHitRate: 100,
  recoveryRate: 100,
  maxElapsedSec: 120,
  maxDbMB: 50,
  expectedRecords: 1000,
} as const;

export interface ReplayMetrics {
  records: number;
  unique: number;
  created_first_pass: number;
  created_second_pass: number;
  idempotent_hit_rate: number;
  recovered: number;
  recovery_rate: number;
  writeback_calls: number;
  elapsed_sec: number;
  db_mb: number;
  fingerprint: string;
}

function loadIncidents(): IncidentReport[] {
  const path = resolve("data/raw/incidents.jsonl");
  if (!existsSync(path)) return generateIncidents(THRESHOLDS.expectedRecords);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as IncidentReport);
}

/**
 * options.keepDbPath 用于把本次真实回放产生的运行库保留到运行时目录，
 * 供 npm run export 与截图脚本读取同一份数据（不是临时拼装的样例）。
 */
export async function runReplay(options: { input?: IncidentReport[]; keepDbPath?: string } = {}): Promise<ReplayMetrics> {
  const reports = options.input ?? loadIncidents();
  const dir = mkdtempSync(join(tmpdir(), "ndr-replay-"));
  const dbPath = join(dir, "replay.db");
  const started = Date.now();
  const clock = fixedClock(Date.parse("2026-11-09T00:00:00.000Z"));
  let writebackCalls = 0;
  const db = openDatabase(dbPath);
  const engine = new Engine({
    db,
    clock,
    hooks: {
      onWriteback: async (ctx) => {
        writebackCalls += 1;
        return { ok: true, receipt_id: `RCP-REPLAY-${ctx.run.incident_id}` };
      },
    },
    retryOptions: { maxRetries: 0, sleep: () => Promise.resolve() },
  });

  try {
    let createdFirst = 0;
    for (const report of reports) {
      const scheduled = engine.schedule(report);
      if (scheduled.created) {
        createdFirst += 1;
        await engine.execute(scheduled.run.run_id);
      }
    }
    // 同一批输入重复投递，验证幂等
    let createdSecond = 0;
    for (const report of reports) {
      if (engine.schedule(report).created) createdSecond += 1;
    }
    const idempotentHitRate = reports.length === 0 ? 0 : ((reports.length - createdSecond) / reports.length) * 100;

    // 每条走完四类人工确认，验证挂起恢复与回写恰好一次
    const confirmKinds: { kind: "grade" | "remedy" | "review" | "close" }[] = [
      { kind: "grade" },
      { kind: "remedy" },
      { kind: "review" },
      { kind: "close" },
    ];
    let recovered = 0;
    for (const report of reports) {
      const run = engine.getRunByIncident(report.incident_id);
      if (!run) continue;
      for (const step of confirmKinds) {
        clock.advance(HOUR_MS);
        await engine.resume(run.run_id, {
          kind: step.kind,
          confirmed: true,
          operator: "replay_runner",
          payloadKey: report.incident_id,
        });
      }
      if (engine.getRun(run.run_id)?.status === ("written_back" as RunState)) recovered += 1;
    }
    const recoveryRate = reports.length === 0 ? 0 : (recovered / reports.length) * 100;
    const unique = new Set(reports.map((r) => r.incident_id)).size;
    const elapsedSec = (Date.now() - started) / 1000;
    const dbMB = existsSync(dbPath) ? statSync(dbPath).size / (1024 * 1024) : 0;
    const fingerprint = sha256(
      JSON.stringify({ records: reports.length, unique, createdFirst, createdSecond, recovered, writebackCalls }),
    );
    return {
      records: reports.length,
      unique,
      created_first_pass: createdFirst,
      created_second_pass: createdSecond,
      idempotent_hit_rate: Math.round(idempotentHitRate * 100) / 100,
      recovered,
      recovery_rate: Math.round(recoveryRate * 100) / 100,
      writeback_calls: writebackCalls,
      elapsed_sec: Math.round(elapsedSec * 100) / 100,
      db_mb: Math.round(dbMB * 100) / 100,
      fingerprint,
    };
  } finally {
    db.close();
    if (options.keepDbPath) {
      const target = resolve(options.keepDbPath);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(dbPath, target);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const isCli = process.argv[1]?.endsWith("replay-scale.ts") ?? false;
if (isCli) {
  const summaryOnly = process.argv.includes("--summary-only");
  const keepIndex = process.argv.indexOf("--keep-db");
  const keepDbPath = keepIndex >= 0 ? process.argv[keepIndex + 1] : undefined;
  const metrics = await runReplay({ ...(keepDbPath ? { keepDbPath } : {}) });
  const pass =
    metrics.idempotent_hit_rate === THRESHOLDS.idempotentHitRate &&
    metrics.recovery_rate === THRESHOLDS.recoveryRate &&
    metrics.writeback_calls === metrics.unique &&
    metrics.elapsed_sec <= THRESHOLDS.maxElapsedSec &&
    metrics.db_mb <= THRESHOLDS.maxDbMB;
  if (summaryOnly) {
    process.stdout.write(`${JSON.stringify({ ...metrics, pass }, null, 2)}\n`);
  } else {
    const rows = [
      "规模回放摘要 · 1000 条脱敏上报",
      `  输入条数            ${metrics.records}`,
      `  去重后条数          ${metrics.unique}`,
      `  首轮新建处置单      ${metrics.created_first_pass}`,
      `  重复投递新建        ${metrics.created_second_pass}（期望 0）`,
      `  幂等命中率          ${metrics.idempotent_hit_rate}%（阈值 ${THRESHOLDS.idempotentHitRate}%）`,
      `  恢复正确率          ${metrics.recovery_rate}%（阈值 ${THRESHOLDS.recoveryRate}%）`,
      `  回写调用数          ${metrics.writeback_calls}（期望 = 去重后条数 ${metrics.unique}）`,
      `  总耗时              ${metrics.elapsed_sec}s（阈值 ≤ ${THRESHOLDS.maxElapsedSec}s）`,
      `  运行态体积          ${metrics.db_mb}MB（阈值 ≤ ${THRESHOLDS.maxDbMB}MB）`,
      `  结果指纹            ${metrics.fingerprint}`,
      `  结论                ${pass ? "通过" : "未通过"}`,
      ...(keepDbPath ? [`  运行库已保留        ${resolve(keepDbPath)}`] : []),
    ];
    process.stdout.write(`${rows.join("\n")}\n`);
  }
  process.exitCode = pass ? 0 : 1;
}
