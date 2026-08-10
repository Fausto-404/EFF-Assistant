const $ = (id) => document.getElementById(id);
const POPUP_DRAFT_KEY = "effAssistantPopupDraft";
let runtimeState = null;
let context = null;
let currentPageText = "";
let draftTimer = null;

init();

async function init() {
  bind();
  await refreshAll();
  await restorePopupDraft();
}

function bind() {
  $("toggleAssistant").addEventListener("click", toggleAssistant);
  $("refreshPage").addEventListener("click", refreshParse);
  $("syncDevices").addEventListener("click", syncDevices);
  $("viewText").addEventListener("click", viewPageText);
  $("copyText").addEventListener("click", copyPageText);
  $("closeDialog").addEventListener("click", () => $("textDialog").close());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("textDialog").open) $("textDialog").close();
  });
  $("connectBtn").addEventListener("click", connectPlatform);
  $("disconnectBtn").addEventListener("click", disconnectPlatform);
  $("openPlatformRepo").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    send({ type: "OPEN_URL", url: "https://github.com/Fausto-404/EFF-Monitoring" });
  });
  $("saveQuickBtn").addEventListener("click", saveQuickAI);
  $("testQuickBtn").addEventListener("click", testQuickAI);
  $("fetchModelsBtn").addEventListener("click", fetchQuickModels);
  $("quickProtocol").addEventListener("change", updateProtocolUI);
  $("quickEndpointMode").addEventListener("change", updateProtocolUI);
  $("quickModelSelect").addEventListener("change", () => {
    if ($("quickModelSelect").value) $("quickModel").value = $("quickModelSelect").value;
    savePopupDraftSoon();
  });
  bindDraftPersistence();
}

async function refreshAll() {
  const [state, ctx] = await Promise.all([send({ type: "GET_STATE" }), send({ type: "GET_ACTIVE_TAB_CONTEXT" })]);
  runtimeState = state.ok ? state : null;
  context = ctx.ok ? ctx : null;
  render();
}

function render() {
  const platform = runtimeState?.platform || {};
  $("connectionText").textContent = platform.connected ? `已连接 ${platform.platformName || "EFF-Monitoring"}` : "未连接 EFF-Monitoring";
  $("connectionDot").classList.toggle("ok", !!platform.connected);
  $("platformAI").textContent = platform.platformAI ? "可用" : "不可用";
  $("platformAI").className = platform.platformAI ? "ok" : "off";
  $("platformConfigState").textContent = platform.connected ? "已连接" : "未连接";
  $("platformConfigState").classList.toggle("ok", !!platform.connected);
  $("openPlatformRepo").hidden = !!platform.connected;
  $("platformUrl").value = platform.baseUrl || "";
  $("platformToken").placeholder = platform.tokenMasked || "eff_pat_****************";
  const q = runtimeState?.quickAI || {};
  const quickReady = !!(q.enabled && q.configured);
  $("quickAI").textContent = quickReady ? (q.model || "已配置") : "未配置";
  $("quickAI").className = quickReady ? "ok" : "off";
  $("quickConfigState").textContent = quickReady ? "已配置" : "未配置";
  $("quickConfigState").classList.toggle("ok", quickReady);
  renderQuickAI(q);

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
  $("refreshPage").disabled = !platform.connected || !device;
  $("viewText").disabled = !supportedPage;
}

function renderQuickAI(q) {
  $("quickEnabled").checked = !!q.enabled;
  $("quickProtocol").value = q.protocol || "openai";
  $("quickUrl").value = q.baseUrl || "";
  $("quickKey").placeholder = q.apiKeyMasked || "sk-****************";
  $("quickModel").value = q.model || "";
  $("sendRawText").checked = q.sendRawText !== false;
  $("quickAuthMode").value = q.authMode || "protocol";
  $("quickEndpointMode").value = q.endpointMode || "base";
  $("quickOpenAIWire").value = q.openaiWire || "chat";
  updateProtocolUI();
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
  const r = await send({ type: "REFRESH_ACTIVE_TAB" });
  busy("refreshPage", false, "重新解析");
  if (!r.ok) return message(r.error?.message || "解析失败", true);
  message("当前页面已重新解析");
  await refreshAll();
}

async function syncDevices() {
  busy("syncDevices", true, "同步中…");
  const r = await send({ type: "SYNC_DEVICES" });
  busy("syncDevices", false, "同步配置");
  if (!r.ok) return message(r.error?.message || "同步失败", true);
  message(`已同步 ${(r.devices || []).length} 个设备`);
  await refreshAll();
}

async function connectPlatform() {
  clearInfo("platformInfo");
  const baseUrl = $("platformUrl").value.trim();
  const token = $("platformToken").value.trim();
  if (!baseUrl || !token) return setInfo("platformInfo", "请输入平台地址和插件密钥。", true);
  try {
    const granted = await chrome.permissions.request({ origins: [toOriginPattern(baseUrl)] });
    if (!granted) throw new Error("未授予平台访问权限");
    busy("connectBtn", true, "连接中…");
    const test = await send({ type: "TEST_PLATFORM", baseUrl, token }, 20000);
    if (!test.ok) throw new Error(test.error?.message || "连接失败");
    const saved = await send({ type: "SAVE_PLATFORM", baseUrl, token, meta: test.data });
    if (!saved.ok) throw new Error(saved.error?.message || "保存失败");
    $("platformToken").value = "";
    await clearPopupDraftSection("platform");
    setInfo("platformInfo", "连接成功，正在同步配置…");
    await syncDevices();
    await refreshAll();
  } catch (e) {
    setInfo("platformInfo", e.message, true);
  } finally {
    busy("connectBtn", false, "测试并连接");
  }
}

async function disconnectPlatform() {
  const r = await send({ type: "DISCONNECT_PLATFORM" });
  if (!r.ok) return setInfo("platformInfo", r.error?.message || "断开失败", true);
  setInfo("platformInfo", "已断开平台连接。");
  await refreshAll();
}

async function saveQuickAI() {
  clearInfo("quickInfo");
  const config = quickConfigFromForm();
  const hasExistingKey = !!runtimeState?.quickAI?.configured;
  if (config.enabled && (!config.baseUrl || (!config.apiKey && !hasExistingKey) || !config.model)) {
    return setInfo("quickInfo", "启用快速研判时必须填写 API、API Key 和模型。", true);
  }
  try {
    if (config.enabled) {
      const granted = await chrome.permissions.request({ origins: [toOriginPattern(config.baseUrl)] });
      if (!granted) throw new Error("未授予 AI API 访问权限");
    }
    busy("saveQuickBtn", true, "保存中…");
    const r = await send({ type: "SAVE_QUICK_AI", config });
    if (!r.ok) throw new Error(r.error?.message || "保存失败");
    $("quickKey").value = "";
    await clearPopupDraftSection("quick");
    setInfo("quickInfo", config.enabled ? "插件 AI 能力已保存。" : "插件 AI 能力已禁用。");
    await refreshAll();
  } catch (e) {
    setInfo("quickInfo", e.message, true);
  } finally {
    busy("saveQuickBtn", false, "保存");
  }
}

async function testQuickAI() {
  clearInfo("quickInfo");
  const config = quickConfigFromForm();
  const hasExistingKey = !!runtimeState?.quickAI?.configured;
  if (!config.baseUrl || (!config.apiKey && !hasExistingKey) || !config.model) return setInfo("quickInfo", "测试前请填写 API、API Key 和模型。", true);
  try {
    const granted = await chrome.permissions.request({ origins: [toOriginPattern(config.baseUrl)] });
    if (!granted) throw new Error("未授予 AI API 访问权限");
    busy("testQuickBtn", true, "测试中…");
    const r = await send({ type: "TEST_QUICK_AI", config }, 30000);
    if (!r.ok) throw new Error(r.error?.message || "测试失败");
    setInfo("quickInfo", `AI 连接成功：${r.data?.summary || r.data?.conclusion || "响应正常"}`);
  } catch (e) {
    setInfo("quickInfo", e.message, true);
  } finally {
    busy("testQuickBtn", false, "测试 AI");
  }
}

async function fetchQuickModels() {
  clearInfo("quickInfo");
  const config = quickConfigFromForm();
  const hasExistingKey = !!runtimeState?.quickAI?.configured;
  if (!config.baseUrl || (!config.apiKey && !hasExistingKey)) return setInfo("quickInfo", "获取模型前请填写 API 地址和 API Key。", true);
  try {
    const granted = await chrome.permissions.request({ origins: [toOriginPattern(config.baseUrl)] });
    if (!granted) throw new Error("未授予 AI API 访问权限");
    busy("fetchModelsBtn", true, "获取中…");
    const r = await send({ type: "LIST_QUICK_AI_MODELS", config }, 30000);
    if (!r.ok) throw new Error(r.error?.message || "模型列表获取失败");
    const models = Array.isArray(r.models) ? r.models : [];
    if (!models.length) {
      $("quickModelSelect").hidden = true;
      return setInfo("quickInfo", r.warning || "未获取到模型列表，可直接填写模型 ID。");
    }
    $("quickModelSelect").innerHTML = `<option value="">选择模型</option>` + models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
    $("quickModelSelect").hidden = false;
    setInfo("quickInfo", `已获取 ${models.length} 个模型。`);
  } catch (e) {
    setInfo("quickInfo", e.message, true);
  } finally {
    busy("fetchModelsBtn", false, "获取模型");
  }
}

function quickConfigFromForm() {
  return {
    enabled: $("quickEnabled").checked,
    protocol: $("quickProtocol").value,
    baseUrl: $("quickUrl").value.trim(),
    apiKey: $("quickKey").value.trim(),
    model: $("quickModel").value.trim(),
    sendRawText: $("sendRawText").checked,
    authMode: $("quickAuthMode").value,
    endpointMode: $("quickEndpointMode").value,
    openaiWire: $("quickOpenAIWire").value
  };
}

function bindDraftPersistence() {
  [
    "platformUrl", "platformToken", "quickEnabled", "quickProtocol", "quickModel",
    "quickUrl", "quickKey", "quickAuthMode", "quickEndpointMode",
    "quickOpenAIWire", "sendRawText"
  ].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener(el.type === "checkbox" ? "change" : "input", savePopupDraftSoon);
    if (el.tagName === "SELECT") el.addEventListener("change", savePopupDraftSoon);
  });
  ["platformConfig", "quickConfig"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("toggle", savePopupDraftSoon);
  });
  window.addEventListener("beforeunload", () => {
    if (draftTimer) clearTimeout(draftTimer);
    savePopupDraftNow();
  });
}

function savePopupDraftSoon() {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(savePopupDraftNow, 160);
}

function collectPopupDraft() {
  return {
    updatedAt: Date.now(),
    open: {
      platform: $("platformConfig")?.open || false,
      quick: $("quickConfig")?.open || false
    },
    platform: {
      baseUrl: $("platformUrl")?.value || "",
      token: $("platformToken")?.value || ""
    },
    quick: {
      enabled: $("quickEnabled")?.checked || false,
      protocol: $("quickProtocol")?.value || "openai",
      model: $("quickModel")?.value || "",
      baseUrl: $("quickUrl")?.value || "",
      apiKey: $("quickKey")?.value || "",
      authMode: $("quickAuthMode")?.value || "protocol",
      endpointMode: $("quickEndpointMode")?.value || "base",
      openaiWire: $("quickOpenAIWire")?.value || "chat",
      sendRawText: $("sendRawText")?.checked !== false
    }
  };
}

async function savePopupDraftNow() {
  try {
    await chrome.storage.local.set({ [POPUP_DRAFT_KEY]: collectPopupDraft() });
  } catch (_) {}
}

async function restorePopupDraft() {
  try {
    const data = await chrome.storage.local.get(POPUP_DRAFT_KEY);
    const draft = data?.[POPUP_DRAFT_KEY];
    if (!draft || typeof draft !== "object") return;

    if (draft.open?.platform) $("platformConfig").open = true;
    if (draft.open?.quick) $("quickConfig").open = true;

    if (draft.platform?.baseUrl) $("platformUrl").value = draft.platform.baseUrl;
    if (draft.platform?.token) $("platformToken").value = draft.platform.token;

    const q = draft.quick || {};
    if (typeof q.enabled === "boolean") $("quickEnabled").checked = q.enabled;
    if (q.protocol) $("quickProtocol").value = q.protocol;
    if (q.model) $("quickModel").value = q.model;
    if (q.baseUrl) $("quickUrl").value = q.baseUrl;
    if (q.apiKey) $("quickKey").value = q.apiKey;
    if (q.authMode) $("quickAuthMode").value = q.authMode;
    if (q.endpointMode) $("quickEndpointMode").value = q.endpointMode;
    if (q.openaiWire) $("quickOpenAIWire").value = q.openaiWire;
    if (typeof q.sendRawText === "boolean") $("sendRawText").checked = q.sendRawText;
    updateProtocolUI();
  } catch (_) {}
}

async function clearPopupDraftSection(section) {
  try {
    const data = await chrome.storage.local.get(POPUP_DRAFT_KEY);
    const draft = data?.[POPUP_DRAFT_KEY];
    if (!draft || typeof draft !== "object") return;
    if (section === "platform") draft.platform = { baseUrl: "", token: "" };
    if (section === "quick") draft.quick = { ...draft.quick, apiKey: "" };
    draft.updatedAt = Date.now();
    await chrome.storage.local.set({ [POPUP_DRAFT_KEY]: draft });
  } catch (_) {}
}

function updateProtocolUI() {
  const protocol = $("quickProtocol")?.value || "openai";
  const endpointMode = $("quickEndpointMode")?.value || "base";
  $("openaiWireLabel").hidden = protocol !== "openai";
  $("quickUrl").placeholder = protocol === "anthropic"
    ? (endpointMode === "full" ? "https://xxx.xxx/v1/messages" : "https://xxx.xxx/anthropic")
    : (endpointMode === "full" ? "https://xxx.xxx/v1/chat/completions" : "https://xxx.xxx/v1");
  $("quickModelSelect").hidden = true;
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

function message(text, error = false) {
  $("message").textContent = text || "";
  $("message").classList.toggle("error", !!error);
}

function setInfo(id, text, error = false) {
  $(id).textContent = text || "";
  $(id).classList.toggle("error", !!error);
}

function clearInfo(id) { setInfo(id, ""); }

function toOriginPattern(value) {
  const u = new URL(value);
  return `${u.protocol}//${u.host}/*`;
}

function send(message, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: { kind: "timeout", message: "插件后台响应超时" } }), timeoutMs);
    chrome.runtime.sendMessage(message, (r) => {
      clearTimeout(timer);
      resolve(r || { ok: false, error: { message: chrome.runtime.lastError?.message || "插件后台无响应" } });
    });
  });
}

function esc(v) { return String(v ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }
