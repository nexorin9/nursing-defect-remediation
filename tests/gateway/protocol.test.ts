/** T31 · OpenAI-compatible 七类响应语义 + 错误分类 + 替身只在 tests/ 层。 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { OpenAiCompatibleGateway } from "../../src/gateway/model-gateway.js";
import { createFetchStub, chatResponse, type StubResponse } from "../helpers/fetch-stub.js";
import { makeTestConfig } from "../helpers/fixtures.js";

function gatewayFor(spec: StubResponse, maxRetries = 0) {
  const stub = createFetchStub([spec]);
  const gateway = new OpenAiCompatibleGateway(makeTestConfig(), { fetchImpl: stub.fetchImpl, maxRetries });
  return { gateway, stub };
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(path);
  }
  return out;
}

describe("模型协议兼容性（tests/ 层替身）", () => {
  const request = { messages: [{ role: "user" as const, content: "交接班漏项" }] };

  it("① 正常返回：content 与 usage 解析正确，请求体字段齐全", async () => {
    const { gateway, stub } = gatewayFor(chatResponse("正常", { prompt_tokens: 21, completion_tokens: 9 }));
    const result = await gateway.complete(request);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("正常");
    expect(result.usage).toEqual({ prompt_tokens: 21, completion_tokens: 9 });
    const body = JSON.parse(String(stub.calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("test-model");
    expect(body.temperature).toBe(0.2);
    expect((stub.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer key123456");
  });

  it("② 401 未授权：不可重试，只调用一次", async () => {
    const { gateway, stub } = gatewayFor({ status: 401, body: { error: "unauthorized" } }, 2);
    const result = await gateway.complete(request);
    expect(result.ok).toBe(false);
    expect(result.error?.klass).toBe("permanent");
    expect(result.error?.retryable).toBe(false);
    expect(result.attempts).toBe(1);
    expect(stub.calls).toHaveLength(1);
  });

  it("③ 429 限流：可重试，退避次数受 max_retries 约束", async () => {
    const { gateway, stub } = gatewayFor({ status: 429, body: { error: "rate limited" } }, 2);
    const result = await gateway.complete(request);
    expect(result.error?.klass).toBe("retryable");
    expect(result.attempts).toBe(3);
    expect(stub.calls).toHaveLength(3);
  });

  it("④ 500：可重试，重试耗尽后返回统一错误", async () => {
    const { gateway } = gatewayFor({ status: 500, body: { error: "server error" } }, 2);
    const result = await gateway.complete(request);
    expect(result.ok).toBe(false);
    expect(result.error?.status).toBe(500);
    expect(result.error?.klass).toBe("retryable");
  });

  it("⑤ 超时：可重试，映射为 retryable", async () => {
    const { gateway } = gatewayFor({ timeout: true }, 1);
    const result = await gateway.complete(request);
    expect(result.error?.klass).toBe("retryable");
    expect(result.attempts).toBe(2);
  });

  it("⑥ 返回体非 JSON：按 parse 错误处理，不重试", async () => {
    const { gateway, stub } = gatewayFor({ status: 200, text: "<html>bad gateway</html>" }, 2);
    const result = await gateway.complete(request);
    expect(result.error?.klass).toBe("parse");
    expect(result.error?.retryable).toBe(false);
    expect(stub.calls).toHaveLength(1);
  });

  it("⑦ content 为空：按 parse 错误处理，不静默当草稿", async () => {
    const { gateway } = gatewayFor(chatResponse("   "), 2);
    const result = await gateway.complete(request);
    expect(result.ok).toBe(false);
    expect(result.error?.klass).toBe("parse");
    expect(result.error?.message).toContain("content 为空");
  });

  it("替身只存在于 tests/：src/ 内不含替身端点常量，凭据位只从环境变量读", () => {
    const srcRoot = resolve(process.cwd(), "src");
    const files = sourceFiles(srcRoot);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/localhost|127\.0\.0\.1|example\.com/);
      expect(text).not.toMatch(/https?:\/\/[^"'`\s]*\/(mock|stub|fake)/i);
    }
    const processEnvUsers = files.filter((f) => /process\.env/.test(readFileSync(f, "utf8")));
    expect(processEnvUsers.map((f) => f.slice(srcRoot.length + 1))).toEqual(["config/runtime-config.ts"]);
    expect(existsSync(resolve(process.cwd(), "tests/helpers/fetch-stub.ts"))).toBe(true);
  });
});
