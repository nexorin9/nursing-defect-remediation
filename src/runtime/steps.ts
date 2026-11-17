/**
 * 命名步骤定义表（T11）。
 *
 * 业务判断不散落在引擎里：每步的名字、前后状态、是否需人工确认都写在这里。
 * 一件上报 = 一条 run，6 个有名字的步骤对应 7 个状态。
 */
import type { RunState, ConfirmKind } from "../domain/models.js";

export type StepKind = "system" | "model" | "confirm" | "writeback";

export interface StepDef {
  id: string;
  name: string;
  from: RunState;
  to: RunState;
  kind: StepKind;
  requiresConfirmation: boolean;
  confirmKind?: ConfirmKind;
  /** 该步对应的挂起等待事件名（T15 按事件匹配恢复） */
  waitEvent?: string;
}

export const STEP_DEFS: readonly StepDef[] = [
  { id: "intake", name: "上报接住", from: "new", to: "extracting", kind: "system", requiresConfirmation: false },
  { id: "extract", name: "要素抽取", from: "extracting", to: "awaiting_grade", kind: "model", requiresConfirmation: false },
  {
    id: "grade",
    name: "分级确认",
    from: "awaiting_grade",
    to: "remedying",
    kind: "confirm",
    requiresConfirmation: true,
    confirmKind: "grade",
    waitEvent: "confirm.grade",
  },
  {
    id: "remedy",
    name: "整改措施",
    from: "remedying",
    to: "awaiting_review",
    kind: "confirm",
    requiresConfirmation: true,
    confirmKind: "remedy",
    waitEvent: "confirm.remedy",
  },
  {
    id: "review",
    name: "措施复核",
    from: "awaiting_review",
    to: "closed",
    kind: "confirm",
    requiresConfirmation: true,
    confirmKind: "review",
    waitEvent: "confirm.review",
  },
  {
    id: "close",
    name: "销号确认与回写",
    from: "closed",
    to: "written_back",
    kind: "writeback",
    requiresConfirmation: true,
    confirmKind: "close",
    waitEvent: "confirm.close",
  },
];

export function stepDefById(id: string): StepDef | undefined {
  return STEP_DEFS.find((s) => s.id === id);
}

export function stepDefAt(state: RunState): StepDef | undefined {
  return STEP_DEFS.find((s) => s.from === state);
}

export function stepIndex(id: string): number {
  return STEP_DEFS.findIndex((s) => s.id === id);
}

/** 需要等人回复 / 人工确认的步骤（挂起点）。 */
export function isConfirmationStep(def: StepDef): boolean {
  return def.requiresConfirmation;
}
