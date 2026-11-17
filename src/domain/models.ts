/**
 * 领域模型（单一事实来源）。
 *
 * 字段与 docs/api/nursing-qc.yaml 的入站契约一致；
 * encounter_id 缺失时显式为 undefined —— 不猜、不补、不报错，
 * 该件进入「待补住院号」清单（spec §5 权威数据源与实体绑定）。
 */
export const RUN_STATES = [
  "new",
  "extracting",
  "awaiting_grade",
  "remedying",
  "awaiting_review",
  "closed",
  "written_back",
] as const;

export type RunState = (typeof RUN_STATES)[number];

/** 状态中文名：窗口、在办清单、超期清单、台账统一取这里。 */
export const STATE_LABELS: Record<RunState, string> = {
  new: "已接住",
  extracting: "要素抽取中",
  awaiting_grade: "待分级",
  remedying: "整改中",
  awaiting_review: "措施待复核",
  closed: "待销号",
  written_back: "已闭环",
};

/** 需要等人回复 / 人工确认的挂起态。 */
export const AWAITING_STATES: readonly RunState[] = [
  "awaiting_grade",
  "awaiting_review",
  "closed",
];

/** 护理缺陷上报单（入站）。 */
export interface IncidentReport {
  incident_id: string;
  reported_at: string;
  ward_code: string;
  shift_code: string;
  narrative: string;
  reporter_role: string;
  severity_hint?: string;
  encounter_id?: string;
}

/** 处置单运行态。一件上报 = 一条 run，incident_id 唯一。 */
export interface Run {
  run_id: string;
  incident_id: string;
  status: RunState;
  revision: number;
  ward_code: string;
  shift_code: string;
  narrative_redacted: string;
  assignee_key: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  receipt_id?: string;
  /** 模型降级标记：规则初判草稿，待人工确认 */
  degraded?: number;
  /** 当前失败原因（重试耗尽后展示） */
  last_error?: string;
}

/** 命名步骤落库记录：三时刻（queued / started / ended）+ 操作人 + 幂等哈希。 */
export interface StepRecord {
  step_id: string;
  run_id: string;
  idx: number;
  status: "queued" | "running" | "done" | "failed" | "waiting";
  queued_at: string;
  started_at?: string;
  ended_at?: string;
  operator: string;
  retry_count: number;
  input_hash: string;
  output_hash?: string;
  step_hash?: string;
  last_error?: string;
}

/** 挂起项：独立持久化，不占用内存等待。 */
export interface PauseRecord {
  pause_id: string;
  run_id: string;
  wait_event: string;
  payload_key: string;
  timeout_policy: "等待人工" | "继续等待";
  paused_at: string;
  resumed_at?: string;
  created_at: string;
  updated_at: string;
}

/** 只增不改审计行。 */
export interface AuditEntry {
  id?: number;
  run_id: string;
  operator: string;
  at: string;
  kind: string;
  input_hash: string;
  output_hash: string;
  model_call_id?: string;
  from_state?: string;
  to_state?: string;
  detail?: string;
}

/** 出站盒：回写 / 催办 / 巡检批次的去重与对账载体。 */
export interface OutboxEntry {
  id?: number;
  kind: "review" | "wecom" | "sweep" | "model";
  incident_id: string;
  batch_id: string;
  dedupe_key: string;
  payload: string;
  created_at: string;
  status: "pending" | "sent" | "failed";
  receipt_id?: string;
  error?: string;
}

/** 四类人工确认。 */
export type ConfirmKind = "grade" | "remedy" | "review" | "close";

/** 模型草稿（结构化输出 + 依据原句）。 */
export interface ModelDraft {
  grade?: string;
  remediation_plan?: string;
  review_result?: string;
  plan_deadline?: string;
  evidence_refs: string[];
  degraded?: boolean;
}

/** 质控系统回写 payload（契约字段，见 docs/api/nursing-qc.yaml）。 */
export interface ReviewPayload {
  review_result: string;
  grade: string;
  remediation_plan: string;
  plan_deadline: string;
  evidence_refs: string[];
  revision: number;
}

/** 时间线 trace 输入（T21 纯函数的入参）。 */
export interface StepTrace {
  step_id: string;
  name: string;
  operator: string;
  queued_at: string;
  started_at?: string;
  ended_at?: string;
  status: StepRecord["status"];
}
