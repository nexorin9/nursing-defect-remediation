/**
 * 契约一致性校验（T9）。
 *
 * 把 docs/api/*.yaml（OpenAPI 3.1）的 required 与 enum 与
 * src/domain/contract.ts 的 TypeScript 字段规范逐项比对；
 * 不一致即非 0 退出，防止契约与实现悄悄漂移。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { CONTRACT_FILES, CONTRACT_SPECS, CONTRACT_CREDENTIALS } from "../src/domain/contract.js";

export interface ContractCheck {
  ok: boolean;
  problems: string[];
  checkedFiles: number;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).sort() : [];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort().join("|");
  const right = [...b].sort().join("|");
  return left === right;
}

/** 纯函数入口：测试可传入被篡改的契约文本，断言校验会失败。 */
export function checkContractTexts(texts: Record<string, string>): ContractCheck {
  const problems: string[] = [];
  let checkedFiles = 0;
  for (const file of CONTRACT_FILES) {
    const name = file.split("/").pop()!;
    const text = texts[name];
    if (text === undefined) {
      problems.push(`缺少契约文件：${file}`);
      continue;
    }
    checkedFiles += 1;
    let doc: JsonObject;
    try {
      doc = asObject(load(text));
    } catch (error) {
      problems.push(`${name} 无法解析为 YAML：${(error as Error).message}`);
      continue;
    }
    if (doc.openapi !== "3.1.0") problems.push(`${name} openapi 版本不是 3.1.0`);
    const schemas = asObject(asObject(doc.components).schemas);
    const specs = CONTRACT_SPECS[name] ?? {};
    for (const [schemaName, spec] of Object.entries(specs)) {
      const schema = asObject(schemas[schemaName]);
      if (Object.keys(schema).length === 0) {
        problems.push(`${name} 缺少 schema：${schemaName}`);
        continue;
      }
      const required = asStringArray(schema.required);
      if (!sameSet(required, spec.required)) {
        problems.push(`${name} ${schemaName} 必填字段不一致：契约 [${required.join(",")}] vs 代码 [${spec.required.join(",")}]`);
      }
      const properties = asObject(schema.properties);
      for (const [field, expected] of Object.entries(spec.enums ?? {})) {
        const actual = asStringArray(asObject(properties[field]).enum);
        if (!sameSet(actual, expected)) {
          problems.push(`${name} ${schemaName}.${field} 枚举不一致：契约 [${actual.join(",")}] vs 代码 [${expected.join(",")}]`);
        }
      }
    }
  }
  const allText = Object.values(texts).join("\n");
  for (const credential of CONTRACT_CREDENTIALS) {
    if (!allText.includes(credential)) problems.push(`契约未写明凭据位：${credential}`);
  }
  return { ok: problems.length === 0, problems, checkedFiles };
}

/** 从磁盘读取 4 份契约。 */
export function checkContracts(baseDir: string): ContractCheck {
  const texts: Record<string, string> = {};
  for (const file of CONTRACT_FILES) {
    const path = join(baseDir, file);
    if (existsSync(path)) texts[file.split("/").pop()!] = readFileSync(path, "utf8");
  }
  return checkContractTexts(texts);
}

const isCli = process.argv[1]?.endsWith("check-contract.ts") ?? false;
if (isCli) {
  const result = checkContracts(process.cwd());
  if (result.ok) {
    process.stdout.write(`契约一致性校验通过：${result.checkedFiles} 份 OpenAPI 3.1 文件，必填字段 / 枚举 / 凭据位与代码一致\n`);
    process.exit(0);
  }
  process.stderr.write(`契约一致性校验失败：\n${result.problems.map((p) => `  - ${p}`).join("\n")}\n`);
  process.exit(1);
}
