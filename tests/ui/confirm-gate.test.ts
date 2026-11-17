/** T43 · 确认闸门：四类人工确认 / 未确认不发 POST / 破坏性二次确认 / 回执回显。 */
import { describe, it, expect } from "vitest";
import {
  CONFIRM_KINDS, DESTRUCTIVE_KINDS, requiresSecondConfirm, isWritebackEnabled,
  confirmGateView, decidePost, applyConfirmation, renderConfirmButton, type ConfirmStates,
} from "../../src/ui/confirm-gate.js";

function allStates(): ConfirmStates {
  return {
    grade: { confirmed: true, second: true },
    remedy: { confirmed: true, second: true },
    review: { confirmed: true, second: true },
    close: { confirmed: true, second: true },
  };
}

describe("确认闸门", () => {
  it("四类确认齐全；销号与撤回一级属于破坏性操作", () => {
    expect(CONFIRM_KINDS).toEqual(["grade", "remedy", "review", "close"]);
    expect(DESTRUCTIVE_KINDS).toEqual(["close", "rollback"]);
    expect(requiresSecondConfirm("close")).toBe(true);
    expect(requiresSecondConfirm("rollback")).toBe(true);
    expect(requiresSecondConfirm("grade")).toBe(false);
  });

  it("未确认态按钮 disabled，出站 POST 数 = 0", () => {
    const empty: ConfirmStates = {};
    expect(isWritebackEnabled(empty)).toBe(false);
    const view = confirmGateView(empty);
    expect(view.disabled).toBe(true);
    expect(view.confirmedCount).toBe(0);
    expect(view.reason).toContain("0/4");
    expect(decidePost(empty)).toMatchObject({ allowed: false, postCount: 0 });
    expect(decidePost(allStates(), { confirmedByCaller: false })).toMatchObject({ postCount: 0 });
  });

  it("四类全部确认后恰好 1 次 POST，并回显 receipt_id", () => {
    const states = allStates();
    const view = confirmGateView(states, { receiptId: "RCP-2026-0001" });
    expect(view.disabled).toBe(false);
    expect(view.confirmedCount).toBe(4);
    expect(view.receiptId).toBe("RCP-2026-0001");
    expect(decidePost(states)).toEqual({
      allowed: true,
      postCount: 1,
      reason: "经 engine.resume 单点入口回写一次",
    });
  });

  it("破坏性操作未二次确认时不执行，按钮提示再次确认", () => {
    let states: ConfirmStates = {};
    for (const kind of CONFIRM_KINDS) states = applyConfirmation(states, kind);
    expect(states.close).toEqual({ confirmed: true, second: false });
    expect(isWritebackEnabled(states)).toBe(false);
    expect(decidePost(states).postCount).toBe(0);
    expect(renderConfirmButton("close", states.close)).toContain("再次点击以确认");
    states = applyConfirmation(states, "close");
    expect(states.close).toEqual({ confirmed: true, second: true });
    expect(isWritebackEnabled(states)).toBe(true);
    expect(decidePost(states).postCount).toBe(1);
    expect(renderConfirmButton("close", states.close)).toContain("disabled");
  });

  it("degraded 场景提示规则初判为草稿，推进按钮保持可用", () => {
    const view = confirmGateView(allStates(), { degraded: true });
    expect(view.degradedNotice).toContain("模型不可达，已用规则初判，待人工确认");
    expect(view.degradedNotice).toContain("草稿");
    expect(view.disabled).toBe(false);
    expect(confirmGateView({}).degradedNotice).toBe("");
  });

  it("确认按钮 HTML 的 disabled 只由确认状态决定", () => {
    expect(renderConfirmButton("grade", undefined)).toContain("data-confirm=\"grade\"");
    expect(renderConfirmButton("grade", undefined)).not.toContain("disabled");
    expect(renderConfirmButton("grade", { confirmed: true, second: true })).toContain("disabled");
  });
});
