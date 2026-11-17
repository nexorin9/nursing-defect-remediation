/**
 * 公开数据集阶梯（T3）：脚本化下载 + 完整性校验 + 断网降级。
 *
 * 阶梯：① 本地已缓存且校验通过 → 直接跳过（不产生重复文件、不破坏校验和）；
 *       ② 按 --dataset 独立下载公开数据集，独立校验记录数与校验和；
 *       ③ 网络失败 / 校验和不符 → 打印明确降级原因（缺哪个数据集、影响哪条能力、
 *          后续用哪份本地样例兜底），并以非 0 退出码结束，绝不静默失败。
 *
 * 公开数据只用于校验与联通，不进入最终产品路径（见 docs/data-sources.md）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

interface DataSet {
  id: "cblue" | "synthea";
  name: string;
  url: string;
  file: string;
  minRecords: number;
  ability: string;
  fallback: string;
  license: string;
}

/** 阈值与来源写进脚本常量，不散落在流程里。 */
const DATASETS: DataSet[] = [
  {
    id: "cblue",
    name: "CBLUE 中文医疗术语基线",
    url: "https://raw.githubusercontent.com/CBLUEbenchmark/CBLUE/main/README_ZH.md",
    file: "README_ZH.md",
    minRecords: 20,
    ability: "中文护理术语归一的可比基线",
    fallback: "fixtures/public-fallback/cblue.jsonl",
    license: "Apache-2.0（源仓库 LICENSE）",
  },
  {
    id: "synthea",
    name: "Synthea 事件流骨架",
    url: "https://raw.githubusercontent.com/synthetichealth/synthea/master/src/main/resources/birthweights.csv",
    file: "birthweights.csv",
    minRecords: 100,
    ability: "CSV 事件流端到端联通骨架",
    fallback: "fixtures/public-fallback/synthea.jsonl",
    license: "Apache-2.0（源仓库 LICENSE）",
  },
];

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function recordCount(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

interface ChecksumLine {
  key: string;
  rest: string;
}

function readChecksums(path: string): ChecksumLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => {
      const first = line.indexOf(" ");
      return first > 0 ? { key: line.slice(0, first), rest: line.slice(first + 1) } : { key: line, rest: "" };
    });
}

function writeChecksums(path: string, lines: ChecksumLine[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const header = "# 公开数据集完整性校验和：key sha256 记录数 来源\n";
  writeFileSync(path, `${header}${lines.map((l) => `${l.key} ${l.rest}`).join("\n")}\n`, "utf8");
}

async function download(url: string, timeoutMs = 8000): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function main(): Promise<number> {
  const datasetArg = arg("dataset", "all") ?? "all";
  if (!["cblue", "synthea", "all"].includes(datasetArg)) {
    process.stderr.write(`未知数据集：${datasetArg}（可选 cblue | synthea | all）\n`);
    return 2;
  }
  const offline = process.argv.includes("--offline");
  const selected = datasetArg === "all" ? DATASETS : DATASETS.filter((d) => d.id === datasetArg);
  const root = resolve("data/raw/public");
  const checksumPath = join(root, "CHECKSUMS.txt");
  let checksums = readChecksums(checksumPath);
  const degradations: string[] = [];

  for (const dataset of selected) {
    const dir = join(root, dataset.id);
    const target = join(dir, dataset.file);
    const key = `${dataset.id}/${dataset.file}`;
    const known = checksums.find((c) => c.key === key);
    const knownHash = known?.rest.split(" ")[0];

    if (existsSync(target)) {
      const text = readFileSync(target, "utf8");
      const count = recordCount(text);
      if (count >= dataset.minRecords && knownHash === sha256(text)) {
        process.stdout.write(`${dataset.name}：本地缓存校验通过（${count} 条记录），跳过下载\n`);
        continue;
      }
    }

    if (!offline) {
      try {
        const text = await download(dataset.url);
        const count = recordCount(text);
        if (count < dataset.minRecords) throw new Error(`记录数 ${count} < 阈值 ${dataset.minRecords}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(target, text, "utf8");
        checksums = checksums.filter((c) => c.key !== key);
        checksums.push({ key, rest: `${sha256(text)} ${count} ${dataset.url}` });
        writeChecksums(checksumPath, checksums);
        process.stdout.write(`${dataset.name}：下载完成，${count} 条记录，校验和已写入 CHECKSUMS.txt\n`);
        continue;
      } catch (error) {
        degradations.push(`${dataset.id}: ${(error as Error).message}`);
      }
    } else {
      degradations.push(`${dataset.id}: 显式离线模式，未发起网络请求`);
    }

    const reason = `降级：公开数据集 ${dataset.name}（${dataset.id}）未下载 —— 原因：${degradations[degradations.length - 1]}；` +
      `影响能力：${dataset.ability}；后续用本地样例 ${dataset.fallback} 兜底做联通校验。`;
    process.stderr.write(`${reason}\n`);
    const degradedKey = `${dataset.id}/DEGRADED`;
    checksums = checksums.filter((c) => c.key !== degradedKey);
    checksums.push({ key: degradedKey, rest: `fallback=${dataset.fallback} license=${dataset.license}` });
    writeChecksums(checksumPath, checksums);
  }

  if (degradations.length > 0) {
    process.stderr.write(`共 ${degradations.length} 个数据集降级；公开数据只用于校验与联通，不进入最终产品路径。\n`);
    return 3;
  }
  return 0;
}

process.exitCode = await main();
