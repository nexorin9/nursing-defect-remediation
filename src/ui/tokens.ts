/**
 * 设计 token（T40）。
 *
 * 参考成熟中后台设计体系：语义色由产品自身定义（不依赖系统深浅色主题）、
 * 8px 间距栅格、四级字体层级。CSS 变量在 theme.css 里逐项镜像本文件。
 */
export const COLORS = {
  brand: "#1F6FEB",
  brandHover: "#1A5FD0",
  brandActive: "#164FB0",
  brandSoft: "#EAF1FE",
  success: "#1F9254",
  successSoft: "#E8F6EE",
  todo: "#B7791F",
  todoSoft: "#FDF4E3",
  overdue: "#C0392B",
  overdueSoft: "#FCEDEB",
  fail: "#C0392B",
  info: "#5B6B7F",
  textPrimary: "#1D2733",
  textSecondary: "#5B6B7F",
  textDisabled: "#A6B0BD",
  border: "#E3E8F0",
  surface: "#FFFFFF",
  canvas: "#F4F6FA",
  navDark: "#14243A",
} as const;

/** 中性色阶（8 级，供标签 / 分割线 / 骨架屏使用）。 */
export const NEUTRAL_SCALE = ["#FFFFFF", "#F8FAFC", "#F1F4F8", "#E8EDF4", "#DCE3EC", "#C7D0DC", "#9AA6B5", "#6B7889"] as const;

/** 8px 间距栅格。 */
export const SPACING = { unit: 8, xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

export const TYPO = { pageTitle: 20, sectionTitle: 16, body: 14, caption: 12 } as const;

export const RADIUS = { sm: 4, md: 6, lg: 8 } as const;

/** 按钮四态类名：供渲染层与自检共用。 */
export const BUTTON_STATES = ["hover", "active", "disabled", "loading"] as const;
export const BUTTON_STATE_CLASS: Record<(typeof BUTTON_STATES)[number], string> = {
  hover: "ndr-btn--hover",
  active: "ndr-btn--active",
  disabled: "ndr-btn--disabled",
  loading: "ndr-btn--loading",
};

export const RESPONSIVE = { threeColumn: 1280, twoColumn: 768 } as const;

/** 栅格倍数：所有间距都取 8px 的整数倍（xs 例外，用于图标与文字微调）。 */
export function spacing(steps: number): number {
  return SPACING.unit * Math.max(0, Math.floor(steps));
}

/** 长文本截断策略：中文按字数截断，超长字段在卡片里不破版。 */
export function truncateText(text: string, max = 120): { text: string; truncated: boolean } {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return { text: normalized, truncated: false };
  return { text: `${normalized.slice(0, max)}…`, truncated: true };
}

/** 布局档位：≥1280 三栏 / 768–1280 两栏（确认栏收抽屉） / <768 列表 + 详情抽屉。 */
export function layoutFor(width: number): "three" | "two" | "one" {
  if (width >= RESPONSIVE.threeColumn) return "three";
  if (width >= RESPONSIVE.twoColumn) return "two";
  return "one";
}

/** 语义色选择：待办琥珀、超期砖红、成功绿、失败红。 */
export function statusColor(overdue: boolean, status: "done" | "running" | "waiting" | "failed"): string {
  if (overdue) return COLORS.overdue;
  if (status === "failed") return COLORS.fail;
  if (status === "done") return COLORS.success;
  if (status === "waiting") return COLORS.todo;
  return COLORS.brand;
}
