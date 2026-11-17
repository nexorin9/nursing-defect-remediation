/**
 * Node 22 内置 node:sqlite 的最小类型声明。
 * @types/node@20 尚未内置该模块，运行时尚属实验特性，故在此显式声明，
 * 业务层通过 store/db.ts 消费，避免把实验 API 散落到各模块。
 */
declare module "node:sqlite" {
  export interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: Record<string, unknown>);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
