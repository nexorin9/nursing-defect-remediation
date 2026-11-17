/** T39 · Electron 主进程生命周期 + preload 白名单桥（不启动真实 Electron）。 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLifecycle, trayActionHandler, TRAY_MENU, type ElectronLike } from "../../src/main/lifecycle.js";
import {
  BRIDGE_API,
  BRIDGE_NAME,
  FORBIDDEN_BRIDGE_KEYS,
  IPC_CHANNELS,
  assertBridge,
  pickBridge,
} from "../../src/main/preload.js";

function fakeElectron() {
  const calls: string[] = [];
  const electron: ElectronLike = {
    requestSingleInstanceLock: () => true,
    focusMainWindow: () => { calls.push("focus"); },
    createWindow: () => { calls.push("createWindow"); },
    hideToTray: () => { calls.push("hideToTray"); },
    setLoginItemSettings: (options) => { calls.push(`login:${options.openAtLogin}`); },
    setTrayMenu: () => { calls.push("trayMenu"); },
  };
  return { electron, calls };
}

function deps() {
  const log: string[] = [];
  return {
    log,
    deps: {
      drainOnce: async () => { log.push("drain"); },
      onSweep: async () => { log.push("sweep"); },
      onExport: async () => { log.push("export"); },
      onShow: () => { log.push("show"); },
      onQuit: () => { log.push("quit"); },
    },
  };
}

describe("Electron 主进程生命周期", () => {
  it("second-instance 只聚焦已有窗口，不新开实例", () => {
    const { electron, calls } = fakeElectron();
    const { deps: d } = deps();
    const lifecycle = createLifecycle(electron, d);
    expect(lifecycle.windowCreateCount()).toBe(1);
    lifecycle.handleSecondInstance();
    lifecycle.handleSecondInstance();
    expect(lifecycle.focusCount()).toBe(2);
    expect(lifecycle.windowCreateCount()).toBe(1);
    expect(calls.filter((c) => c === "createWindow")).toHaveLength(1);
  });

  it("退出流程调用 drain 一次；关闭窗口只隐藏到托盘；托盘菜单四项齐全", async () => {
    const { electron, calls } = fakeElectron();
    const { log, deps: d } = deps();
    const lifecycle = createLifecycle(electron, d);
    lifecycle.closeToTray();
    expect(calls).toContain("hideToTray");
    expect(log).not.toContain("quit");
    await trayActionHandler(d, lifecycle, "quit");
    expect(lifecycle.drainCallCount()).toBe(1);
    expect(log).toContain("drain");
    expect(log).toContain("quit");
    expect(lifecycle.trayMenu().map((i) => i.action)).toEqual(["show", "sweep", "export", "quit"]);
    expect(TRAY_MENU.map((i) => i.label)).toContain("导出台账");
  });

  it("开机自启开关落到 setLoginItemSettings；立即巡检 / 导出经托盘动作", async () => {
    const { electron, calls } = fakeElectron();
    const { log, deps: d } = deps();
    const lifecycle = createLifecycle(electron, d);
    lifecycle.setAutoLaunch(true);
    lifecycle.setAutoLaunch(false);
    expect(calls).toContain("login:true");
    expect(calls).toContain("login:false");
    await trayActionHandler(d, lifecycle, "sweep");
    await trayActionHandler(d, lifecycle, "export");
    expect(log).toContain("sweep");
    expect(log).toContain("export");
  });

  it("preload 桥只暴露白名单 API，不含任意 ipc 通道", () => {
    const allowed: Record<string, unknown> = {};
    for (const key of BRIDGE_API) allowed[key] = () => undefined;
    expect(assertBridge(allowed).ok).toBe(true);
    expect(assertBridge({ ...allowed, ipcRenderer: {} }).ok).toBe(false);
    expect(assertBridge({ ...allowed, invoke: () => undefined }).violations.join(" ")).toContain("未授权键");
    const missing = { ...allowed };
    delete missing.refresh;
    expect(assertBridge(missing).ok).toBe(false);
    const picked = pickBridge({ ...allowed, ipcRenderer: {}, send: () => undefined, unrelated: 1 });
    expect(Object.keys(picked).sort()).toEqual([...BRIDGE_API].sort());
    expect(assertBridge(picked).ok).toBe(true);
    expect(BRIDGE_NAME).toBe("ndr");
    expect(IPC_CHANNELS).toHaveLength(BRIDGE_API.length);
    expect(FORBIDDEN_BRIDGE_KEYS).toContain("ipcRenderer");
  });

  it("主进程装配文件存在：单实例锁 / 托盘 / drain / contextIsolation", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main/index.ts"), "utf8");
    const preload = readFileSync(resolve(process.cwd(), "src/main/preload-entry.ts"), "utf8");
    expect(main).toContain("requestSingleInstanceLock");
    expect(main).toContain("Tray");
    expect(main).toContain("drain");
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("nodeIntegration: false");
    expect(preload).toContain("contextBridge");
    expect(existsSync(resolve(process.cwd(), "src/main/tray-icon.ts"))).toBe(true);
  });
});
