/**
 * 结构化输出 schema（T28）。
 *
 * 三份 json_schema：要素抽取 / 分级建议 / 措施与通知草稿。
 * 字段与枚举来自 src/domain；校验器复用 rules/schema.ts，不另写第二套。
 * 解析失败按协议错误处理（不静默当草稿用），调用方停在当前步。
 */
import { DEFAULT_GRADES } from "../domain/policy.js";
import { createPolicy } from "../domain/policy.js";
import { validateSchemaFields, type ValidationResult } from "../rules/schema.js";

export type SchemaName = "extraction" | "grade" | "draft";

export interface JsonSchema {
  type: "object";
  required: readonly string[];
  properties: Record<string, { type: string; enum?: readonly string[]; description?: string; items?: { type: string } }>;
  additionalProperties: boolean;
}

export const extractionSchema: JsonSchema = {
  type: "object",
  required: ["defect_type", "evidence_refs", "missing_elements"],
  properties: {
    defect_type: { type: "string", description: "归并到固定标签集的缺陷类型" },
    evidence_refs: { type: "array", items: { type: "string" }, description: "必须确实出现在输入叙述中的原句" },
    missing_elements: { type: "array", items: { type: "string" }, description: "结构化缺项提示" },
  },
  additionalProperties: false,
};

export const gradeSchema: JsonSchema = {
  type: "object",
  required: ["grade", "reason", "evidence_refs"],
  properties: {
    grade: { type: "string", enum: DEFAULT_GRADES, description: "分级建议（草稿，须人工确认）" },
    reason: { type: "string" },
    evidence_refs: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

export const draftSchema: JsonSchema = {
  type: "object",
  required: ["remediation_plan", "notification_draft", "evidence_refs"],
  properties: {
    remediation_plan: { type: "string" },
    notification_draft: { type: "string" },
    evidence_refs: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

export const SCHEMAS: Record<SchemaName, JsonSchema> = {
  extraction: extractionSchema,
  grade: gradeSchema,
  draft: draftSchema,
};

export interface ParseResult<T> {
  ok: boolean;
  value?: T;
  reason?: string;
  violations?: ValidationResult["violations"];
}

/** 解析模型返回的 JSON 文本并过 schema 校验；任何一步失败都按协议错误处理。 */
export function parseStructured<T extends Record<string, unknown>>(
  content: string,
  name: SchemaName,
): ParseResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, reason: `结构化返回不是合法 JSON（${name}），按协议错误处理，停在当前步` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: `结构化返回不是对象（${name}）` };
  }
  const value = parsed as Record<string, unknown>;
  const result = validateSchemaFields(createPolicy(), value, SCHEMAS[name]);
  if (!result.ok) {
    return {
      ok: false,
      reason: `schema 校验未通过：${result.violations.map((v) => `${v.field} ${v.rule}（期望 ${v.expected}，实际 ${v.actual}）`).join("；")}`,
      violations: result.violations,
    };
  }
  return { ok: true, value: value as T };
}

/** 请求体里的 response_format 片段。 */
export function responseFormat(name: SchemaName): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: { name, strict: true, schema: SCHEMAS[name] },
  };
}
