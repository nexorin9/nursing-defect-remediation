/**
 * 步骤哈希幂等（T12）。
 *
 * 语义对齐源仓库「步骤哈希 %s:%d + hash version」：
 * 哈希只由 (runId, stepId, idx, 输入摘要, 版本) 决定，
 * 与时间戳、重试次数无关 —— 因此重复投递 / 重试不会重复执行副作用。
 * 输入摘要变化则哈希变化，允许重新执行。
 */
import { sha256, digest } from "../util/hash.js";
import { get, type Database } from "../store/db.js";
import type { StepRecord } from "../domain/models.js";

/** 输入格式变化时递增；golden 对照测试守住历史值不漂移。 */
export const STEP_HASH_VERSION = 1;

/** 源语义的固定拼接顺序：runId:stepId:idx，再拼输入摘要与版本。 */
export function stepHash(runId: string, stepId: string, idx: number, inputDigest: string): string {
  return `v${STEP_HASH_VERSION}:${sha256(`${runId}:${stepId}:${idx}:${inputDigest}`)}`;
}

/** 步骤输入摘要：只含业务输入，不含时间、重试次数。 */
export function stepInputDigest(input: unknown): string {
  return digest(input);
}

/** 执行前查已落库结果；命中即复用，不再执行副作用。 */
export function findCompletedStepByHash(db: Database, hash: string): StepRecord | undefined {
  return get<StepRecord>(
    db,
    "SELECT * FROM steps WHERE step_hash = ? AND status = 'done' LIMIT 1",
    hash,
  );
}

export function hasStepHash(db: Database, hash: string): boolean {
  return get<{ step_id: string }>(db, "SELECT step_id FROM steps WHERE step_hash = ? LIMIT 1", hash) !== undefined;
}
