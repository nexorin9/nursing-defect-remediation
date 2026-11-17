/**
 * Electron 主进程生命周期（T39）：可注入的单实例 / 托盘 / 开机自启 / 退出前 drain。
 *
 * 业务逻辑与 Electron API 分离：纯逻辑放在这里可直接测试，
 * src/main/index.ts 只做装配，不在测试里启动真实 Electron。
 */
export interface ElectronLike {
  requestSingleInstanceLock(): boolean;
  focusMainWindow(): void;
  createWindow(): void;
  hideToTray(): void;
  setLoginItemSettings(options: { openAtLogin: boolean }): void;
  setTrayMenu(items: readonly TrayMenuItem[]): void;
}

export interface TrayMenuItem {
  label: string;
  action: "show" | "sweep" | "export" | "quit";
}

export interface LifecycleDeps {
  drainOnce: () => Promise<void>;
  onSweep: () => Promise<void>;
  onExport: () => Promise<void>;
  onShow: () => void;
  onQuit: () => void;
}

export interface Lifecycle {
  handleSecondInstance(): void;
  trayMenu(): TrayMenuItem[];
  beforeQuit(): Promise<void>;
  setAutoLaunch(enabled: boolean): void;
  closeToTray(): void;
  show(): void;
  drainCallCount(): number;
  windowCreateCount(): number;
  focusCount(): number;
}

/** 托盘菜单固定四项：显示窗口 / 立即巡检 / 导出台账 / 退出。 */
export const TRAY_MENU: readonly TrayMenuItem[] = [
  { label: "显示窗口", action: "show" },
  { label: "立即巡检", action: "sweep" },
  { label: "导出台账", action: "export" },
  { label: "退出", action: "quit" },
];

export function createLifecycle(electron: ElectronLike, deps: LifecycleDeps): Lifecycle {
  let drains = 0;
  let windows = 0;
  let focuses = 0;
  let autoLaunchEnabled = false;

  const lifecycle: Lifecycle = {
    handleSecondInstance() {
      // second-instance 事件只在已有实例持有锁时触发：只聚焦已有窗口，绝不新开第二个窗口
      electron.focusMainWindow();
      focuses += 1;
    },
    trayMenu() {
      return [...TRAY_MENU];
    },
    async beforeQuit() {
      drains += 1;
      await deps.drainOnce();
    },
    setAutoLaunch(enabled: boolean) {
      autoLaunchEnabled = enabled;
      electron.setLoginItemSettings({ openAtLogin: enabled });
    },
    closeToTray() {
      electron.hideToTray();
    },
    show() {
      electron.focusMainWindow();
      deps.onShow();
    },
    drainCallCount: () => drains,
    windowCreateCount: () => windows,
    focusCount: () => focuses,
  };

  // 首次启动时只有一份窗口；单实例锁失败时走 handleSecondInstance 的聚焦路径
  if (electron.requestSingleInstanceLock()) {
    electron.createWindow();
    windows += 1;
  }
  electron.setTrayMenu(TRAY_MENU);
  return lifecycle;
}

export function trayActionHandler(
  deps: LifecycleDeps,
  lifecycle: Lifecycle,
  action: TrayMenuItem["action"],
): Promise<void> | void {
  switch (action) {
    case "show":
      return lifecycle.show();
    case "sweep":
      return deps.onSweep();
    case "export":
      return deps.onExport();
    case "quit":
      return lifecycle.beforeQuit().then(deps.onQuit);
  }
}
