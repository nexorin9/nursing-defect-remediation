/**
 * adapters · 出站 HTTP 客户端（T35）。
 *
 * 基于原生 fetch：超时（AbortSignal.timeout）+ 退避 + 统一错误分类 + 结构化错误码；
 * base URL 与凭据只从 RuntimeConfig 取，业务代码不散落读环境变量；
 * 每次出站调用记审计（目标端点、状态码、耗时、脱敏后的响应摘要）。
 */
import { redactText } from "../domain/redact.js";
import { appendAudit } from "../store/audit.js";
import type { Database } from "../store/db.js";
import { systemClock, type Clock } from "../util/clock.js";
import { classifyError, makeError, withRetry, immediateSleep, type ClassifiedError } from "../runtime/errors.js";
import type { RuntimeConfig } from "../config/runtime-config.js";

export interface HttpRequestOptions {
  method: "GET" | "POST";
  url: string;
  /** 令牌由调用方从 RuntimeConfig 传入，不在客户端里读 env */
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  /** 审计用途标签 */
  kind: string;
  runId?: string;
}

export interface HttpResponse<T> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: ClassifiedError;
  durationMs: number;
  attempts: number;
}

export interface HttpDeps {
  fetchImpl?: typeof fetch;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  db?: Database;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class OutboundHttp {
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly db?: Database;

  constructor(private readonly config: RuntimeConfig, deps: HttpDeps = {}) {
    this.fetchImpl = (deps.fetchImpl ?? fetch) as FetchLike;
    this.clock = deps.clock ?? systemClock;
    this.sleep = deps.sleep ?? immediateSleep;
    this.db = deps.db;
  }

  /** 单次请求（不含重试），错误分类后返回结构化结果。 */
  async requestOnce<T>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    const started = this.clock.now();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    };
    try {
      const response = await this.fetchImpl(options.url, {
        method: options.method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      const text = await response.text();
      let data: unknown = text;
      try {
        data = text === "" ? {} : JSON.parse(text);
      } catch {
        /* 非 JSON 响应按文本保留，由调用方判定 */
      }
      const durationMs = this.clock.now() - started;
      this.audit(options, response.status, durationMs, redactText(String(text).slice(0, 200)));
      if (!response.ok) {
        const error = classifyError(makeError(`HTTP ${response.status}`, { status: response.status }));
        return { ok: false, status: response.status, error, durationMs, attempts: 1 };
      }
      return { ok: true, status: response.status, data: data as T, durationMs, attempts: 1 };
    } catch (error) {
      const classified = classifyError(error);
      const durationMs = this.clock.now() - started;
      this.audit(options, classified.status, durationMs, classified.message);
      return { ok: false, error: classified, durationMs, attempts: 1 };
    }
  }

  /** 带退避重试：4xx 不重试，5xx / 网络错 / 超时按配置重试。 */
  async request<T>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    let last: HttpResponse<T> | undefined;
    const retried = await withRetry(
      async () => {
        last = await this.requestOnce<T>(options);
        if (last.ok) return last;
        throw makeError(last.error?.message ?? "请求失败", {
          status: last.status,
          klass: last.error?.klass,
        });
      },
      {
        maxRetries: options.maxRetries ?? 2,
        sleep: this.sleep,
        clock: this.clock,
      },
    );
    // requestOnce 的 attempts 恒为 1；带重试的 request 应回报实际总调用次数
    if (retried.ok && retried.value) return { ...retried.value, attempts: retried.attempts };
    return {
      ok: false,
      status: last?.status,
      error: retried.error ?? last?.error,
      durationMs: last?.durationMs ?? 0,
      attempts: retried.attempts,
    };
  }

  private audit(options: HttpRequestOptions, status: number | undefined, durationMs: number, summary: string): void {
    if (!this.db) return;
    appendAudit(
      this.db,
      {
        runId: options.runId ?? "adapters",
        operator: "outbound_http",
        kind: "outbound_call",
        detail: {
          endpoint: new URL(options.url).pathname,
          method: options.method,
          status: status ?? 0,
          duration_ms: durationMs,
          kind: options.kind,
          response_summary: summary.slice(0, 160),
        },
      },
      this.clock,
    );
  }

  get runtimeConfig(): RuntimeConfig {
    return this.config;
  }
}
