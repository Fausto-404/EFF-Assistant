const $ = (id) => document.getElementById(id);
const HISTORY_KEY = "effAssistantOperationHistory";
let runtimeState = null;
let context = null;
let historyItems = [];
let currentPageText = "";
let historyFolded = true;
let lastAction = "";
let lastActionStatus = null;

init();

async function init() {
  bind();
  await refreshAll();
}

function bind() {
  $("themeToggle").addEventListener("click", toggleTheme);
  $("toggleAssistant").addEventListener("click", toggleAssistant);
  $("refreshPage").addEventListener("click", refreshParse);
  $("syncDevices").addEventListener("click", syncDevices);
  $("popupActions").addEventListener("click", runPopupActionFromClick);
  $("pinWidgetDetail").addEventListener("click", pinLastActionDetail);
  $("viewWidgetDetail").addEventListener("click", viewLastActionDetail);
  $("runCorrelationNow").addEventListener("click", () => runPopupAction("correlate-run"));
  $("refreshHistory").addEventListener("click", loadHistory);
  $("toggleHistoryFold").addEventListener("click", toggleHistoryFold);
  $("openHistoryPage").addEventListener("click", () => openHistoryDetails());
  $("openOptions").addEventListener("click", openOptionsPage);
  $("viewText").addEventListener("click", viewPageText);
  $("historyList").addEventListener("click", restoreHistoryFromClick);
  $("copyText").addEventListener("click", copyPageText);
  $("closeDialog").addEventListener("click", () => $("textDialog").close());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("textDialog").open) $("textDialog").close();
  });
}

async function refreshAll() {
  const [state, ctx, history] = await Promise.all([send({ type: "GET_STATE" }), send({ type: "GET_ACTIVE_TAB_CONTEXT" }), readHistoryLocal()]);
  runtimeState = state.ok ? state : null;
  context = ctx.ok ? ctx : null;
  historyItems = Array.isArray(history) ? history : [];
  render();
}

function render() {
  applyTheme(runtimeState?.ui?.theme || "dark");
  const platform = runtimeState?.platform || {};
  $("connectionText").textContent = platform.connected ? `已连接 ${platform.platformName || "EFF-Monitoring"}` : "未连接 EFF-Monitoring";
  $("connectionDot").classList.toggle("ok", !!platform.connected);
  $("platformAI").textContent = "平台AI";
  $("platformAI").title = platform.platformAI ? "平台 AI 可用" : "平台 AI 不可用";
  $("platformAI").className = `ai-pill ${platform.platformAI ? "ok" : "off"}`;
  const q = runtimeState?.quickAI || {};
  const quickReady = !!(q.enabled && q.configured);
  $("quickAI").textContent = "插件AI";
  $("quickAI").title = quickReady ? `插件 AI 可用：${q.model || "已配置"}` : "插件 AI 未配置";
  $("quickAI").className = `ai-pill ${quickReady ? "ok" : "off"}`;
  document.querySelectorAll(".platform-only").forEach((btn) => {
    btn.hidden = !platform.connected;
  });

  const tab = context?.tab;
  const widget = context?.widget || null;
  const device = context?.widget?.device || context?.device || null;

  const toggle = $("toggleAssistant");
  const supportedPage = !!(tab?.url && /^https?:/i.test(tab.url));
  toggle.disabled = false;
  const widgetVisible = widget?.visible === true || runtimeState?.ui?.assistantEnabled === true;
  // 以当前 Tab 的实际宠物状态为准，而不是只看全局 assistantEnabled。
  toggle.textContent = widgetVisible ? "隐藏助手" : "显示助手";
  toggle.dataset.visible = widgetVisible ? "1" : "0";
  $("refreshPage").disabled = !supportedPage;
  $("viewText").disabled = !supportedPage;
  renderActionStatus();
  renderHistory();
}

async function toggleTheme() {
  const current = document.body.dataset.theme === "light" ? "light" : "dark";
  const next = current === "light" ? "dark" : "light";
  applyTheme(next);
  if (runtimeState?.ui) runtimeState.ui.theme = next;
  const r = await send({ type: "SAVE_UI_STATE", ui: { theme: next } }, 6000);
  if (!r.ok) return message(r.error?.message || "主题保存失败", true);
}

function applyTheme(theme) {
  const normalized = theme === "light" ? "light" : "dark";
  document.body.dataset.theme = normalized;
  const btn = $("themeToggle");
  if (!btn) return;
  btn.textContent = normalized === "light" ? "☾" : "☼";
  btn.title = normalized === "light" ? "切换深色模式" : "切换浅色模式";
  btn.setAttribute("aria-label", btn.title);
}

async function runPopupActionFromClick(event) {
  const btn = event.target.closest("[data-action]");
  if (!btn) return;
  await runPopupAction(btn.dataset.action, btn);
}

async function runPopupAction(action, sourceButton = null) {
  const actualAction = action;
  lastAction = actualAction;
  setActionStatus(actionTitle(actualAction), actionStartText(actualAction), "running");
  if (sourceButton) sourceButton.disabled = true;
  try {
    const r = await send({ type: "RUN_ACTIVE_TAB_WIDGET_ACTION", action: actualAction }, 620000);
    if (!r.ok) throw new Error(r.error?.message || "操作失败");
    lastActionStatus = r.data || null;
    renderActionStatus();
    if (actualAction !== "correlate") {
      await loadHistory().catch(() => {});
    }
  } catch (e) {
    setActionStatus(actionTitle(actualAction), e.message || "操作失败", "error");
  } finally {
    if (sourceButton) sourceButton.disabled = false;
  }
}

function setActionStatus(title, text, status = "") {
  $("actionStatus").hidden = false;
  $("actionStatus").className = `action-status ${status}`;
  $("actionStatusTitle").textContent = title;
  $("actionStatusText").textContent = text;
  $("runCorrelationNow").hidden = true;
}

function renderActionStatus() {
  if (!lastActionStatus) return;
  const title = actionTitle(lastActionStatus.action || lastAction);
  const status = lastActionStatus.status || "done";
  const labels = Array.isArray(lastActionStatus.labels) ? lastActionStatus.labels.filter(Boolean).join(" / ") : "";
  const confidence = lastActionStatus.confidence == null ? "" : ` / ${Math.round(Number(lastActionStatus.confidence) || 0)}%`;
  const summary = lastActionStatus.action === "correlate"
    ? `已采集 ${lastActionStatus.clueCount || 0} 条线索`
    : (labels || lastActionStatus.risk || lastActionStatus.summary || "操作已完成") + confidence;
  setActionStatus(`${title}${status === "running" ? "进行中" : "完成"}`, summary, status === "running" ? "running" : "done");
  $("runCorrelationNow").hidden = !(lastActionStatus.action === "correlate" && Number(lastActionStatus.clueCount || 0) >= 2);
}

async function pinLastActionDetail() {
  if (!lastAction) return message("请先选择一个操作", true);
  const r = await send({ type: "SHOW_ACTIVE_TAB_WIDGET_DETAIL", action: lastAction }, 5000);
  if (!r.ok) return message(r.error?.message || "打开详情失败", true);
  message("已固定到页面助手");
}

async function viewLastActionDetail() {
  await pinLastActionDetail();
  setTimeout(() => window.close(), 180);
}

function actionTitle(action) {
  return action === "ticket" ? "生成工单" : action === "smart" ? "智能分析" : action === "correlate" || action === "correlate-run" ? "关联分析" : "快速研判";
}

function actionStartText(action) {
  return action === "ticket" ? "正在生成平台工单..." : action === "smart" ? "正在调用平台智能分析..." : action === "correlate-run" ? "正在启动关联分析..." : action === "correlate" ? "正在采集当前告警线索..." : "AI 正在分析当前页面...";
}

function renderHistory() {
  const list = $("historyList");
  const card = list.closest(".history-card");
  card?.classList.toggle("folded", historyFolded);
  $("toggleHistoryFold").textContent = historyFolded ? "展开" : "收起";
  if (!historyItems.length) {
    list.innerHTML = `<div class="history-empty">暂无操作历史</div>`;
    return;
  }
  list.innerHTML = historyItems.slice(0, 20).map((item) => {
    const kindText = item.kind === "ticket" ? "工单" : item.kind === "smart" ? "智能" : item.kind === "correlation" ? "关联" : "快速";
    const time = item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
    return `
      <button class="history-item" type="button" data-id="${escAttr(item.id)}">
        <span class="history-kind ${escAttr(item.kind)}">${kindText}</span>
        <span class="history-main">
          <strong>${esc(item.title || kindText)}</strong>
          <em>${esc(item.summary || item.page?.title || "无摘要")}</em>
        </span>
        <span class="history-side">
          <time>${esc(time)}</time>
          <span class="history-detail" role="button" tabindex="0" data-act="history-detail" data-id="${escAttr(item.id)}">详情</span>
        </span>
      </button>
    `;
  }).join("");
}

async function loadHistory() {
  busy("refreshHistory", true, "刷新中");
  const r = await readHistoryLocal().then((history) => ({ ok: true, history })).catch((error) => ({ ok: false, error }));
  busy("refreshHistory", false, "刷新");
  if (!r.ok) {
    historyItems = [];
    renderHistory();
    const text = /未知插件消息类型/.test(r.error?.message || "") ? "历史接口未加载，请在扩展管理页重新加载插件" : (r.error?.message || "读取历史失败");
    return message(text, true);
  }
  historyItems = Array.isArray(r.history) ? r.history : [];
  renderHistory();
}

async function restoreHistoryFromClick(event) {
  const detail = event.target.closest('[data-act="history-detail"]');
  if (detail) {
    event.stopPropagation();
    openHistoryDetails(detail.dataset.id);
    return;
  }
  const btn = event.target.closest(".history-item");
  if (!btn) return;
  busyHistoryItem(btn, true);
  let r = await send({ type: "RESTORE_HISTORY_ITEM", id: btn.dataset.id }, 6000);
  if (!r.ok && /未知插件消息类型/.test(r.error?.message || "")) {
    r = await restoreHistoryDirect(btn.dataset.id);
  }
  busyHistoryItem(btn, false);
  if (!r.ok) return message(r.error?.message || "恢复历史失败", true);
  message("已恢复到页面助手");
  setTimeout(() => window.close(), 280);
}

function toggleHistoryFold() {
  historyFolded = !historyFolded;
  renderHistory();
}

async function readHistoryLocal() {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  const history = Array.isArray(data?.[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
  return history
    .filter((item) => item && typeof item === "object")
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

async function restoreHistoryDirect(id) {
  const history = await readHistoryLocal();
  const item = history.find((x) => x.id === id);
  if (!item) return { ok: false, error: { message: "未找到该历史记录" } };
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) return { ok: false, error: { message: "当前页面不支持恢复到助手" } };
  let resp = await sendTab(tab.id, { type: "RESTORE_HISTORY_ITEM", item });
  if (!resp.ok) {
    await send({ type: "SET_ASSISTANT_ENABLED", enabled: true }, 6000);
    await new Promise((resolve) => setTimeout(resolve, 350));
    resp = await sendTab(tab.id, { type: "RESTORE_HISTORY_ITEM", item });
  }
  return resp;
}

async function toggleAssistant() {
  const actuallyVisible = $("toggleAssistant").dataset.visible === "1";
  const wantVisible = !actuallyVisible;
  if (wantVisible) {
    const granted = await chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] });
    if (!granted) return message("未授予页面访问权限，无法在所有页面显示助手", true);
  }
  busy("toggleAssistant", true, wantVisible ? "正在显示…" : "正在隐藏…");
  const r = await send({ type: "SET_ASSISTANT_ENABLED", enabled: wantVisible });
  busy("toggleAssistant", false);
  if (!r.ok) return message(r.error?.message || "操作失败", true);
  if (context?.widget) context.widget.visible = wantVisible;
  if (runtimeState?.ui) runtimeState.ui.assistantEnabled = wantVisible;
  render();
  message(wantVisible ? "已显示助手" : "已隐藏助手");
  refreshAll().catch(() => {});
}

async function refreshParse() {
  busy("refreshPage", true, "解析中…");
  const r = await send({ type: "REFRESH_ACTIVE_TAB" }, 120000);
  busy("refreshPage", false, "重新解析");
  if (!r.ok) return message(r.error?.message || "解析失败", true);
  message(r.mode === "platform" ? "当前页面已重新解析" : "当前页面上下文已刷新");
  await refreshAll();
}

async function syncDevices() {
  busy("syncDevices", true, "同步中…");
  const r = await send({ type: "SYNC_PLUGIN_STATE" }, 60000);
  busy("syncDevices", false, "同步插件");
  if (!r.ok) return message(r.error?.message || "同步失败", true);
  const deviceText = r.platformSynced ? `，平台设备 ${Number(r.devices?.length || 0)} 个` : "";
  message(`插件状态已同步${deviceText}`);
  await refreshAll();
}

function openOptionsPage() {
  chrome.runtime.openOptionsPage();
}

function openHistoryDetails(id = "") {
  const hash = id ? `#history=${encodeURIComponent(id)}` : "#history";
  chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html${hash}`) });
  window.close();
}

async function viewPageText() {
  const r = await send({ type: "GET_ACTIVE_PAGE_TEXT" });
  if (!r.ok) return message(r.error?.message || "读取失败", true);
  const d = r.data || {};
  currentPageText = d.text || "";
  $("textMeta").textContent = `${d.url || ""} · ${d.length || 0} 字符`;
  $("textContent").textContent = currentPageText;
  $("copyText").textContent = "复制";
  if (!$("textDialog").open) $("textDialog").show();
}

async function copyPageText() {
  const text = currentPageText || $("textContent").textContent || "";
  if (!text.trim()) return message("暂无可复制的采集文本", true);
  try {
    await navigator.clipboard.writeText(text);
    $("copyText").textContent = "已复制";
    message("采集文本已复制");
    setTimeout(() => {
      if ($("copyText")) $("copyText").textContent = "复制";
    }, 1200);
  } catch (e) {
    message("复制失败，请检查剪贴板权限", true);
  }
}

function busy(id, on, label) {
  const b = $(id);
  if (on) {
    b.dataset.oldText = b.textContent;
    b.disabled = true;
    if (label) b.textContent = label;
  } else {
    b.disabled = false;
    b.textContent = label || b.dataset.oldText || b.textContent;
  }
}

function busyHistoryItem(btn, on) {
  btn.disabled = !!on;
  btn.classList.toggle("loading", !!on);
}

function message(text, error = false) {
  $("message").textContent = text || "";
  $("message").classList.toggle("error", !!error);
}

function esc(v) { return String(v ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }
function escAttr(v) { return esc(v).replace(/`/g, "&#96;"); }

function send(message, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: { kind: "timeout", message: "插件后台响应超时" } }), timeoutMs);
    chrome.runtime.sendMessage(message, (r) => {
      clearTimeout(timer);
      resolve(r || { ok: false, error: { message: chrome.runtime.lastError?.message || "插件后台无响应" } });
    });
  });
}

function sendTab(tabId, message, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: { kind: "timeout", message: "页面助手响应超时" } }), timeoutMs);
    chrome.tabs.sendMessage(tabId, message, (r) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) resolve({ ok: false, error: { message: chrome.runtime.lastError.message } });
      else resolve(r || { ok: false, error: { message: "页面助手无响应" } });
    });
  });
}
