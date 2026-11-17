/** T38 · 企微催办：同批次单次、跨批次复查可重推、脱敏、失败写审计不阻断主流程。 */
import { describe, it, expect } from "vitest";
import { OutboundHttp } from "../../src/adapters/http.js";
import { pushReminders, type ReminderItem } from "../../src/adapters/wecom.js";
import { containsPatientIdentifier, PATIENT_IDENTIFIER_FIELDS } from "../../src/domain/redact.js";
import { readAudit } from "../../src/store/audit.js";
import { createFetchStub } from "../helpers/fetch-stub.js";
import { freshDb, makeTestConfig, testClock } from "../helpers/fixtures.js";

const ITEM: ReminderItem = {
  incident_id: "INC-2026-0001",
  ward_code: "内科三病区",
  shift_code: "白班",
  current_step: "待分级",
  elapsed_ms: 3 * 3_600_000,
};

function setup(status = 200) {
  const stub = createFetchStub([{ status, body: { errcode: 0, errmsg: "ok" } }]);
  const db = freshDb();
  const http = new OutboundHttp(makeTestConfig(), { fetchImpl: stub.fetchImpl, clock: testClock(), db });
  return { stub, db, http, deps: { http, db, clock: testClock() } };
}

describe("adapters · 企微催办", () => {
  it("同批次重复推送次数 = 1；跨批次超期复查允许重推", async () => {
    const { stub, db, deps } = setup();
    const first = await pushReminders([ITEM], "batch-20261109", deps);
    const again = await pushReminders([ITEM], "batch-20261109", deps);
    expect(first.sent).toBe(1);
    expect(again.sent).toBe(0);
    expect(again.skipped).toBe(1);
    expect(stub.calls).toHaveLength(1);
    const nextBatch = await pushReminders([ITEM], "batch-20261110", deps);
    expect(nextBatch.sent).toBe(1);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0]!.url).toBe("https://wecom.internal.test/hook");
    db.close();
  });

  it("消息体为 markdown 且只含业务字段，不含患者标识", async () => {
    const { stub, db, deps } = setup();
    await pushReminders([{ ...ITEM, ward_code: "内科三病区 住院号：AB123456" }], "batch-mask", deps);
    const body = JSON.parse(String(stub.calls[0]!.init.body)) as {
      msgtype: string;
      markdown: { content: string };
    };
    expect(body.msgtype).toBe("markdown");
    const content = body.markdown.content;
    expect(content).toContain("上报单号");
    expect(content).toContain("停留时长");
    expect(containsPatientIdentifier(content)).toBe(false);
    for (const field of PATIENT_IDENTIFIER_FIELDS) expect(content).not.toContain(field);
    expect(content).toContain("[已脱敏]");
    db.close();
  });

  it("推送失败写审计且不抛未捕获异常，不阻断主处置流程", async () => {
    const { stub, db, deps } = setup(500);
    await expect(pushReminders([ITEM], "batch-fail", deps)).resolves.toMatchObject({ sent: 0, failed: 1 });
    expect(stub.calls).toHaveLength(1);
    const failed = readAudit(db).filter((r) => r.kind === "wecom_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.detail).toContain("batch-fail");
    db.close();
  });

  it("多件同批逐件独立去重", async () => {
    const { stub, db, deps } = setup();
    const items = [ITEM, { ...ITEM, incident_id: "INC-2026-0002" }];
    const result = await pushReminders(items, "batch-multi", deps);
    expect(result.sent).toBe(2);
    expect(stub.calls).toHaveLength(2);
    const repeat = await pushReminders(items, "batch-multi", deps);
    expect(repeat.skipped).toBe(2);
    expect(stub.calls).toHaveLength(2);
    db.close();
  });
});
