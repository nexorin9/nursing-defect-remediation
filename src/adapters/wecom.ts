/**
 * adapters · 企微催办（T38）：批次去重 + 单件单次 + 仅超期复查才重推。
 *
 * 去重键 = incident_id + 巡检批次号；同批次重复推送次数 = 1，跨批次复查允许重推。
 * 消息体只含业务字段（先过脱敏模块），推送失败写审计且不抛未捕获异常，
 * 失败不阻断主处置流程。
 */
import { utc, systemClock, type Clock } from "../util/clock.js";
import { get, run, type Database } from "../store/db.js";
import { appendAudit } from "../store/audit.js";
import { redactText, containsPatientIdentifier } from "../domain/redact.js";
import type { OutboundHttp } from "./http.js";

export interface ReminderItem {
  incident_id: string;
  ward_code: string;
  shift_code: string;
  current_step: string;
  elapsed_ms: number;
}

export interface PushDeps {
  http: OutboundHttp;
  db: Database;
  clock?: Clock;
}

export interface PushResult {
  sent: number;
  skipped: number;
  failed: number;
  patient_identifier_blocked: number;
}

function reminderContent(item: ReminderItem): string {
  const minutes = Math.floor(item.elapsed_ms / 60_000);
  return redactText(
    `### 护理缺陷整改超期催办\n` +
      `> 上报单号：${item.incident_id}\n` +
      `> 病区：${item.ward_code}\n` +
      `> 班次：${item.shift_code}\n` +
      `> 当前步：${item.current_step}\n` +
      `> 停留时长：${minutes} 分钟\n`,
  );
}

export async function pushReminders(items: ReminderItem[], batchId: string, deps: PushDeps): Promise<PushResult> {
  const clock = deps.clock ?? systemClock;
  const result: PushResult = { sent: 0, skipped: 0, failed: 0, patient_identifier_blocked: 0 };
  for (const item of items) {
    const dedupeKey = `${item.incident_id}|${batchId}`;
    const existing = get<{ status: string }>(
      deps.db,
      "SELECT status FROM outbox WHERE kind = 'wecom' AND dedupe_key = ?",
      dedupeKey,
    );
    if (existing?.status === "sent") {
      result.skipped += 1;
      continue;
    }
    const content = reminderContent(item);
    if (containsPatientIdentifier(content)) {
      result.patient_identifier_blocked += 1;
      appendAudit(
        deps.db,
        { runId: "adapters", operator: "wecom", kind: "wecom_blocked", detail: { incident_id: item.incident_id, reason: "消息体含患者标识字段" } },
        clock,
      );
      continue;
    }
    if (!existing) {
      run(
        deps.db,
        `INSERT OR IGNORE INTO outbox (kind, incident_id, batch_id, dedupe_key, payload, created_at, updated_at, status)
         VALUES ('wecom', ?, ?, ?, ?, ?, ?, 'pending')`,
        item.incident_id,
        batchId,
        dedupeKey,
        JSON.stringify(item),
        utc(clock.now()),
        utc(clock.now()),
      );
    }
    const response = await deps.http.request<{ errcode?: number }>({
      method: "POST",
      url: deps.http.runtimeConfig.wecomWebhookUrl,
      body: { msgtype: "markdown", markdown: { content } },
      kind: "wecom_reminder",
      maxRetries: 0,
    });
    if (!response.ok || (response.data?.errcode ?? 0) !== 0) {
      result.failed += 1;
      run(
        deps.db,
        "UPDATE outbox SET status = 'failed', error = ?, updated_at = ? WHERE dedupe_key = ?",
        response.error?.message ?? "企微返回 errcode 非 0",
        utc(clock.now()),
        dedupeKey,
      );
      appendAudit(
        deps.db,
        { runId: "adapters", operator: "wecom", kind: "wecom_failed", detail: { incident_id: item.incident_id, batch_id: batchId, reason: response.error?.message ?? "errcode 非 0" } },
        clock,
      );
      continue;
    }
    run(deps.db, "UPDATE outbox SET status = 'sent', updated_at = ? WHERE dedupe_key = ?", utc(clock.now()), dedupeKey);
    result.sent += 1;
  }
  return result;
}
