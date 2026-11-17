/**
 * 脱敏模块（T9）。
 *
 * 制度依据：十八、信息安全管理制度 第 5、6 条 —— 患者诊疗信息的使用与授权。
 * 窗口、导出件、企微催办默认全部过这里：保留病区 / 班次 / 缺陷类型等业务字段，
 * 去掉姓名 / 住院号 / 床号 / 身份证 / 电话等患者可识别信息。
 */
import type { IncidentReport } from "./models.js";

export const PATIENT_IDENTIFIER_FIELDS = ["姓名", "患者姓名", "住院号", "床号", "身份证", "身份证号", "电话", "手机号"] as const;

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "住院号", re: /(住院号|住院流水号|病案号)\s*[:：]?\s*[A-Za-z0-9-]{4,}/g },
  { name: "床号", re: /(床号|床位)\s*[:：]?\s*\d+\s*床?/g },
  { name: "姓名", re: /(患者姓名|姓名)\s*[:：]?\s*[\u4e00-\u9fa5]{2,4}(?=[，。、；\s]|$)/g },
  // 带标签的身份证 / 电话先整段替换，连标签一起去掉；裸号兜底放最后
  { name: "身份证", re: /(身份证号|身份证|证件号)\s*[:：]?\s*[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])([0-2]\d|3[01])\d{3}[\dXx]/g },
  { name: "电话", re: /(手机号|联系电话|电话)\s*[:：]?\s*1[3-9]\d{9}/g },
  { name: "身份证裸号", re: /[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])([0-2]\d|3[01])\d{3}[\dXx]/g },
  { name: "电话裸号", re: /1[3-9]\d{9}/g },
];

/** 去掉文本中的患者标识，返回可直接上屏/入台账的文本。 */
export function redactText(text: string): string {
  let out = text;
  for (const { re } of PATTERNS) {
    // 统一占位符：不回显「住院号 / 床号」等字段名本身，导出件里连字段名都不带
    out = out.replace(re, "[已脱敏]");
  }
  return out;
}

/** 文本是否仍含患者标识字段名（导出与推送前的断言用）。 */
export function containsPatientIdentifier(text: string): boolean {
  return PATIENT_IDENTIFIER_FIELDS.some((f) => text.includes(f)) || PATTERNS.some(({ re }) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

/** 上报单脱敏投影：窗口列表、在办清单、超期清单只消费这个结构。 */
export interface RedactedIncident {
  incident_id: string;
  reported_at: string;
  ward_code: string;
  shift_code: string;
  narrative: string;
  reporter_role: string;
  severity_hint?: string;
  /** 住院号不进窗口：只标「是否缺失」，供「待补住院号」清单使用 */
  missing_encounter_id: boolean;
}

export function redactIncident(report: IncidentReport): RedactedIncident {
  return {
    incident_id: report.incident_id,
    reported_at: report.reported_at,
    ward_code: report.ward_code,
    shift_code: report.shift_code,
    narrative: redactText(report.narrative),
    reporter_role: report.reporter_role,
    ...(report.severity_hint !== undefined ? { severity_hint: report.severity_hint } : {}),
    missing_encounter_id: report.encounter_id === undefined || report.encounter_id === "",
  };
}
