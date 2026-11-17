/** T36 · 入站读：分页 + 增量水位 + 单条失败不中断同批 + 缺 encounter_id 不发请求。 */
import { describe, it, expect } from "vitest";
import { OutboundHttp } from "../../src/adapters/http.js";
import { NursingQcReader } from "../../src/adapters/nursing-qc.js";
import { EmrReader, missingEncounterEntry } from "../../src/adapters/emr.js";
import { createFetchStub, type StubResponse } from "../helpers/fetch-stub.js";
import { makeTestConfig, testClock } from "../helpers/fixtures.js";

function reader(responses: StubResponse[]) {
  const stub = createFetchStub(responses);
  const http = new OutboundHttp(makeTestConfig(), { fetchImpl: stub.fetchImpl, clock: testClock() });
  return { stub, http, qc: new NursingQcReader(http), emr: new EmrReader(http) };
}

function row(id: string, reportedAt: string) {
  return {
    incident_id: id,
    reported_at: reportedAt,
    ward_code: "内科三病区",
    shift_code: "白班",
    narrative: "交接班漏项，已按流程补记并上报。",
    reporter_role: "责任护士",
    encounter_id: `ENC-${id}`,
  };
}

describe("adapters · 入站读取", () => {
  it("分页与增量水位：cursor / since / limit 都带上，翻页不丢条目", async () => {
    const { stub, qc } = reader([
      { status: 200, body: { items: [row("INC-1", "2026-11-09T01:00:00.000Z")], next_cursor: "p2" } },
      { status: 200, body: { items: [row("INC-2", "2026-11-09T02:00:00.000Z")], next_cursor: null } },
    ]);
    const page1 = await qc.listIncidents("new", 50, { since: "2026-11-09T00:00:00.000Z" });
    expect(page1.items).toHaveLength(1);
    expect(page1.next_cursor).toBe("p2");
    expect(page1.failed).toBe(0);
    expect(stub.calls[0]!.url).toContain("status=new");
    expect(stub.calls[0]!.url).toContain("limit=50");
    expect(stub.calls[0]!.url).toContain("since=2026-11-09T00%3A00%3A00.000Z");
    expect(stub.calls[0]!.url).not.toContain("cursor=");

    const paged = reader([
      { status: 200, body: { items: [row("INC-1", "2026-11-09T01:00:00.000Z")], next_cursor: "p2" } },
      { status: 200, body: { items: [row("INC-2", "2026-11-09T02:00:00.000Z")], next_cursor: null } },
    ]);
    const all = await paged.qc.listAllNew("2026-11-09T00:00:00.000Z");
    expect(all.map((i) => i.incident_id)).toEqual(["INC-1", "INC-2"]);
    expect(paged.stub.calls).toHaveLength(2);
    expect(paged.stub.calls[1]!.url).toContain("cursor=p2");
  });

  it("单条字段异常不中断同批，失败数如实返回", async () => {
    const { qc } = reader([
      { status: 200, body: { items: [row("INC-1", "2026-11-09T01:00:00.000Z"), { narrative: "无单号" }, row("INC-3", "2026-11-09T03:00:00.000Z")], next_cursor: null } },
    ]);
    const page = await qc.listIncidents("new", 50);
    expect(page.items.map((i) => i.incident_id)).toEqual(["INC-1", "INC-3"]);
    expect(page.failed).toBe(1);
  });

  it("缺 encounter_id 时 EMR 请求数 = 0，并列入待补住院号清单", async () => {
    const { stub, emr } = reader([{ status: 200, body: { records: [] } }]);
    const result = await emr.getNursingRecords(undefined);
    expect(result.missingEncounter).toBe(true);
    expect(result.requestCount).toBe(0);
    expect(result.records).toEqual([]);
    expect(stub.calls).toHaveLength(0);
    expect(missingEncounterEntry("INC-9", "内科三病区", "白班")).toMatchObject({
      incident_id: "INC-9",
      reason: "缺住院号，未调用 EMR 接口",
    });
  });

  it("有 encounter_id 时按契约字段映射护理记录，只发一次请求", async () => {
    const { stub, emr } = reader([
      { status: 200, body: { encounter_id: "ENC-1", records: [{ time: "2026-11-09T02:00:00.000Z", text: "翻身并记录", author_role: "责任护士" }] } },
    ]);
    const result = await emr.getNursingRecords("ENC-1");
    expect(result.requestCount).toBe(1);
    expect(result.missingEncounter).toBe(false);
    expect(result.records[0]).toEqual({ time: "2026-11-09T02:00:00.000Z", text: "翻身并记录", author_role: "责任护士" });
    expect(stub.calls[0]!.url).toContain("encounter_id=ENC-1");
    const headers = stub.calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer emr123456");
  });

  it("读失败时按错误分类抛出可读原因，不返回假数据", async () => {
    const { qc } = reader([{ status: 500, body: { error: "down" } }]);
    await expect(qc.listIncidents("new", 50)).rejects.toThrow(/读取上报列表失败/);
  });
});
