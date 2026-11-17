/**
 * Electron 主进程（T39）：托盘常驻 + 单实例 + 开机自启 + 退出前 drain。
 *
 * 主进程同时是常驻运行时：60 秒轮询拉增量上报、每日 08:00 超期巡检、
 * 经 engine.resume 单点入口推进、人工确认后回写质控系统。
 * 渲染进程只通过 preload 白名单桥访问主进程，不暴露任意 ipc 通道。
 * 凭据缺失时窗口显式显示缺失变量名，不静默显示空列表。
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, type IpcMainInvokeEvent } from "electron";

import { openDatabase } from "../store/db.js";
import { Engine } from "../runtime/engine.js";
import { Scheduler } from "../runtime/scheduler.js";
import { drain } from "../runtime/drain.js";
import { createLifecycle, trayActionHandler } from "./lifecycle.js";
import { TRAY_ICON_DATA_URL } from "./tray-icon.js";
import { IPC_CHANNELS } from "./preload.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../config/runtime-config.js";
import { OutboundHttp } from "../adapters/http.js";
import { NursingQcReader } from "../adapters/nursing-qc.js";
import { submitReview } from "../adapters/writeback.js";
import { auditSummary } from "../store/audit.js";
import { summarizeModelCalls } from "../gateway/ledger.js";
import { exportLedgerXlsx, ledgerRowsFromDb } from "../export/ledger.js";
import { exportOverdueCsv } from "../export/overdue.js";
import { STATE_LABELS, type RunState } from "../domain/models.js";
import { accumulatedPauseMs } from "../runtime/pause.js";
import { isOverdue } from "../domain/policy.js";

const here = dirname(fileURLToPath(import.meta.url));

function resolveUiHtml(): string {
  const candidates = [
    join(app.getAppPath(), "src", "ui", "index.html"),
    resolve(process.cwd(), "src", "ui", "index.html"),
    join(here, "..", "..", "ui", "index.html"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

function resolvePreload(): string | undefined {
  const candidates = [
    join(here, "preload-entry.js"),
    join(app.getAppPath(), "dist", "src", "main", "preload-entry.js"),
    resolve(process.cwd(), "dist", "src", "main", "preload-entry.js"),
  ];
  return candidates.find((p) => existsSync(p));
}

interface Runtime {
  config?: RuntimeConfig;
  missingEnv: string[];
  db: ReturnType<typeof openDatabase>;
  engine: Engine;
  scheduler?: Scheduler;
}

function createRuntime(): Runtime {
  const dbPath = resolve(process.cwd(), "app-data", "runtime.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  let config: RuntimeConfig | undefined;
  let missingEnv: string[] = [];
  try {
    config = loadRuntimeConfig();
  } catch (error) {
    missingEnv = (error as { missing?: string[] }).missing ?? ["NURSING_QC_TOKEN"];
  }
  const engine = new Engine({ db });
  const runtime: Runtime = { config, missingEnv, db, engine };
  if (config) {
    const http = new OutboundHttp(config, { db });
    const reader = new NursingQcReader(http);
    runtime.scheduler = new Scheduler({
      engine,
      db,
      source: { listNew: (since) => reader.listAllNew(since) },
      pollIntervalSec: config.pollIntervalSec,
    });
    runtime.scheduler.start();
  }
  return runtime;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: Runtime | null = null;
let drainCalls = 0;
let quitting = false;

function snapshot(): Record<string, unknown> {
  const rt = runtime;
  if (!rt) return { items: [], missingEnv: [], summary: {} };
  const now = Date.now();
  const items = rt.engine.listRuns().map((run) => {
    const elapsedMs = accumulatedPauseMs(rt.db, run.run_id, now) || Math.max(0, now - Date.parse(run.created_at));
    const overdue = isOverdue(rt.engine.policy, run.status, elapsedMs) === true;
    return {
      incident_id: run.incident_id,
      ward_code: run.ward_code,
      shift_code: run.shift_code,
      status: run.status,
      statusLabel: STATE_LABELS[run.status as RunState],
      dwellMinutes: Math.floor(elapsedMs / 60_000),
      overdue,
      assignee: run.assignee_key,
      narrative: run.narrative_redacted,
      timeline: [],
      evidenceRefs: [],
      hallucinated: [],
      draft: {},
      receiptId: run.receipt_id ?? "",
    };
  });
  const audit = auditSummary(rt.db);
  const model = summarizeModelCalls(rt.db);
  return {
    items,
    missingEnv: rt.missingEnv,
    degraded: false,
    summary: {
      sweeps: audit.sweeps,
      retries: audit.retries,
      modelCalls: Math.max(audit.modelCalls, model.calls),
      estimatedCost: model.cost ?? audit.estimatedCost,
    },
  };
}

function createWindow(): void {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }
  const preload = resolvePreload();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "护理缺陷整改闭环",
    backgroundColor: "#F4F6FA",
    ...(preload ? { webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false } } : {}),
  });
  void mainWindow.loadFile(resolveUiHtml());
  mainWindow.webContents.on("did-finish-load", () => {
    void mainWindow?.webContents.executeJavaScript(
      `window.__NDR_SNAPSHOT__ = ${JSON.stringify(snapshot())}; window.dispatchEvent(new Event('ndr:snapshot'));`,
    );
  });
  // 关闭隐藏到托盘，不退出；退出由托盘菜单触发 beforeQuit
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function setupIpc(): void {
  ipcMain.handle(IPC_CHANNELS[0], async () => snapshot());
  ipcMain.handle(IPC_CHANNELS[1], async () => snapshot().items);
  ipcMain.handle(IPC_CHANNELS[2], async () => {
    if (!runtime?.scheduler) return { error: "巡检需要完整配置" };
    const result = runtime.scheduler.sweepNow();
    return { batch_id: result.batch_id, enqueued: result.items.length };
  });
  ipcMain.handle(IPC_CHANNELS[3], async (_event: IpcMainInvokeEvent, payload: { kind?: string; incident_id?: string }) => {
    const rt = runtime;
    if (!rt || !payload.incident_id || !payload.kind) return { ok: false, reason: "参数不完整" };
    const run = rt.engine.getRunByIncident(payload.incident_id);
    if (!run) return { ok: false, reason: "处置单不存在" };
    const kind = ["grade", "remedy", "review", "close"].includes(payload.kind)
      ? (payload.kind as "grade" | "remedy" | "review" | "close")
      : undefined;
    if (!kind) return { ok: false, reason: "未知确认类型" };
    const resumed = await rt.engine.resume(run.run_id, {
      kind,
      confirmed: true,
      operator: "nurse_manager",
      payloadKey: run.incident_id,
    });
    if (!resumed.advanced) return { ok: false, reason: resumed.reason };
    const current = rt.engine.getRun(run.run_id);
    if (kind === "close" && rt.config && current && current.receipt_id === undefined) {
      // 真实外发：只在人工确认后、且配置齐备时调用质控回写
      const http = new OutboundHttp(rt.config, { db: rt.db });
      const written = await submitReview(
        current.incident_id,
        {
          review_result: "人工确认销号",
          grade: "人工确认",
          remediation_plan: current.narrative_redacted,
          plan_deadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          evidence_refs: [],
          revision: current.revision,
        },
        { http, db: rt.db, runId: current.run_id },
      );
      return { ok: written.ok, receipt_id: written.receipt_id, reason: written.reason };
    }
    return { ok: true, receipt_id: current?.receipt_id };
  });
  ipcMain.handle(IPC_CHANNELS[4], async () => {
    if (!runtime) return { ok: false, reason: "运行时未就绪" };
    const rows = ledgerRowsFromDb(runtime.db);
    const ledger = await exportLedgerXlsx(rows);
    const overdue = exportOverdueCsv(
      rows.map((r) => ({ incident_id: r.incident_id, dwell_minutes: r.dwell_minutes, current_step: r.current_step, assignee: "病区护士长" })),
    );
    return { ok: true, path: ledger.path, ledgerRows: ledger.rowCount, overdueRows: overdue.rowCount };
  });
  ipcMain.handle(IPC_CHANNELS[5], async () => snapshot().summary);
}

function bootstrap(): void {
  runtime = createRuntime();
  setupIpc();
  const electronLike = {
    requestSingleInstanceLock: () => gotLock,
    focusMainWindow: () => {
      if (!mainWindow) createWindow();
      mainWindow?.show();
      mainWindow?.focus();
    },
    createWindow,
    hideToTray: () => mainWindow?.hide(),
    setLoginItemSettings: (options: { openAtLogin: boolean }) => app.setLoginItemSettings(options),
    setTrayMenu: (items: readonly { label: string; action: "show" | "sweep" | "export" | "quit" }[]) => {
      if (!tray) return;
      tray.setContextMenu(Menu.buildFromTemplate(items.map((item) => ({
        label: item.label,
        click: () => { void trayActionHandler(deps, lifecycle, item.action); },
      }))));
    },
  };
  const deps = {
    drainOnce: async () => {
      if (!runtime) return;
      await drain({ db: runtime.db, engine: runtime.engine });
    },
    onSweep: async () => { runtime?.scheduler?.sweepNow(); },
    onExport: async () => {
      if (!runtime) return;
      await exportLedgerXlsx(ledgerRowsFromDb(runtime.db));
    },
    onShow: () => undefined,
    onQuit: () => { quitting = true; app.quit(); },
  };
  const lifecycle = createLifecycle(electronLike, deps);
  app.on("second-instance", () => lifecycle.handleSecondInstance());
  app.on("before-quit", () => { drainCalls += 1; });
  void drainCalls;

  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
  tray.setToolTip("护理缺陷整改闭环系统");
  electronLike.setTrayMenu([
    { label: "显示窗口", action: "show" },
    { label: "立即巡检", action: "sweep" },
    { label: "导出台账", action: "export" },
    { label: "退出", action: "quit" },
  ]);
  tray.on("click", () => electronLike.focusMainWindow());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(bootstrap).catch((error) => {
    process.stderr.write(`主进程启动失败：${(error as Error).message}\n`);
  });
}
// 托盘常驻：关掉窗口不退出应用
app.on("window-all-closed", () => undefined);
