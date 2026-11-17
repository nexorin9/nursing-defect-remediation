/**
 * 规模与边界校验报告（T4）。
 * 输出：条数 = 1000、incident_id 唯一率、各字段非空率、encounter_id 缺失条数
 * （该类必须进「待补住院号」清单而非报错）、边界样例覆盖情况。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IncidentReport } from "../src/domain/models.js";

function readJsonl(path: string): IncidentReport[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as IncidentReport);
}

const main = readJsonl(resolve("data/raw/incidents.jsonl"));
const boundary = readJsonl(resolve("fixtures/boundary-incidents.jsonl"));
const unique = new Set(main.map((r) => r.incident_id)).size;
const nonEmpty = (field: keyof IncidentReport): number =>
  main.filter((r) => r[field] !== undefined && r[field] !== "").length;
const missingEncounter = main.filter((r) => !r.encounter_id).length;
const uniqueRate = main.length > 0 ? (unique / main.length) * 100 : 0;

const lines = [
  "规模校验报告 · 合成脱敏上报",
  `  总条数                  ${main.length}（期望 1000）`,
  `  incident_id 唯一数      ${unique}`,
  `  incident_id 唯一率      ${uniqueRate.toFixed(2)}%（期望 100.00%）`,
  `  reported_at 非空率      ${((nonEmpty("reported_at") / (main.length || 1)) * 100).toFixed(2)}%`,
  `  ward_code 非空率        ${((nonEmpty("ward_code") / (main.length || 1)) * 100).toFixed(2)}%`,
  `  shift_code 非空率       ${((nonEmpty("shift_code") / (main.length || 1)) * 100).toFixed(2)}%`,
  `  narrative 非空率        ${((nonEmpty("narrative") / (main.length || 1)) * 100).toFixed(2)}%`,
  `  severity_hint 非空率    ${((nonEmpty("severity_hint") / (main.length || 1)) * 100).toFixed(2)}%`,
  `  encounter_id 缺失条数   ${missingEncounter}（进待补住院号清单，不报错）`,
  `  边界样例条数            ${boundary.length}（期望 20）`,
  `  边界样例缺 encounter_id ${boundary.filter((r) => !r.encounter_id).length}`,
  `  边界样例缺 severity_hint ${boundary.filter((r) => !r.severity_hint).length}`,
  `  边界样例空叙述          ${boundary.filter((r) => r.narrative === "").length}`,
  `  边界样例超长叙述(>2000) ${boundary.filter((r) => r.narrative.length > 2000).length}`,
  `  边界样例生僻字混编      ${boundary.filter((r) => /[㐀-䶿]|[\u{20000}-\u{2FFFF}]/u.test(r.narrative)).length}`,
];
process.stdout.write(`${lines.join("\n")}\n`);
if (main.length !== 1000 || unique !== main.length || boundary.length !== 20) {
  process.stderr.write("规模校验未通过：条数 / 唯一率 / 边界样例数量不符合预期\n");
  process.exitCode = 1;
}
