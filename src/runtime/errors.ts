/**
 * 错误分类与退避重试（T13）。
 *
 * 统一口径供 runtime 引擎与 adapters 共用：
 * 4xx（除 429）不可重试；429 / 5xx / 网络错 / 超时可重试；解析错按调用方定义。
 * 退避 = 指数 + 抖动，间隔可注入，便于确定性测试。
 */
import type { Clock } from "../util/clock.js";

export type ErrorClass = "permanent" | "retryable" | "parse" | "none";

export interface ClassifiedError {
  klass: ErrorClass;
  status?: number;
  message: string;
  retryable: boolean;
}

export interface OutboundError extends Error {
  status?: number;
  klass?: ErrorClass;
  code?: string;
}

export function makeError(message: string, options: { status?: number; klass?: ErrorClass; code?: string } = {}): OutboundError {
  const error = new Error(message) as OutboundError;
  error.status = options.status;
  error.klass = options.klass;
  error.code = options.code;
  return error;
}

export function classifyError(error: unknown): ClassifiedError {
  if (error === undefined || error === null) return { klass: "none", message: "", retryable: false };
  const e = error as Partial<OutboundError>;
  const message = e instanceof Error ? e.message : String(error);
  if (e.klass === "parse") return { klass: "parse", message, retryable: false };
  if (e.klass) {
    return { klass: e.klass, status: e.status, message, retryable: e.klass === "retryable" };
  }
  if (typeof e.status === "number") {
    const status = e.status;
    if (status >= 400 && status < 500 && status !== 429) {
      return { klass: "permanent", status, message, retryable: false };
    }
    if (status === 429 || status >= 500) {
      return { klass: "retryable", status, message, retryable: true };
    }
  }
  const text = message.toLowerCase();
  if (text.includes("timeout") || text.includes("abort") || text.includes("econn") || text.includes("network") || text.includes("fetch failed")) {
    return { klass: "retryable", message, retryable: true };
  }
  return { klass: "permanent", message, retryable: false };
}

/** 指数退避 + 抖动（base 100ms，最多 1600ms）。 */
export function backoffDelay(attempt: number, baseMs = 100, jitter: () => number = () => 0): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), 1600);
  return exponential + Math.floor(jitter() * Math.max(1, exponential * 0.2));
}

export interface RetryOptions {
  maxRetries: number;
  sleep: (ms: number) => Promise<void>;
  baseMs?: number;
  jitter?: () => number;
  clock?: Clock;
  onRetry?: (attempt: number, error: unknown) => void;
}

export interface RetryResult<T> {
  ok: boolean;
  value?: T;
  error?: ClassifiedError;
  /** 实际重试次数（不含首次调用） */
  retryCount: number;
  /** 总调用次数 */
  attempts: number;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<RetryResult<T>> {
  let attempts = 0;
  let retryCount = 0;
  let last: ClassifiedError = { klass: "none", message: "", retryable: false };
  for (;;) {
    attempts += 1;
    try {
      const value = await fn();
      return { ok: true, value, retryCount, attempts };
    } catch (error) {
      last = classifyError(error);
      if (!last.retryable || retryCount >= options.maxRetries) {
        return { ok: false, error: last, retryCount, attempts };
      }
      retryCount += 1;
      options.onRetry?.(retryCount, error);
      await options.sleep(backoffDelay(retryCount, options.baseMs ?? 100, options.jitter));
    }
  }
}

/** 测试与无头环境用的即时 sleep。 */
export const immediateSleep: (ms: number) => Promise<void> = () => Promise.resolve();
