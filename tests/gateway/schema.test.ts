/** T28 · 三份 json_schema：合法返回通过；缺字段 / 枚举越界被拒且调用方停在当前步。 */
import { describe, it, expect } from "vitest";
import { parseStructured, responseFormat, SCHEMAS } from "../../src/gateway/schemas.js";
import { createPolicy, DEFAULT_GRADES } from "../../src/domain/policy.js";
import { Engine } from "../../src/runtime/engine.js";
import { callWithDegrade } from "../../src/gateway/degrade.js";
import type { ModelGateway, GatewayResult } from "../../src/gateway/model-gateway.js";
import { freshDb, makeIncident, testClock } from "../helpers/fixtures.js";

/** 本地协议替身：只返回文本，不发任何请求。 */
function textGateway(content: string): ModelGateway {
  return {
    async complete(): Promise<GatewayResult> {
      return { ok: true, content, usage: { prompt_tokens: 5, completion_tokens: 4 }, callId: "call_fixture", attempts: 1 };
    },
  };
}

describe("结构化输出 schema", () => {
  it("三份 schema 的枚举来自 domain，不写第二份词表", () => {
    expect(SCHEMAS.grade.properties.grade?.enum).toEqual([...DEFAULT_GRADES]);
    expect(SCHEMAS.extraction.required).toContain("evidence_refs");
    expect(SCHEMAS.draft.required).toContain("remediation_plan");
    expect(responseFormat("grade")).toMatchObject({ type: "json_schema", json_schema: { name: "grade", strict: true } });
    expect(createPolicy().grades.value).toEqual([...DEFAULT_GRADES]);
  });

  it("合法结构化返回通过 schema 校验", () => {
    const parsed = parseStructured<{ grade: string }>(
      JSON.stringify({ grade: "Ⅱ级", reason: "按分级细则", evidence_refs: ["交接班漏项"] }),
      "grade",
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.grade).toBe("Ⅱ级");
  });

  it("缺字段与枚举越界被拒，理由含字段名", () => {
    const missing = parseStructured(JSON.stringify({ grade: "Ⅱ级" }), "grade");
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain("schema 校验未通过");
    expect(missing.violations?.some((v) => v.field === "reason")).toBe(true);
    const outOfRange = parseStructured(
      JSON.stringify({ grade: "Ⅴ级", reason: "x", evidence_refs: ["x"] }),
      "grade",
    );
    expect(outOfRange.ok).toBe(false);
    expect(outOfRange.violations?.some((v) => v.rule === "schema_enum" && v.field === "grade")).toBe(true);
  });

  it("返回体非 JSON 按协议错误处理，不静默当草稿", () => {
    const parsed = parseStructured("这不是 JSON", "draft");
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("按协议错误处理");
  });

  it("调用方在校验失败时停在当前步，状态不推进、步骤表无新增行", async () => {
    const db = freshDb();
    let writebackCalls = 0;
    const engine = new Engine({
      db,
      clock: testClock(),
      hooks: {
        onStep: async () => {
          const outcome = await callWithDegrade(textGateway("{坏的 JSON"), { messages: [{ role: "user", content: "x" }] }, { schemaName: "grade" });
          return { ok: false, degraded: true, reason: outcome.reason, callId: outcome.callId };
        },
        onWriteback: async () => {
          writebackCalls += 1;
          return { ok: true, receipt_id: "RCP-SHOULD-NOT-HAPPEN" };
        },
      },
    });
    const scheduled = engine.schedule(makeIncident());
    await engine.execute(scheduled.run.run_id);
    expect(engine.getRun(scheduled.run.run_id)?.status).toBe("new");
    expect(engine.countSteps(scheduled.run.run_id)).toBe(0);
    expect(writebackCalls).toBe(0);
    db.close();
  });
});
