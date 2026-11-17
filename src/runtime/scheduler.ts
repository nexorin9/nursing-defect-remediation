/**
 * runtime 调度器（T19）：可注入时钟 + 60 秒轮询 + 手动立即巡检。
 *
 * 三者共用同一个 Scheduler 实例，避免多定时器叠加；
 * scheduler 只负责「到点调用 engine」，不直接改状态。
 * 轮询按 reported_at 水位只拉增量，重复轮询不产生重复处置单；
 * 接口失败按 T13 错误分类处理并写运行日志，不静默失败。
 */
import { utc, systemClock, type Clock } from "../util/clock.js";
import { appendAudit } from "../store/audit.js";
import { classifyError } from "./errors.js";
import { runDailySweep, type SweepResult } from "./sweep.js";
import { createPolicy, sweepMinuteOfDay, type QcPolicy } from "../domain/policy.js";
import type { IncidentReport } from "../domain/models.js";
import type { Engine } from "./engine.js";
import type { Database } from "../store/db.js";

export interface PollSource {
  /** 拉取 status=new 且 reported_at 大于水位的上报；替身只在 tests/ 层 */
  listNew(since?: string): Promise<IncidentReport[]>;
}

export interface SchedulerOptions {
  engine: Engine;
  db: Database;
  source: PollSource;
  clock?: Clock;
  policy?: QcPolicy;
  pollIntervalSec?: number;
}

export interface PollResult {
  received: number;
  created: number;
  watermark?: string;
  error?: string;
}

export class Scheduler {
  readonly clock: Clock;
  readonly policy: QcPolicy;
  readonly pollIntervalSec: number;
  readonly logs: string[] = [];
  pollCount = 0;
  sweepCount = 0;
  private watermark?: string;
  private lastPollAt?: number;
  private lastSweepDay?: string;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: SchedulerOptions) {
    this.clock = options.clock ?? systemClock;
    this.policy = options.policy ?? createPolicy();
    this.pollIntervalSec = options.pollIntervalSec ?? 60;
  }

  private log(line: string): void {
    this.logs.push(`${utc(this.clock.now())} ${line}`);
  }

  /** 注入时钟后可确定性推进：到 60 秒触发轮询，跨过 08:00 且当日未巡检则触发巡检。 */
  async tick(nowMs: number = this.clock.now()): Promise<{ polled: boolean; swept: boolean }> {
    let polled = false;
    let swept = false;
    if (this.lastPollAt === undefined || nowMs - this.lastPollAt >= this.pollIntervalSec * 1000) {
      this.lastPollAt = nowMs;
      await this.poll();
      polled = true;
    }
    const minute = new Date(nowMs).getUTCHours() * 60 + new Date(nowMs).getUTCMinutes();
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (minute >= sweepMinuteOfDay(this.policy.dailySweepAt.value) && this.lastSweepDay !== day) {
      this.lastSweepDay = day;
      this.sweepNow(nowMs);
      swept = true;
    }
    return { polled, swept };
  }

  /** 拉增量 → 建处置单 → 执行到挂起点。失败记日志与审计，不推进状态。 */
  async poll(): Promise<PollResult> {
    this.pollCount += 1;
    try {
      const reports = await this.options.source.listNew(this.watermark);
      let created = 0;
      for (const report of reports) {
        const scheduled = this.options.engine.schedule(report);
        if (scheduled.created) {
          created += 1;
          await this.options.engine.execute(scheduled.run.run_id);
        }
        if (!this.watermark || report.reported_at > this.watermark) this.watermark = report.reported_at;
      }
      this.log(`轮询 #${this.pollCount}：收到 ${reports.length} 条，新建处置单 ${created} 条`);
      return { received: reports.length, created, watermark: this.watermark };
    } catch (error) {
      const classified = classifyError(error);
      const message = `轮询失败（${classified.klass}）：${classified.message}`;
      this.log(message);
      appendAudit(
        this.options.db,
        { runId: "scheduler", operator: "scheduler", kind: "poll_error", detail: { message, klass: classified.klass } },
        this.clock,
      );
      return { received: 0, created: 0, watermark: this.watermark, error: message };
    }
  }

  /** 手动「立即巡检」：与每日 08:00 走同一份 sweep 逻辑。 */
  sweepNow(nowMs: number = this.clock.now()): SweepResult {
    this.sweepCount += 1;
    const result = runDailySweep({
      db: this.options.db,
      policy: this.policy,
      nowMs,
      clock: this.clock,
    });
    this.log(`巡检 #${this.sweepCount}：扫描 ${result.scanned} 件，催办入队 ${result.items.length} 件，未设定时限 ${result.unconfigured_due_count} 件`);
    return result;
  }

  get currentWatermark(): string | undefined {
    return this.watermark;
  }

  /** Electron 主进程用真实定时器；无头测试只调 tick。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
