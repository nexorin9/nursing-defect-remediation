/**
 * preload 受限桥（T39）：只暴露白名单 API，不暴露任意 ipc 通道。
 *
 * 本文件只放纯常量与校验函数，不静态 import electron，便于在无头环境直接测试；
 * 真正装配在 src/main/preload-entry.ts。
 */
export const BRIDGE_NAME = "ndr";

/** 渲染进程可见的全部能力，逐个显式列出。 */
export const BRIDGE_API = [
  "refresh",
  "getRuns",
  "sweepNow",
  "confirm",
  "exportLedger",
  "getSummary",
  "onUpdate",
] as const;

export type BridgeKey = (typeof BRIDGE_API)[number];

/** 任意通道 / 原始 ipc 对象一律不得出现在桥上。 */
export const FORBIDDEN_BRIDGE_KEYS = [
  "ipcRenderer",
  "send",
  "invoke",
  "on",
  "once",
  "sendSync",
  "openExternal",
  "require",
  "process",
] as const;

export interface BridgeCheck {
  ok: boolean;
  violations: string[];
}

/** 白名单断言：多一个键、少一个键、出现任意通道名都判失败。 */
export function assertBridge(api: Record<string, unknown>): BridgeCheck {
  const violations: string[] = [];
  const keys = Object.keys(api);
  for (const key of keys) {
    if (!(BRIDGE_API as readonly string[]).includes(key)) violations.push(`桥上出现未授权键：${key}`);
    if ((FORBIDDEN_BRIDGE_KEYS as readonly string[]).includes(key)) violations.push(`桥上出现任意 ipc 通道：${key}`);
  }
  for (const key of BRIDGE_API) {
    if (typeof api[key] !== "function") violations.push(`白名单能力缺失或非函数：${key}`);
  }
  return { ok: violations.length === 0, violations };
}

/** 从候选对象里只挑白名单键，构造真正暴露给渲染进程的桥。 */
export function pickBridge(candidates: Record<string, unknown>): Record<string, unknown> {
  const bridge: Record<string, unknown> = {};
  for (const key of BRIDGE_API) {
    if (typeof candidates[key] === "function") bridge[key] = candidates[key];
  }
  return bridge;
}

/** ipc 通道名白名单（主进程侧同样只认这 7 个）。 */
export const IPC_CHANNELS = [
  "ndr:refresh",
  "ndr:get-runs",
  "ndr:sweep-now",
  "ndr:confirm",
  "ndr:export-ledger",
  "ndr:get-summary",
  "ndr:update",
] as const;
