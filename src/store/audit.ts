/**
 * 只增不改审计链（T8）。
 *
 * 每一步推进、挂起、恢复、回写、模型调用都从这里追加一行；
 * 本模块只提供追加与读取，任何变更或移除既有行的能力都不存在。
 * 写入失败一律向上抛出，由调用方据此阻断状态推进（失败不静默改数据）。
 */
import { utc, type Clock } from "../util/clock.js";
import { all, get, run, type Database } from "./db.js";
import type { AuditEntry } from "../domain/models.js";

export interface AuditInput {
  runId: string;
  operator: string;
  kind: string;
  inputHash?: string;
  outputHash?: string;
  modelCallId?: string;
  fromState?: string;
  toState?: string;
  detail?: unknown;
  at?: string;
}

/** 追加一条审计。异常直接上抛，绝不吞掉。 */
export function appendAudit(db: Database, input: AuditInput, clock?: Clock): number {
  const at = input.at ?? utc(clock ? clock.now() : Date.now());
  const detail = input.detail === undefined ? "" : typeof input.detail === "string" ? input.detail : JSON.stringify(input.detail);
  const result = run(
    db,
    `INSERT INTO audit
       (run_id, operator, at, kind, input_hash, output_hash, model_call_id, from_state, to_state, detail, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.runId,
    input.operator,
    at,
    input.kind,
    input.inputHash ?? "",
    input.outputHash ?? "",
    input.modelCallId ?? null,
    input.fromState ?? null,
    input.toState ?? null,
    detail,
    at,
    at,
  );
  return result.lastInsertRowid;
}

export function readAudit(db: Database, runId?: string): AuditEntry[] {
  const rows = runId
    ? all<Record<string, unknown>>(db, "SELECT * FROM audit WHERE run_id = ? ORDER BY id ASC", runId)
    : all<Record<string, unknown>>(db, "SELECT * FROM audit ORDER BY id ASC");
  return rows.map(mapRow);
}

function mapRow(row: Record<string, unknown>): AuditEntry {
  return {
    id: Number(row.id),
    run_id: String(row.run_id),
    operator: String(row.operator),
    at: String(row.at),
    kind: String(row.kind),
    input_hash: String(row.input_hash),
    output_hash: String(row.output_hash),
    ...(row.model_call_id !== null && row.model_call_id !== undefined
      ? { model_call_id: String(row.model_call_id) }
      : {}),
    ...(row.from_state !== null && row.from_state !== undefined ? { from_state: String(row.from_state) } : {}),
    ...(row.to_state !== null && row.to_state !== undefined ? { to_state: String(row.to_state) } : {}),
    ...(row.detail !== null && row.detail !== undefined ? { detail: String(row.detail) } : {}),
  };
}

export function countAudit(db: Database, runId?: string, kind?: string): number {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (runId) {
    clauses.push("run_id = ?");
    params.push(runId);
  }
  if (kind) {
    clauses.push("kind = ?");
    params.push(kind);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = get<{ c: number }>(db, `SELECT COUNT(*) AS c FROM audit ${where}`, ...params);
  return row?.c ?? 0;
}

/** 运行摘要计数：巡检 / 重试 / 模型调用 / 成本，供窗口底部读取（T44）。 */
export interface AuditSummary {
  sweeps: number;
  retries: number;
  modelCalls: number;
  estimatedCost: number | undefined;
  pricedCalls: number;
}

export function auditSummary(db: Database, runId?: string): AuditSummary {
  const where = runId ? "WHERE run_id = ?" : "";
  const params = runId ? [runId] : [];
  const rows = all<{ kind: string; c: number }>(
    db,
    `SELECT kind, COUNT(*) AS c FROM audit ${where} GROUP BY kind`,
    ...params,
  );
  const byKind = new Map(rows.map((r) => [r.kind, r.c]));
  const modelRows = all<{ detail: string }>(
    db,
    `SELECT detail FROM audit ${where ? `${where} AND kind = 'model_call'` : "WHERE kind = 'model_call'"}`,
    ...params,
  );
  let cost = 0;
  let priced = 0;
  for (const row of modelRows) {
    try {
      const parsed = JSON.parse(row.detail) as { estimated_cost?: number };
      if (typeof parsed.estimated_cost === "number") {
        cost += parsed.estimated_cost;
        priced += 1;
      }
    } catch {
      /* 非结构化留痕不参与成本汇总 */
    }
  }
  return {
    sweeps: byKind.get("sweep") ?? 0,
    retries: byKind.get("retry") ?? 0,
    modelCalls: byKind.get("model_call") ?? 0,
    estimatedCost: priced > 0 ? Math.round(cost * 1e6) / 1e6 : undefined,
    pricedCalls: priced,
  };
}
