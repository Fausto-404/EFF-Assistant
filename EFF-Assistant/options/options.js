const el = (id) => document.getElementById(id);
const HISTORY_KEY = "effAssistantOperationHistory";
const HISTORY_PAGE_SIZE = 10;
let historyItems = [];
let historyDetailState = { item: null, evidencePage: 1 };
let historyListPage = 1;

init();

async function init() {
  const state = await send({ type: "GET_STATE" });
  if (state.ok) renderState(state);

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => openSection(btn.dataset.section || "ai", true));
  });
  window.addEventListener("hashchange", openSectionFromHash);
  el("themeToggle").addEventListener("click", toggleTheme);
  el("connectBtn").addEventListener("click", connectPlatform);
  el("disconnectBtn").addEventListener("click", disconnectPlatform);
  el("syncBtn").addEventListener("click", syncDevices);
  el("openAssistantRepo").addEventListener("click", () => openUrl("https://github.com/Fausto-404/EFF-Assistant"));
  el("openAssistantDocs").addEventListener("click", () => openUrl("https://github.com/Fausto-404/EFF-Assistant"));
  el("openPlatformRepo").addEventListener("click", () => openUrl("https://github.com/Fausto-404/EFF-Monitoring"));
  el("testQuickBtn").addEventListener("click", testQuickAI);
  el("saveQuickBtn").addEventListener("click", saveQuickAI);
  el("fetchModelsBtn").addEventListener("click", fetchQuickModels);
  el("quickProtocol").addEventListener("change", updateProtocolUI);
  el("quickEndpointMode").addEventListener("change", updateProtocolUI);
  el("historySearch").addEventListener("input", () => {
    historyListPage = 1;
    renderHistory();
  });
  el("historyKindFilter").addEventListener("change", () => {
    historyListPage = 1;
    renderHistory();
  });
  el("clearHistoryBtn").addEventListener("click", clearHistory);
  el("historyResults").addEventListener("click", openHistoryDetailFromClick);
  el("historyListPager").addEventListener("click", changeHistoryListPage);
  el("historyEvidencePager").addEventListener("click", changeEvidencePage);
  el("closeHistoryDialog").addEventListener("click", () => el("historyDialog").close());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && el("historyDialog").open) el("historyDialog").close();
  });
  el("quickModelSelect").addEventListener("change", () => {
    if (el("quickModelSelect").value) el("quickModel").value = el("quickModelSelect").value;
  });
  openSectionFromHash();
  await loadHistory();
}

function openSection(section, updateHash = false) {
  const target = ["ai", "monitoring", "history"].includes(section) ? section : "ai";
  // 切换到非历史页面时自动关闭详情弹窗
  if (target !== "history") el("historyDialog").close();
  document.querySelectorAll(".settings-section").forEach((node) => {
    node.hidden = node.dataset.section !== target;
  });
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.section === target);
  });
  if (updateHash) {
    const hash = target === "ai" ? "" : `#${target}`;
    if (hash) history.replaceState(null, "", hash);
    else history.replaceState(null, "", location.pathname);
  }
}

function openSectionFromHash() {
  const hash = String(location.hash || "");
  if (hash.startsWith("#history")) return openSection("history", false);
  if (hash.startsWith("#monitoring")) return openSection("monitoring", false);
  openSection("ai", false);
}

function renderState(state) {
  applyTheme(state.ui?.theme || "dark");
  const p = state.platform || {};
  el("platformUrl").value = p.baseUrl || "";
  el("platformToken").placeholder = p.tokenMasked || "eff_pat_****************";
  el("connectionBadge").textContent = p.connected ? "已连接" : "未连接";
  el("connectionBadge").classList.toggle("ok", !!p.connected);
  el("platformInfo").textContent = p.connected
    ? `平台：${p.platformName || "EFF-Monitoring"}${p.version ? ` ${p.version}` : ""} · Workspace：${p.workspace || "-"} · 平台AI：${p.platformAI ? "可用" : "不可用"}`
    : "";
  renderDevices(state.devices || [], state.devicesSyncedAt);
  if (state.quickAI) {
    el("quickEnabled").checked = !!state.quickAI.enabled;
    el("quickProtocol").value = state.quickAI.protocol || "openai";
    el("quickUrl").value = state.quickAI.baseUrl || "";
    el("quickKey").placeholder = state.quickAI.apiKeyMasked || "sk-****************";
    el("quickModel").value = state.quickAI.model || "";
    el("sendRawText").checked = state.quickAI.sendRawText !== false;
    el("quickAuthMode").value = state.quickAI.authMode || "protocol";
    el("quickEndpointMode").value = state.quickAI.endpointMode || "base";
    el("quickOpenAIWire").value = state.quickAI.openaiWire || "chat";
    el("quickCustomHeaders").value = state.quickAI.customHeaders || "";
    updateProtocolUI();
  }
}

async function toggleTheme() {
  const current = document.body.dataset.theme === "light" ? "light" : "dark";
  const next = current === "light" ? "dark" : "light";
  applyTheme(next);
  const r = await send({ type: "SAVE_UI_STATE", ui: { theme: next } });
  if (!r.ok) setInfo("quickInfo", r.error?.message || "主题保存失败", true);
}

function applyTheme(theme) {
  const normalized = theme === "light" ? "light" : "dark";
  document.body.dataset.theme = normalized;
  const btn = el("themeToggle");
  if (!btn) return;
  btn.textContent = normalized === "light" ? "深色模式" : "浅色模式";
}

async function connectPlatform() {
  clearInfo("platformInfo");
  const baseUrl = el("platformUrl").value.trim();
  const token = el("platformToken").value.trim();
  if (!baseUrl || !token) return setInfo("platformInfo", "请输入平台地址和插件密钥。", true);

  try {
    const originPattern = toOriginPattern(baseUrl);
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) throw new Error("未授予访问 EFF-Monitoring 平台的浏览器权限");

    setBusy("connectBtn", true, "正在连接…");
    const test = await send({ type: "TEST_PLATFORM", baseUrl, token }, 30000);
    if (!test.ok) throw new Error(test.error?.message || "连接失败");
    const saved = await send({ type: "SAVE_PLATFORM", baseUrl, token, meta: test.data });
    if (!saved.ok) throw new Error(saved.error?.message || "保存失败");
    el("platformToken").value = "";
    setInfo("platformInfo", "连接成功，正在获取启用浏览器助手的设备配置…");
    await syncDevices();
    const state = await send({ type: "GET_STATE" });
    if (state.ok) renderState(state);
  } catch (e) {
    setInfo("platformInfo", e.message, true);
  } finally {
    setBusy("connectBtn", false, "测试并连接");
  }
}

async function disconnectPlatform() {
  const r = await send({ type: "DISCONNECT_PLATFORM" });
  if (r.ok) {
    const state = await send({ type: "GET_STATE" });
    renderState(state);
  }
}

async function syncDevices() {
  clearInfo("platformInfo");
  setBusy("syncBtn", true, "同步中…");
  try {
    const r = await send({ type: "SYNC_DEVICES" }, 60000);
    if (!r.ok) throw new Error(r.error?.message || "同步设备失败");
    const origins = [...new Set((r.devices || []).flatMap((d) => d.url_patterns || []).map(toPermissionPattern).filter(Boolean))];
    let granted = true;
    if (origins.length) granted = await chrome.permissions.request({ origins });
    if (!granted) setInfo("platformInfo", "设备配置已获取，但部分设备站点访问权限未授予；这些设备页面不会自动显示助手。", true);
    // Trigger another sync so service worker can register content scripts for newly granted origins.
    const r2 = await send({ type: "SYNC_DEVICES" }, 60000);
    renderDevices(r2.devices || r.devices || [], r2.devicesSyncedAt || r.devicesSyncedAt);
    if (granted) setInfo("platformInfo", `已同步 ${(r2.devices || r.devices || []).length} 个浏览器助手设备。`);
  } catch (e) {
    setInfo("platformInfo", e.message, true);
  } finally {
    setBusy("syncBtn", false, "获取平台配置");
  }
}

async function saveQuickAI() {
  clearInfo("quickInfo");
  const config = quickConfigFromForm();
  const current = await send({ type: "GET_STATE" });
  const hasExistingKey = !!current?.quickAI?.configured;
  if (config.enabled && (!config.baseUrl || (!config.apiKey && !hasExistingKey) || !config.model)) return setInfo("quickInfo", "启用快速 AI 时必须填写 API、API Key 和模型。", true);
  try {
    if (config.enabled) {
      const originPattern = toOriginPattern(config.baseUrl);
      const granted = await chrome.permissions.request({ origins: [originPattern] });
      if (!granted) throw new Error("未授予快速 AI API 站点访问权限");
    }
    const r = await send({ type: "SAVE_QUICK_AI", config });
    if (!r.ok) throw new Error(r.error?.message || "保存失败");
    el("quickKey").value = "";
    setInfo("quickInfo", config.enabled ? "快速研判 AI 配置已保存。" : "快速研判 AI 已禁用。" );
  } catch (e) {
    setInfo("quickInfo", e.message, true);
  }
}

async function testQuickAI() {
  clearInfo("quickInfo");
  const config = quickConfigFromForm();
  const current = await send({ type: "GET_STATE" });
  const hasExistingKey = !!current?.quickAI?.configured;
  if (!config.baseUrl || (!config.apiKey && !hasExistingKey) || !config.model) return setInfo("quickInfo", "测试前请填写 API、API Key 和模型。", true);
  try {
    const granted = await chrome.permissions.request({ origins: [toOriginPattern(config.baseUrl)] });
    if (!granted) throw new Error("未授予 AI API 站点访问权限");
    setBusy("testQuickBtn", true, "快速测试中…");
    const r = await send({ type: "TEST_QUICK_AI", config }, 30000);
    if (!r.ok) throw new Error(r.error?.message || "测试失败");
    const route = r.route ? ` · ${r.route.wire || ""} · ${r.route.authMode || ""}` : "";
    setInfo("quickInfo", `AI 连接成功：${r.data?.summary || r.data?.conclusion || "响应正常"}${route}`);
  } catch (e) {
    setInfo("quickInfo", e.message, true);
  } finally {
    setBusy("testQuickBtn", false, "测试 AI");
  }
}

function quickConfigFromForm() {
  return {
    enabled: el("quickEnabled").checked,
    protocol: el("quickProtocol").value,
    baseUrl: el("quickUrl").value.trim(),
    apiKey: el("quickKey").value.trim(),
    model: el("quickModel").value.trim(),
    sendRawText: el("sendRawText").checked,
    authMode: el("quickAuthMode").value,
    endpointMode: el("quickEndpointMode").value,
    openaiWire: el("quickOpenAIWire").value,
    customHeaders: el("quickCustomHeaders").value
  };
}

async function fetchQuickModels() {
  clearInfo("quickInfo");
  const config = quickConfigFromForm();
  const current = await send({ type: "GET_STATE" });
  const hasExistingKey = !!current?.quickAI?.configured;
  if (!config.baseUrl || (!config.apiKey && !hasExistingKey)) {
    return setInfo("quickInfo", "获取模型前请填写 API 地址和 API Key。", true);
  }
  try {
    const granted = await chrome.permissions.request({ origins: [toOriginPattern(config.baseUrl)] });
    if (!granted) throw new Error("未授予 AI API 站点访问权限");
    setBusy("fetchModelsBtn", true, "获取中…");
    const r = await send({ type: "LIST_QUICK_AI_MODELS", config }, 30000);
    if (!r.ok) throw new Error(r.error?.message || "模型列表获取失败");
    const models = Array.isArray(r.models) ? r.models : [];
    if (!models.length) {
      el("quickModelSelect").hidden = true;
      return setInfo("quickInfo", r.warning || "该 Provider 未提供模型列表接口。可直接手工填写模型 ID；这不影响测试 AI 和快速研判。", false, "warn");
    }
    const select = el("quickModelSelect");
    select.innerHTML = `<option value="">已获取 ${models.length} 个模型，请选择</option>` + models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
    select.hidden = false;
    if (config.model && models.includes(config.model)) select.value = config.model;
    const discovery = r.discovery?.url ? ` · ${r.discovery.url}` : "";
    setInfo("quickInfo", `已获取 ${models.length} 个模型${discovery}`);
    select.focus();
  } catch (e) {
    setInfo("quickInfo", e.message, true);
  } finally {
    setBusy("fetchModelsBtn", false, "获取模型 ⌄");
  }
}

function updateProtocolUI() {
  const protocol = el("quickProtocol")?.value || "openai";
  const endpointMode = el("quickEndpointMode")?.value || "base";
  const url = el("quickUrl");
  const key = el("quickKey");
  const help = el("protocolHelp");
  const wireLabel = el("openaiWireLabel");
  wireLabel.hidden = protocol !== "openai";

  if (protocol === "anthropic") {
    url.placeholder = endpointMode === "full" ? "https://xxx.xxx/v1/messages" : "https://xxx.xxx/anthropic";
    key.placeholder = "sk-ant-**************** / API Key";
    help.textContent = endpointMode === "full"
      ? "Anthropic 兼容 · 完整 URL：请直接填写 Messages 接口完整地址。模型发现可能不可用，可手工填写模型 ID。"
      : "Anthropic 兼容 · Base URL：推理严格请求 {Base URL}/v1/messages；获取模型时会自动从 Base URL 提取 Provider 服务根（例如去掉 /anthropic），并快速并发尝试 {服务根}/models 与 {服务根}/v1/models。模型发现失败不影响实际调用。";
  } else {
    url.placeholder = endpointMode === "full" ? "https://xxx.xxx/v1/chat/completions" : "https://xxx.xxx/v1";
    key.placeholder = "sk-****************";
    help.textContent = endpointMode === "full"
      ? "OpenAI 兼容 · 完整 URL：请填写 Chat Completions 或 Responses 的完整接口地址，并在高级选项选择对应格式。"
      : "OpenAI 兼容 · Base URL：请按供应商文档填写完整 Base URL（通常以 /v1 结尾），再在高级选项明确选择 Chat Completions 或 Responses。";
  }
  el("quickModelSelect").hidden = true;
}

function renderDevices(devices, syncedAt) {
  el("deviceCount").textContent = devices.length;
  el("lastSync").textContent = syncedAt ? new Date(syncedAt).toLocaleString("zh-CN", { hour12: false }) : "-";
  el("deviceList").innerHTML = devices.map((d) => `<div class="device"><strong>${escapeHtml(d.name)}</strong><div class="patterns">${(d.url_patterns || []).map(escapeHtml).join("<br>") || "未配置 URL"}</div></div>`).join("") || `<div class="info">暂无启用浏览器助手的设备。</div>`;
}

async function loadHistory() {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  historyItems = (Array.isArray(data?.[HISTORY_KEY]) ? data[HISTORY_KEY] : [])
    .filter((item) => item && typeof item === "object")
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  renderHistory();
  openHistoryFromHash();
}

function renderHistory() {
  const query = el("historySearch").value.trim().toLowerCase();
  const kind = el("historyKindFilter").value;
  const filtered = historyItems.filter((item) => {
    if (kind && item.kind !== kind) return false;
    if (!query) return true;
    return historySearchText(item).includes(query);
  });
  const pageCount = Math.max(Math.ceil(filtered.length / HISTORY_PAGE_SIZE), 1);
  historyListPage = Math.min(Math.max(Number(historyListPage) || 1, 1), pageCount);
  const start = (historyListPage - 1) * HISTORY_PAGE_SIZE;
  const current = filtered.slice(start, start + HISTORY_PAGE_SIZE);
  const rangeText = filtered.length ? `，第 ${start + 1}-${start + current.length} 条` : "";
  el("historyStats").textContent = `共 ${historyItems.length} 条记录，匹配 ${filtered.length} 条${rangeText}`;
  el("historyResults").innerHTML = current.length ? current.map(renderHistoryRow).join("") : `<div class="history-empty-wide">暂无匹配的操作历史</div>`;
  renderHistoryListPager(filtered.length, pageCount);
}

function renderHistoryListPager(total, pageCount) {
  const pager = el("historyListPager");
  if (!pager) return;
  if (total <= HISTORY_PAGE_SIZE) {
    pager.innerHTML = "";
    return;
  }
  pager.innerHTML = `
    <button type="button" data-page="${historyListPage - 1}" ${historyListPage <= 1 ? "disabled" : ""}>上一页</button>
    <span>${historyListPage} / ${pageCount}</span>
    <button type="button" data-page="${historyListPage + 1}" ${historyListPage >= pageCount ? "disabled" : ""}>下一页</button>
  `;
}

function changeHistoryListPage(event) {
  const btn = event.target.closest("button[data-page]");
  if (!btn) return;
  historyListPage = Number(btn.dataset.page) || 1;
  renderHistory();
  el("historySection")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderHistoryRow(item) {
  const kindText = historyKindText(item.kind);
  const time = item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false }) : "-";
  const title = item.title || kindText;
  const summary = item.summary || item.result?.summary || item.result?.conclusion || item.page?.title || "无摘要";
  return `
    <div class="history-row" data-id="${escapeAttr(item.id)}">
      <span class="history-kind-pill ${escapeAttr(item.kind)}">${escapeHtml(kindText)}</span>
      <div class="history-row-main">
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(summary)}</p>
        <em>${escapeHtml(item.page?.url || "")}</em>
      </div>
      <time>${escapeHtml(time)}</time>
      <button data-act="history-detail" data-id="${escapeAttr(item.id)}" type="button">详情</button>
    </div>
  `;
}

function openHistoryDetailFromClick(event) {
  const btn = event.target.closest('[data-act="history-detail"]');
  if (!btn) return;
  const item = historyItems.find((x) => x.id === btn.dataset.id);
  if (item) showHistoryDetail(item);
}

function showHistoryDetail(item) {
  const kindText = historyKindText(item.kind);
  const time = item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false }) : "-";
  const result = historyResultOf(item);
  const summary = item.summary || result?.summary || result?.conclusion || "无摘要";
  historyDetailState = { item, evidencePage: 1 };
  el("historyDialogTitle").textContent = item.title || kindText;
  el("historyDialogMeta").textContent = `${kindText} · ${time}`;
  el("historyDialogSummary").innerHTML = `
    <div><span>页面</span><b>${escapeHtml(item.page?.title || "-")}</b></div>
    <div><span>地址</span><b>${escapeHtml(item.page?.url || "-")}</b></div>
    <div class="wide"><span>摘要</span><b>${escapeHtml(summary)}</b></div>
  `;
  renderHistoryReport(item);
  document.querySelector(".history-raw")?.removeAttribute("open");
  el("historyDialogPayload").textContent = JSON.stringify(item.result || item.payload || item, null, 2);
  if (!el("historyDialog").open) el("historyDialog").showModal();
}

function renderHistoryReport(item) {
  const result = historyResultOf(item) || {};
  const labels = historyLabels(item, result);
  const fields = historyFields(item, result);
  el("historyDialogReport").innerHTML = `
    <div class="history-report-section">
      <span>研判结论</span>
      <div class="history-tags">${labels.map((label) => `<em class="${escapeAttr(historyTagClass(label))}">${escapeHtml(label)}</em>`).join("") || `<em>无法确认</em>`}</div>
    </div>
    <div class="history-report-section">
      <span>综合判断</span>
      <p>${escapeHtml(result.conclusion || result.summary || item.summary || "暂无综合判断。")}</p>
    </div>
    <div class="history-metrics">
      <div><span>置信度</span><b>${escapeHtml(result.confidence == null ? "-" : `${Math.round(Number(result.confidence) || 0)}%`)}</b></div>
      <div><span>风险等级</span><b>${escapeHtml(result.risk_level || "-")}</b></div>
      <div><span>证据数量</span><b>${escapeHtml(String(historyEvidence(result).length))} 项</b></div>
    </div>
    ${fields.length ? `<div class="history-fields">${fields.map(([k, v]) => `<div><span>${escapeHtml(k)}</span><b>${escapeHtml(v || "-")}</b></div>`).join("")}</div>` : ""}
  `;
  renderHistoryEvidence(result);
}

function renderHistoryEvidence(result) {
  const evidence = historyEvidence(result);
  const pageSize = 5;
  const pageCount = Math.max(Math.ceil(evidence.length / pageSize), 1);
  const page = Math.min(Math.max(Number(historyDetailState.evidencePage) || 1, 1), pageCount);
  historyDetailState.evidencePage = page;
  const visible = evidence.slice((page - 1) * pageSize, page * pageSize);
  el("historyEvidenceList").innerHTML = visible.length ? visible.map((step, index) => `
    <div class="history-evidence-row">
      <b>${String((page - 1) * pageSize + index + 1).padStart(2, "0")}</b>
      <div>
        <strong>${escapeHtml(step.title || "证据")}${step.status ? ` · ${escapeHtml(step.status)}` : ""}</strong>
        <p>${escapeHtml(step.detail || step.text || "")}</p>
      </div>
    </div>
  `).join("") : `<div class="history-empty-wide">暂无证据链明细</div>`;
  el("historyEvidencePager").innerHTML = pageCount > 1 ? `
    <button type="button" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button>
    <span>${page} / ${pageCount}</span>
    <button type="button" data-page="${page + 1}" ${page >= pageCount ? "disabled" : ""}>下一页</button>
  ` : `<span>${evidence.length} 项</span>`;
}

function changeEvidencePage(event) {
  const btn = event.target.closest("button[data-page]");
  if (!btn || !historyDetailState.item) return;
  historyDetailState.evidencePage = Number(btn.dataset.page) || 1;
  renderHistoryEvidence(historyResultOf(historyDetailState.item) || {});
}

function historyResultOf(item) {
  if (item?.result) return item.result;
  const payload = item?.payload || {};
  return payload.quickResult || payload.analysisResult || payload.ticketResult || payload.result || null;
}

function historyLabels(item, result) {
  if (item.kind === "correlation") {
    const primary = [
      result.relation_verdict,
      result.attack_outcome,
      result.risk_change,
      result.priority
    ].filter(Boolean);
    const optional = Array.isArray(result.optional_labels) ? result.optional_labels : [];
    const fallback = Array.isArray(result.verdict_labels) ? result.verdict_labels : [];
    return [...new Set([...primary, ...optional, ...fallback])].slice(0, 12);
  }
  if (Array.isArray(result.verdict_labels) && result.verdict_labels.length) return result.verdict_labels;
  return [result.attack_outcome || result.risk_level || "无法确认"];
}

function historyFields(item, result) {
  if (item.kind === "ticket") {
    return [
      ["告警ID", result.alert_id],
      ["告警哈希", result.alert_hash],
      ["通报目标", result.target],
      ["通报状态", result.sent ? "已发送" : result.message ? "已生成" : "-"]
    ].filter(([, v]) => v != null && v !== "");
  }
  if (item.kind === "correlation") {
    return [
      ["关联关系", result.relation_verdict],
      ["攻击结果", result.attack_outcome],
      ["风险变化", result.risk_change],
      ["处置优先级", result.priority],
      ["事件类型", result.event_type]
    ].filter(([, v]) => v != null && v !== "");
  }
  return [
    ["页面类型", result.page_type],
    ["研判路径", result.stage_route_label],
    ["源IP", result.src_ip],
    ["目的IP", result.dst_ip],
    ["事件类型", result.event_type],
    ["设备/来源", result.device]
  ].filter(([, v]) => v != null && v !== "");
}

function historyEvidence(result) {
  if (Array.isArray(result?.analysis_steps) && result.analysis_steps.length) {
    return result.analysis_steps.map((step, index) => ({
      title: step?.title || `证据 ${index + 1}`,
      status: step?.status || "",
      detail: step?.detail || step?.text || ""
    }));
  }
  if (Array.isArray(result?.evidence)) {
    return result.evidence.map((text, index) => ({ title: `证据 ${index + 1}`, status: "", detail: String(text || "") }));
  }
  if (result?.message) return [{ title: "工单消息", status: "已生成", detail: result.message }];
  return [];
}

function historyTagClass(label) {
  if (/成功|升级|立即|攻击链/.test(label)) return "hot";
  if (/失败|未见|优先|相似/.test(label)) return "warn";
  if (/业务|降低|归档/.test(label)) return "ok";
  if (/无法|无有效/.test(label)) return "muted";
  return "";
}

async function clearHistory() {
  if (!historyItems.length) return;
  if (!confirm("确认清空全部操作历史？此操作不可恢复。")) return;
  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  historyItems = [];
  renderHistory();
}

function openHistoryFromHash() {
  const hash = String(location.hash || "");
  if (hash === "#history") {
    openSection("history", false);
    return;
  }
  const match = hash.match(/^#history=([^&]+)/);
  if (!match) return;
  openSection("history", false);
  const id = decodeURIComponent(match[1]);
  const item = historyItems.find((x) => x.id === id);
  if (!item) return;
  el("historySection")?.scrollIntoView({ behavior: "smooth", block: "start" });
  showHistoryDetail(item);
}

function historySearchText(item) {
  return [
    item.kind,
    item.title,
    item.summary,
    item.page?.title,
    item.page?.url,
    item.result?.summary,
    item.result?.conclusion,
    item.result?.src_ip,
    item.result?.dst_ip,
    item.result?.event_type,
    item.result?.risk_level,
    ...(Array.isArray(item.result?.verdict_labels) ? item.result.verdict_labels : [])
  ].filter(Boolean).join(" ").toLowerCase();
}

function historyKindText(kind) {
  return kind === "ticket" ? "生成工单" : kind === "smart" ? "智能研判" : kind === "correlation" ? "关联分析" : "快速研判";
}

function toOriginPattern(value) {
  const u = new URL(value);
  return `${u.protocol}//${u.host}/*`;
}

function toPermissionPattern(pattern) {
  const p = String(pattern || "").trim();
  if (/^https?:\/\/[^/]+\/.*$/i.test(p)) return p;
  try { return toOriginPattern(p.replace(/\*/g, "x")); } catch (_) { return null; }
}

function setInfo(id, text, error = false, level = "") {
  el(id).textContent = text;
  el(id).classList.toggle("error", error);
  el(id).classList.toggle("warn", level === "warn");
}
function clearInfo(id) { setInfo(id, "", false, ""); }
function setBusy(id, busy, text) { el(id).disabled = busy; el(id).textContent = text; }
function send(message, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: { kind: "timeout", message: "插件后台响应超时" } }), timeoutMs);
    chrome.runtime.sendMessage(message, (r) => {
      clearTimeout(timer);
      resolve(r || { ok: false, error: { message: chrome.runtime.lastError?.message || "插件后台无响应" } });
    });
  });
}
function openUrl(url) {
  send({ type: "OPEN_URL", url }).catch?.(() => {});
}
function escapeHtml(v) { return String(v ?? "").replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }
function escapeAttr(v) { return escapeHtml(v).replace(/`/g, "&#96;"); }
