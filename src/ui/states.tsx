/**
 * UI 状态与打磨（T44）：加载 / 空 / 错误三态 + toast + 运行摘要所需的凭据提示。
 */
export type ViewState = "loading" | "empty" | "error" | "ready";

export function decideViewState(args: { loading: boolean; error?: string; itemCount: number; missingEnv?: string[] }): ViewState {
  if ((args.missingEnv?.length ?? 0) > 0) return "error";
  if (args.error) return "error";
  if (args.loading && args.itemCount === 0) return "loading";
  if (args.itemCount === 0) return "empty";
  return "ready";
}

export function renderStateView(
  state: ViewState,
  options: { error?: string; missingEnv?: string[] } = {},
): string {
  switch (state) {
    case "loading":
      return '<div class="ndr-skeleton" style="width:92%"></div><div class="ndr-skeleton" style="width:80%"></div><div class="ndr-skeleton" style="width:86%"></div>';
    case "empty":
      return '<div class="ndr-empty"><div class="ndr-empty__icon"></div><div class="ndr-empty__title">还没有收到新的护理缺陷上报</div><div class="ndr-caption">点击「立即巡检」拉取新上报，或等待下一次 60 秒轮询。</div></div>';
    case "error": {
      const reason = (options.missingEnv?.length ?? 0) > 0
        ? `缺少环境变量：${options.missingEnv!.join("、")}`
        : options.error ?? "拉取失败";
      return `<div class="ndr-error"><div class="ndr-error__icon">!</div><div class="ndr-error__title">${reason}</div><div class="ndr-caption">窗口不静默显示空列表；请补齐配置后重试。</div><button class="ndr-btn" data-retry type="button">重试</button></div>`;
    }
    default:
      return "";
  }
}

export function toastRules(): { durationMs: number; maxStack: number; kinds: string[] } {
  return { durationMs: 4000, maxStack: 3, kinds: ["success", "warning", "fail"] };
}

/** 凭据缺失时显式提示变量名，不用空列表假装正常。 */
export function missingCredentialsBanner(missingEnv: string[]): string {
  if (missingEnv.length === 0) return "";
  return `<div class="ndr-credentials-banner is-visible" role="alert">配置未完成：缺少环境变量 ${missingEnv.join("、")}。请先补齐后重启。</div>`;
}
