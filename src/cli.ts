/**
 * 命令行入口（运维与排障通道）。
 *
 * 桌面窗口是日常入口，CLI 只服务于「配置对不对」「起没起得来」「导出台账」三类排障：
 *   doctor  校验 RuntimeConfig 必填项、URL 合法性、4 份 OpenAPI 契约可解析，并打印脱敏摘要
 *   dev     启动桌面常驻应用（托盘 + 窗口），需先 npm run build
 *   export  从运行库导出整改台账 xlsx 与超期清单 csv，读回 xlsx 自检
 *   help    打印用法
 *
 * 生产路径不读任何本地替身端点；凭据一律来自环境变量。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { load as loadYaml } from "js-yaml";
import {
  loadRuntimeConfig,
  MissingEnvError,
  InvalidEnvError,
  redact,
  defaultedFields,
} from "./config/runtime-config.js";
import { openDatabase, all } from "./store/db.js";
import { STATE_LABELS, type RunState } from "./domain/models.js";
import { CONTRACT_FILES } from "./domain/contract.js";
import {
  ledgerRowsFromDb,
  exportLedgerXlsx,
  readLedgerXlsx,
  LEDGER_COLUMNS,
} from "./export/ledger.js";
import { exportOverdueCsv, type OverdueRow } from "./export/overdue.js";

const USAGE = `护理缺陷整改闭环系统 · 命令行通道

用法：
  npm run doctor                       校验配置 + 契约，打印脱敏摘要
  npm run dev                          启动桌面常驻应用（需先 npm run build）
  npm run export -- --db <运行库>      导出整改台账 xlsx 与超期清单 csv
  npm run slice -- --input <jsonl>     最窄端到端切片自检
  npm run replay -- --keep-db <路径>   规模回放并保留运行库供导出
  npm run verify                       一条命令串起契约 / 切片 / 回放 / 导出自检

环境变量见 .env.example。`;

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

/** 4 份 OpenAPI 契约必须可解析且版本号一致；文档与代码字段一致性由 check-contract 脚本拦截。 */
function checkOpenApiContracts(cwd: string): { ok: boolean; files: string[]; reason?: string } {
  const files: string[] = [];
  for (const rel of CONTRACT_FILES) {
    const path = resolve(cwd, rel);
    if (!existsSync(path)) return { ok: false, files, reason: `契约文件缺失：${rel}` };
    const text = readFileSync(path, "utf8");
    let doc: unknown;
    try {
      doc = loadYaml(text);
    } catch (error) {
      return { ok: false, files, reason: `${rel} 不是合法 YAML：${(error as Error).message}` };
    }
    const version = (doc as { openapi?: unknown } | null)?.openapi;
    if (version !== "3.1.0") return { ok: false, files, reason: `${rel} 的 openapi 版本不是 3.1.0：${String(version)}` };
    files.push(rel);
  }
  return { ok: true, files };
}

function runDoctor(): number {
  try {
    const config = loadRuntimeConfig();
    const summary = redact(config);
    process.stdout.write("配置校验通过：\n");
    for (const [key, value] of Object.entries(summary)) {
      process.stdout.write(`  ${key.padEnd(20)} ${value}\n`);
    }
    const defaults = defaultedFields(config);
    if (defaults.length > 0) {
      process.stdout.write(
        `  以下配置按默认值运行：${defaults.join(", ")}（制度时限未导入时不做超期判定）\n`,
      );
    }
  } catch (error) {
    if (error instanceof MissingEnvError) {
      process.stderr.write(`${error.message}\n`);
      process.stderr.write("请在环境变量中补齐上述变量名后重试（参考 .env.example）。\n");
      return 2;
    }
    if (error instanceof InvalidEnvError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    process.stderr.write(`配置校验失败：${(error as Error).message}\n`);
    return 2;
  }
  const contracts = checkOpenApiContracts(process.cwd());
  if (!contracts.ok) {
    process.stderr.write(`契约校验失败：${contracts.reason ?? "未知原因"}\n`);
    return 2;
  }
  process.stdout.write(`契约可解析：${contracts.files.length} 份 OpenAPI 3.1（${contracts.files.join("、")}）\n`);
  return 0;
}

function runDev(): number {
  const entry = resolve(process.cwd(), "dist/main/index.js");
  if (!existsSync(entry)) {
    process.stderr.write(`找不到主进程产物 ${entry}，请先执行 npm run build。\n`);
    return 2;
  }
  const binary = resolve(process.cwd(), "node_modules/.bin/electron");
  if (!existsSync(binary)) {
    process.stderr.write("找不到 Electron 可执行文件，请先执行 npm ci。\n");
    return 2;
  }
  process.stdout.write(`启动桌面常驻应用：${entry}\n`);
  const result = spawnSync(binary, [entry], { stdio: "inherit", cwd: process.cwd() });
  return result.status ?? 1;
}

interface ExportSummary {
  ledgerRows: number;
  overdueRows: number;
  ledgerPath: string;
  overduePath: string;
}

/** 导出：台账取已闭环件，超期清单取仍在办件；两者都来自同一运行库。 */
export async function runExport(argv: string[] = process.argv.slice(2)): Promise<ExportSummary> {
  const dbPath = resolve(argv.includes("--db") ? argv[argv.indexOf("--db") + 1] ?? "app-data/runtime.db" : "app-data/runtime.db");
  const outDir = resolve(argv.includes("--out") ? argv[argv.indexOf("--out") + 1] ?? "data/exports" : "data/exports");
  if (!existsSync(dbPath)) {
    throw new Error(`运行库不存在：${dbPath}。请先执行 npm run replay -- --keep-db ${dbPath} 产生真实运行态。`);
  }
  const db = openDatabase(dbPath);
  try {
    const rows = ledgerRowsFromDb(db);
    const ledger = await exportLedgerXlsx(rows, resolve(outDir, "整改台账.xlsx"));
    const readBack = await readLedgerXlsx(ledger.path);
    if (readBack.headers.length !== LEDGER_COLUMNS.length || readBack.rows.length !== rows.length) {
      throw new Error(`台账读回自检失败：列 ${readBack.headers.length} / 行 ${readBack.rows.length}，期望 ${LEDGER_COLUMNS.length} / ${rows.length}`);
    }
    const now = Date.now();
    const open = all<Record<string, unknown>>(db, "SELECT * FROM runs WHERE status <> 'written_back' ORDER BY created_at ASC");
    const overdueRows: OverdueRow[] = open.map((row) => ({
      incident_id: String(row.incident_id),
      dwell_minutes: Math.max(0, Math.floor((now - Date.parse(String(row.created_at))) / 60_000)),
      current_step: STATE_LABELS[String(row.status) as RunState] ?? String(row.status),
      assignee: String(row.assignee_key ?? ""),
    }));
    const overdue = exportOverdueCsv(overdueRows, resolve(outDir, "超期清单.csv"));
    mkdirSync(dirname(ledger.path), { recursive: true });
    return {
      ledgerRows: ledger.rowCount,
      overdueRows: overdue.rowCount,
      ledgerPath: ledger.path,
      overduePath: overdue.path,
    };
  } finally {
    db.close();
  }
}

async function cliExport(): Promise<number> {
  try {
    const result = await runExport();
    process.stdout.write(`导出完成\n`);
    process.stdout.write(`  整改台账 xlsx  ${result.ledgerPath}（${result.ledgerRows} 行，读回自检通过）\n`);
    process.stdout.write(`  超期清单 csv   ${result.overduePath}（${result.overdueRows} 行，按停留时长倒序）\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`导出失败：${(error as Error).message}\n`);
    return 2;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? "doctor";
  switch (command) {
    case "doctor":
      return runDoctor();
    case "dev":
      return runDev();
    case "export":
      return cliExport();
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    default:
      process.stderr.write(`未知命令：${command}\n\n${USAGE}\n`);
      return 2;
  }
}

// 仅在作为 CLI 直接执行时落地副作用；被测试 / 验证脚本 import 时不自动运行。
const invokedDirectly = /[/\\]cli\.(ts|js)$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  process.exitCode = await main();
}
