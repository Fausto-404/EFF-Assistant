const el = (id) => document.getElementById(id);

init();

async function init() {
  const state = await send({ type: "GET_STATE" });
  if (state.ok) renderState(state);

  el("connectBtn").addEventListener("click", connectPlatform);
  el("disconnectBtn").addEventListener("click", disconnectPlatform);
  el("syncBtn").addEventListener("click", syncDevices);
  el("testQuickBtn").addEventListener("click", testQuickAI);
  el("saveQuickBtn").addEventListener("click", saveQuickAI);
  el("fetchModelsBtn").addEventListener("click", fetchQuickModels);
  el("quickProtocol").addEventListener("change", updateProtocolUI);
  el("quickEndpointMode").addEventListener("change", updateProtocolUI);
  el("quickModelSelect").addEventListener("change", () => {
    if (el("quickModelSelect").value) el("quickModel").value = el("quickModelSelect").value;
  });
}

function renderState(state) {
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
    updateProtocolUI();
  }
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
    openaiWire: el("quickOpenAIWire").value
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
function escapeHtml(v) { return String(v ?? "").replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }
