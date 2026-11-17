/**
 * SQLite 运行态底座（T7，在 T2 最小建表上深化）。
 *
 * - 运行态单文件，落 app-data/（测试用 :memory:）；
 * - 五张表：runs / steps / pauses / audit / outbox，索引按查询路径设计；
 * - schema 版本号 + 向前迁移：首次建库与旧库升级走同一路径；
 * - 只暴露参数化查询接口，业务代码不拼 SQL 字符串。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

/**
 * Node 22 的 node:sqlite 尚未列入 module.builtinModules，打包器会把它当成 npm 包去解析。
 * 用 createRequire 在运行时取内置模块，静态分析阶段看不到该 import，
 * 使 src/ 在 tsx 直跑与 Vitest/Vite 转换下行为一致（业务层仍只经本文件访问 SQLite）。
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as {
  DatabaseSync: new (path: string, options?: Record<string, unknown>) => DatabaseSyncType;
};

export type Database = DatabaseSyncType;

export const SCHEMA_VERSION = 2;

interface Migration {
  version: number;
  sql: string;
}

const SCHEMA_TEXT = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/** 解析 schema.sql：preamble + 按版本号分段的 DDL。 */
function parseSchema(text: string): { preamble: string; migrations: Migration[] } {
  const chunks = text.split(/^--\s*@migration\s+(\d+)\s*$/m);
  const preamble = chunks[0] ?? "";
  const migrations: Migration[] = [];
  for (let i = 1; i < chunks.length; i += 2) {
    migrations.push({ version: Number(chunks[i]), sql: chunks[i + 1] ?? "" });
  }
  return { preamble, migrations };
}

const { preamble, migrations } = parseSchema(SCHEMA_TEXT);

export function getSchemaVersion(db: Database): number {
  try {
    const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
      | { version: number }
      | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

/**
 * 向前迁移到 target。旧库（例如只有 v1 三表）执行同一函数即可升级。
 * 每个版本在事务内执行，失败即回滚，不允许半升级状态。
 */
export function migrate(db: Database, target: number = SCHEMA_VERSION): number {
  db.exec(preamble);
  let current = getSchemaVersion(db);
  for (const migration of migrations) {
    if (migration.version <= current || migration.version > target) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      const existing = db.prepare("SELECT COUNT(*) AS c FROM schema_version").get() as { c: number };
      if (existing.c === 0) {
        db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(migration.version);
      } else {
        db.prepare("UPDATE schema_version SET version = ?").run(migration.version);
      }
      db.exec("COMMIT");
      current = migration.version;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return current;
}

export interface OpenOptions {
  /** 指定迁移目标版本；测试可先建 v1 旧库再升级 */
  migrateTo?: number;
}

export function openDatabase(path: string = ":memory:", options: OpenOptions = {}): Database {
  const db = new DatabaseSync(path);
  migrate(db, options.migrateTo ?? SCHEMA_VERSION);
  return db;
}

/** 参数化读：业务代码只传 SQL 常量 + 占位参数。 */
export function all<T>(db: Database, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T>(db: Database, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(
  db: Database,
  sql: string,
  ...params: unknown[]
): { changes: number; lastInsertRowid: number } {
  const result = db.prepare(sql).run(...params);
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}

/** 同步事务（只包同步写；跨 await 的编排不在此事务内）。 */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function tableNames(db: Database): string[] {
  return all<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).map((r) => r.name);
}
