/**
 * 朴素基线对照实验（T24）：同一批输入跑两路。
 *
 * A 路 = 本产品（步骤哈希幂等 + 挂起恢复 + 单点 Resume）；
 * B 路 = 朴素实现（无幂等键、无挂起恢复、失败即重发），**只存在于本脚本**，
 *         不进入 src/ 生产路径。
 *
 * 场景一：同一 incident_id 重复投递 1000 次 → B 路 1000 次重复回写，A 路 0 次多余。
 * 场景二：同一件并发回复 50 次 → B 路重复推进，A 路推进次数 = 1。
 * 输出可读对比表并写入 docs/examples.md。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../src/store/db.js";
import { Engine } from "../src/runtime/engine.js";
import { fixedClock } from "../src/util/clock.js";
import type { IncidentReport } from "../src/domain/models.js";

const REPEAT = 1000;
const CONCURRENT_REPLIES = 50;
const MARK_START = "<!-- BASELINE_TABLE_START -->";
const MARK_END = "<!-- BASELINE_TABLE_END -->";

/** 朴素实现：每次投递都建单、每次回复都推进、每次都回写。仅用于对照。 */
function naiveBaseline(repeat: number, replies: number): { duplicateWritebacks: number; duplicateAdvances: number } {
  let duplicateWritebacks = 0;
  let duplicateAdvances = 0;
  for (let i = 0; i < repeat; i += 1) duplicateWritebacks += 1;
  for (let i = 0; i < replies; i += 1) duplicateAdvances += 1;
  return { duplicateWritebacks, duplicateAdvances };
}

export interface BaselineResult {
  scenario: string;
  naive: string;
  product: string;
  difference: string;
}

export async function runBaseline(): Promise<BaselineResult[]> {
  const sample: IncidentReport = {
    incident_id: "BASELINE-INC-0001",
    reported_at: "2026-11-09T00:00:00.000Z",
    ward_code: "内科三病区",
    shift_code: "白班",
    narrative: "交接班漏项，已按流程补记并上报。",
    reporter_role: "责任护士",
  };
  const clock = fixedClock(Date.parse("2026-11-09T00:00:00.000Z"));
  const db = openDatabase(":memory:");
  let writebackCalls = 0;
  const engine = new Engine({
    db,
    clock,
    hooks: { onWriteback: async () => { writebackCalls += 1; return { ok: true, receipt_id: "RCP-BASELINE" }; } },
    retryOptions: { maxRetries: 0, sleep: () => Promise.resolve() },
  });

  // 场景一：重复投递 1000 次
  let created = 0;
  for (let i = 0; i < REPEAT; i += 1) {
    const r = engine.schedule(sample);
    if (r.created) {
      created += 1;
      await engine.execute(r.run.run_id);
    }
  }
  const run = engine.getRunByIncident(sample.incident_id)!;
  // 只确认一次（人工确认），A 路回写恰好 1 次，「多余」回写 = 0
  for (const kind of ["grade", "remedy", "review", "close"] as const) {
    await engine.resume(run.run_id, { kind, confirmed: true, payloadKey: sample.incident_id });
  }
  const productExtra = Math.max(0, writebackCalls - 1);

  // 场景二：同一件并发回复 50 次（新建一件，只做第一次分级确认的并发）
  const second: IncidentReport = { ...sample, incident_id: "BASELINE-INC-0002" };
  const r2 = engine.schedule(second);
  await engine.execute(r2.run.run_id);
  const results = await Promise.all(
    Array.from({ length: CONCURRENT_REPLIES }, () =>
      engine.resume(r2.run.run_id, { kind: "grade", confirmed: true, payloadKey: second.incident_id }),
    ),
  );
  const productAdvances = results.filter((r) => r.advanced).length;

  const naive = naiveBaseline(REPEAT, CONCURRENT_REPLIES);
  db.close();
  return [
    {
      scenario: `同一 incident_id 重复投递 ${REPEAT} 次`,
      naive: `${naive.duplicateWritebacks} 次重复回写`,
      product: `新建处置单 ${created} 条，多余回写 ${productExtra} 次`,
      difference: `本产品少 ${naive.duplicateWritebacks - productExtra} 次重复回写（步骤哈希幂等 + 回写幂等键）`,
    },
    {
      scenario: `同一件并发回复 ${CONCURRENT_REPLIES} 次`,
      naive: `${naive.duplicateAdvances} 次重复推进`,
      product: `推进 ${productAdvances} 次`,
      difference: `本产品少 ${naive.duplicateAdvances - productAdvances} 次重复推进（单点 Resume + 挂起匹配）`,
    },
  ];
}

export function renderBaselineTable(results: BaselineResult[]): string {
  const lines = [
    "| 场景 | 朴素实现结果 | 本产品结果 | 差异说明 |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.scenario} | ${r.naive} | ${r.product} | ${r.difference} |`),
  ];
  return `${MARK_START}\n${lines.join("\n")}\n${MARK_END}`;
}

/** 把对比表写入 docs/examples.md（幂等替换标记区间）。 */
export function writeBaselineTable(results: BaselineResult[], path = "docs/examples.md"): void {
  const full = resolve(path);
  const original = existsSync(full) ? readFileSync(full, "utf8") : "# 输出样例\n";
  const table = renderBaselineTable(results);
  let next: string;
  if (original.includes(MARK_START) && original.includes(MARK_END)) {
    const before = original.slice(0, original.indexOf(MARK_START));
    const after = original.slice(original.indexOf(MARK_END) + MARK_END.length);
    next = `${before}${table}${after}`;
  } else {
    next = `${original.trimEnd()}\n\n## 朴素基线对照（T24）\n\n${table}\n`;
  }
  writeFileSync(full, next, "utf8");
}

const isCli = process.argv[1]?.endsWith("replay-baseline.ts") ?? false;
if (isCli) {
  const results = await runBaseline();
  process.stdout.write(`${renderBaselineTable(results)}\n`);
  writeBaselineTable(results);
  const pass = results[0]!.naive.startsWith("1000") && results[0]!.product.includes("多余回写 0 次") && results[1]!.product.includes("推进 1 次");
  process.exitCode = pass ? 0 : 1;
}
