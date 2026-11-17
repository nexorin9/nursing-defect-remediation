/**
 * 确认闸门视图模型（T43）。
 *
 * 四类人工确认：分级 / 措施 / 复核 / 销号，每类显示模型草稿 + 依据原句 + 规则校验结论。
 * 未确认时「回写质控系统」按钮 disabled 且**不发起**任何 POST；
 * 确认状态是按钮 disabled 的唯一依据。破坏性操作（撤回一级 / 销号）需二次确认。
 * 确认动作经 ipc → 主进程 → engine.resume 单点入口，业务层不直接改状态。
 */
export const CONFIRM_KINDS = ["grade", "remedy", "review", "close"] as const;
export type ConfirmKind = (typeof CONFIRM_KINDS)[number];

export interface ConfirmState {
  confirmed: boolean;
  second: boolean;
}

export type ConfirmStates = Partial<Record<ConfirmKind, ConfirmState>>;

/** 破坏性操作：销号（四类确认内）与撤回一级（闸门外的显式动作）。 */
export const DESTRUCTIVE_KINDS: readonly string[] = ["close", "rollback"];

export function requiresSecondConfirm(kind: string): boolean {
  return kind === "close" || kind === "rollback";
}

/** 四类全部确认（破坏性项还需二次确认）才允许回写。 */
export function isWritebackEnabled(states: ConfirmStates): boolean {
  return CONFIRM_KINDS.every((kind) => {
    const state = states[kind];
    if (!state?.confirmed) return false;
    return !requiresSecondConfirm(kind) || state.second;
  });
}

export interface ConfirmGateView {
  disabled: boolean;
  confirmedCount: number;
  reason: string;
  degradedNotice: string;
  receiptId?: string;
}

export function confirmGateView(states: ConfirmStates, options: { degraded?: boolean; receiptId?: string } = {}): ConfirmGateView {
  const confirmedCount = CONFIRM_KINDS.filter((kind) => states[kind]?.confirmed).length;
  const disabled = !isWritebackEnabled(states);
  return {
    disabled,
    confirmedCount,
    reason: disabled
      ? `需先完成四类人工确认（当前 ${confirmedCount}/4），未确认时按钮禁用且不发起任何 POST`
      : "四类结论已全部确认，可发起一次回写",
    degradedNotice: options.degraded
      ? "模型不可达，已用规则初判，待人工确认。推进按钮保持可用，但结论一律标为草稿。"
      : "",
    ...(options.receiptId ? { receiptId: options.receiptId } : {}),
  };
}

/**
 * 出站 POST 决策：未确认 0 次；已确认且未二次确认的破坏性操作 0 次；
 * 全部就绪恰好 1 次（回写幂等键保证重复点击不会变成 2 次）。
 */
export function decidePost(states: ConfirmStates, options: { confirmedByCaller?: boolean } = {}): { allowed: boolean; postCount: number; reason: string } {
  if (options.confirmedByCaller === false || !isWritebackEnabled(states)) {
    return { allowed: false, postCount: 0, reason: "未人工确认，不发回写请求" };
  }
  return { allowed: true, postCount: 1, reason: "经 engine.resume 单点入口回写一次" };
}

/** 应用一次确认点击；破坏性项第一次只置 confirmed，第二次才置 second。 */
export function applyConfirmation(states: ConfirmStates, kind: ConfirmKind): ConfirmStates {
  const current = states[kind] ?? { confirmed: false, second: false };
  if (requiresSecondConfirm(kind)) {
    if (!current.confirmed) return { ...states, [kind]: { confirmed: true, second: false } };
    return { ...states, [kind]: { confirmed: true, second: true } };
  }
  return { ...states, [kind]: { confirmed: true, second: true } };
}

/** 确认按钮的 HTML（disabled 由确认状态唯一决定）。 */
export function renderConfirmButton(kind: ConfirmKind, state: ConfirmState | undefined): string {
  const done = state?.confirmed && (!requiresSecondConfirm(kind) || state.second);
  const label = done ? "已确认" : requiresSecondConfirm(kind) && state?.confirmed ? "再次点击以确认" : "确认";
  return `<button type="button" class="ndr-btn ${done ? "ndr-btn--disabled" : "ndr-btn--primary"}" data-confirm="${kind}" ${done ? "disabled" : ""}>${label}</button>`;
}
