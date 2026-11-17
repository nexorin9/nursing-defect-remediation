/**
 * 处置编排引擎（T2 最小切片 → T11 命名步骤引擎，同一处深化，不另起实现）。
 *
 * 主路径：schedule 建 run → execute 执行命名步骤直到挂起点 →
 * resume（唯一推进入口）按事件匹配解除挂起并推进 → 人工确认销号后回写拿回执。
 *
 * 可靠性约束：
 * - 状态写入口只在 state-machine.applyTransition；业务代码不直接改 status；
 * - 步骤副作用受步骤哈希幂等保护（T12），重复 execute / 重复 resume 不再执行；
 * - 所有推进串行经同一把互斥锁，drain 与 resume 互斥（T18 / T22）；
 * - 失败（含模型降级）停在当前步，不推进、不回写、不销号，审计如实留痕。
 */
import { utc, systemClock, type Clock } from "../util/clock.js";
import { digest, sha256 } from "../util/hash.js";
import { all, get, run as sqlRun, type Database } from "../store/db.js";
import { appendAudit } from "../store/audit.js";
import { redactIncident, redactText } from "../domain/redact.js";
import { createPolicy, type QcPolicy } from "../domain/policy.js";
import type { ConfirmKind, IncidentReport, ModelDraft, Run, RunState, StepRecord } from "../domain/models.js";
import { applyTransition } from "./state-machine.js";
import { STEP_DEFS, stepDefAt, stepIndex, type StepDef } from "./steps.js";
import { stepHash, stepInputDigest, findCompletedStepByHash } from "./idempotency.js";
import { withRetry, makeError, immediateSleep, type RetryOptions } from "./errors.js";
import { createPause, findActivePause, findMatchingPause, resolvePause, type CreatePauseArgs } from "./pause.js";
import { KeyedGate } from "./concurrency.js";
import { AsyncMutex } from "./mutex.js";

export type ResumeKind = ConfirmKind | "manual" | "retry" | "sweep";

export interface ResumeSignal {
  kind: ResumeKind;
  /** 人工确认是推进的唯一依据；未确认一律不推进 */
  confirmed: boolean;
  operator?: string;
  /** 事件载荷键，默认 incident_id */
  payloadKey?: string;
  draft?: ModelDraft;
  note?: string;
}

export interface StepContext {
  run: Run;
  def: StepDef;
  idx: number;
  signal?: ResumeSignal;
  stepHash: string;
}

export interface StepOutcome {
  ok: boolean;
  output?: unknown;
  reason?: string;
  /** 规则 / 模型不可用：不重试、不推进、不新增步骤行 */
  degraded?: boolean;
  /** 可重试的业务失败（5xx / 超时） */
  retryable?: boolean;
  status?: number;
  callId?: string;
  reused?: boolean;
}

export interface ExecuteResult {
  executed: number;
  status: RunState | undefined;
  stepsCount: number;
  reason?: string;
}

export interface EngineHooks {
  /** 命名步骤的真实业务副作用（模型要素抽取 / 规则闸门 / 回写前校验等） */
  onStep?: (ctx: StepContext) => Promise<StepOutcome> | StepOutcome;
  /** 销号确认后的质控回写；返回回执号 */
  onWriteback?: (ctx: StepContext, signal: ResumeSignal) => Promise<{ ok: boolean; receipt_id?: string; reason?: string }>;
}

export interface EngineDeps {
  db: Database;
  clock?: Clock;
  policy?: QcPolicy;
  hooks?: EngineHooks;
  retryOptions?: Partial<RetryOptions>;
  gate?: KeyedGate;
  mutex?: AsyncMutex;
}

function mapRun(row: Record<string, unknown>): Run {
  return {
    run_id: String(row.run_id),
    incident_id: String(row.incident_id),
    status: String(row.status) as RunState,
    revision: Number(row.revision),
    ward_code: String(row.ward_code),
    shift_code: String(row.shift_code),
    narrative_redacted: String(row.narrative_redacted),
    assignee_key: String(row.assignee_key),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    ...(row.closed_at ? { closed_at: String(row.closed_at) } : {}),
    ...(row.receipt_id ? { receipt_id: String(row.receipt_id) } : {}),
    degraded: Number(row.degraded ?? 0),
    ...(row.last_error ? { last_error: String(row.last_error) } : {}),
  };
}

export class Engine {
  readonly db: Database;
  readonly clock: Clock;
  readonly policy: QcPolicy;
  readonly hooks: EngineHooks;
  readonly mutex: AsyncMutex;
  readonly retryOptions: RetryOptions;
  private readonly gate?: KeyedGate;
  private _draining = false;

  constructor(deps: EngineDeps) {
    this.db = deps.db;
    this.clock = deps.clock ?? systemClock;
    this.policy = deps.policy ?? createPolicy();
    this.hooks = deps.hooks ?? {};
    this.mutex = deps.mutex ?? new AsyncMutex();
    this.gate = deps.gate;
    this.retryOptions = {
      maxRetries: 3,
      sleep: immediateSleep,
      baseMs: 100,
      clock: this.clock,
      onRetry: (_attempt, _error) => {
        // 重试次数进审计，供窗口底部运行摘要读取
        appendAudit(this.db, { runId: "runtime", operator: "engine", kind: "retry" }, this.clock);
      },
      ...deps.retryOptions,
    };
  }

  get draining(): boolean {
    return this._draining;
  }

  /** 仅供 drain 模块调用：关停期间不接受新的回复驱动推进。 */
  setDraining(value: boolean): void {
    this._draining = value;
  }

  /** 一件上报 = 一条 run；incident_id 唯一，重复投递不产生第二条处置单。 */
  schedule(incident: IncidentReport): { run: Run; created: boolean } {
    const existing = this.getRunByIncident(incident.incident_id);
    if (existing) return { run: existing, created: false };
    const at = utc(this.clock.now());
    const runId = `run_${sha256(`run:${incident.incident_id}`).slice(0, 16)}`;
    const redacted = redactIncident(incident);
    const result = sqlRun(
      this.db,
      `INSERT OR IGNORE INTO runs
         (run_id, incident_id, status, revision, ward_code, shift_code, narrative_redacted,
          assignee_key, step_cursor, created_at, updated_at)
       VALUES (?, ?, 'new', 1, ?, ?, ?, ?, 0, ?, ?)`,
      runId,
      incident.incident_id,
      redacted.ward_code,
      redacted.shift_code,
      redactText(incident.narrative),
      `nurse:${redacted.ward_code}:${redacted.shift_code}`,
      at,
      at,
    );
    const created = result.changes === 1;
    if (created) {
      // 步骤行由 runStep 统一写入（含 queued/started/ended 三时刻），此处不预插入占位行
      if (this.gate) {
        const slot = this.gate.acquire(`nurse:${redacted.ward_code}:${redacted.shift_code}`, runId);
        if (!slot.acquired) {
          appendAudit(
            this.db,
            { runId, operator: "engine", kind: "queued", detail: { position: slot.position, limit: slot.limit } },
            this.clock,
          );
        }
      }
    }
    return { run: this.getRun(runId)!, created };
  }

  getRun(runId: string): Run | undefined {
    const row = get<Record<string, unknown>>(this.db, "SELECT * FROM runs WHERE run_id = ?", runId);
    return row ? mapRun(row) : undefined;
  }

  getRunByIncident(incidentId: string): Run | undefined {
    const row = get<Record<string, unknown>>(this.db, "SELECT * FROM runs WHERE incident_id = ?", incidentId);
    return row ? mapRun(row) : undefined;
  }

  listRuns(filter?: { status?: RunState; since?: string }): Run[] {
    if (filter?.status) {
      return all<Record<string, unknown>>(
        this.db,
        "SELECT * FROM runs WHERE status = ? ORDER BY created_at ASC",
        filter.status,
      ).map(mapRun);
    }
    if (filter?.since) {
      return all<Record<string, unknown>>(
        this.db,
        "SELECT * FROM runs WHERE created_at >= ? ORDER BY created_at ASC",
        filter.since,
      ).map(mapRun);
    }
    return all<Record<string, unknown>>(this.db, "SELECT * FROM runs ORDER BY created_at ASC").map(mapRun);
  }

  countRuns(): number {
    return get<{ c: number }>(this.db, "SELECT COUNT(*) AS c FROM runs")?.c ?? 0;
  }

  countSteps(runId?: string): number {
    return runId
      ? get<{ c: number }>(this.db, "SELECT COUNT(*) AS c FROM steps WHERE run_id = ?", runId)?.c ?? 0
      : get<{ c: number }>(this.db, "SELECT COUNT(*) AS c FROM steps")?.c ?? 0;
  }

  /** 执行到下一个挂起点（人工确认）。重复调用不会重复执行副作用。 */
  async execute(runId: string): Promise<ExecuteResult> {
    let executed = 0;
    for (let guard = 0; guard < STEP_DEFS.length + 2; guard += 1) {
      const current = this.getRun(runId);
      if (!current) break;
      const def = stepDefAt(current.status);
      if (!def) break;
      if (def.requiresConfirmation) {
        this.ensurePause(current, def);
        break;
      }
      if (this.gate && !this.gate.active(current.assignee_key).includes(runId)) {
        return { executed, status: current.status, stepsCount: this.countSteps(runId), reason: "等待并发闸门槽位" };
      }
      const outcome = await this.runStep(runId, def);
      if (!outcome.ok) {
        return { executed, status: this.getRun(runId)?.status, stepsCount: this.countSteps(runId), reason: outcome.reason };
      }
      if (!outcome.reused) executed += 1;
      const advance = applyTransition(this.db, {
        runId,
        from: def.from,
        to: def.to,
        operator: "system",
        reason: `${def.name} 完成`,
        clock: this.clock,
      });
      if (!advance.ok) break;
    }
    return { executed, status: this.getRun(runId)?.status, stepsCount: this.countSteps(runId) };
  }

  /**
   * 唯一推进入口（T14）：挂起恢复 / 手动推进 / 重试续跑 / 巡检触发都经它。
   * 返回结构化结果，调用方据此决定是否提示。
   */
  async resume(runId: string, signal: ResumeSignal): Promise<{ advanced: boolean; reason: string }> {
    return this.mutex.runExclusive(async () => {
      if (this._draining) {
        return { advanced: false, reason: "应用正在关停排空，暂不接受新的回复驱动推进" };
      }
      const current = this.getRun(runId);
      if (!current) return { advanced: false, reason: "处置单不存在" };
      if (current.status === "written_back") {
        appendAudit(
          this.db,
          { runId, operator: signal.operator ?? "nurse_manager", kind: "late_reply", detail: { signal: signal.kind } },
          this.clock,
        );
        return { advanced: false, reason: "处置单已闭环，回复记为迟到，不改变已生效状态" };
      }
      // 巡检 / 手动 / 重试只触发步骤续跑，不代替人工确认推进
      if (signal.kind === "manual" || signal.kind === "retry" || signal.kind === "sweep") {
        const result = await this.execute(runId);
        return { advanced: result.executed > 0, reason: result.executed > 0 ? `续跑 ${result.executed} 步` : "无可续跑步骤" };
      }
      if (!signal.confirmed) {
        return { advanced: false, reason: "未人工确认，不推进状态、不发回写请求" };
      }
      const def = stepDefAt(current.status);
      const waitEvent = `confirm.${signal.kind}`;
      if (!def || def.waitEvent !== waitEvent) {
        return { advanced: false, reason: `信号 ${signal.kind} 与当前步骤 ${current.status} 不匹配，不推进` };
      }
      const pause = findMatchingPause(this.db, waitEvent, signal.payloadKey ?? current.incident_id);
      if (!pause) {
        return { advanced: false, reason: "无匹配的挂起项（已恢复或事件载荷不匹配），不重复推进" };
      }
      resolvePause(this.db, pause.pause_id, this.clock, signal.operator);
      const outcome = await this.runStep(runId, def, signal);
      if (!outcome.ok) {
        this.ensurePause(this.getRun(runId)!, def);
        return { advanced: false, reason: outcome.reason ?? "步骤失败，停在当前步" };
      }
      if (def.kind === "writeback" && this.hooks.onWriteback) {
        const ctx = this.buildContext(this.getRun(runId)!, def, signal);
        const written = await this.hooks.onWriteback(ctx, signal);
        if (!written.ok) {
          this.ensurePause(this.getRun(runId)!, def);
          return { advanced: false, reason: written.reason ?? "回写失败，停在当前步" };
        }
        if (written.receipt_id) {
          const at = utc(this.clock.now());
          sqlRun(this.db, "UPDATE runs SET receipt_id = ?, updated_at = ? WHERE run_id = ?", written.receipt_id, at, runId);
        }
      }
      const advance = applyTransition(this.db, {
        runId,
        from: def.from,
        to: def.to,
        operator: signal.operator ?? "nurse_manager",
        reason: `人工确认 ${def.name}`,
        clock: this.clock,
      });
      if (!advance.ok) return { advanced: false, reason: advance.reason };
      await this.execute(runId);
      return { advanced: true, reason: `已推进：${def.from} → ${def.to}` };
    });
  }

  /** 执行单个命名步骤；步骤哈希命中即复用结果，不重复执行副作用。 */
  async runStep(runId: string, def: StepDef, signal?: ResumeSignal): Promise<StepOutcome> {
    const run = this.getRun(runId);
    if (!run) return { ok: false, reason: "处置单不存在" };
    const idx = stepIndex(def.id);
    const input = stepInputDigest({
      incident_id: run.incident_id,
      step_id: def.id,
      revision: run.revision,
      signal: signal ? { kind: signal.kind, confirmed: signal.confirmed, note: signal.note ?? "" } : null,
    });
    const hash = stepHash(runId, def.id, idx, input);
    const completed = findCompletedStepByHash(this.db, hash);
    if (completed) {
      return { ok: true, reused: true, output: { reused: true, step_id: completed.step_id } };
    }
    const stepId = `${runId}:${def.id}:${idx}:${hash.slice(-8)}`;
    const at = utc(this.clock.now());
    sqlRun(
      this.db,
      `INSERT OR IGNORE INTO steps
         (step_id, run_id, idx, status, queued_at, operator, retry_count, input_hash, step_hash, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, 'system', 0, ?, ?, ?, ?)`,
      stepId,
      runId,
      idx,
      at,
      input,
      hash,
      at,
      at,
    );
    sqlRun(this.db, "UPDATE steps SET status = 'running', started_at = ?, updated_at = ? WHERE step_id = ?", at, at, stepId);

    const ctx = this.buildContext(run, def, signal);
    let retryCount = 0;
    let result: { ok: boolean; value?: StepOutcome; error?: { message: string } };
    if (this.hooks.onStep) {
      const retried = await withRetry<StepOutcome>(
        async () => {
          const outcome = await this.hooks.onStep!(ctx);
          if (outcome.ok) return outcome;
          if (outcome.degraded) return outcome;
          throw makeError(outcome.reason ?? "步骤失败", {
            status: outcome.status,
            klass: outcome.retryable ? undefined : "permanent",
          });
        },
        this.retryOptions,
      );
      retryCount = retried.retryCount;
      result = retried.ok
        ? { ok: true, value: retried.value }
        : { ok: false, error: { message: retried.error?.message ?? "未知错误" } };
    } else {
      result = { ok: true, value: { ok: true, output: { placeholder: def.name } } };
    }

    const value = result.value;
    if (result.ok && value?.degraded) {
      // 模型不可达：不推进、不回写、不销号，也不留下一条虚假的「已执行」步骤
      sqlRun(this.db, "DELETE FROM steps WHERE step_id = ?", stepId);
      appendAudit(
        this.db,
        {
          runId,
          operator: signal?.operator ?? "system",
          kind: "model_degraded",
          detail: { call_id: value.callId ?? "unknown", reason: value.reason ?? "模型不可达", step: def.name },
        },
        this.clock,
      );
      return { ok: false, degraded: true, reason: value.reason ?? "模型不可达，已用规则初判，待人工确认" };
    }
    if (!result.ok || !value?.ok) {
      const reason = value?.reason ?? result.error?.message ?? "步骤失败";
      sqlRun(
        this.db,
        "UPDATE steps SET status = 'failed', ended_at = ?, retry_count = ?, last_error = ?, updated_at = ? WHERE step_id = ?",
        utc(this.clock.now()),
        retryCount,
        reason,
        utc(this.clock.now()),
        stepId,
      );
      sqlRun(this.db, "UPDATE runs SET last_error = ?, updated_at = ? WHERE run_id = ?", reason, utc(this.clock.now()), runId);
      appendAudit(
        this.db,
        {
          runId,
          operator: signal?.operator ?? "system",
          kind: retryCount > 0 ? "retry_exhausted" : "step_failed",
          detail: { step: def.name, reason, retry_count: retryCount },
        },
        this.clock,
      );
      return { ok: false, reason };
    }

    const endedAt = utc(this.clock.now());
    const outputHash = digest(value.output ?? {});
    sqlRun(
      this.db,
      "UPDATE steps SET status = 'done', ended_at = ?, output_hash = ?, retry_count = ?, updated_at = ? WHERE step_id = ?",
      endedAt,
      outputHash,
      retryCount,
      endedAt,
      stepId,
    );
    appendAudit(
      this.db,
      {
        runId,
        operator: signal?.operator ?? "system",
        kind: "step",
        inputHash: input,
        outputHash,
        fromState: def.from,
        toState: def.to,
        detail: { step_id: def.id, step_name: def.name, step_hash: hash, retry_count: retryCount },
      },
      this.clock,
    );
    return { ok: true, output: value.output ?? {}, reason: value.reason };
  }

  private buildContext(run: Run, def: StepDef, signal?: ResumeSignal): StepContext {
    const input = stepInputDigest({
      incident_id: run.incident_id,
      step_id: def.id,
      revision: run.revision,
      signal: signal ? { kind: signal.kind, confirmed: signal.confirmed, note: signal.note ?? "" } : null,
    });
    return {
      run,
      def,
      idx: stepIndex(def.id),
      ...(signal ? { signal } : {}),
      stepHash: stepHash(run.run_id, def.id, stepIndex(def.id), input),
    };
  }

  private ensurePause(current: Run, def: StepDef): void {
    const waitEvent = def.waitEvent ?? `confirm.${def.id}`;
    if (findActivePause(this.db, current.run_id, waitEvent)) return;
    const args: CreatePauseArgs = {
      runId: current.run_id,
      waitEvent,
      payloadKey: current.incident_id,
      timeoutPolicy: this.policy.pauseTimeoutPolicy.value,
      clock: this.clock,
    };
    createPause(this.db, args);
  }

  /** 步骤记录（时间线视图与时间线纯函数的数据源）。 */
  stepRecords(runId: string): StepRecord[] {
    return all<StepRecord>(this.db, "SELECT * FROM steps WHERE run_id = ? ORDER BY idx ASC, queued_at ASC", runId);
  }
}
