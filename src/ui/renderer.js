/**
 * 渲染进程视图（原生 ES module，Electron 直接 loadFile，无需打包工具链）。
 *
 * 数据来源：preload 白名单桥 window.ndr；无桥时（无头截图 / 静态预览）
 * 使用 window.__NDR_SNAPSHOT__（由截图脚本从真实运行数据内联注入）。
 * 60 秒增量轮询保留前一次数据，刷新不闪空；凭据缺失时显式提示变量名，不静默显示空列表。
 */
const bridge = window.ndr ?? null;
const injected = window.__NDR_SNAPSHOT__ ?? null;

const COLUMNS = [
  { key: "all", label: "全部" },
  { key: "awaiting_grade", label: "待分级" },
  { key: "awaiting_review", label: "措施待复核" },
  { key: "closed", label: "待销号" },
  { key: "written_back", label: "已闭环" },
];
const CONFIRM_KINDS = [
  { key: "grade", label: "分级确认", destructive: false },
  { key: "remedy", label: "整改措施确认", destructive: false },
  { key: "review", label: "措施复核确认", destructive: false },
  { key: "close", label: "销号确认", destructive: true },
];
const PAGE_SIZE = 20;

const state = {
  items: Array.isArray(injected?.items) ? injected.items : [],
  summary: injected?.summary ?? { sweeps: 0, retries: 0, modelCalls: 0, estimatedCost: undefined },
  missingEnv: Array.isArray(injected?.missingEnv) ? injected.missingEnv : [],
  degraded: Boolean(injected?.degraded),
  selectedId: null,
  column: "all",
  ward: "",
  overdueOnly: false,
  minDwell: 0,
  page: 1,
  loading: false,
  error: "",
  confirmations: (injected?.confirmations && typeof injected.confirmations === "object") ? injected.confirmations : {},
  pendingSecond: {},
  receiptId: injected?.receiptId ?? "",
  toasts: [],
};

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const truncate = (text, max = 120) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? { text: s, truncated: false } : { text: `${s.slice(0, max)}…`, truncated: true };
};

function visibleItems() {
  return state.items.filter((item) => {
    if (state.column !== "all" && item.status !== state.column) return false;
    if (state.ward && item.ward_code !== state.ward) return false;
    if (state.overdueOnly && !item.overdue) return false;
    if (state.minDwell > 0 && Number(item.dwellMinutes ?? 0) < state.minDwell) return false;
    return true;
  });
}

function renderHeader() {
  const open = state.items.filter((i) => i.status !== "written_back").length;
  const overdue = state.items.filter((i) => i.overdue).length;
  $("metric-open").textContent = String(open);
  $("metric-overdue").textContent = String(overdue);
  $("metric-overdue").classList.toggle("is-overdue", overdue > 0);
  const banner = $("credentials-banner");
  if (state.missingEnv.length > 0) {
    banner.textContent = `配置未完成：缺少环境变量 ${state.missingEnv.join("、")}。窗口不显示空列表来假装正常，请先补齐后重启。`;
    banner.classList.add("is-visible");
  } else {
    banner.classList.remove("is-visible");
  }
}

function renderTabs() {
  const counts = { all: state.items.length };
  for (const col of COLUMNS.slice(1)) counts[col.key] = state.items.filter((i) => i.status === col.key).length;
  $("tabs").innerHTML = COLUMNS.map(
    (col) => `<button type="button" role="tab" class="ndr-tab ${state.column === col.key ? "is-active" : ""}" data-column="${col.key}" aria-selected="${state.column === col.key}">${esc(col.label)} ${counts[col.key]}</button>`,
  ).join("");
  $("tabs").querySelectorAll("[data-column]").forEach((btn) => {
    btn.addEventListener("click", () => { state.column = btn.dataset.column; state.page = 1; renderAll(); });
  });
}

function renderList() {
  const body = $("list-body");
  const items = visibleItems();
  if (state.loading && items.length === 0) {
    body.innerHTML = Array.from({ length: 4 }, (_, i) => `<div class="ndr-skeleton" style="width:${92 - i * 9}%"></div>`).join("");
    $("list-count").textContent = "加载中";
    return;
  }
  if (state.error) {
    body.innerHTML = `<div class="ndr-error"><div class="ndr-error__icon">!</div><div class="ndr-error__title">${esc(state.error)}</div><div class="ndr-caption">可重试，或联系信息科核对配置。</div><button class="ndr-btn" id="btn-retry" type="button" style="margin-top:12px">重试</button></div>`;
    $("btn-retry")?.addEventListener("click", () => { state.error = ""; refresh(); });
    return;
  }
  if (state.missingEnv.length > 0) {
    body.innerHTML = `<div class="ndr-error"><div class="ndr-error__icon">!</div><div class="ndr-error__title">缺少配置，无法拉取上报</div><div class="ndr-caption">${esc(state.missingEnv.join("、"))}</div></div>`;
    return;
  }
  if (items.length === 0) {
    body.innerHTML = `<div class="ndr-empty"><div class="ndr-empty__icon"></div><div class="ndr-empty__title">还没有收到新的护理缺陷上报</div><div class="ndr-caption">点击页头「立即巡检」拉取新上报，或等待下一次 60 秒轮询。</div></div>`;
    $("list-count").textContent = "0 件";
    $("list-pager").textContent = "";
    return;
  }
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  state.page = Math.min(state.page, totalPages);
  const pageItems = items.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
  body.innerHTML = pageItems.map((item) => {
    const tag = item.overdue ? "ndr-tag--overdue" : item.status === "written_back" ? "ndr-tag--success" : "ndr-tag--todo";
    return `<article class="ndr-card ${item.overdue ? "ndr-card--overdue" : ""} ${state.selectedId === item.incident_id ? "is-selected" : ""}" tabindex="0" role="button" data-id="${esc(item.incident_id)}" aria-label="打开 ${esc(item.incident_id)} 处置单">
      <div class="ndr-card__top"><span class="ndr-card__id">${esc(item.incident_id)}</span><span class="ndr-tag ${tag}">${esc(item.statusLabel ?? item.status)}</span></div>
      <div class="ndr-card__meta"><span>${esc(item.ward_code)}</span><span>${esc(item.shift_code)}</span><span class="ndr-card__dwell">停留 ${esc(item.dwellMinutes ?? 0)} 分钟</span>${item.overdue ? '<span class="ndr-tag ndr-tag--overdue">超期</span>' : ""}</div>
    </article>`;
  }).join("");
  body.querySelectorAll("[data-id]").forEach((card) => {
    const select = () => { state.selectedId = card.dataset.id; renderTimeline(); renderConfirm(); };
    card.addEventListener("click", select);
    card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
  });
  $("list-count").textContent = `${items.length} 件`;
  $("list-pager").textContent = `第 ${state.page} / ${totalPages} 页 · 每页 ${PAGE_SIZE} 件`;
}

function selectedItem() {
  return state.items.find((i) => i.incident_id === state.selectedId) ?? null;
}

function renderTimeline() {
  const item = selectedItem();
  const body = $("timeline-body");
  if (!item) {
    body.innerHTML = '<div class="ndr-empty"><div class="ndr-empty__icon"></div><div class="ndr-empty__title">未选中处置单</div><div class="ndr-caption">在左侧列表选中一件，查看每步走到哪儿、停了多久。</div></div>';
    $("timeline-subtitle").textContent = "选中一件查看";
    return;
  }
  const narrative = truncate(item.narrative ?? "", 600);
  let quoteHtml = esc(narrative.text);
  for (const ref of item.evidenceRefs ?? []) {
    if ((item.hallucinated ?? []).includes(ref)) continue;
    const safe = esc(ref);
    quoteHtml = quoteHtml.split(safe).join(`<mark class="ndr-quote">${safe}</mark>`);
  }
  const segments = item.timeline ?? [];
  $("timeline-subtitle").textContent = `${item.incident_id} · ${segments.filter((s) => s.kind === "step").length} 步`;
  body.innerHTML = `
    <div class="ndr-caption" style="margin-bottom:8px">上报叙述（默认脱敏）</div>
    <div class="ndr-narrative">${quoteHtml}${narrative.truncated ? "…" : ""}</div>
    <div class="ndr-caption" style="margin:16px 0 8px">处置步骤与等待</div>
    <div class="ndr-timeline">${segments.map((seg) => `
      <div class="ndr-tl-seg ndr-tl-seg--${esc(seg.status)}">
        <div class="ndr-tl-seg__head"><span class="ndr-tl-seg__name">${esc(seg.name)}</span><span class="ndr-caption">${esc(seg.label)}</span></div>
        <div class="ndr-tl-seg__meta">${esc(seg.operator)} · ${seg.kind === "waiting" ? "卡在等人，不是卡在系统" : esc(seg.status === "running" ? "进行中" : "已完成")}</div>
        <div class="ndr-tl-bar"><div class="ndr-tl-bar__fill" style="width:${Math.max(2, Math.round((seg.bar_width ?? 0) * 100))}%"></div></div>
      </div>`).join("")}</div>`;
}

function confirmStateFor(kind) {
  return state.confirmations[kind] ?? { confirmed: false, second: false };
}

function allConfirmed() {
  return CONFIRM_KINDS.every((k) => confirmStateFor(k.key).confirmed && (!k.destructive || confirmStateFor(k.key).second));
}

function renderConfirmPanel(target) {
  const item = selectedItem();
  if (!item) {
    target.innerHTML = '<div class="ndr-empty"><div class="ndr-empty__title">未选中处置单</div><div class="ndr-caption">选中一件后在此完成四类人工确认。</div></div>';
    return;
  }
  const done = CONFIRM_KINDS.filter((k) => confirmStateFor(k.key).confirmed).length;
  const degradedNotice = state.degraded
    ? '<div class="ndr-degraded">模型不可达，已用规则初判，待人工确认。结论一律标为草稿，不自动推进、不回写。</div>'
    : "";
  const draft = item.draft ?? {};
  const itemsHtml = CONFIRM_KINDS.map((k) => {
    const st = confirmStateFor(k.key);
    const needsSecond = k.destructive && st.confirmed && !st.second;
    const label = st.second ? "已确认" : needsSecond ? "再次点击以确认" : st.confirmed ? "已确认" : "确认";
    return `<div class="ndr-confirm-item">
      <div class="ndr-confirm-item__head"><span>${esc(k.label)}</span><button type="button" class="ndr-btn ${st.second ? "ndr-btn--disabled" : "ndr-btn--primary"}" data-confirm="${k.key}" ${st.second ? "disabled" : ""}>${label}</button></div>
      <div class="ndr-hint">模型草稿：${esc(k.key === "grade" ? draft.grade ?? "待生成" : k.key === "remedy" ? draft.remediation_plan ?? "待生成" : "复核/销号结论")} · 依据原句见中部高亮 · 规则校验结论：${st.confirmed ? "已通过人工确认" : "待确认"}</div>
    </div>`;
  }).join("");
  const disabled = !allConfirmed();
  target.innerHTML = `${degradedNotice}
    <div class="ndr-draft"><strong>模型草稿（不是结论）</strong><div class="ndr-caption" style="margin-top:4px">分级：${esc(draft.grade ?? "待人工分级")} · 措施：${esc(truncate(draft.remediation_plan ?? "待补充", 80).text)}</div></div>
    <ul class="ndr-rule-list"><li>四类结论一律人工确认；模型不得直接调用写回接口。</li><li>引文回查未通过的原句不进入确认闸门与回写内容。</li></ul>
    <div style="margin-top:8px">${itemsHtml}</div>
    <div style="margin-top:16px">
      <button type="button" data-writeback class="ndr-btn ndr-btn--primary ${disabled ? "ndr-btn--disabled" : ""}" ${disabled ? "disabled" : ""} style="width:100%">回写质控系统</button>
      <div class="ndr-hint">${disabled ? `需先完成四类人工确认（当前 ${done}/4），未确认时按钮禁用且不发起任何 POST。` : "已全部确认，可发起一次回写。"}</div>
    </div>
    ${state.receiptId ? `<div class="ndr-tag ndr-tag--success" style="margin-top:12px">回执号 ${esc(state.receiptId)}</div>` : ""}`;
  target.querySelectorAll("[data-confirm]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.dataset.confirm;
      const def = CONFIRM_KINDS.find((k) => k.key === kind);
      const st = confirmStateFor(kind);
      if (def.destructive && st.confirmed && !st.second) {
        state.confirmations[kind] = { confirmed: true, second: true };
        toast("success", `${def.label}已二次确认`);
      } else if (!st.confirmed) {
        state.confirmations[kind] = { confirmed: true, second: false };
        toast("success", `${def.label}完成`);
        if (def.destructive) toast("warning", "破坏性操作需再次点击确认");
      }
      renderConfirm();
    });
  });
  target.querySelector("[data-writeback]")?.addEventListener("click", async () => {
    if (!allConfirmed()) return;
    try {
      const result = bridge?.confirm ? await bridge.confirm({ kind: "close", incident_id: item.incident_id }) : { receipt_id: state.receiptId || "RCP-LOCAL-PREVIEW" };
      state.receiptId = result?.receipt_id ?? state.receiptId;
      toast("success", `回写成功，回执号 ${state.receiptId}`);
      renderConfirm();
    } catch (error) {
      toast("fail", `回写失败：${error.message ?? error}`);
    }
  });
}

function renderConfirm() {
  renderConfirmPanel($("confirm-body"));
  renderConfirmPanel($("drawer-body"));
  $("confirm-progress").textContent = `${CONFIRM_KINDS.filter((k) => confirmStateFor(k.key).confirmed).length} / 4`;
  $("drawer").classList.toggle("is-open", false);
}

function renderSummary() {
  $("sum-sweeps").textContent = String(state.summary.sweeps ?? 0);
  $("sum-retries").textContent = String(state.summary.retries ?? 0);
  $("sum-model").textContent = String(state.summary.modelCalls ?? 0);
  const cost = state.summary.estimatedCost;
  $("sum-cost").textContent = typeof cost === "number" ? `¥${cost.toFixed(2)}` : "未配置单价";
}

function renderFilters() {
  const wards = [...new Set(state.items.map((i) => i.ward_code).filter(Boolean))];
  const select = $("filter-ward");
  select.innerHTML = '<option value="">全部病区</option>' + wards.map((w) => `<option value="${esc(w)}" ${state.ward === w ? "selected" : ""}>${esc(w)}</option>`).join("");
}

function toast(kind, text) {
  const entry = { kind, text, id: `${Date.now()}-${Math.random()}` };
  state.toasts.push(entry);
  state.toasts = state.toasts.slice(-3);
  const paint = () => { $("toasts").innerHTML = state.toasts.map((t) => `<div class="ndr-toast ndr-toast--${t.kind}">${esc(t.text)}</div>`).join(""); };
  paint();
  setTimeout(() => { state.toasts = state.toasts.filter((x) => x.id !== entry.id); paint(); }, 4000);
}

function renderAll() {
  renderHeader();
  renderTabs();
  renderFilters();
  renderList();
  renderTimeline();
  renderConfirm();
  renderSummary();
}

/** 增量刷新：合并新数据，保留前一次内容（不闪空）。 */
async function refresh() {
  if (!bridge?.refresh) return;
  state.loading = true;
  try {
    const incoming = await bridge.refresh();
    const merged = new Map(state.items.map((i) => [i.incident_id, i]));
    for (const item of incoming?.items ?? []) merged.set(item.incident_id, item);
    state.items = [...merged.values()];
    if (incoming?.summary) state.summary = incoming.summary;
    if (Array.isArray(incoming?.missingEnv)) state.missingEnv = incoming.missingEnv;
    state.error = "";
  } catch (error) {
    state.error = `拉取失败：${error.message ?? error}`;
  } finally {
    state.loading = false;
    renderAll();
  }
}

$("filter-ward").addEventListener("change", (e) => { state.ward = e.target.value; state.page = 1; renderList(); });
$("filter-overdue").addEventListener("change", (e) => { state.overdueOnly = e.target.value === "yes"; state.page = 1; renderList(); });
$("filter-dwell").addEventListener("input", (e) => { state.minDwell = Number(e.target.value) || 0; state.page = 1; renderList(); });
$("btn-sweep").addEventListener("click", async () => {
  toast("warning", "正在执行立即巡检…");
  try { if (bridge?.sweepNow) await bridge.sweepNow(); await refresh(); toast("success", "巡检完成，超期条目已更新"); }
  catch (error) { toast("fail", `巡检失败：${error.message ?? error}`); }
});
$("btn-export").addEventListener("click", async () => {
  try { const result = bridge?.exportLedger ? await bridge.exportLedger() : null; toast("success", result?.path ? `台账已导出：${result.path}` : "台账导出命令已下发"); }
  catch (error) { toast("fail", `导出失败：${error.message ?? error}`); }
});
$("btn-drawer").addEventListener("click", () => $("drawer").classList.add("is-open"));
$("btn-drawer-close").addEventListener("click", () => $("drawer").classList.remove("is-open"));

/** 主进程 did-finish-load 后注入真实运行快照（无头截图也走同一入口）。 */
window.__NDR_APPLY__ = (data) => {
  if (!data) return;
  if (Array.isArray(data.items)) state.items = data.items;
  if (data.summary) state.summary = data.summary;
  if (Array.isArray(data.missingEnv)) state.missingEnv = data.missingEnv;
  if (typeof data.degraded === "boolean") state.degraded = data.degraded;
  if (data.receiptId) state.receiptId = data.receiptId;
  if (data.confirmations && typeof data.confirmations === "object") state.confirmations = data.confirmations;
  if (typeof data.selectedId === "string") state.selectedId = data.selectedId;
  if (state.items.length > 0 && !state.selectedId) state.selectedId = state.items[0].incident_id;
  renderAll();
};
window.addEventListener("ndr:snapshot", () => window.__NDR_APPLY__(window.__NDR_SNAPSHOT__));

renderAll();
if (state.items.length > 0) state.selectedId = state.items[0].incident_id;
renderTimeline();
renderConfirm();
if (bridge?.onUpdate) bridge.onUpdate((payload) => { if (payload?.items) { state.items = payload.items; renderAll(); } });
if (bridge?.refresh) setInterval(refresh, 60_000);
