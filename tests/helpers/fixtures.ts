/** 测试共享夹具：凭据位只用假值，且不进入 src/ 生产路径。 */
import { openDatabase, type Database } from "../../src/store/db.js";
import { fixedClock } from "../../src/util/clock.js";
import type { RuntimeConfig } from "../../src/config/runtime-config.js";
import type { IncidentReport } from "../../src/domain/models.js";

export function freshDb(): Database {
  return openDatabase(":memory:");
}

export function testClock(startIso = "2026-11-09T00:00:00.000Z") {
  return fixedClock(Date.parse(startIso));
}

export function makeTestConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    nursingQcBaseUrl: "https://qc.internal.test",
    nursingQcToken: "tok123456",
    emrBaseUrl: "https://emr.internal.test",
    emrApiToken: "emr123456",
    wecomWebhookUrl: "https://wecom.internal.test/hook",
    modelBaseUrl: "https://model.internal.test",
    modelApiKey: "key123456",
    modelName: "test-model",
    modelTimeout: 1000,
    modelMaxRetries: 2,
    modelTemperature: 0.2,
    pollIntervalSec: 60,
    dailySweepAt: "08:00",
    sources: {},
    ...overrides,
  };
}

export function makeIncident(overrides: Partial<IncidentReport> = {}): IncidentReport {
  return {
    incident_id: "INC-TEST-0001",
    reported_at: "2026-11-09T00:00:00.000Z",
    ward_code: "内科三病区",
    shift_code: "白班",
    narrative: "交接班漏项，已按流程补记并上报。",
    reporter_role: "责任护士",
    ...overrides,
  };
}

/** 让 audit 写入失败的库代理，用来验证「失败不静默改数据」。 */
export function auditFailingDb(real: Database): Database {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes("INSERT INTO audit")) throw new Error("audit write failed (injected)");
          return target.prepare(sql);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Database;
}
