/**
 * 摘要与哈希工具。
 * 所有幂等键、审计输入输出摘要都走这里，保证同一份输入总是同一份摘要。
 */
import { createHash } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 稳定 JSON 摘要：对象键排序后再序列化，避免字段顺序影响哈希。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function digest(value: unknown): string {
  return sha256(stableStringify(value));
}

/** 单调递增的进程内 id 生成器（call_id / batch_id 等用）。 */
let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}
