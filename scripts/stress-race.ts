/**
 * 并发与竞态压测（T26）：三项指标全为 0。
 *
 * 场景：并发 resume 同一件 1000 次 / 50 件并发回复 / resume 与 drain 交错 100 轮。
 * 指标：重复推进次数、重复回写次数、状态倒退次数。
 * 临时 SQLite 库，不污染 app-data/；结果稳定可重复。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, all } from "../src/store/db.js";
import { Engine } from "../src/runtime/engine.js";
import { fixedClock, HOUR_MS } from "../src/util/clock.js";
import { transition } from "../src/runtime/state-machine.js";
import { drain, resumeAfterDrain } from "../src/runtime/drain.js";
import type { IncidentReport, RunState } from "../src/domain/models.js";

const CONCURRENT_RESUMES = 1000;
const PARALLEL_RUNS = 50;
const DRAIN_ROUNDS = 100;
const MARK_START = "<!-- STRESS_TABLE_START -->";
const MARK_END = "<!-- STRESS_TABLE_END -->";

function sample(i: number): IncidentReport {
  return {
    incident_id: `STRESS-INC-${String(i).padStart(5, "0")}`,
    reported_at: new Date(Date.parse("2026-11-09T00:00:00.000Z") + i * 1000).toISOString(),
    ward_code: "内科三病区",
    shift_code: "白班",
    narrative: "交接班漏项，已按流程补记并上报。",
    reporter_role: "责任护士",
  };
}

export interface StressMetrics {
  duplicate_advances: number;
  duplicate_writebacks: number;
  state_regressions: number;
  parallel_runs_advanced: number;
  resume_drain_conflicts: number;
}

export async function runStress(): Promise<StressMetrics> {
  const clock = fixedClock(Date.parse("2026-11-09T00:00:00.000Z"));
  const db = openDatabase(":memory:");
  let writebackCalls = 0;
  const engine = new Engine({
    db,
    clock,
    hooks: { onWriteback: async () => { writebackCalls += 1; return { ok: true, receipt_id: "RCP-STRESS" }; } },
    retryOptions: { maxRetries: 0, sleep: () => Promise.resolve() },
  });

  // 场景 1：同一件并发 resume 1000 次
  const first = engine.schedule(sample(0));
  await engine.execute(first.run.run_id);
  const replies = await Promise.all(
    Array.from({ length: CONCURRENT_RESUMES }, () =>
      engine.resume(first.run.run_id, { kind: "grade", confirmed: true, payloadKey: sample(0).incident_id }),
    ),
  );
  const advancedCount = replies.filter((r) => r.advanced).length;
  const duplicateAdvances = Math.max(0, advancedCount - 1);

  // 场景 2：50 件并发回复（每件一次，全部应被推进且无一件推进两次）
  const runs: string[] = [];
  for (let i = 1; i <= PARALLEL_RUNS; i += 1) {
    const r = engine.schedule(sample(i));
    await engine.execute(r.run.run_id);
    runs.push(r.run.run_id);
  }
  const parallelResults = await Promise.all(
    runs.map((runId, index) =>
      engine.resume(runId, { kind: "grade", confirmed: true, payloadKey: sample(index + 1).incident_id }),
    ),
  );
  const parallelAdvanced = parallelResults.filter((r) => r.advanced).length;

  // 场景 3：resume 与 drain 交错 100 轮
  let conflicts = 0;
  for (let round = 0; round < DRAIN_ROUNDS; round += 1) {
    const target = runs[round % runs.length]!;
    const drainPromise = drain({ db, engine, clock, forceTimeout: false, waitForIdle: async () => true });
    const resumePromise = engine.resume(target, {
      kind: "remedy",
      confirmed: true,
      payloadKey: sample((round % runs.length) + 1).incident_id,
    });
    const [, resumed] = await Promise.all([drainPromise, resumePromise]);
    if (resumed.advanced) conflicts += 1;
    resumeAfterDrain(engine, db, clock);
  }

  // 重复回写：同一件再次走完确认链，幂等应阻止第二次回写
  const before = writebackCalls;
  for (const kind of ["remedy", "review", "close"] as const) {
    await engine.resume(first.run.run_id, { kind, confirmed: true, payloadKey: sample(0).incident_id });
  }
  await engine.resume(first.run.run_id, { kind: "close", confirmed: true, payloadKey: sample(0).incident_id });
  const duplicateWritebacks = Math.max(0, writebackCalls - before - 1);

  // 状态倒退：逐条审计里的 from→to 必须都是状态机允许的转换
  const transitions = all<{ from_state: string | null; to_state: string | null }>(
    db,
    "SELECT from_state, to_state FROM audit WHERE kind = 'transition'",
  );
  let regressions = 0;
  for (const row of transitions) {
    if (!row.from_state || !row.to_state) continue;
    if (!transition(row.from_state as RunState, row.to_state as RunState).ok) regressions += 1;
  }
  db.close();
  return {
    duplicate_advances: duplicateAdvances,
    duplicate_writebacks: duplicateWritebacks,
    state_regressions: regressions,
    parallel_runs_advanced: parallelAdvanced,
    resume_drain_conflicts: conflicts,
  };
}

export function renderStressTable(m: StressMetrics): string {
  const lines = [
    "| 指标 | 实测值 | 期望值 |",
    "|---|---|---|",
    `| 重复推进次数 | ${m.duplicate_advances} | 0 |`,
    `| 重复回写次数 | ${m.duplicate_writebacks} | 0 |`,
    `| 状态倒退次数 | ${m.state_regressions} | 0 |`,
    `| 50 件并发回复全部被推进 | ${m.parallel_runs_advanced}/${PARALLEL_RUNS} | ${PARALLEL_RUNS} |`,
    `| drain 期间被误推进次数 | ${m.resume_drain_conflicts} | 0 |`,
  ];
  return `${MARK_START}\n${lines.join("\n")}\n${MARK_END}`;
}

export function writeStressTable(m: StressMetrics, path = "docs/examples.md"): void {
  const full = resolve(path);
  const original = existsSync(full) ? readFileSync(full, "utf8") : "# 输出样例\n";
  const table = renderStressTable(m);
  let next: string;
  if (original.includes(MARK_START) && original.includes(MARK_END)) {
    next = `${original.slice(0, original.indexOf(MARK_START))}${table}${original.slice(original.indexOf(MARK_END) + MARK_END.length)}`;
  } else {
    next = `${original.trimEnd()}\n\n## 并发与竞态压测（T26）\n\n${table}\n`;
  }
  writeFileSync(full, next, "utf8");
}

const isCli = process.argv[1]?.endsWith("stress-race.ts") ?? false;
if (isCli) {
  const metrics = await runStress();
  process.stdout.write(`${renderStressTable(metrics)}\n`);
  writeStressTable(metrics);
  const pass =
    metrics.duplicate_advances === 0 &&
    metrics.duplicate_writebacks === 0 &&
    metrics.state_regressions === 0 &&
    metrics.parallel_runs_advanced === PARALLEL_RUNS &&
    metrics.resume_drain_conflicts === 0;
  process.stdout.write(`结论：${pass ? "三项指标全为 0，压测通过" : "压测未通过"}\n`);
  process.exitCode = pass ? 0 : 1;
}
