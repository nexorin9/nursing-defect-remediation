/**
 * 一条命令的可重复验证（T49 用）：契约 → 样例 → 切片 → 规模回放 → 导出读回 → 配置体检。
 *
 * 所有数据来自真实运行库：回放驱动真实 Engine，回写计数用脚本层的协议计数替身
 * （不连院内接口），导出的台账与截图都读同一份 app-data/runtime.db。
 * doctor 由验证脚本注入一组 CI 占位凭据，仅用于校验「字段齐全 + URL 可解析」，
 * 生产环境仍必须由环境变量提供真实地址与令牌。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { checkContracts } from "./check-contract.js";
import { generateIncidents, generateBoundaryFixtures } from "./generate-incidents.js";
import { runReplay, THRESHOLDS } from "./replay-scale.js";
import { runExport } from "../src/cli.js";
import { readLedgerXlsx, LEDGER_COLUMNS } from "../src/export/ledger.js";
import { containsPatientIdentifier } from "../src/domain/redact.js";
import { CONTRACT_FILES } from "../src/domain/contract.js";

const lines: string[] = [];
function say(text: string): void {
  lines.push(text);
  process.stdout.write(`${text}\n`);
}
function fail(reason: string): never {
  process.stderr.write(`可重复验证失败：${reason}\n`);
  process.exit(1);
}

const CI_ENV: Record<string, string> = {
  NURSING_QC_BASE_URL: "https://qc.ci.invalid",
  NURSING_QC_TOKEN: "ci-placeholder-token",
  EMR_BASE_URL: "https://emr.ci.invalid",
  EMR_API_TOKEN: "ci-placeholder-token",
  WECOM_WEBHOOK_URL: "https://wecom.ci.invalid/hook",
  MODEL_BASE_URL: "https://model.ci.invalid",
  MODEL_API_KEY: "ci-placeholder-token",
};

const DB_PATH = "app-data/runtime.db";
const EXPORT_DIR = "data/exports";

async function main(): Promise<void> {
  const cwd = process.cwd();

  // 1) 4 份契约：文件存在 + 字段/枚举/凭据位与代码一致
  const contracts = checkContracts(cwd);
  if (!contracts.ok) fail(`契约不一致：${contracts.problems.join("；")}`);
  say(`[1/6] 契约一致性通过：${contracts.checkedFiles} 份 OpenAPI 3.1（${CONTRACT_FILES.length} 个路径）`);

  // 2) 1000 条脱敏样例可生成，且不含患者标识字段
  const incidents = generateIncidents();
  const boundaries = generateBoundaryFixtures();
  const unique = new Set(incidents.map((r) => r.incident_id)).size;
  if (incidents.length !== THRESHOLDS.expectedRecords || unique !== incidents.length) {
    fail(`样例规模异常：${incidents.length} 条 / 唯一 ${unique} 条`);
  }
  if (incidents.some((r) => containsPatientIdentifier(r.narrative))) fail("合成叙述含患者标识字段");
  say(`[2/6] 样例自检通过：${incidents.length} 条唯一上报 + ${boundaries.length} 条边界样例，默认脱敏`);

  // 3) 最窄端到端切片：真实 Engine → 在办清单 CSV
  const slice = spawnSync(process.execPath, ["--import", "tsx", "scripts/slice.ts", "--input", "fixtures/slice-sample.jsonl"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
  });
  if (slice.status !== 0) fail(`切片脚本退出码 ${slice.status}：${slice.stderr}`);
  const sliceCsv = readFileSync(resolve(cwd, "data/out/在办清单.csv"), "utf8").trim().split("\n");
  if (sliceCsv.length !== 3) fail(`在办清单应为表头 + 2 行，实际 ${sliceCsv.length} 行`);
  say(`[3/6] 切片通过：${sliceCsv.length - 1} 条处置单，当前步待分级，重复投递不新增`);

  // 4) 规模回放：真实 Engine 跑完四类确认并保留运行库
  const metrics = await runReplay({ keepDbPath: DB_PATH });
  if (
    metrics.idempotent_hit_rate !== THRESHOLDS.idempotentHitRate ||
    metrics.recovery_rate !== THRESHOLDS.recoveryRate ||
    metrics.writeback_calls !== metrics.unique ||
    metrics.elapsed_sec > THRESHOLDS.maxElapsedSec ||
    metrics.db_mb > THRESHOLDS.maxDbMB
  ) {
    fail(`规模回放未达阈值：${JSON.stringify(metrics)}`);
  }
  if (!existsSync(resolve(cwd, DB_PATH))) fail("回放未保留运行库");
  say(`[4/6] 规模回放通过：幂等 ${metrics.idempotent_hit_rate}% / 恢复 ${metrics.recovery_rate}% / 回写 ${metrics.writeback_calls} 次 / ${metrics.elapsed_sec}s / ${metrics.db_mb}MB`);

  // 5) 导出并读回 xlsx；台账行数 > 0，csv 不含患者标识字段
  const exported = await runExport(["--db", DB_PATH, "--out", EXPORT_DIR]);
  const readBack = await readLedgerXlsx(exported.ledgerPath);
  if (exported.ledgerRows <= 0) fail("导出的台账行数为 0");
  if (readBack.headers.length !== LEDGER_COLUMNS.length || readBack.rows.length !== exported.ledgerRows) {
    fail(`台账读回不一致：${readBack.headers.length} 列 / ${readBack.rows.length} 行`);
  }
  const csvText = readFileSync(exported.overduePath, "utf8");
  if (containsPatientIdentifier(csvText)) fail("超期清单含患者标识字段");
  say(`[5/6] 导出通过：台账 ${exported.ledgerRows} 行（${LEDGER_COLUMNS.length} 列读回一致）/ 超期清单 ${exported.overdueRows} 行`);

  // 6) 配置体检：必填项齐全 + URL 合法 + 4 份契约可解析（CI 占位凭据，不指向院内端点）
  const doctor = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "doctor"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...CI_ENV },
  });
  if (doctor.status !== 0) fail(`doctor 退出码 ${doctor.status}：${doctor.stderr}`);
  say(`[6/6] 配置体检通过（CI 占位凭据，仅校验字段与 URL；生产须填真实环境变量）`);

  say(`运行库体积 ${(statSync(resolve(cwd, DB_PATH)).size / 1024 / 1024).toFixed(2)}MB；验证全部通过`);
}

await main();
