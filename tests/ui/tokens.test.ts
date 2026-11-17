/** T40 · 设计 token：色板 / 8px 栅格 / 字体层级 / 四态组件 / 响应式档位。 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COLORS, NEUTRAL_SCALE, SPACING, TYPO, RADIUS,
  BUTTON_STATES, BUTTON_STATE_CLASS, RESPONSIVE,
  spacing, layoutFor, truncateText, statusColor,
} from "../../src/ui/tokens.js";

const theme = readFileSync(resolve(process.cwd(), "src/ui/theme.css"), "utf8");
const styles = readFileSync(resolve(process.cwd(), "src/ui/styles.css"), "utf8");

describe("设计 token 与基础样式", () => {
  it("色板含品牌色 + 四类语义色 + 中性色阶，且 CSS 变量逐项镜像", () => {
    for (const key of ["brand", "success", "todo", "overdue", "fail", "textPrimary", "border", "surface"] as const) {
      expect(COLORS[key]).toMatch(/^#[0-9A-F]{6}$/);
    }
    expect(NEUTRAL_SCALE).toHaveLength(8);
    expect(theme).toContain(`--ndr-brand: ${COLORS.brand}`);
    expect(theme).toContain(`--ndr-success: ${COLORS.success}`);
    expect(theme).toContain(`--ndr-overdue: ${COLORS.overdue}`);
    expect(theme).not.toContain("prefers-color-scheme");
    expect(styles).toContain("--ndr-");
  });

  it("8px 间距栅格与四级字体层级", () => {
    expect(SPACING.unit).toBe(8);
    expect(spacing(3)).toBe(24);
    expect(spacing(0)).toBe(0);
    expect([SPACING.sm, SPACING.md, SPACING.lg, SPACING.xl].every((v) => v % 8 === 0)).toBe(true);
    expect(TYPO).toEqual({ pageTitle: 20, sectionTitle: 16, body: 14, caption: 12 });
    expect(theme).toContain(`--ndr-space: ${SPACING.unit}px`);
    expect(theme).toContain("font-size: 20px");
    expect(theme).toContain("font-size: 12px");
    expect(RADIUS.md).toBe(6);
  });

  it("按钮四态类名齐全，禁用态与加载态样式可区分", () => {
    expect(BUTTON_STATES).toEqual(["hover", "active", "disabled", "loading"]);
    const classes = Object.values(BUTTON_STATE_CLASS);
    expect(new Set(classes).size).toBe(4);
    for (const cls of classes) expect(theme).toContain(cls);
    const disabledBlock = theme.slice(theme.indexOf(".ndr-btn.ndr-btn--disabled"));
    expect(disabledBlock.slice(0, 240)).toContain("not-allowed");
    expect(theme).toContain(".ndr-btn.ndr-btn--loading::before");
    expect(theme.indexOf(".ndr-btn.ndr-btn--disabled")).not.toBe(theme.indexOf(".ndr-btn.ndr-btn--loading"));
  });

  it("响应式三档：≥1280 三栏 / 768–1280 两栏 / <768 列表 + 抽屉", () => {
    expect(layoutFor(1440)).toBe("three");
    expect(layoutFor(RESPONSIVE.threeColumn)).toBe("three");
    expect(layoutFor(1024)).toBe("two");
    expect(layoutFor(RESPONSIVE.twoColumn)).toBe("two");
    expect(layoutFor(640)).toBe("one");
    expect(styles).toContain("@media");
  });

  it("长文本截断与生僻字显示策略", () => {
    const long = "交接班漏项，".repeat(80) + "㐀𠮷妧𠀀㒰";
    const result = truncateText(long, 120);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(121);
    expect(result.text.endsWith("…")).toBe(true);
    expect(truncateText("  换行\n  空白  ", 20)).toEqual({ text: "换行 空白", truncated: false });
    expect(statusColor(true, "running")).toBe(COLORS.overdue);
    expect(statusColor(false, "waiting")).toBe(COLORS.todo);
    expect(statusColor(false, "done")).toBe(COLORS.success);
    expect(statusColor(false, "failed")).toBe(COLORS.fail);
  });
});
