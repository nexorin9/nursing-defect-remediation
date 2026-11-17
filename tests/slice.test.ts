import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** T2：一条命令核对最窄端到端切片，重复跑不产生第二条处置单。 */
describe("T2 最窄端到端切片", () => {
  it("slice 产出 2 行在办清单（当前步 = 待分级）且重复执行 runs 行数不变", () => {
    const dir = mkdtempSync(join(tmpdir(), "ndr-slice-"));
    try {
      const args = [
        "tsx", "scripts/slice.ts",
        "--input", "fixtures/slice-sample.jsonl",
        "--db", join(dir, "slice.db"),
        "--out", join(dir, "out"),
      ];
      const first = execFileSync("npx", args, { cwd: process.cwd(), encoding: "utf8" });
      const csv = readFileSync(join(dir, "out", "在办清单.csv"), "utf8").trim().split("\n");
      expect(csv).toHaveLength(3);
      expect(csv[1]).toContain("待分级");
      expect(csv[2]).toContain("待分级");
      expect(first).toContain("本次新建处置单   2 条");
      expect(first).toContain("runs 表行数      2");

      const second = execFileSync("npx", args, { cwd: process.cwd(), encoding: "utf8" });
      expect(second).toContain("本次新建处置单   0 条");
      expect(second).toContain("runs 表行数      2");
      const csv2 = readFileSync(join(dir, "out", "在办清单.csv"), "utf8").trim().split("\n");
      expect(csv2).toHaveLength(3);
      const audit = readFileSync(join(dir, "out", "审计行.csv"), "utf8").trim().split("\n");
      expect(audit.length).toBeGreaterThan(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
