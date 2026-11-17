/**
 * 运行时配置归一层（RuntimeConfig）。
 *
 * 归一思路参考「部署配置归一」这一类做法：命令行与文件配置都可以是部分的，
 * 因此运行时应消费**一份具体结构**，而不是在各处重复写「URL 拼装 + 默认值」。
 * 本文件把这套做法改写到院内场景：
 *
 *   源做法   : RuntimeConfig{ 多个 base_url + 事件密钥 + 签名密钥 + Timeout }，
 *              TimeoutOrDefault(60s) —— 非法超时回落默认值，URL 解析失败即报错。
 *   本产品   : RuntimeConfig{ 4 个 base_url + 4 组凭据 + 模型参数 + 节奏参数 }，
 *              缺任一**必填**凭据时启动即报错并点名缺失的环境变量；
 *              可选项非法时回落默认值并标注来源（env / default），
 *              避免「悄悄按自造数字催办」或「悄悄换个端点」。
 *
 * 约定：
 *   - 凭据只从环境变量读，代码里不出现任何默认密钥；
 *   - 业务模块一律消费 RuntimeConfig，不自行读取 process.env；
 *   - 脱敏摘要 redact() 供 doctor / 运行日志使用，避免密钥进日志。
 */

/** 某一项配置的实际来源：来自环境变量，还是回落到默认值。 */
export type ConfigSource = "env" | "default";

/** 环境变量名 → 是否必填。必填项缺失即启动失败。 */
export const REQUIRED_ENV_VARS = [
  "NURSING_QC_BASE_URL",
  "NURSING_QC_TOKEN",
  "EMR_BASE_URL",
  "EMR_API_TOKEN",
  "WECOM_WEBHOOK_URL",
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
] as const;

/** 可选项的默认值（源做法里的 TimeoutOrDefault 在这里的对应位置）。 */
export const CONFIG_DEFAULTS = {
  modelName: "gpt-4o-mini",
  modelTimeout: 30_000,
  modelMaxRetries: 2,
  modelTemperature: 0.2,
  pollIntervalSec: 60,
  dailySweepAt: "08:00",
} as const;

/** 归一后的运行时配置：端点 + 凭据 + 参数一份结构。 */
export interface RuntimeConfig {
  /** 护理质控上报系统基地址（读上报 / 回写整改结论） */
  nursingQcBaseUrl: string;
  /** 护理质控系统接口令牌 */
  nursingQcToken: string;
  /** 电子病历基地址（读护理记录） */
  emrBaseUrl: string;
  /** 电子病历接口令牌 */
  emrApiToken: string;
  /** 企业微信群机器人 webhook（超期催办） */
  wecomWebhookUrl: string;
  /** 模型服务基地址（OpenAI-compatible） */
  modelBaseUrl: string;
  /** 模型服务密钥 */
  modelApiKey: string;
  /** 模型名 */
  modelName: string;
  /** 单次模型调用超时（毫秒） */
  modelTimeout: number;
  /** 模型调用最大重试次数 */
  modelMaxRetries: number;
  /** 模型采样温度 */
  modelTemperature: number;
  /** 上报轮询间隔（秒） */
  pollIntervalSec: number;
  /** 每日超期巡检时刻（HH:mm） */
  dailySweepAt: string;
  /** 每个字段的实际来源，便于运行摘要说明「哪些是按默认值在跑」 */
  sources: Record<string, ConfigSource>;
}

/** 必填环境变量缺失时抛出；错误文案点名缺失变量名。 */
export class MissingEnvError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`MISSING ENV: ${missing.join(", ")}`);
    this.name = "MissingEnvError";
    this.missing = missing;
  }
}

/** 必填环境变量的取值非法（URL 解析失败 / 协议不对）时抛出。 */
export class InvalidEnvError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`INVALID ENV: ${field} ${detail}`);
    this.name = "InvalidEnvError";
    this.field = field;
  }
}

export type EnvLike = Record<string, string | undefined>;

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

/** 校验 base_url：必须是可解析的 http(s) 地址。 */
function assertHttpUrl(field: string, raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new InvalidEnvError(field, `不是合法 URL：${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidEnvError(field, `协议必须是 http/https，收到 ${parsed.protocol}`);
  }
  // 去掉尾部斜杠，避免拼路径时出现双斜杠
  return raw.replace(/\/+$/, "");
}

/**
 * 读取可选项：非法值（非数字 / 非正数 / 超范围）回落默认值，并标注来源为 default。
 * 对齐源做法里 TimeoutOrDefault 的语义：超时不报错，但必须能被看见。
 */
function readOptionalNumber(
  env: EnvLike,
  field: string,
  fallback: number,
  bounds: { min: number; max: number },
): { value: number; source: ConfigSource } {
  const raw = trimmed(env[field]);
  if (raw === "") {
    return { value: fallback, source: "default" };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < bounds.min || parsed > bounds.max) {
    return { value: fallback, source: "default" };
  }
  return { value: parsed, source: "env" };
}

/** 读取可选项字符串：空值回落默认值。 */
function readOptionalString(
  env: EnvLike,
  field: string,
  fallback: string,
): { value: string; source: ConfigSource } {
  const raw = trimmed(env[field]);
  if (raw === "") {
    return { value: fallback, source: "default" };
  }
  return { value: raw, source: "env" };
}

/** 巡检时刻格式校验：HH:mm（24 小时制，分钟 00–59）。 */
function isValidSweepTime(value: string): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

/**
 * 从环境变量装配 RuntimeConfig。
 *
 * 缺任一必填项 → 抛 MissingEnvError（文案含 `MISSING ENV: <变量名>`）。
 * 可选项非法 → 回落默认值并在 sources 中标注 default。
 */
export function loadRuntimeConfig(env: EnvLike = process.env): RuntimeConfig {
  const sources: Record<string, ConfigSource> = {};
  const missing: string[] = [];

  for (const name of REQUIRED_ENV_VARS) {
    if (trimmed(env[name]) === "") {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new MissingEnvError(missing);
  }

  /** 必填项取值（上面已统一校验过存在性，这里再兜一层防御）。 */
  const required = (name: string): string => {
    const value = trimmed(env[name]);
    if (value === "") {
      throw new MissingEnvError([name]);
    }
    return value;
  };

  const nursingQcBaseUrl = assertHttpUrl(
    "NURSING_QC_BASE_URL",
    required("NURSING_QC_BASE_URL"),
  );
  const emrBaseUrl = assertHttpUrl("EMR_BASE_URL", required("EMR_BASE_URL"));
  const modelBaseUrl = assertHttpUrl("MODEL_BASE_URL", required("MODEL_BASE_URL"));
  const wecomWebhookUrl = assertHttpUrl(
    "WECOM_WEBHOOK_URL",
    required("WECOM_WEBHOOK_URL"),
  );

  const modelName = readOptionalString(env, "MODEL_NAME", CONFIG_DEFAULTS.modelName);
  const modelTimeout = readOptionalNumber(
    env,
    "MODEL_TIMEOUT",
    CONFIG_DEFAULTS.modelTimeout,
    { min: 1, max: 600_000 },
  );
  const modelMaxRetries = readOptionalNumber(
    env,
    "MODEL_MAX_RETRIES",
    CONFIG_DEFAULTS.modelMaxRetries,
    { min: 0, max: 10 },
  );
  const modelTemperature = readOptionalNumber(
    env,
    "MODEL_TEMPERATURE",
    CONFIG_DEFAULTS.modelTemperature,
    { min: 0, max: 2 },
  );
  const pollIntervalSec = readOptionalNumber(
    env,
    "POLL_INTERVAL_SEC",
    CONFIG_DEFAULTS.pollIntervalSec,
    { min: 5, max: 3600 },
  );

  const sweepRaw = readOptionalString(env, "DAILY_SWEEP_AT", CONFIG_DEFAULTS.dailySweepAt);
  const dailySweepAt = isValidSweepTime(sweepRaw.value)
    ? sweepRaw
    : { value: CONFIG_DEFAULTS.dailySweepAt, source: "default" as ConfigSource };

  sources.MODEL_NAME = modelName.source;
  sources.MODEL_TIMEOUT = modelTimeout.source;
  sources.MODEL_MAX_RETRIES = modelMaxRetries.source;
  sources.MODEL_TEMPERATURE = modelTemperature.source;
  sources.POLL_INTERVAL_SEC = pollIntervalSec.source;
  sources.DAILY_SWEEP_AT = dailySweepAt.source;

  return {
    nursingQcBaseUrl,
    nursingQcToken: required("NURSING_QC_TOKEN"),
    emrBaseUrl,
    emrApiToken: required("EMR_API_TOKEN"),
    wecomWebhookUrl,
    modelBaseUrl,
    modelApiKey: required("MODEL_API_KEY"),
    modelName: modelName.value,
    modelTimeout: modelTimeout.value,
    modelMaxRetries: modelMaxRetries.value,
    modelTemperature: modelTemperature.value,
    pollIntervalSec: pollIntervalSec.value,
    dailySweepAt: dailySweepAt.value,
    sources,
  };
}

/**
 * 脱敏摘要：给 doctor 命令与运行日志用。
 * 凭据只显示「是否已配置」，绝不回显明文。
 */
export function redact(config: RuntimeConfig): Record<string, string> {
  const mask = (value: string): string =>
    value === "" ? "(未配置)" : `${value.slice(0, 4)}***${value.slice(-2)}`;
  return {
    nursingQcBaseUrl: config.nursingQcBaseUrl,
    nursingQcToken: mask(config.nursingQcToken),
    emrBaseUrl: config.emrBaseUrl,
    emrApiToken: mask(config.emrApiToken),
    wecomWebhookUrl: mask(config.wecomWebhookUrl),
    modelBaseUrl: config.modelBaseUrl,
    modelApiKey: mask(config.modelApiKey),
    modelName: config.modelName,
    modelTimeout: String(config.modelTimeout),
    modelMaxRetries: String(config.modelMaxRetries),
    modelTemperature: String(config.modelTemperature),
    pollIntervalSec: String(config.pollIntervalSec),
    dailySweepAt: config.dailySweepAt,
  };
}

/**
 * 按来源列出哪些配置在按默认值运行。
 * 口径「未配置」的项目必须在窗口上明说，不能让护理部误以为制度时限已生效。
 */
export function defaultedFields(config: RuntimeConfig): string[] {
  return Object.entries(config.sources)
    .filter(([, source]) => source === "default")
    .map(([field]) => field);
}
