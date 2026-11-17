/**
 * 可注入时钟。
 *
 * 全项目统一 UTC 毫秒存储（Date.now() 语义），展示层再转本地时区。
 * 跨天挂起、每日巡检、退避重试全部依赖这个接口，便于确定性测试。
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** 测试用固定时钟：可设定、可推进、可模拟休眠唤醒后的时钟跳跃。 */
export interface MutableClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

export function fixedClock(startMs: number): MutableClock {
  let current = startMs;
  return {
    now: () => current,
    set: (ms: number) => {
      current = ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** UTC ISO 字符串（数据库里所有时间字段都用这个格式）。 */
export function utc(ms: number): string {
  return new Date(ms).toISOString();
}

/** 毫秒 → 人话时长（窗口与超期清单用，如 25h03m / 03:12）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export const HOUR_MS = 3_600_000;
