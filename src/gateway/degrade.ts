/**
 * 模型超时 / 退避 / 降级（T29）。
 *
 * 网关内部按 max_retries 退避；全部失败后这里给出确定性降级：
 * 规则粗分级 + degraded=true + 明确原因。**调用方必须停在当前步，
 * 不推进状态、不回写、不销号**，窗口提示「模型不可达，已用规则初判，待人工确认」。
 */
import type { ModelGateway, GatewayRequest, GatewayResult } from "./model-gateway.js";
import { parseStructured, type SchemaName, type ParseResult } from "./schemas.js";

export interface DegradeOutcome<T = Record<string, unknown>> {
  ok: boolean;
  degraded: boolean;
  /** 结构化解析并过 schema 的结果 */
  parsed?: ParseResult<T>;
  content?: string;
  callId?: string;
  reason?: string;
  /** 规则粗分级（降级时给人工参考，不是结论） */
  coarseGrade?: string;
  usage?: GatewayResult["usage"];
}

/** 规则粗分级：只按关键词给最粗的参考，不替代模型、不作结论。 */
export function ruleCoarseGrade(narrative: string): string {
  if (/坠床|跌倒|滑倒/.test(narrative)) return "需人工优先复核（跌倒类）";
  if (/压疮|压力性损伤/.test(narrative)) return "需人工优先复核（压力性损伤类）";
  if (/给药|核对/.test(narrative)) return "需人工优先复核（给药核对类）";
  return "需人工分级（规则初判不足）";
}

export interface CallOptions {
  schemaName?: SchemaName;
  narrative?: string;
}

/**
 * 调模型并解析结构化返回；任何失败都收敛为一个 degraded 结果。
 * 不写库 —— 审计由 engine 在停步时统一写（含 call_id 与失败原因）。
 */
export async function callWithDegrade<T extends Record<string, unknown>>(
  gateway: ModelGateway,
  request: GatewayRequest,
  options: CallOptions = {},
): Promise<DegradeOutcome<T>> {
  let result: GatewayResult;
  try {
    result = await gateway.complete(request);
  } catch (error) {
    return {
      ok: false,
      degraded: true,
      reason: `模型不可达，已用规则初判，待人工确认（${(error as Error).message}）`,
      coarseGrade: ruleCoarseGrade(options.narrative ?? ""),
    };
  }
  if (!result.ok || !result.content) {
    return {
      ok: false,
      degraded: true,
      callId: result.callId,
      reason: `模型不可达，已用规则初判，待人工确认（${result.error?.message ?? "调用失败"}）`,
      coarseGrade: ruleCoarseGrade(options.narrative ?? ""),
    };
  }
  if (options.schemaName) {
    const parsed = parseStructured<T>(result.content, options.schemaName);
    if (!parsed.ok) {
      return {
        ok: false,
        degraded: true,
        parsed,
        content: result.content,
        callId: result.callId,
        usage: result.usage,
        reason: `结构化返回未通过校验，停在当前步：${parsed.reason ?? ""}`,
        coarseGrade: ruleCoarseGrade(options.narrative ?? ""),
      };
    }
    return { ok: true, degraded: false, parsed, content: result.content, callId: result.callId, usage: result.usage };
  }
  return { ok: true, degraded: false, content: result.content, callId: result.callId, usage: result.usage };
}
