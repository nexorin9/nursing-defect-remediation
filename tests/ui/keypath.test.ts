/** T45 · UI 关键路径：上报 → 列表 → 四类确认 → 销号回执；degraded 文案；长文本；键盘可达。 */
import { describe, it, expect } from "vitest";
import { Engine } from "../../src/runtime/engine.js";
import { STEP_DEFS } from "../../src/runtime/steps.js";
import { buildTimeline } from "../../src/runtime/timeline.js";
import { HOUR_MS } from "../../src/util/clock.js";
import type { StepTrace } from "../../src/domain/models.js";
import { buildWorkbenchView, renderLongNarrative, keyboardAttrs, type WorkbenchItem } from "../../src/ui/workbench.js";
import { buildTimelineView, stepSegmentCount, highlightQuotes } from "../../src/ui/timeline-view.js";
import {
  confirmGateView, decidePost, applyConfirmation, CONFIRM_KINDS, type ConfirmStates,
} from "../../src/ui/confirm-gate.js";
import { freshDb, makeIncident, testClock } from "../helpers/fixtures.js";

const RECEIPT = "RCP-KEYPATH-0001";

describe("UI 关键路径（全部走本地替身，不发真实请求）", () => {
  it("上报到达 → 列表出现 → 分级 / 措施 / 复核 / 销号确认 → 回显回执", async () => {
    const db = freshDb();
    const clock = testClock();
    let writebackHookCalls = 0;
    const engine = new Engine({
      db,
      clock,
      hooks: {
        onWriteback: async () => {
          writebackHookCalls += 1;
          return { ok: true, receipt_id: RECEIPT };
        },
      },
    });
    const incident = makeIncident({ narrative: "交接班漏项，已按流程补记并上报。" });
    const scheduled = engine.schedule(incident);
    expect(scheduled.created).toBe(true);

    // 收到上报：执行到第一个人工确认点
    await engine.execute(scheduled.run.run_id);
    expect(engine.getRun(scheduled.run.run_id)?.status).toBe("awaiting_grade");

    const item: WorkbenchItem = {
      incident_id: incident.incident_id,
      ward_code: incident.ward_code,
      shift_code: incident.shift_code,
      status: "awaiting_grade",
      statusLabel: "待分级",
      dwellMinutes: 0,
      overdue: false,
    };
    let view = buildWorkbenchView([item]);
    expect(view.items[0]!.incident_id).toBe(incident.incident_id);
    expect(view.header.open).toBe(1);
    expect(confirmGateView({}).disabled).toBe(true);
    expect(decidePost({}).postCount).toBe(0);

    // 四类人工确认依次点击（销号要二次确认）
    let states: ConfirmStates = {};
    const expectedStatus = ["remedying", "awaiting_review", "closed", "written_back"];
    const timelineStates: string[] = [];
    for (let i = 0; i < CONFIRM_KINDS.length; i += 1) {
      const kind = CONFIRM_KINDS[i]!;
      states = applyConfirmation(states, kind);
      if (kind === "close") states = applyConfirmation(states, kind);
      expect(confirmGateView(states).confirmedCount).toBe(i + 1);
      clock.advance(HOUR_MS);
      const resumed = await engine.resume(scheduled.run.run_id, {
        kind,
        confirmed: true,
        operator: "护士长",
        payloadKey: incident.incident_id,
      });
      expect(resumed.advanced).toBe(true);
      const status = engine.getRun(scheduled.run.run_id)?.status;
      expect(status).toBe(expectedStatus[i]);
      timelineStates.push(String(status));
    }
    expect(timelineStates).toEqual(expectedStatus);
    expect(writebackHookCalls).toBe(1);
    const run = engine.getRun(scheduled.run.run_id)!;
    expect(run.receipt_id).toBe(RECEIPT);
    const gate = confirmGateView(states, { receiptId: run.receipt_id });
    expect(gate.disabled).toBe(false);
    expect(gate.receiptId).toBe(RECEIPT);
    expect(decidePost(states).postCount).toBe(1);

    // 时间线分段数与运行库步骤数一致
    const records = engine.stepRecords(scheduled.run.run_id);
    const traces: StepTrace[] = records.map((r, idx) => ({
      step_id: r.step_id,
      name: STEP_DEFS[idx]?.name ?? r.step_id,
      operator: r.operator,
      queued_at: r.queued_at,
      ...(r.started_at ? { started_at: r.started_at } : {}),
      ...(r.ended_at ? { ended_at: r.ended_at } : {}),
      status: r.status,
    }));
    const timelineView = buildTimelineView(buildTimeline(traces, clock.now()));
    expect(stepSegmentCount(timelineView)).toBe(records.length);
    expect(highlightQuotes(incident.narrative, ["交接班漏项"], [])).toContain("<mark");
    db.close();
  });

  it("degraded 场景显示规则初判文案，结论标草稿", () => {
    const view = confirmGateView({}, { degraded: true });
    expect(view.degradedNotice).toContain("模型不可达，已用规则初判，待人工确认");
    expect(view.degradedNotice).toContain("草稿");
    expect(view.disabled).toBe(true);
  });

  it("长叙述与生僻字不破版；列表项与确认按钮可 Tab 聚焦", () => {
    const long = "交接班漏项，㐀𠮷妧𠀀㒰。".repeat(80);
    const rendered = renderLongNarrative(long, 140);
    expect(rendered.truncated).toBe(true);
    expect(rendered.html).toContain("ndr-narrative");
    expect(keyboardAttrs({
      incident_id: "INC-1", ward_code: "内科三病区", shift_code: "白班",
      status: "awaiting_grade", statusLabel: "待分级", dwellMinutes: 1, overdue: false,
    })).toMatchObject({ tabindex: "0", role: "button" });
  });
});
