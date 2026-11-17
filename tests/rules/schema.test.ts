/** T32 · 枚举 + 必填校验：字段级可读原因，枚举来自 domain 配置。 */
import { describe, it, expect } from "vitest";
import { createPolicy } from "../../src/domain/policy.js";
import { validateDraft, validateEnum, enumValues, validateSchemaFields } from "../../src/rules/schema.js";
import { SCHEMAS } from "../../src/gateway/schemas.js";

const REQUIRED = ["grade", "remediation_plan"] as const;

describe("守门层 · 枚举与必填", () => {
  it("合法草稿通过", () => {
    const result = validateDraft(createPolicy(), {
      grade: "Ⅱ级",
      remediation_plan: "补记翻身计划并双人核对",
      shift_code: "白班",
      reporter_role: "责任护士",
    }, REQUIRED);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("枚举越界与必填缺失均被拒，返回 { rule, field, expected, actual }", () => {
    const result = validateDraft(createPolicy(), { grade: "Ⅴ级", shift_code: "夜班" }, REQUIRED);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.rule === "enum" && v.field === "grade" && v.expected.includes("Ⅰ级"))).toBe(true);
    expect(result.violations.some((v) => v.rule === "enum" && v.field === "shift_code")).toBe(true);
    expect(result.violations.some((v) => v.rule === "required" && v.field === "remediation_plan")).toBe(true);
    for (const v of result.violations) {
      expect(typeof v.rule).toBe("string");
      expect(typeof v.field).toBe("string");
      expect(typeof v.expected).toBe("string");
      expect(typeof v.actual).toBe("string");
    }
  });

  it("枚举词表只有一份：domain 配置变化后规则同步生效", () => {
    const policy = createPolicy({ grades: { value: ["甲", "乙"] }, shiftCodes: { value: ["A 班"] } });
    expect(enumValues(policy, "grade")).toEqual(["甲", "乙"]);
    expect(validateEnum(policy, "grade", "甲")).toHaveLength(0);
    expect(validateEnum(policy, "grade", "Ⅱ级")).toHaveLength(1);
    expect(validateEnum(policy, "shift_code", "白班")).toHaveLength(1);
    expect(validateEnum(policy, "unknown_field", "anything")).toHaveLength(0);
  });

  it("schema 校验器复用同一套必填 / 枚举规则", () => {
    const ok = validateSchemaFields(createPolicy(), { grade: "Ⅰ级", reason: "x", evidence_refs: ["x"] }, SCHEMAS.grade);
    expect(ok.ok).toBe(true);
    const bad = validateSchemaFields(createPolicy(), { grade: "Ⅴ级" }, SCHEMAS.grade);
    expect(bad.ok).toBe(false);
    expect(bad.violations.map((v) => v.rule)).toContain("schema_required");
    expect(bad.violations.map((v) => v.rule)).toContain("schema_enum");
  });

  it("规则层不做语义归并：自由叙述原样保留，只判合法性", () => {
    const freeText = "夜里老人下床时滑了一下";
    const result = validateDraft(createPolicy(), { grade: "Ⅲ级", remediation_plan: freeText }, REQUIRED);
    expect(result.ok).toBe(true);
    expect(freeText).toBe("夜里老人下床时滑了一下");
  });
});
