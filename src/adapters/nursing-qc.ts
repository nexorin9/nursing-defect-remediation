/**
 * adapters · 入站读上报列表（T36）。
 * 支持分页与按 reported_at 水位的增量拉取；单条字段异常不中断同批。
 */
import type { IncidentReport } from "../domain/models.js";
import type { OutboundHttp } from "./http.js";

export interface IncidentPage {
  items: IncidentReport[];
  next_cursor?: string;
  failed: number;
}

export class NursingQcReader {
  constructor(private readonly http: OutboundHttp) {}

  async listIncidents(
    status: string,
    limit: number,
    options: { since?: string; cursor?: string } = {},
  ): Promise<IncidentPage> {
    const base = this.http.runtimeConfig.nursingQcBaseUrl;
    const url = new URL("/api/v1/nursing-incidents", base);
    url.searchParams.set("status", status);
    url.searchParams.set("limit", String(limit));
    if (options.since) url.searchParams.set("since", options.since);
    if (options.cursor) url.searchParams.set("cursor", options.cursor);
    const response = await this.http.request<{ items?: unknown[]; next_cursor?: string | null }>({
      method: "GET",
      url: url.toString(),
      token: this.http.runtimeConfig.nursingQcToken,
      kind: "list_incidents",
    });
    if (!response.ok || !response.data) {
      throw new Error(`读取上报列表失败：${response.error?.message ?? "无响应"}`);
    }
    const rows = Array.isArray(response.data.items) ? response.data.items : [];
    const items: IncidentReport[] = [];
    let failed = 0;
    for (const row of rows) {
      try {
        const value = row as Record<string, unknown>;
        if (typeof value.incident_id !== "string" || value.incident_id === "") throw new Error("incident_id 缺失");
        items.push({
          incident_id: value.incident_id,
          reported_at: String(value.reported_at ?? ""),
          ward_code: String(value.ward_code ?? ""),
          shift_code: String(value.shift_code ?? ""),
          narrative: String(value.narrative ?? ""),
          reporter_role: String(value.reporter_role ?? ""),
          ...(value.severity_hint !== undefined && value.severity_hint !== null
            ? { severity_hint: String(value.severity_hint) }
            : {}),
          ...(value.encounter_id !== undefined && value.encounter_id !== null && value.encounter_id !== ""
            ? { encounter_id: String(value.encounter_id) }
            : {}),
        });
      } catch {
        failed += 1;
      }
    }
    return {
      items,
      ...(response.data.next_cursor ? { next_cursor: String(response.data.next_cursor) } : {}),
      failed,
    };
  }

  /** 循环翻页拉全量增量；水位由调度器保存。 */
  async listAllNew(since?: string, maxPages = 50): Promise<IncidentReport[]> {
    const all: IncidentReport[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.listIncidents("new", 50, { ...(since ? { since } : {}), ...(cursor ? { cursor } : {}) });
      all.push(...result.items);
      if (!result.next_cursor) break;
      cursor = result.next_cursor;
    }
    return all;
  }
}
