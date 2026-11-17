/**
 * 守门层 · 时间序校验（T33）。
 * 措施 / 复核 / 销号时刻不得早于上报时刻；交接班相关记录按记录时间排序。
 */
import type { RuleViolation, ValidationResult } from "./schema.js";

export interface TemporalInput {
  reported_at: string;
  measure_at?: string;
  review_at?: string;
  close_at?: string;
}

export interface TimestampedRecord {
  time: string;
  text: string;
  author_role?: string;
}

function ms(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function validateTemporal(input: TemporalInput): ValidationResult {
  const violations: RuleViolation[] = [];
  const reported = ms(input.reported_at);
  if (reported === undefined) {
    return { ok: false, violations: [{ rule: "temporal", field: "reported_at", expected: "合法时刻", actual: String(input.reported_at) }] };
  }
  const fields: (keyof Omit<TemporalInput, "reported_at">)[] = ["measure_at", "review_at", "close_at"];
  for (const field of fields) {
    const value = ms(input[field]);
    if (value === undefined) continue;
    if (value < reported) {
      violations.push({
        rule: "temporal",
        field,
        expected: `不早于上报时刻 ${input.reported_at}`,
        actual: String(input[field]),
      });
    }
  }
  const ordered: (keyof Omit<TemporalInput, "reported_at">)[] = ["measure_at", "review_at", "close_at"];
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ms(input[ordered[i - 1]!]);
    const curr = ms(input[ordered[i]!]);
    if (prev !== undefined && curr !== undefined && curr < prev) {
      violations.push({
        rule: "temporal",
        field: ordered[i]!,
        expected: `不早于 ${ordered[i - 1]}`,
        actual: String(input[ordered[i]!]),
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** 交接班记录按时间排序（稳定排序，不改原文）。 */
export function sortRecords<T extends TimestampedRecord>(records: T[]): T[] {
  return [...records].sort((a, b) => (ms(a.time) ?? 0) - (ms(b.time) ?? 0));
}
