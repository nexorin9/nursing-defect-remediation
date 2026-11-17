/**
 * 守门层 · 枚举与必填校验（T32）。
 *
 * 枚举取值一律来自 src/domain 的口径配置，规则层不写第二份词表；
 * 拒收时返回字段级可读原因 { rule, field, expected, actual }，供窗口逐条显示。
 * 规则层不做语义归并 —— 把自由叙述归并到标签集是模型的活。
 */
import { DEFAULT_GRADES, DEFAULT_SHIFTS, DEFAULT_REPORTER_ROLES, type QcPolicy } from "../domain/policy.js";

export interface RuleViolation {
  rule: string;
  field: string;
  expected: string;
  actual: string;
}

export interface ValidationResult {
  ok: boolean;
  violations: RuleViolation[];
}

/** 字段 → 允许枚举（配置化来源，不写死）。 */
export function enumValues(policy: QcPolicy, field: string): readonly string[] | undefined {
  switch (field) {
    case "grade":
      return policy.grades.value.length > 0 ? policy.grades.value : DEFAULT_GRADES;
    case "shift_code":
      return policy.shiftCodes.value.length > 0 ? policy.shiftCodes.value : DEFAULT_SHIFTS;
    case "reporter_role":
      return policy.reporterRoles.value.length > 0 ? policy.reporterRoles.value : DEFAULT_REPORTER_ROLES;
    default:
      return undefined;
  }
}

export function validateEnum(policy: QcPolicy, field: string, value: unknown): RuleViolation[] {
  const allowed = enumValues(policy, field);
  if (!allowed) return [];
  if (typeof value !== "string" || !allowed.includes(value)) {
    return [{ rule: "enum", field, expected: allowed.join("/"), actual: String(value) }];
  }
  return [];
}

export function validateRequired(
  value: Record<string, unknown>,
  fields: readonly string[],
  rule = "required",
): RuleViolation[] {
  const violations: RuleViolation[] = [];
  for (const field of fields) {
    const v = value[field];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
      violations.push({ rule, field, expected: "必填且非空", actual: v === undefined ? "缺失" : JSON.stringify(v) });
    }
  }
  return violations;
}

/** 模型草稿校验：必填 + 枚举，返回全部违规项（不是遇到第一条就停）。 */
export function validateDraft(
  policy: QcPolicy,
  draft: Record<string, unknown>,
  requiredFields: readonly string[],
): ValidationResult {
  const violations = [...validateRequired(draft, requiredFields)];
  for (const field of ["grade", "shift_code", "reporter_role"]) {
    if (draft[field] !== undefined) violations.push(...validateEnum(policy, field, draft[field]));
  }
  return { ok: violations.length === 0, violations };
}

/** 结构化 schema 校验共用：缺失 / 枚举越界都返回统一违规结构。 */
export function validateSchemaFields(
  policy: QcPolicy,
  value: Record<string, unknown>,
  schema: { required: readonly string[]; properties?: Record<string, { enum?: readonly string[] }> },
): ValidationResult {
  const violations = validateRequired(value, schema.required, "schema_required");
  for (const [field, spec] of Object.entries(schema.properties ?? {})) {
    if (spec.enum && value[field] !== undefined && !spec.enum.includes(String(value[field]))) {
      violations.push({
        rule: "schema_enum",
        field,
        expected: spec.enum.join("/"),
        actual: String(value[field]),
      });
    }
  }
  return { ok: violations.length === 0, violations };
}
