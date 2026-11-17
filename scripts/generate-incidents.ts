/**
 * 配置化合成 1000 条脱敏上报（T4）。
 *
 * 同义表述族写在 config/synonyms.json（可编辑），不在脚本里写死；
 * 固定 seed 保证同一输入两次生成结果一致（规模回放可复现）。
 * 不生成姓名 / 住院号 / 床号 / 身份证 / 电话等患者可识别信息；
 * encounter_id 使用合成关联键 SYN-ENC-*，不指向任何真实患者。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { IncidentReport } from "../src/domain/models.js";
import { PATIENT_IDENTIFIER_FIELDS } from "../src/domain/redact.js";

interface SynonymConfig {
  seed: number;
  count: number;
  wards: string[];
  shifts: string[];
  roles: string[];
  severity_hints: string[];
  subjects: string[];
  times: string[];
  tails: string[];
  synonym_families: { key: string; label: string; variants: string[] }[];
}

const config = JSON.parse(
  readFileSync(new URL("../config/synonyms.json", import.meta.url), "utf8"),
) as SynonymConfig;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(config.seed);
const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
const chance = (p: number): boolean => rnd() < p;

function narrative(): string {
  const family = pick(config.synonym_families);
  const variant = pick(family.variants);
  return `${pick(config.times)}，${pick(config.subjects)}发现${variant}，${pick(config.tails)}`;
}

export function generateIncidents(count: number = config.count): IncidentReport[] {
  const base = Date.parse("2026-11-01T00:00:00.000Z");
  const list: IncidentReport[] = [];
  for (let i = 0; i < count; i += 1) {
    const incident: IncidentReport = {
      incident_id: `INC-2026-${String(i + 1).padStart(5, "0")}`,
      reported_at: new Date(base + i * 90_000).toISOString(),
      ward_code: pick(config.wards),
      shift_code: pick(config.shifts),
      narrative: narrative(),
      reporter_role: pick(config.roles),
    };
    if (chance(0.7)) incident.severity_hint = pick(config.severity_hints);
    // 15% 缺 encounter_id：必须进「待补住院号」清单，而不是报错
    if (chance(0.85)) incident.encounter_id = `SYN-ENC-${String(i + 1).padStart(5, "0")}`;
    list.push(incident);
  }
  return list;
}

/** 20 条边界样例：唯一随仓发布的样例集，覆盖缺字段 / 超长 / 混编 / 空叙述。 */
export function generateBoundaryFixtures(): IncidentReport[] {
  const base = Date.parse("2026-11-09T00:00:00.000Z");
  const rare = "㐀𠮷妧𠀀㒰";
  const mixed = `巡查记录含生僻字与多字节混编：${rare}；GBK/UTF-8 转码后仍需完整显示。`;
  const long = "交接班漏项，".repeat(600);
  const rows: IncidentReport[] = [];
  for (let i = 0; i < 20; i += 1) {
    const row: IncidentReport = {
      incident_id: `BND-2026-${String(i + 1).padStart(3, "0")}`,
      reported_at: new Date(base + i * 60_000).toISOString(),
      ward_code: config.wards[i % config.wards.length]!,
      shift_code: config.shifts[i % config.shifts.length]!,
      narrative: narrative(),
      reporter_role: config.roles[i % config.roles.length]!,
      severity_hint: config.severity_hints[i % config.severity_hints.length],
      encounter_id: `SYN-ENC-B${String(i).padStart(3, "0")}`,
    };
    if (i % 4 === 0) delete row.encounter_id;
    if (i % 5 === 0) delete row.severity_hint;
    if (i === 1) row.narrative = long;
    if (i === 2) row.narrative = mixed;
    if (i === 3) row.narrative = "";
    if (i === 4) row.narrative = "，。；、" .repeat(120);
    if (i === 5) row.narrative = `${mixed}${long}`;
    rows.push(row);
  }
  return rows;
}

function assertNoPatientIdentifiers(rows: IncidentReport[]): void {
  for (const row of rows) {
    for (const field of PATIENT_IDENTIFIER_FIELDS) {
      if (row.narrative.includes(field)) {
        throw new Error(`生成文本含患者标识字段名「${field}」：${row.incident_id}`);
      }
    }
    if (/\d{11,}/.test(row.narrative)) throw new Error(`生成文本含长数字标识：${row.incident_id}`);
  }
}

const isCli = process.argv[1]?.endsWith("generate-incidents.ts") ?? false;
if (isCli) {
  const incidents = generateIncidents();
  const boundaries = generateBoundaryFixtures();
  assertNoPatientIdentifiers([...incidents, ...boundaries]);
  const mainPath = resolve("data/raw/incidents.jsonl");
  const fixturePath = resolve("fixtures/boundary-incidents.jsonl");
  mkdirSync(dirname(mainPath), { recursive: true });
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(mainPath, `${incidents.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  writeFileSync(fixturePath, `${boundaries.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  const unique = new Set(incidents.map((r) => r.incident_id)).size;
  process.stdout.write(`合成完成：${incidents.length} 条，incident_id 唯一 ${unique} 条\n`);
  process.stdout.write(`  主数据     ${mainPath}\n`);
  process.stdout.write(`  边界样例   ${fixturePath}（${boundaries.length} 条）\n`);
  process.stdout.write(`  缺 encounter_id ${incidents.filter((r) => !r.encounter_id).length} 条 → 待补住院号清单\n`);
}
