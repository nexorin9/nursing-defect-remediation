import { describe, expect, it } from "vitest";

import {
  CONFIG_DEFAULTS,
  InvalidEnvError,
  MissingEnvError,
  defaultedFields,
  loadRuntimeConfig,
  redact,
  type EnvLike,
} from "../../src/config/runtime-config.js";

/** 一份「全部齐备」的环境变量样例：凭据为占位串，不含任何真实密钥。 */
const completeEnv: EnvLike = {
  NURSING_QC_BASE_URL: "https://nursing-qc.example-hospital.local",
  NURSING_QC_TOKEN: "qc-token-placeholder",
  EMR_BASE_URL: "https://emr.example-hospital.local",
  EMR_API_TOKEN: "emr-token-placeholder",
  WECOM_WEBHOOK_URL: "https://qyapi.example-hospital.local/cgi-bin/webhook/send",
  MODEL_BASE_URL: "https://model-gateway.example-hospital.local",
  MODEL_API_KEY: "model-key-placeholder",
  MODEL_NAME: "qwen2.5-instruct",
  MODEL_TIMEOUT: "15000",
  MODEL_MAX_RETRIES: "3",
  MODEL_TEMPERATURE: "0.1",
  POLL_INTERVAL_SEC: "90",
  DAILY_SWEEP_AT: "09:30",
};

describe("RuntimeConfig · 一组：全部齐备", () => {
  it("端点、凭据与参数全部落到归一后的结构上", () => {
    const config = loadRuntimeConfig(completeEnv);

    expect(config.nursingQcBaseUrl).toBe("https://nursing-qc.example-hospital.local");
    expect(config.nursingQcToken).toBe("qc-token-placeholder");
    expect(config.emrBaseUrl).toBe("https://emr.example-hospital.local");
    expect(config.emrApiToken).toBe("emr-token-placeholder");
    expect(config.wecomWebhookUrl).toBe(
      "https://qyapi.example-hospital.local/cgi-bin/webhook/send",
    );
    expect(config.modelBaseUrl).toBe("https://model-gateway.example-hospital.local");
    expect(config.modelApiKey).toBe("model-key-placeholder");
    expect(config.modelName).toBe("qwen2.5-instruct");
    expect(config.modelTimeout).toBe(15_000);
    expect(config.modelMaxRetries).toBe(3);
    expect(config.modelTemperature).toBe(0.1);
    expect(config.pollIntervalSec).toBe(90);
    expect(config.dailySweepAt).toBe("09:30");
  });

  it("所有字段的来源都标注为 env（没有一项在悄悄走默认值）", () => {
    const config = loadRuntimeConfig(completeEnv);
    expect(Object.values(config.sources).every((s) => s === "env")).toBe(true);
    expect(defaultedFields(config)).toEqual([]);
  });

  it("base_url 尾斜杠被去掉，拼路径时不会出现双斜杠", () => {
    const config = loadRuntimeConfig({
      ...completeEnv,
      NURSING_QC_BASE_URL: "https://nursing-qc.example-hospital.local/",
    });
    expect(config.nursingQcBaseUrl).toBe("https://nursing-qc.example-hospital.local");
  });

  it("脱敏摘要不回显凭据明文", () => {
    const config = loadRuntimeConfig(completeEnv);
    const summary = redact(config);
    expect(summary.nursingQcToken).not.toContain("qc-token-placeholder");
    expect(summary.modelApiKey).not.toContain("model-key-placeholder");
    expect(JSON.stringify(summary)).not.toContain("placeholder");
  });
});

describe("RuntimeConfig · 二组：缺必填项", () => {
  it("缺 NURSING_QC_TOKEN 时抛错，错误文案点名该变量名", () => {
    const env: EnvLike = { ...completeEnv };
    delete env.NURSING_QC_TOKEN;

    expect(() => loadRuntimeConfig(env)).toThrow(MissingEnvError);
    try {
      loadRuntimeConfig(env);
      throw new Error("本应抛错但没有");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingEnvError);
      expect((error as MissingEnvError).message).toContain("MISSING ENV: NURSING_QC_TOKEN");
      expect((error as MissingEnvError).missing).toEqual(["NURSING_QC_TOKEN"]);
    }
  });

  it("缺多项时列出全部缺失变量名", () => {
    const env: EnvLike = { ...completeEnv };
    delete env.NURSING_QC_TOKEN;
    delete env.MODEL_API_KEY;

    try {
      loadRuntimeConfig(env);
      throw new Error("本应抛错但没有");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingEnvError);
      const missing = (error as MissingEnvError).missing;
      expect(missing).toContain("NURSING_QC_TOKEN");
      expect(missing).toContain("MODEL_API_KEY");
      expect((error as MissingEnvError).message).toContain("MISSING ENV:");
    }
  });

  it("空白值等同于缺失（只有空格不算配置）", () => {
    const env: EnvLike = { ...completeEnv, NURSING_QC_TOKEN: "   " };
    expect(() => loadRuntimeConfig(env)).toThrow(/MISSING ENV: NURSING_QC_TOKEN/);
  });

  it("必填 base_url 不是合法 http(s) 地址时报错并点名变量", () => {
    expect(() =>
      loadRuntimeConfig({ ...completeEnv, EMR_BASE_URL: "not-a-url" }),
    ).toThrow(InvalidEnvError);
    try {
      loadRuntimeConfig({ ...completeEnv, EMR_BASE_URL: "ftp://emr.example.local" });
      throw new Error("本应抛错但没有");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvError);
      expect((error as InvalidEnvError).message).toContain("EMR_BASE_URL");
    }
  });
});

describe("RuntimeConfig · 三组：超时等可选值非法回落默认", () => {
  it("MODEL_TIMEOUT 不是数字时回落默认 30000 毫秒并标注来源 default", () => {
    const config = loadRuntimeConfig({ ...completeEnv, MODEL_TIMEOUT: "abc" });
    expect(config.modelTimeout).toBe(CONFIG_DEFAULTS.modelTimeout);
    expect(config.sources.MODEL_TIMEOUT).toBe("default");
    expect(defaultedFields(config)).toContain("MODEL_TIMEOUT");
  });

  it("MODEL_TIMEOUT 越界（负数 / 过大）时同样回落默认", () => {
    expect(loadRuntimeConfig({ ...completeEnv, MODEL_TIMEOUT: "-1" }).modelTimeout).toBe(
      CONFIG_DEFAULTS.modelTimeout,
    );
    expect(
      loadRuntimeConfig({ ...completeEnv, MODEL_TIMEOUT: "999999999" }).modelTimeout,
    ).toBe(CONFIG_DEFAULTS.modelTimeout);
  });

  it("MODEL_TIMEOUT 合法时按环境变量取值并标注来源 env", () => {
    const config = loadRuntimeConfig({ ...completeEnv, MODEL_TIMEOUT: "5000" });
    expect(config.modelTimeout).toBe(5_000);
    expect(config.sources.MODEL_TIMEOUT).toBe("env");
  });

  it("未提供可选项时全部回落默认值且不抛错", () => {
    const minimal: EnvLike = {
      NURSING_QC_BASE_URL: completeEnv.NURSING_QC_BASE_URL!,
      NURSING_QC_TOKEN: completeEnv.NURSING_QC_TOKEN!,
      EMR_BASE_URL: completeEnv.EMR_BASE_URL!,
      EMR_API_TOKEN: completeEnv.EMR_API_TOKEN!,
      WECOM_WEBHOOK_URL: completeEnv.WECOM_WEBHOOK_URL!,
      MODEL_BASE_URL: completeEnv.MODEL_BASE_URL!,
      MODEL_API_KEY: completeEnv.MODEL_API_KEY!,
    };
    const config = loadRuntimeConfig(minimal);
    expect(config.modelName).toBe(CONFIG_DEFAULTS.modelName);
    expect(config.modelTimeout).toBe(CONFIG_DEFAULTS.modelTimeout);
    expect(config.modelMaxRetries).toBe(CONFIG_DEFAULTS.modelMaxRetries);
    expect(config.modelTemperature).toBe(CONFIG_DEFAULTS.modelTemperature);
    expect(config.pollIntervalSec).toBe(CONFIG_DEFAULTS.pollIntervalSec);
    expect(config.dailySweepAt).toBe(CONFIG_DEFAULTS.dailySweepAt);
    expect(defaultedFields(config).sort()).toEqual([
      "DAILY_SWEEP_AT",
      "MODEL_MAX_RETRIES",
      "MODEL_NAME",
      "MODEL_TEMPERATURE",
      "MODEL_TIMEOUT",
      "POLL_INTERVAL_SEC",
    ]);
  });

  it("巡检时刻格式非法时回落默认 08:00 并标注来源 default", () => {
    const config = loadRuntimeConfig({ ...completeEnv, DAILY_SWEEP_AT: "25:99" });
    expect(config.dailySweepAt).toBe(CONFIG_DEFAULTS.dailySweepAt);
    expect(config.sources.DAILY_SWEEP_AT).toBe("default");
  });
});
