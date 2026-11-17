/**
 * 步骤时间线视图模型（T42）。
 * 数据来自 T21 的纯函数输出；「挂起等待」段单独呈现并标出等待时长；
 * 依据原句在叙述文本中高亮，标 hallucinated 的引文不渲染；
 * 点击某步可跳到右侧对应确认项。
 */
import type { Timeline, TimelineSegment } from "../runtime/timeline.js";

export interface TimelineSegmentView extends TimelineSegment {
  confirmAnchor?: string;
  rendered: string;
}

export function buildTimelineView(timeline: Timeline): TimelineSegmentView[] {
  return timeline.segments.map((segment) => ({
    ...segment,
    ...(segment.kind === "step" && segment.status !== "done"
      ? { confirmAnchor: `confirm:${segment.step_id}` }
      : {}),
    rendered: renderTimelineSegment(segment),
  }));
}

export function renderTimelineSegment(segment: TimelineSegment): string {
  const statusText = segment.status === "running" ? "进行中" : segment.status === "waiting" ? "挂起等待" : "已完成";
  const width = Math.max(2, Math.round(segment.bar_width * 100));
  return `<div class="ndr-tl-seg ndr-tl-seg--${segment.status}" data-step="${segment.step_id}">
    <span class="ndr-tl-seg__name">${segment.name}</span>
    <span class="ndr-caption">${segment.label}</span>
    <span>${segment.operator}</span>
    <span>${statusText}</span>
    ${segment.kind === "waiting" ? "<span>卡在等人，不是卡在系统</span>" : ""}
    <div class="ndr-tl-bar"><div class="ndr-tl-bar__fill" style="width:${width}%"></div></div>
  </div>`;
}

/** 作废引文不渲染（引文回查已保证其余原句确实来自输入文本）。 */
export function shouldRenderCitation(ref: string, hallucinated: readonly string[]): boolean {
  return ref.trim().length > 0 && !hallucinated.includes(ref);
}

/** 依据原句高亮：只标确实出现的原句，不做语义改写。 */
export function highlightQuotes(
  narrative: string,
  validRefs: readonly string[],
  hallucinatedRefs: readonly string[],
): string {
  let html = narrative;
  for (const ref of validRefs) {
    if (!shouldRenderCitation(ref, hallucinatedRefs)) continue;
    if (!html.includes(ref)) continue;
    html = html.split(ref).join(`<mark class="ndr-quote">${ref}</mark>`);
  }
  return html;
}

/** 时间线分段数与后端一致：只数步骤段，等待段单列但不计入步数。 */
export function stepSegmentCount(view: TimelineSegmentView[]): number {
  return view.filter((segment) => segment.kind === "step").length;
}
