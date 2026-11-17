/**
 * 按 key 的并发闸门（T17）。
 *
 * 默认 key = 责任护士长 id，limit 可配置；超出的件进入等待队列不丢弃，
 * 槽位释放后按 FIFO 出队。槽位与队列都落 slots 表，进程重启后从库恢复继续。
 */
import { utc, type Clock } from "../util/clock.js";
import { all, get, run, type Database } from "../store/db.js";

export interface AcquireResult {
  acquired: boolean;
  queued: boolean;
  position: number;
  active: number;
  limit: number;
}

interface SlotRow {
  gate_key: string;
  run_id: string;
  position: number;
  acquired_at: string;
}

export class KeyedGate {
  constructor(
    private readonly db: Database,
    private readonly limit: number = 2,
    private readonly clock?: Clock,
  ) {}

  private now(): string {
    return utc(this.clock ? this.clock.now() : Date.now());
  }

  private nextPosition(gateKey: string): number {
    const row = get<{ p: number }>(
      this.db,
      "SELECT COALESCE(MAX(position), 0) + 1 AS p FROM slots WHERE gate_key = ?",
      gateKey,
    );
    return row?.p ?? 1;
  }

  activeCount(gateKey: string): number {
    const row = get<{ c: number }>(
      this.db,
      "SELECT COUNT(*) AS c FROM slots WHERE gate_key = ? AND acquired_at <> ''",
      gateKey,
    );
    return row?.c ?? 0;
  }

  pending(gateKey: string): string[] {
    return all<SlotRow>(
      this.db,
      "SELECT * FROM slots WHERE gate_key = ? AND acquired_at = '' ORDER BY position ASC",
      gateKey,
    ).map((r) => r.run_id);
  }

  /** 已占用的槽位（acquired_at 非空）。 */
  active(gateKey: string): string[] {
    return all<SlotRow>(
      this.db,
      "SELECT * FROM slots WHERE gate_key = ? AND acquired_at <> '' ORDER BY position ASC",
      gateKey,
    ).map((r) => r.run_id);
  }

  /**
   * 取槽位；limit 内直接获得，超出则排队（acquired_at 为空串表示排队中）。
   * 同一 run 重复 acquire 幂等，不会占两个槽位。
   */
  acquire(gateKey: string, runId: string): AcquireResult {
    const existing = get<SlotRow>(this.db, "SELECT * FROM slots WHERE gate_key = ? AND run_id = ?", gateKey, runId);
    if (existing) {
      return {
        acquired: existing.acquired_at !== "",
        queued: existing.acquired_at === "",
        position: existing.position,
        active: this.activeCount(gateKey),
        limit: this.limit,
      };
    }
    const active = this.activeCount(gateKey);
    const acquired = active < this.limit;
    const position = this.nextPosition(gateKey);
    run(
      this.db,
      "INSERT INTO slots (gate_key, run_id, position, acquired_at) VALUES (?, ?, ?, ?)",
      gateKey,
      runId,
      position,
      acquired ? this.now() : "",
    );
    return { acquired, queued: !acquired, position, active: this.activeCount(gateKey), limit: this.limit };
  }

  /** 释放槽位，按 FIFO 让下一件自动出队；返回下一个应当被执行的 run_id。 */
  release(gateKey: string, runId: string): string | undefined {
    run(this.db, "DELETE FROM slots WHERE gate_key = ? AND run_id = ?", gateKey, runId);
    const next = get<SlotRow>(
      this.db,
      "SELECT * FROM slots WHERE gate_key = ? AND acquired_at = '' ORDER BY position ASC LIMIT 1",
      gateKey,
    );
    if (!next) return undefined;
    run(
      this.db,
      "UPDATE slots SET acquired_at = ? WHERE gate_key = ? AND run_id = ?",
      this.now(),
      gateKey,
      next.run_id,
    );
    return next.run_id;
  }

  /** 重启恢复：队列与槽位都在库里，这里只做一致性核对并返回仍在处理中的件。 */
  restore(gateKey: string): { active: string[]; queued: string[] } {
    return { active: this.active(gateKey), queued: this.pending(gateKey) };
  }
}
