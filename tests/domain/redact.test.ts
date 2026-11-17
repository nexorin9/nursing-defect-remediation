import { describe, expect, it } from "vitest";
import { redactText, redactIncident, containsPatientIdentifier } from "../../src/domain/redact.js";
import { checkContracts, checkContractTexts } from "../../scripts/check-contract.js";
import { CONTRACT_FILES } from "../../src/domain/contract.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** T9：脱敏 + 4 份 OpenAPI 3.1 契约一致性。 */
describe("T9 脱敏与契约", () => {
  it("脱敏后文本不含患者标识（住院号 / 床号 / 姓名 / 身份证 / 电话）", () => {
    const raw = "患者姓名：张三，住院号：A123456，床号 12 床，身份证 110101199001011234，电话 13800138000。";
    const redacted = redactText(raw);
    expect(redacted).not.toContain("张三");
    expect(redacted).not.toContain("住院号");
    expect(redacted).not.toContain("床号");
    expect(redacted).not.toContain("110101199001011234");
    expect(redacted).not.toContain("13800138000");
    expect(containsPatientIdentifier(redacted)).toBe(false);
  });

  it("窗口投影保留业务字段，缺 encounter_id 显式标为待补住院号", () => {
    const view = redactIncident({
      incident_id: "INC-1", reported_at: "2026-11-09T00:00:00Z", ward_code: "内科三病区",
      shift_code: "白班", narrative: "交接班漏项", reporter_role: "责任护士",
    });
    expect(view.ward_code).toBe("内科三病区");
    expect(view.missing_encounter_id).toBe(true);
    expect(JSON.stringify(view)).not.toContain("姓名");
  });

  it("4 份契约可解析且必填字段 / 枚举与代码一致", () => {
    const result = checkContracts(process.cwd());
    expect(result.ok).toBe(true);
    expect(result.checkedFiles).toBe(4);
    expect(CONTRACT_FILES).toHaveLength(4);
  });

  it("人为把契约某字段改为必填后校验失败", () => {
    const texts: Record<string, string> = {};
    for (const file of CONTRACT_FILES) {
      texts[file.split("/").pop()!] = readFileSync(resolve(process.cwd(), file), "utf8");
    }
    const tampered = texts["nursing-qc.yaml"]!.replace(
      "required: [incident_id, reported_at, ward_code, shift_code, narrative, reporter_role]",
      "required: [incident_id, reported_at, ward_code, shift_code, narrative, reporter_role, patient_name]",
    );
    const result = checkContractTexts({ ...texts, "nursing-qc.yaml": tampered });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("patient_name");
  });
});
