/**
 * adapters · 入站读 EMR 护理记录（T36）。
 *
 * encounter_id 缺失时**不发起请求**，直接返回「缺住院号」并把该件列入待补清单；
 * 这是 spec「不猜、不补、不报错」的落点。
 */
import type { OutboundHttp } from "./http.js";

export interface NursingRecordItem {
  time: string;
  text: string;
  author_role: string;
}

export interface EmrResult {
  encounter_id?: string;
  records: NursingRecordItem[];
  missingEncounter: boolean;
  /** 供测试与审计核对：本次实际发出的 EMR 请求数 */
  requestCount: number;
}

export class EmrReader {
  constructor(private readonly http: OutboundHttp) {}

  async getNursingRecords(encounterId?: string): Promise<EmrResult> {
    if (!encounterId) {
      return { records: [], missingEncounter: true, requestCount: 0 };
    }
    const base = this.http.runtimeConfig.emrBaseUrl;
    const url = new URL("/api/v1/nursing-records", base);
    url.searchParams.set("encounter_id", encounterId);
    const response = await this.http.request<{ encounter_id?: string; records?: unknown[] }>({
      method: "GET",
      url: url.toString(),
      token: this.http.runtimeConfig.emrApiToken,
      kind: "get_nursing_records",
    });
    const rows = Array.isArray(response.data?.records) ? response.data!.records! : [];
    const records: NursingRecordItem[] = [];
    for (const row of rows) {
      const value = row as Record<string, unknown>;
      records.push({
        time: String(value.time ?? ""),
        text: String(value.text ?? ""),
        author_role: String(value.author_role ?? ""),
      });
    }
    return {
      encounter_id: encounterId,
      records,
      missingEncounter: false,
      requestCount: 1,
    };
  }
}

/** 待补住院号清单：只收业务字段，不猜住院号。 */
export function missingEncounterEntry(incidentId: string, wardCode: string, shiftCode: string): Record<string, string> {
  return { incident_id: incidentId, ward_code: wardCode, shift_code: shiftCode, reason: "缺住院号，未调用 EMR 接口" };
}
