/** T27 · ModelGateway 单一网关（协议替身只在本目录）。 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { OpenAiCompatibleGateway } from "../../src/gateway/model-gateway.js";
import { SCHEMAS } from "../../src/gateway/schemas.js";
import { chatResponse, createFetchStub } from "../helpers/fetch-stub.js";
import { makeTestConfig } from "../helpers/fixtures.js";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(path);
  }
  return out;
}

describe("OpenAI-compatible 单一网关", () => {
  it("出站路径为 /v1/chat/completions 且头含 Authorization Bearer", async () => {
    const stub = createFetchStub([chatResponse("要素抽取结果")]);
    const gateway = new OpenAiCompatibleGateway(makeTestConfig(), { fetchImpl: stub.fetchImpl });
    const result = await gateway.complete({ messages: [{ role: "user", content: "交接班漏项" }], schemaName: "extraction" });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("要素抽取结果");
    expect(result.usage).toEqual({ prompt_tokens: 12, completion_tokens: 8 });
    expect(result.callId).toMatch(/^call_/);
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.url).toBe("https://model.internal.test/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer key123456");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("test-model");
    expect(body.temperature).toBe(0.2);
    expect(Array.isArray(body.messages)).toBe(true);
    const format = body.response_format as { type: string; json_schema: { name: string } };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.name).toBe("extraction");
  });

  it("temperature 可由单次请求覆盖，模型参数只来自 RuntimeConfig", async () => {
    const stub = createFetchStub([chatResponse("ok")]);
    const gateway = new OpenAiCompatibleGateway(makeTestConfig({ modelTemperature: 0.7, modelName: "院内模型" }), {
      fetchImpl: stub.fetchImpl,
    });
    await gateway.complete({ messages: [{ role: "user", content: "x" }], temperature: 0.1 });
    const body = JSON.parse(String(stub.calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.temperature).toBe(0.1);
    expect(body.model).toBe("院内模型");
  });

  it("缺 MODEL_API_KEY 时抛错并点名变量名", async () => {
    const gateway = new OpenAiCompatibleGateway(makeTestConfig({ modelApiKey: "" }), {
      fetchImpl: createFetchStub([chatResponse("ok")]).fetchImpl,
    });
    await expect(gateway.complete({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/MODEL_API_KEY/);
  });

  it("业务层不 import 厂商 SDK，src/ 不含替身端点常量", () => {
    const files = sourceFiles(resolve(process.cwd(), "src"));
    expect(files.length).toBeGreaterThan(30);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/from\s+["'](openai|@anthropic-ai|@azure\/openai|langchain)/);
      expect(text).not.toMatch(/localhost|127\.0\.0\.1|example\.com/);
    }
    // 三份 schema 与网关同处 gateway/，业务层只有这一个模型出站入口
    expect(Object.keys(SCHEMAS)).toEqual(["extraction", "grade", "draft"]);
  });
});
