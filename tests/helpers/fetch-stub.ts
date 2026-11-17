/** tests/ 层专用的 HTTP / 模型协议替身；src/ 内不存在任何替身或默认替身端点。 */
export interface RecordedCall {
  url: string;
  init: RequestInit;
}

export interface FetchStub {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
  statusFor?: (url: string, callIndex: number) => number;
}

export type StubResponse =
  | { status?: number; body: unknown }
  | { status?: number; text: string }
  | { timeout: true }
  | { networkError: string };

/** 按队列返回响应；可精确控制 401 / 429 / 500 / 非 JSON / 空 content 等语义。 */
export function createFetchStub(responses: StubResponse[]): FetchStub {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const spec = responses[Math.min(index, responses.length - 1)] ?? { status: 200, body: {} };
    index += 1;
    if ("timeout" in spec) {
      throw new Error("The operation was aborted due to timeout");
    }
    if ("networkError" in spec) {
      throw new Error(`fetch failed: ${spec.networkError}`);
    }
    const status = spec.status ?? 200;
    const text = "text" in spec ? spec.text : JSON.stringify(spec.body);
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** 单个 OpenAI-compatible 正常返回。 */
export function chatResponse(content: string, usage = { prompt_tokens: 12, completion_tokens: 8 }): StubResponse {
  return {
    status: 200,
    body: { choices: [{ message: { content } }], usage },
  };
}
