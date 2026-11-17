/**
 * 7 态生命周期状态机（T10）。
 *
 * 所有状态写入口收敛在本文件：业务代码不直接改 run.status，
 * 一律经 transition() 校验、applyTransition() 落库并留审计。
 * 非法转换拒绝并返回可读 reason，且不改写当前状态。
 */
import { utc, type Clock } from "../util/clock.js";
import { appendAudit } from "../store/audit.js";
import { get, run, transaction, type Database } from "../store/db.js";
import { RUN_STATES, type RunState } from "../domain/models.js";

/** 合法转换表。撤回不属于正向转换，单独走 rollbackOf / applyRollback。 */
export const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  new: ["extracting"],
  extracting: ["awaiting_grade"],
  awaiting_grade: ["remedying", "extracting"],
  remedying: ["awaiting_review", "awaiting_grade"],
  awaiting_review: ["closed", "remedying"],
  closed: ["written_back", "awaiting_review"],
  written_back: [],
};

/** 允许回退一级的映射（awaiting_review 之前）。 */
export const ROLLBACK_MAP: Partial<Record<RunState, RunState>> = {
  extracting: "new",
  awaiting_grade: "extracting",
  remedying: "awaiting_grade",
  awaiting_review: "remedying",
};

export interface TransitionContext {
  operator?: string;
  reason?: string;
}

export interface TransitionResult {
  ok: boolean;
  reason: string;
  from: RunState;
  to: RunState;
}

export function isRunState(value: string): value is RunState {
  return (RUN_STATES as readonly string[]).includes(value);
}

/** 纯校验：不写库、不改状态。 */
export function transition(current: RunState, next: RunState, ctx: TransitionContext = {}): TransitionResult {
  if (!TRANSITIONS[current].includes(next)) {
    return {
      ok: false,
      reason: `${current} → ${next} 不允许：${ctx.reason ?? "不在合法转换表内"}（已闭环件不可回退）`,
      from: current,
      to: next,
    };
  }
  return { ok: true, reason: ctx.reason ?? "允许", from: current, to: next };
}

export function rollbackOf(current: RunState): RunState | undefined {
  return ROLLBACK_MAP[current];
}

/** 唯一的落库推进入口：校验 → 写状态 → 追加审计（失败不静默改数据）。 */
export function applyTransition(
  db: Database,
  args: { runId: string; from: RunState; to: RunState; operator?: string; reason?: string; clock?: Clock },
): TransitionResult {
  const check = transition(args.from, args.to, args);
  if (!check.ok) {
    appendAudit(
      db,
      {
        runId: args.runId,
        operator: args.operator ?? "system",
        kind: "transition_rejected",
        fromState: args.from,
        toState: args.to,
        detail: { reason: check.reason },
      },
      args.clock,
    );
    return check;
  }
  const at = utc(args.clock ? args.clock.now() : Date.now());
  // 状态改写与审计同事务：审计写失败即整体回滚，绝不留下「状态已改但没留痕」
  transaction(db, () => {
    run(db, "UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?", args.to, at, args.runId);
    appendAudit(
      db,
      {
        runId: args.runId,
        operator: args.operator ?? "system",
        kind: "transition",
        fromState: args.from,
        toState: args.to,
        detail: { reason: args.reason ?? "" },
      },
      args.clock,
    );
  });
  return check;
}

/** 撤回一级：只允许 awaiting_review 之前，每次回退写一条带前后状态的审计。 */
export function applyRollback(
  db: Database,
  args: { runId: string; operator: string; clock?: Clock },
): TransitionResult {
  const row = get<{ status: string }>(db, "SELECT status FROM runs WHERE run_id = ?", args.runId);
  const from = (row?.status ?? "new") as RunState;
  const to = rollbackOf(from);
  if (to === undefined) {
    return { ok: false, reason: `${from} 不允许撤回（仅 awaiting_review 之前可回退一级）`, from, to: from };
  }
  const at = utc(args.clock ? args.clock.now() : Date.now());
  run(db, "UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?", to, at, args.runId);
  appendAudit(
    db,
    {
      runId: args.runId,
      operator: args.operator,
      kind: "rollback",
      fromState: from,
      toState: to,
      detail: { reason: "人工撤回一级" },
    },
    args.clock,
  );
  return { ok: true, reason: "已撤回一级", from, to };
}
