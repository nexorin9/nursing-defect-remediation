-- 护理缺陷整改闭环系统 · 运行态 schema
-- 由 src/store/db.ts 按「-- @migration N」分段执行；首次建库与后续升级走同一路径。
-- 时间字段统一 UTC ISO 8601 字符串；展示层再转本地时区。
-- audit 只增不改：本文件不为该表提供任何变更或移除语句。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

-- @migration 1
-- v1：最小端到端切片所需三张表（T2）
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  ward_code TEXT NOT NULL DEFAULT '',
  shift_code TEXT NOT NULL DEFAULT '',
  narrative_redacted TEXT NOT NULL DEFAULT '',
  assignee_key TEXT NOT NULL DEFAULT 'default',
  step_cursor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  receipt_id TEXT,
  degraded INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_status_updated ON runs(status, updated_at);

CREATE TABLE IF NOT EXISTS steps (
  step_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  status TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  operator TEXT NOT NULL DEFAULT 'system',
  retry_count INTEGER NOT NULL DEFAULT 0,
  input_hash TEXT NOT NULL DEFAULT '',
  output_hash TEXT,
  step_hash TEXT UNIQUE,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id, idx);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  operator TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  input_hash TEXT NOT NULL DEFAULT '',
  output_hash TEXT NOT NULL DEFAULT '',
  model_call_id TEXT,
  from_state TEXT,
  to_state TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit(run_id, at);

-- @migration 2
-- v2：挂起、出站盒、并发闸门槽位（T7）
CREATE TABLE IF NOT EXISTS pauses (
  pause_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  wait_event TEXT NOT NULL,
  payload_key TEXT NOT NULL,
  timeout_policy TEXT NOT NULL DEFAULT '等待人工',
  paused_at TEXT NOT NULL,
  resumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pauses_run_event ON pauses(run_id, wait_event);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  receipt_id TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_kind_batch ON outbox(kind, batch_id);

CREATE TABLE IF NOT EXISTS slots (
  gate_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (gate_key, run_id, position)
);
CREATE INDEX IF NOT EXISTS idx_slots_key ON slots(gate_key, position);
