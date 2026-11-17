/**
 * preload 装配入口：Electron 加载本文件时把受限桥挂到 window.ndr。
 * 纯逻辑与白名单定义在 src/main/preload.ts（无 electron 依赖，可无头测试）。
 */
import { contextBridge, ipcRenderer } from "electron";
import { BRIDGE_NAME, IPC_CHANNELS, pickBridge, assertBridge } from "./preload.js";

const candidates: Record<string, unknown> = {
  refresh: () => ipcRenderer.invoke(IPC_CHANNELS[0]),
  getRuns: () => ipcRenderer.invoke(IPC_CHANNELS[1]),
  sweepNow: () => ipcRenderer.invoke(IPC_CHANNELS[2]),
  confirm: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS[3], payload),
  exportLedger: () => ipcRenderer.invoke(IPC_CHANNELS[4]),
  getSummary: () => ipcRenderer.invoke(IPC_CHANNELS[5]),
  onUpdate: (callback: (payload: unknown) => void) =>
    ipcRenderer.on(IPC_CHANNELS[6], (_event, payload: unknown) => callback(payload)),
};

const bridge = pickBridge(candidates);
const check = assertBridge(bridge);
if (!check.ok) throw new Error(`preload 桥白名单校验失败：${check.violations.join("；")}`);
contextBridge.exposeInMainWorld(BRIDGE_NAME, bridge);
