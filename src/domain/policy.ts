/**
 * 口径配置化（分级枚举 / 各步时限 / 催办时刻）。
 *
 * 资产纪律（spec §6）：domain/ 资产层没有护理缺陷分级文件、也没有各步处置时限条款，
 * 因此本文件**不写死可用的时限数字**：默认 stepDueHours 为空，
 * 未配置时限时 isOverdue() 返回 undefined（不是 false），UI 显示「未设定时限」，
 * 巡检不产生催办条目。只有来源标注为「院内制度导入」的时限才参与超期判定。
 */
import type { RunState } from "./models.js";

export type ConfigSource = "院内制度导入" | "经验推断·待核验";

export interface ConfigItem<T> {
  value: T;
  source: ConfigSource;
  note?: string;
}

export interface QcPolicy {
  grades: ConfigItem<string[]>;
  shiftCodes: ConfigItem<string[]>;
  reporterRoles: ConfigItem<string[]>;
  wardCodes: ConfigItem<string[]>;
  /** 各状态允许停留的小时数；缺省 = 未设定时限 */
  stepDueHours: ConfigItem<Partial<Record<RunState, number>>>;
  dailySweepAt: ConfigItem<string>;
  concurrencyLimit: ConfigItem<number>;
  pauseTimeoutPolicy: ConfigItem<"等待人工" | "继续等待">;
  drainTimeoutSec: ConfigItem<number>;
  /** 每百万 token 单价；未配置时成本为 undefined，不伪造 0 */
  modelPricePerMillion: ConfigItem<{ input: number; output: number } | undefined>;
}

/** 经验推断的默认值：只用于枚举展示，**不得**进入催办或超期判定。 */
export const DEFAULT_GRADES = ["Ⅰ级", "Ⅱ级", "Ⅲ级", "Ⅳ级"] as const;
export const DEFAULT_SHIFTS = ["白班", "小夜班", "大夜班"] as const;
export const DEFAULT_REPORTER_ROLES = ["责任护士", "护理组长", "护士长", "质控员"] as const;

export type PolicyOverrides = Partial<{ [K in keyof QcPolicy]: Partial<QcPolicy[K]> | QcPolicy[K] }>;

/** 构造口径配置。默认所有时限为空，来源一律显式标注。 */
export function createPolicy(overrides: PolicyOverrides = {}): QcPolicy {
  const merge = <T>(fallback: ConfigItem<T>, patch?: Partial<ConfigItem<T>> | ConfigItem<T>): ConfigItem<T> =>
    ({
      value: (patch?.value ?? fallback.value) as T,
      source: patch?.source ?? fallback.source,
      note: (patch as ConfigItem<T> | undefined)?.note ?? fallback.note,
    });

  return {
    grades: merge(
      { value: [...DEFAULT_GRADES], source: "经验推断·待核验", note: "院内分级细则待核验" },
      overrides.grades,
    ),
    shiftCodes: merge({ value: [...DEFAULT_SHIFTS], source: "院内制度导入" }, overrides.shiftCodes),
    reporterRoles: merge(
      { value: [...DEFAULT_REPORTER_ROLES], source: "院内制度导入" },
      overrides.reporterRoles,
    ),
    wardCodes: merge({ value: [], source: "院内制度导入", note: "由上报系统字典导入" }, overrides.wardCodes),
    stepDueHours: merge(
      {
        value: {},
        source: "经验推断·待核验",
        note: "资产层无处置时限条款；未导入前不判定超期、不催办",
      },
      overrides.stepDueHours,
    ),
    dailySweepAt: merge({ value: "08:00", source: "经验推断·待核验", note: "巡检时刻待院方确认" }, overrides.dailySweepAt),
    concurrencyLimit: merge({ value: 2, source: "经验推断·待核验" }, overrides.concurrencyLimit),
    pauseTimeoutPolicy: merge({ value: "等待人工", source: "经验推断·待核验" }, overrides.pauseTimeoutPolicy),
    drainTimeoutSec: merge({ value: 10, source: "经验推断·待核验" }, overrides.drainTimeoutSec),
    modelPricePerMillion: merge(
      { value: undefined, source: "经验推断·待核验", note: "未配置单价时窗口显示「未配置单价」" },
      overrides.modelPricePerMillion,
    ),
  };
}

/** 取某状态的时限（小时）；无配置或未导入 → undefined。 */
export function dueHoursFor(policy: QcPolicy, state: RunState): number | undefined {
  if (policy.stepDueHours.source !== "院内制度导入") return undefined;
  return policy.stepDueHours.value[state];
}

/**
 * 是否超期。无时限配置时返回 undefined（三态），调用方不得把 undefined 当 false 用。
 */
export function isOverdue(policy: QcPolicy, state: RunState, elapsedMs: number): boolean | undefined {
  const hours = dueHoursFor(policy, state);
  if (hours === undefined) return undefined;
  return elapsedMs > hours * 3_600_000;
}

export interface OverdueCandidate {
  incident_id: string;
  run_id: string;
  status: RunState;
  elapsed_ms: number;
}

/** 催办队列：无时限配置的件一律不进队列（T5 断言长度为 0）。 */
export function buildReminderQueue(policy: QcPolicy, candidates: OverdueCandidate[]): OverdueCandidate[] {
  return candidates
    .filter((c) => isOverdue(policy, c.status, c.elapsed_ms) === true)
    .sort((a, b) => b.elapsed_ms - a.elapsed_ms);
}

/** 巡检时刻解析：HH:mm → 当日 UTC 分钟数（纯函数，便于注入时钟测试）。 */
export function sweepMinuteOfDay(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return 8 * 60;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 所有参与口径判定的配置项都必须有来源标注。 */
export function hasSource(policy: QcPolicy): boolean {
  return Object.values(policy).every((item) => typeof (item as ConfigItem<unknown>).source === "string" && (item as ConfigItem<unknown>).source.length > 0);
}
