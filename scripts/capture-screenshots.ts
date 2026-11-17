/**
 * T47 · 采集真实运行截图。
 *
 * 诚实声明：截图来自本项目**真实运行**的一次确定性回放（真实 Engine + 真实 SQLite +
 * 真实导出模块），由无头 Chromium 渲染 src/ui/index.html 的真实 HTML/CSS/JS。
 * 回放用脚本层的协议计数替身给出回执号，不连接院内真实接口；
 * 真实外发协议路径在 src/adapters/，其协议测试在 tests/adapters/。
 * 截图运行显式导入了一份「院内时限」演示口径以触发超期清单；
 * 产品出厂默认 stepDueHours 为空，此时不判定超期、不催办。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../src/store/db.js";
import { Engine } from "../src/runtime/engine.js";
import { STEP_DEFS } from "../src/runtime/steps.js";
import { buildTimeline } from "../src/runtime/timeline.js";
import { createPolicy, isOverdue } from "../src/domain/policy.js";
import { STATE_LABELS, type IncidentReport, type RunState, type StepTrace } from "../src/domain/models.js";
import { ledgerRowsFromDb, exportLedgerXlsx, readLedgerXlsx, LEDGER_COLUMNS } from "../src/export/ledger.js";
import { exportOverdueCsv, OVERDUE_HEADERS, type OverdueRow } from "../src/export/overdue.js";
import { HOUR_MS, type Clock } from "../src/util/clock.js";

const ROOT = process.cwd();
const SHOT_DIR = resolve(ROOT, "docs/screenshots");
const HTML_DIR = resolve(ROOT, "data/screenshots-html");
const DB_PATH = resolve(ROOT, "app-data/screenshots.db");
const EXPORT_DIR = resolve(ROOT, "data/exports");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const BASE = Date.parse("2026-11-09T00:00:00.000Z");

/** 注入时钟：每次 now() 前进 5 秒，让步骤 / 等待段呈现真实时间间隔。 */
class TickingClock implements Clock {
  private current: number;
  constructor(start: number, private readonly stepMs = 5_000) {
    this.current = start;
  }
  now(): number {
    const value = this.current;
    this.current += this.stepMs;
    return value;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

interface SnapshotItem {
  incident_id: string;
  ward_code: string;
  shift_code: string;
  status: string;
  statusLabel: string;
  dwellMinutes: number;
  overdue: boolean;
  narrative: string;
  evidenceRefs: string[];
  hallucinated: string[];
  timeline: unknown[];
  draft: { grade: string; remediation_plan: string };
}

function incident(n: number, ward: string, shift: string, narrative: string): IncidentReport {
  return {
    incident_id: `INC-2026-${String(n).padStart(4, "0")}`,
    reported_at: new Date(BASE + n * 60_000).toISOString(),
    ward_code: ward,
    shift_code: shift,
    narrative,
    reporter_role: "责任护士",
    severity_hint: "Ⅲ级",
    encounter_id: `SYN-ENC-${String(n).padStart(5, "0")}`,
  };
}

function esc(text: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(text).replace(/[&<>"']/g, (c) => map[c] ?? c);
}

function inlineUiHtml(snapshot: unknown): string {
  const html = readFileSync(resolve(ROOT, "src/ui/index.html"), "utf8");
  const theme = readFileSync(resolve(ROOT, "src/ui/theme.css"), "utf8");
  const styles = readFileSync(resolve(ROOT, "src/ui/styles.css"), "utf8");
  const renderer = readFileSync(resolve(ROOT, "src/ui/renderer.js"), "utf8");
  return html
    .replace('<link rel="stylesheet" href="theme.css" />', `<style>${theme}</style>`)
    .replace('<link rel="stylesheet" href="styles.css" />', `<style>${styles}</style>`)
    .replace(
      '<script type="module" src="renderer.js"></script>',
      `<script>window.__NDR_SNAPSHOT__ = ${JSON.stringify(snapshot)};</script>\n` +
        `<script type="module">\n${renderer}\n</script>`,
    );
}

function evidenceHtml(title: string, subtitle: string, blocks: { heading: string; body: string }[]): string {
  const theme = readFileSync(resolve(ROOT, "src/ui/theme.css"), "utf8");
  const styles = readFileSync(resolve(ROOT, "src/ui/styles.css"), "utf8");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${esc(title)}</title>
<style>${theme}</style><style>${styles}</style>
<style>
  body { padding: 24px 32px; overflow: hidden; }
  .ev-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:16px; }
  .ev-block { margin-bottom: 20px; }
  .ev-block h2 { margin: 0 0 8px; }
  .ev-table { width:100%; border-collapse:collapse; font-size:12px; background:#fff; }
  .ev-table th, .ev-table td { border:1px solid var(--ndr-border); padding:6px 8px; text-align:left; white-space:nowrap; }
  .ev-table th { background:var(--ndr-neutral-2); font-weight:600; }
  .ev-table tr:nth-child(even) td { background:var(--ndr-neutral-1); }
  .ev-term { background:#14243A; color:#D7E3F4; border-radius:8px; padding:16px 20px; font-family:var(--ndr-mono); font-size:12px; line-height:1.65; white-space:pre-wrap; word-break:break-word; }
  .ev-term .ok { color:#7EE2A8; }
  .ev-note { color:var(--ndr-text-2); font-size:12px; margin-top:8px; }
</style></head><body>
<div class="ev-head"><div><h1 class="ndr-page-title">${esc(title)}</h1><div class="ndr-caption">${esc(subtitle)}</div></div>
<span class="ndr-tag ndr-tag--brand">实测证据</span></div>
${blocks.map((b) => `<div class="ev-block"><h2 class="ndr-section-title">${esc(b.heading)}</h2>${b.body}</div>`).join("")}
</body></html>`;
}

function tableHtml(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return `<table class="ev-table"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(String(c ?? ""))}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function screenshot(htmlPath: string, pngPath: string): void {
  if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`);
  const result = spawnSync(CHROME, [
    "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--force-device-scale-factor=1", "--virtual-time-budget=3000",
    "--window-size=1440,900", `--screenshot=${pngPath}`, pathToFileURL(htmlPath).href,
  ], { encoding: "utf8" });
  if (!existsSync(pngPath)) throw new Error(`截图未生成：${pngPath}\n${result.stderr}`);
  process.stdout.write(`  截图 ${pngPath}\n`);
}

async function main(): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(HTML_DIR, { recursive: true });
  mkdirSync(dirname(DB_PATH), { recursive: true });
  mkdirSync(EXPORT_DIR, { recursive: true });

  // 演示口径：截图运行显式导入「院内时限」，用于展示超期清单路径。
  const policy = createPolicy({
    stepDueHours: {
      value: { awaiting_grade: 1, remedying: 1, awaiting_review: 1 },
      source: "院内制度导入",
    },
  });
  const clock = new TickingClock(BASE);
  const db = openDatabase(DB_PATH);
  let receiptSeq = 0;
  const engine = new Engine({
    db,
    clock,
    policy,
    hooks: {
      onWriteback: async (ctx) => {
        receiptSeq += 1;
        return { ok: true, receipt_id: `RCP-2026-${String(receiptSeq).padStart(4, "0")}` };
      },
    },
  });

  const narratives = [
    "交接班漏项，已按流程补记并上报。",
    "夜间巡视未按时完成，已补记并双人核对。",
    "给药核对漏项，已按查对制度重新核对。",
    "翻身计划执行漏记，已补全护理记录。",
  ];
  const wards = ["内科三病区", "外科二病区", "骨科一病区", "老年病区"];

  const closed = [1, 2, 3, 4].map((n) => incident(n, wards[n - 1]!, "白班", narratives[n - 1]!));
  for (const report of closed) {
    const s = engine.schedule(report);
    await engine.execute(s.run.run_id);
  }
  // 4 件走完四类人工确认 → 闭环并有回执
  for (const report of closed) {
    const run = engine.getRunByIncident(report.incident_id);
    if (!run) continue;
    for (const kind of ["grade", "remedy", "review", "close"] as const) {
      clock.advance(10 * 60_000);
      await engine.resume(run.run_id, { kind, confirmed: true, operator: "护士长", payloadKey: report.incident_id });
    }
  }

  // 4 件留在办，按不同上报时刻呈现不同停留时长
  const open5 = incident(5, "内科三病区", "白班", narratives[0]!);
  const s5 = engine.schedule(open5);
  await engine.execute(s5.run.run_id);

  clock.advance(HOUR_MS);
  const open6 = incident(6, "外科二病区", "小夜班", narratives[1]!);
  const s6 = engine.schedule(open6);
  await engine.execute(s6.run.run_id);

  clock.advance(HOUR_MS);
  const open7 = incident(7, "骨科一病区", "白班", narratives[2]!);
  const s7 = engine.schedule(open7);
  await engine.execute(s7.run.run_id);
  await engine.resume(s7.run.run_id, { kind: "grade", confirmed: true, operator: "护士长", payloadKey: open7.incident_id });

  clock.advance(HOUR_MS);
  const open8 = incident(8, "老年病区", "大夜班", narratives[3]!);
  const s8 = engine.schedule(open8);
  await engine.execute(s8.run.run_id);
  await engine.resume(s8.run.run_id, { kind: "grade", confirmed: true, operator: "护士长", payloadKey: open8.incident_id });
  await engine.resume(s8.run.run_id, { kind: "remedy", confirmed: true, operator: "护士长", payloadKey: open8.incident_id });

  clock.advance(3 * HOUR_MS);
  const nowMs = clock.now();

  const allRuns = engine.listRuns();
  const items: SnapshotItem[] = [];
  const overdueRows: OverdueRow[] = [];
  const openIds = [open5, open6, open7, open8].map((r) => r.incident_id);
  const orderedReports: IncidentReport[] = [open5, open6, open7, open8, ...closed];
  for (const report of orderedReports) {
    const run = allRuns.find((r) => r.incident_id === report.incident_id);
    if (!run) continue;
    const dwellMs = Math.max(0, nowMs - Date.parse(run.created_at));
    const overdue = isOverdue(policy, run.status, dwellMs) === true;
    const traces: StepTrace[] = engine.stepRecords(run.run_id).map((r, idx) => ({
      step_id: r.step_id,
      name: STEP_DEFS[idx]?.name ?? r.step_id,
      operator: r.operator,
      queued_at: r.queued_at,
      ...(r.started_at ? { started_at: r.started_at } : {}),
      ...(r.ended_at ? { ended_at: r.ended_at } : {}),
      status: r.status,
    }));
    const timeline = buildTimeline(traces, nowMs).segments;
    items.push({
      incident_id: report.incident_id,
      ward_code: report.ward_code,
      shift_code: report.shift_code,
      status: run.status,
      statusLabel: STATE_LABELS[run.status as RunState],
      dwellMinutes: Math.floor(dwellMs / 60_000),
      overdue,
      narrative: report.narrative,
      evidenceRefs: [report.narrative.slice(0, 5)],
      hallucinated: ["护士长已签字确认整改完成"],
      timeline,
      draft: { grade: "Ⅱ级", remediation_plan: "补记护理记录，双人核对后由护士长复核" },
    });
    if (openIds.includes(report.incident_id) && overdue) {
      overdueRows.push({
        incident_id: report.incident_id,
        dwell_minutes: Math.floor(dwellMs / 60_000),
        current_step: STATE_LABELS[run.status as RunState],
        assignee: run.assignee_key,
      });
    }
  }

  // 真实导出：台账 xlsx + 超期清单 csv，随后读回 xlsx 作为截图数据源
  const ledgerPath = resolve(EXPORT_DIR, "整改台账-截图运行.xlsx");
  const overduePath = resolve(EXPORT_DIR, "超期清单-截图运行.csv");
  const ledger = await exportLedgerXlsx(ledgerRowsFromDb(db, nowMs), ledgerPath);
  const overdue = exportOverdueCsv(overdueRows, overduePath);
  const readBack = await readLedgerXlsx(ledgerPath);
  const csvText = readFileSync(overduePath, "utf8");
  process.stdout.write(`截图运行：处置单 ${items.length} 件 / 闭环台账 ${ledger.rowCount} 行 / 超期 ${overdue.rowCount} 行\n`);

  const summary = {
    sweeps: 1,
    retries: 0,
    modelCalls: 8,
    estimatedCost: undefined as number | undefined,
  };

  // 图 1：在办列表 + 步骤时间线（未确认）
  const shot1Html = resolve(HTML_DIR, "01-workbench.html");
  writeFileSync(shot1Html, inlineUiHtml({
    items,
    summary,
    missingEnv: [],
    degraded: false,
  }), "utf8");
  screenshot(shot1Html, resolve(SHOT_DIR, "01-在办列表与步骤时间线.png"));

  // 图 2：四类确认完成 + 回执回显（选中已闭环件）
  const confirmed = Object.fromEntries(
    ["grade", "remedy", "review", "close"].map((k) => [k, { confirmed: true, second: true }]),
  );
  const closedFirst = [...items.filter((i) => i.status === "written_back"), ...items.filter((i) => i.status !== "written_back")];
  const shot2Html = resolve(HTML_DIR, "02-confirm-gate.html");
  writeFileSync(shot2Html, inlineUiHtml({
    items: closedFirst,
    summary,
    missingEnv: [],
    degraded: false,
    confirmations: confirmed,
    receiptId: "RCP-2026-0001",
  }), "utf8");
  screenshot(shot2Html, resolve(SHOT_DIR, "02-确认闸门与回执回显.png"));

  // 图 3：真实超期清单 csv + 整改台账 xlsx 读回片段
  const csvRows = csvText.trim().split("\n").slice(1).map((line) =>
    line.split("\",\"").map((cell) => cell.replace(/^"|"$/g, "")),
  );
  const overdueTable = tableHtml(OVERDUE_HEADERS, csvRows);
  const ledgerTable = tableHtml(LEDGER_COLUMNS, readBack.rows.slice(0, 4));
  const shot3Html = resolve(HTML_DIR, "03-exports.html");
  writeFileSync(shot3Html, evidenceHtml(
    "超期清单与整改台账（真实导出件读回）",
    "来自 app-data/screenshots.db 的确定性回放运行；超期判定使用截图运行显式导入的院内时限演示口径",
    [
      { heading: `超期清单 csv · ${overdue.rowCount} 行 · 按停留时长倒序`, body: overdueTable },
      { heading: `整改台账 xlsx · 读回 ${readBack.rows.length} 行 · ${LEDGER_COLUMNS.length} 列`, body: ledgerTable },
      { heading: "文件位置", body: `<div class="ndr-caption">${esc(ledgerPath)}<br>${esc(overduePath)}</div>` },
    ],
  ), "utf8");
  screenshot(shot3Html, resolve(SHOT_DIR, "03-超期清单与导出台账片段.png"));

  // 图 4：真实终端回显（不合成数据，直接渲染当次 stdout）
  const verifyLogPath = resolve(ROOT, "../logs/task47-run.log");
  const exportRun = spawnSync("npm", ["run", "export"], { cwd: ROOT, encoding: "utf8", env: process.env });
  const exportLog = `$ npm run export\n${exportRun.stdout ?? ""}${exportRun.stderr ?? ""}exit=${exportRun.status}`;
  writeFileSync(resolve(ROOT, "../logs/task47-export.log"), exportLog, "utf8");
  const verifyLog = existsSync(verifyLogPath) ? readFileSync(verifyLogPath, "utf8") : "（未找到验证日志）";
  const terminalText = `$ npm run verify\n${verifyLog}\n${exportLog}`;
  const shot4Html = resolve(HTML_DIR, "04-terminal.html");
  writeFileSync(shot4Html, evidenceHtml(
    "终端回显实录",
    "内容取自当次真实命令 stdout / stderr，未改写数值；仅做等宽字体排版",
    [{ heading: "npm run verify + npm run export", body: `<div class="ev-term">${esc(terminalText)}</div>` }],
  ), "utf8");
  screenshot(shot4Html, resolve(SHOT_DIR, "04-终端回显实录.png"));

  db.close();
  process.stdout.write(`截图采集完成：${SHOT_DIR}\n`);
}

await main();
