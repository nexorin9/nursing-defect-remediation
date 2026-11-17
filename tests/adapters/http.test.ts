/** T35 · 出站 HTTP 客户端：超时 / 4xx / 5xx 错误分类、凭据来自 RuntimeConfig、每次出站留痕。 */
import { describe, it, expect } from "vitest";
import { OutboundHttp } from "../../src/adapters/http.js";
import { loadRuntimeConfig, MissingEnvError, type EnvLike } from "../../src/config/runtime-config.js";
import { readAudit } from "../../src/store/audit.js";
import { createFetchStub, type StubResponse } from "../helpers/fetch-stub.js";
import { freshDb, makeTestConfig, testClock } from "../helpers/fixtures.js";

const URL = "https://qc.internal.test/api/v1/nursing-incidents";

function httpFor(spec: StubResponse, db = freshDb()) {
  const stub = createFetchStub([spec]);
  const http = new OutboundHttp(makeTestConfig(), {
    fetchImpl: stub.fetchImpl,
    clock: testClock(),
    db,
  });
  return { http, stub, db, config: makeTestConfig() };
}

describe("adapters · 出站 HTTP", () => {
  it("请求头与凭据来自 RuntimeConfig，业务代码不读 process.env", async () => {
    const { http, stub, config, db } = httpFor({ status: 200, body: { ok: true } });
    const result = await http.requestOnce<{ ok: boolean }>({
      method: "GET",
      url: URL,
      token: config.nursingQcToken,
      kind: "list_incidents",
      runId: "run-http",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ ok: true });
    expect(result.status).toBe(200);
    const headers = stub.calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${config.nursingQcToken}`);
    expect(headers["Content-Type"]).toBe("application/json");
    db.close();
  });

  it("4xx 不可重试 / 5xx 可重试 / 超时可重试，错误分类与 runtime 一致", async () => {
    const bad4xx = await httpFor({ status: 400, body: { error: "bad request" } }).http.requestOnce({
      method: "GET", url: URL, kind: "list_incidents",
    });
    expect(bad4xx.error?.klass).toBe("permanent");
    expect(bad4xx.error?.retryable).toBe(false);

    const bad5xx = await httpFor({ status: 503, body: { error: "unavailable" } }).http.requestOnce({
      method: "GET", url: URL, kind: "list_incidents",
    });
    expect(bad5xx.error?.klass).toBe("retryable");
    expect(bad5xx.error?.status).toBe(503);

    const timedOut = await httpFor({ timeout: true }).http.requestOnce({
      method: "GET", url: URL, kind: "list_incidents",
    });
    expect(timedOut.error?.klass).toBe("retryable");
    expect(timedOut.error?.message).toContain("timeout");
  });

  it("request() 只在可重试错误上退避，恢复后返回成功", async () => {
    const stub = createFetchStub([
      { status: 500, body: { error: "retry" } },
      { status: 200, body: { items: [] } },
    ]);
    const http = new OutboundHttp(makeTestConfig(), {
      fetchImpl: stub.fetchImpl,
      clock: testClock(),
    });
    const result = await http.request<{ items: unknown[] }>({
      method: "GET", url: URL, kind: "list_incidents", maxRetries: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(stub.calls).toHaveLength(2);
  });

  it("每次出站调用记审计：端点 / 状态码 / 耗时 / 脱敏响应摘要", async () => {
    const { http, db, config } = httpFor({ status: 200, text: "住院号：AB123456 已受理" });
    await http.requestOnce({
      method: "POST",
      url: URL,
      token: config.nursingQcToken,
      body: { x: 1 },
      kind: "submit_review",
      runId: "run-http-2",
    });
    const rows = readAudit(db, "run-http-2");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("outbound_call");
    const detail = JSON.parse(rows[0]!.detail ?? "{}") as Record<string, unknown>;
    expect(detail.endpoint).toBe("/api/v1/nursing-incidents");
    expect(detail.method).toBe("POST");
    expect(detail.status).toBe(200);
    expect(detail.duration_ms).toBe(0);
    expect(String(detail.response_summary)).not.toContain("AB123456");
    expect(String(detail.response_summary)).toContain("[已脱敏]");
    db.close();
  });

  it("缺凭据时配置归一层报错并点名变量名", () => {
    const env: EnvLike = {
      NURSING_QC_BASE_URL: "https://qc.internal.test",
      EMR_BASE_URL: "https://emr.internal.test",
      EMR_API_TOKEN: "x",
      WECOM_WEBHOOK_URL: "https://wecom.internal.test/hook",
      MODEL_BASE_URL: "https://model.internal.test",
      MODEL_API_KEY: "x",
    };
    try {
      loadRuntimeConfig(env);
      throw new Error("应当抛出 MissingEnvError");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingEnvError);
      expect((error as Error).message).toContain("NURSING_QC_TOKEN");
    }
  });
});
