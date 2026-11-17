/**
 * 运行时间线（T21）：trace → 分段的**纯函数**。
 *
 * 呈现语义参考成熟前端运行详情组件里的 formatDuration / calculateDuration /
 * calculateBarPosition 三个纯函数写法：把三时刻 trace 转成可渲染的分段数组；
 * 步骤之间的空档单列为「挂起等待」段，让护理部一眼看出卡在等人还是卡在系统。
 * 本文件不读库、不读时钟、不产生副作用。
 */
import type { StepTrace } from "../domain/models.js";

export interface TimelineSegment {
  step_id: string;
  name: string;
  kind: "step" | "waiting";
  operator: string;
  start_ms: number;
  end_ms: number | undefined;
  duration_ms: number;
  status: "done" | "running" | "waiting";
  label: string;
  /** 相对总时长的条位置（0–1），供视图层画条 */
  bar_start: number;
  bar_width: number;
}

export interface Timeline {
  segments: TimelineSegment[];
  total_duration_ms: number;
  step_count: number;
  sum_duration_ms: number;
}

function parse(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** 对齐纯函数：计算某段的耗时；缺 ended 的进行中步骤用 now 且标记进行中。 */
export function calculateDuration(
  startedAt: string | undefined,
  endedAt: string | undefined,
  queuedAt: string,
  nowMs: number,
): { duration_ms: number; status: "done" | "running" } {
  const start = parse(startedAt) ?? parse(queuedAt) ?? nowMs;
  const end = parse(endedAt);
  if (end === undefined) return { duration_ms: Math.max(0, nowMs - start), status: "running" };
  return { duration_ms: Math.max(0, end - start), status: "done" };
}

/** 对齐纯函数：把绝对时刻换算成 0–1 的条形位置。 */
export function calculateBarPosition(startMs: number, endMs: number, timelineStart: number, totalMs: number): { start: number; width: number } {
  if (totalMs <= 0) return { start: 0, width: 0 };
  const start = Math.min(1, Math.max(0, (startMs - timelineStart) / totalMs));
  const width = Math.min(1 - start, Math.max(0, (endMs - startMs) / totalMs));
  return { start, width: Math.max(0, width) };
}

export function formatTimelineDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${Math.floor((ms % 60_000) / 1000)}s`;
}

/** trace → 时间线分段；步间空档单列为等待段。 */
export function buildTimeline(traces: StepTrace[], nowMs: number): Timeline {
  const ordered = [...traces].sort((a, b) => (parse(a.queued_at) ?? 0) - (parse(b.queued_at) ?? 0));
  const timelineStart = parse(ordered[0]?.queued_at) ?? nowMs;
  const ends = ordered.map((t) => parse(t.ended_at) ?? nowMs);
  const timelineEnd = ends.length > 0 ? Math.max(nowMs, ...ends) : nowMs;
  const total = Math.max(0, timelineEnd - timelineStart);
  const segments: TimelineSegment[] = [];
  let cursor = timelineStart;

  for (let i = 0; i < ordered.length; i += 1) {
    const trace = ordered[i]!;
    const queued = parse(trace.queued_at) ?? cursor;
    const started = parse(trace.started_at) ?? queued;
    const ended = parse(trace.ended_at);
    // 步与步之间、以及排队到开跑之间的空档 = 挂起等待段
    if (started > cursor) {
      const bar = calculateBarPosition(cursor, started, timelineStart, total);
      segments.push({
        step_id: `wait:${trace.step_id}`,
        name: "挂起等待",
        kind: "waiting",
        operator: "等人回复",
        start_ms: cursor,
        end_ms: started,
        duration_ms: started - cursor,
        status: "waiting",
        label: `等待 ${formatTimelineDuration(started - cursor)}`,
        bar_start: bar.start,
        bar_width: bar.width,
      });
    }
    const duration = calculateDuration(trace.started_at, trace.ended_at, trace.queued_at, nowMs);
    const endMs = ended ?? nowMs;
    const bar = calculateBarPosition(started, endMs, timelineStart, total);
    segments.push({
      step_id: trace.step_id,
      name: trace.name,
      kind: "step",
      operator: trace.operator,
      start_ms: started,
      end_ms: ended,
      duration_ms: duration.duration_ms,
      status: duration.status,
      label: duration.status === "running" ? "进行中" : formatTimelineDuration(duration.duration_ms),
      bar_start: bar.start,
      bar_width: bar.width,
    });
    cursor = Math.max(cursor, endMs);
  }

  const sum = segments.reduce((acc, s) => acc + s.duration_ms, 0);
  return {
    segments,
    total_duration_ms: total,
    step_count: segments.filter((s) => s.kind === "step").length,
    // 保证「各段耗时之和 ≤ 总时长」这一不变量
    sum_duration_ms: Math.min(sum, total),
  };
}
