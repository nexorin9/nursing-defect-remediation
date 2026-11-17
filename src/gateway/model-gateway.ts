/**
 * ModelGateway（T27）：OpenAI-compatible 单一网关。
 *
 * 业务层只依赖这个接口，不 import 任何厂商 SDK；
 * base_url / api_key / model / timeout / max_retries / temperature 全部取自 RuntimeConfig。
 * 请求体含 messages + temperature + response_format；返回统一结构 { content, usage, raw }。
 * 本地协议替身只存在于 tests/ 层；src/ 内不含任何替身地址或默认端点常量。
 */
import { newId } from "../util/hash.js";
import type { Clock } from "../util/clock.js";
import { systemClock } from "../util/clock.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { classifyError, makeError, withRetry, immediateSleep, type ClassifiedError } from "../runtime/errors.js";
import { responseFormat, type SchemaName } from "./schemas.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GatewayRequest {
  messages: ChatMessage[];
  schemaName?: SchemaName;
  temperature?: number;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface GatewayResult {
  ok: boolean;
  content?: string;
  usage?: TokenUsage;
  raw?: unknown;
  callId: string;
  error?: ClassifiedError;
  attempts: number;
}

export interface ModelGateway {
  complete(request: GatewayRequest): Promise<GatewayResult>;
}

export interface GatewayOptions {
  fetchImpl?: typeof fetch;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface RawChoice {
  message?: { content?: string };
}

export class OpenAiCompatibleGateway implements ModelGateway {
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(
    private readonly config: RuntimeConfig,
    options: GatewayOptions = {},
  ) {
    this.fetchImpl = (options.fetchImpl ?? fetch) as FetchLike;
    this.clock = options.clock ?? systemClock;
    this.sleep = options.sleep ?? immediateSleep;
    this.maxRetries = options.maxRetries ?? config.modelMaxRetries;
  }

  /** 单一出站入口：POST {MODEL_BASE_URL}/v1/chat/completions。 */
  async complete(request: GatewayRequest): Promise<GatewayResult> {
    const callId = newId("call");
    if (!this.config.modelApiKey) {
      throw makeError("MISSING ENV: MODEL_API_KEY 未配置，模型调用已阻断", { klass: "permanent" });
    }
    const url = `${this.config.modelBaseUrl}/v1/chat/completions`;
    const body = {
      model: this.config.modelName,
      messages: request.messages,
      temperature: request.temperature ?? this.config.modelTemperature,
      ...(request.schemaName ? { response_format: responseFormat(request.schemaName) } : {}),
    };
    const retried = await withRetry<{ content: string; usage: TokenUsage; raw: unknown }>(
      async () => {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.modelApiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.modelTimeout),
        });
        if (!response.ok) {
          throw makeError(`模型服务返回 HTTP ${response.status}`, {
            status: response.status,
            klass: response.status === 429 || response.status >= 500 ? "retryable" : "permanent",
          });
        }
        const text = await response.text();
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw makeError("模型返回体不是 JSON", { klass: "parse" });
        }
        const doc = raw as { choices?: RawChoice[]; usage?: Partial<TokenUsage> };
        const content = doc.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.trim() === "") {
          throw makeError("模型返回 content 为空", { klass: "parse" });
        }
        return {
          content,
          usage: {
            prompt_tokens: Number(doc.usage?.prompt_tokens ?? 0),
            completion_tokens: Number(doc.usage?.completion_tokens ?? 0),
          },
          raw,
        };
      },
      {
        maxRetries: this.maxRetries,
        sleep: this.sleep,
        clock: this.clock,
      },
    );

    if (!retried.ok || !retried.value) {
      return { ok: false, callId, error: retried.error ?? classifyError(new Error("unknown")), attempts: retried.attempts };
    }
    return {
      ok: true,
      content: retried.value.content,
      usage: retried.value.usage,
      raw: retried.value.raw,
      callId,
      attempts: retried.attempts,
    };
  }
}

export function createModelGateway(config: RuntimeConfig, options: GatewayOptions = {}): ModelGateway {
  return new OpenAiCompatibleGateway(config, options);
}
