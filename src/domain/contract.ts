/**
 * 院内接口字段规范（代码侧单一事实来源）。
 *
 * docs/api/*.yaml 是给信息科核对的 OpenAPI 3.1 契约；
 * scripts/check-contract.ts 把契约里的 required / enum 与本文件的常量逐项比对，
 * 任何一侧漂移都会让校验非 0 退出（T9）。
 */
import { DEFAULT_GRADES, DEFAULT_SHIFTS, DEFAULT_REPORTER_ROLES } from "./policy.js";

export const CONTRACT_FILES = [
  "docs/api/nursing-qc.yaml",
  "docs/api/emr.yaml",
  "docs/api/wecom.yaml",
  "docs/api/model.yaml",
] as const;

export interface SchemaSpec {
  required: readonly string[];
  enums?: Record<string, readonly string[]>;
}

/** 契约文件 → schema 名 → 必填字段与枚举。 */
export const CONTRACT_SPECS: Record<string, Record<string, SchemaSpec>> = {
  "nursing-qc.yaml": {
    IncidentReport: {
      required: ["incident_id", "reported_at", "ward_code", "shift_code", "narrative", "reporter_role"],
      enums: { shift_code: DEFAULT_SHIFTS, reporter_role: DEFAULT_REPORTER_ROLES },
    },
    ReviewPayload: {
      required: ["review_result", "grade", "remediation_plan", "plan_deadline", "evidence_refs", "revision"],
      enums: { grade: DEFAULT_GRADES },
    },
    ReviewResponse: { required: ["receipt_id"] },
  },
  "emr.yaml": {
    NursingRecord: { required: ["encounter_id", "records"] },
    RecordItem: { required: ["time", "text", "author_role"] },
  },
  "wecom.yaml": {
    MarkdownMessage: { required: ["msgtype", "markdown"] },
  },
  "model.yaml": {
    ChatCompletionRequest: { required: ["model", "messages", "temperature", "response_format"] },
    ChatCompletionResponse: { required: ["choices", "usage"] },
  },
};

/** 环境变量凭据位：契约与 RuntimeConfig 都只认这些名字，不出现明文密钥。 */
export const CONTRACT_CREDENTIALS = [
  "NURSING_QC_BASE_URL",
  "NURSING_QC_TOKEN",
  "EMR_BASE_URL",
  "EMR_API_TOKEN",
  "WECOM_WEBHOOK_URL",
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
] as const;
