const STORAGE_KEY = "effAssistantConfig";
const HISTORY_KEY = "effAssistantOperationHistory";
const HISTORY_LIMIT = 30;
const CONTENT_SCRIPT_ID = "eff-assistant-device-pages";
const QUICK_AI_ROUTE_CACHE = new Map();
const QUICK_AI_ROUTE_CACHE_LIMIT = 16;
const QUICK_SCENE_CACHE = new Map();
const QUICK_SCENE_CACHE_TTL_MS = 10 * 60 * 1000;
const QUICK_SCENE_CACHE_LIMIT = 60;
const QUICK_SCENE_SESSION_KEY = "effQuickSceneCacheV1";
const PLATFORM_TIMEOUTS = {
  me: 20000,
  devices: 30000,
  parse: 90000,
  alerts: 120000,
  investigate: 600000,
  templates: 30000,
  default: 60000
};
const TAB_MESSAGE_TIMEOUT_MS = 1200;
const TAB_INJECTION_TIMEOUT_MS = 1500;
let QUICK_AI_LAST_ROUTE = null;
const tabInjectionLocks = new Map();

const DEFAULT_CONFIG = {
  platform: {
    baseUrl: "",
    token: "",
    connected: false,
    platformName: "EFF-Monitoring",
    version: "",
    workspace: "",
    platformAI: false,
    username: ""
  },
  devices: [],
  devicesSyncedAt: null,
  quickAI: {
    enabled: false,
    protocol: "openai",
    baseUrl: "",
    apiKey: "",
    model: "",
    sendRawText: true,
    authMode: "protocol",
    endpointMode: "base",
    openaiWire: "chat",
    customHeaders: ""
  },
  ui: {
    petPosition: null,
    assistantEnabled: false,
    theme: "dark"
  }
};

async function hardenStorage() {
  try {
    if (chrome.storage?.session?.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    }
  } catch (e) {
    console.warn("EFF Assistant: storage access level could not be restricted", e);
  }
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await hardenStorage();
  const cfg = await getConfig();
  await saveConfig(cfg);
  if (reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await hardenStorage();
  const cfg = await getConfig();
  if (cfg.platform.connected) {
    try {
      await syncDevices(false);
    } catch (e) {
      console.warn("EFF Assistant: device sync on startup failed", e);
      await registerDeviceScripts(cfg.devices || []);
    }
  }
});

// 全局助手开启后，新标签页 / 新窗口 / URL 跳转必须自动自愈注入。
// 动态 registerContentScripts 仍保留作为常规路径，tabs 事件作为可靠兜底。
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url || "";
  if (!/^https?:/i.test(url)) return;
  if (!(changeInfo.url || changeInfo.status === "loading" || changeInfo.status === "complete")) return;
  const delay = changeInfo.status === "complete" ? 80 : 220;
  setTimeout(() => {
    maybeEnsureAssistantOnTab(tabId, url).catch((e) => {
      console.debug("EFF Assistant: auto inject on tab update skipped", e?.message || e);
    });
  }, delay);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId)
    .then((tab) => maybeEnsureAssistantOnTab(tabId, tab?.url || ""))
    .catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_STATE": {
      const cfg = await getConfig();
      return {
        platform: publicPlatform(cfg.platform),
        devices: cfg.devices || [],
        devicesSyncedAt: cfg.devicesSyncedAt,
        ui: {
          petPosition: cfg.ui?.petPosition || null,
          assistantEnabled: cfg.ui?.assistantEnabled !== false,
          theme: normalizeTheme(cfg.ui?.theme)
        },
        quickAI: {
          enabled: !!cfg.quickAI?.enabled,
          protocol: normalizeAIProtocol(cfg.quickAI?.protocol),
          configured: !!(cfg.quickAI?.baseUrl && cfg.quickAI?.model),
          baseUrl: cfg.quickAI?.baseUrl || "",
          apiKeyMasked: cfg.quickAI?.apiKey ? `${cfg.quickAI.apiKey.slice(0, 5)}********` : "",
          model: cfg.quickAI?.model || "",
          sendRawText: cfg.quickAI?.sendRawText !== false,
          authMode: normalizeAuthMode(cfg.quickAI?.authMode),
          endpointMode: normalizeEndpointMode(cfg.quickAI?.endpointMode),
          openaiWire: normalizeOpenAIWire(cfg.quickAI?.openaiWire),
          customHeaders: cfg.quickAI?.customHeaders || ""
        }
      };
    }
    case "SAVE_UI_STATE": {
      const cfg = await getConfig();
      cfg.ui = cfg.ui || {};
      let themeChanged = false;
      if (message.ui?.petPosition && Number.isFinite(Number(message.ui.petPosition.x)) && Number.isFinite(Number(message.ui.petPosition.y))) {
        cfg.ui.petPosition = {
          x: Math.round(Number(message.ui.petPosition.x)),
          y: Math.round(Number(message.ui.petPosition.y))
        };
      }
      if (typeof message.ui?.assistantEnabled === "boolean") {
        cfg.ui.assistantEnabled = message.ui.assistantEnabled;
      }
      if (message.ui?.theme) {
        themeChanged = normalizeTheme(cfg.ui.theme) !== normalizeTheme(message.ui.theme);
        cfg.ui.theme = normalizeTheme(message.ui.theme);
      }
      await saveConfig(cfg);
      if (themeChanged) await broadcastRuntimeConfig(cfg);
      return { ui: { petPosition: cfg.ui.petPosition || null, assistantEnabled: cfg.ui.assistantEnabled !== false, theme: normalizeTheme(cfg.ui.theme) } };
    }
    case "TEST_PLATFORM": {
      const data = await apiFetchWith(message.baseUrl, message.token, "/api/plugin/me", { method: "GET", timeoutMs: PLATFORM_TIMEOUTS.me });
      return { data };
    }
    case "SAVE_PLATFORM": {
      const cfg = await getConfig();
      cfg.platform.baseUrl = normalizeBaseUrl(message.baseUrl);
      cfg.platform.token = String(message.token || "").trim();
      cfg.platform.connected = true;
      if (message.meta) applyPlatformMeta(cfg.platform, message.meta);
      await saveConfig(cfg);
      return { platform: publicPlatform(cfg.platform) };
    }
    case "DISCONNECT_PLATFORM": {
      const cfg = await getConfig();
      cfg.platform = structuredClone(DEFAULT_CONFIG.platform);
      cfg.devices = [];
      cfg.devicesSyncedAt = null;
      await saveConfig(cfg);
      await unregisterDeviceScripts();
      return {};
    }
    case "SYNC_DEVICES": {
      const result = await syncDevices(true);
      return result;
    }
    case "SYNC_PLUGIN_STATE": {
      return await syncPluginState();
    }
    case "SAVE_QUICK_AI": {
      const cfg = await getConfig();
      cfg.quickAI = {
        enabled: !!message.config?.enabled,
        protocol: normalizeAIProtocol(message.config?.protocol || cfg.quickAI?.protocol),
        baseUrl: normalizeBaseUrl(message.config?.baseUrl || cfg.quickAI?.baseUrl || ""),
        apiKey: String(message.config?.apiKey || cfg.quickAI?.apiKey || "").trim(),
        model: String(message.config?.model || cfg.quickAI?.model || "").trim(),
        sendRawText: message.config?.sendRawText !== false,
        authMode: normalizeAuthMode(message.config?.authMode || cfg.quickAI?.authMode),
        endpointMode: normalizeEndpointMode(message.config?.endpointMode || cfg.quickAI?.endpointMode),
        openaiWire: normalizeOpenAIWire(message.config?.openaiWire || cfg.quickAI?.openaiWire),
        customHeaders: String(message.config?.customHeaders ?? cfg.quickAI?.customHeaders ?? "")
      };
      await saveConfig(cfg);
      return {
        quickAI: {
          enabled: cfg.quickAI.enabled,
          protocol: cfg.quickAI.protocol,
          configured: !!(cfg.quickAI.baseUrl && cfg.quickAI.model),
          model: cfg.quickAI.model,
          sendRawText: cfg.quickAI.sendRawText,
          authMode: cfg.quickAI.authMode,
          endpointMode: cfg.quickAI.endpointMode,
          openaiWire: cfg.quickAI.openaiWire
        }
      };
    }
    case "LIST_QUICK_AI_MODELS": {
      const cfg = await getConfig();
      const mergedQuickConfig = {
        ...cfg.quickAI,
        ...(message.config || {}),
        protocol: normalizeAIProtocol(message.config?.protocol || cfg.quickAI?.protocol),
        apiKey: message.config?.apiKey || cfg.quickAI?.apiKey || ""
      };
      const discovery = await listQuickAIModels(mergedQuickConfig);
      return discovery;
    }
    case "TEST_QUICK_AI": {
      const cfg = await getConfig();
      const mergedQuickConfig = {
        ...cfg.quickAI,
        ...(message.config || {}),
        apiKey: message.config?.apiKey || cfg.quickAI?.apiKey || ""
      };
      QUICK_AI_LAST_ROUTE = null;
      const result = await testQuickAIConnection(mergedQuickConfig);
      return { data: result, route: QUICK_AI_LAST_ROUTE };
    }
    case "PARSE_PAGE": {
      const cfg = await requirePlatformConfig();
      const payload = {
        device_id: message.deviceId,
        message_template_id: message.messageTemplateId || null,
        page: message.page || {},
        text: message.text || ""
      };
      let data;
      try {
        data = await apiFetch(cfg, "/api/plugin/parse", {
          method: "POST",
          body: JSON.stringify(payload)
        });
      } catch (e) {
        if (e?.status !== 404) throw e;
        // Transitional fallback for the existing EFF parser while /api/plugin/parse is being added.
        data = await apiFetch(cfg, "/api/logs/parse", {
          method: "POST",
          body: JSON.stringify({ text: payload.text, device_id: payload.device_id })
        });
      }
      return { data: normalizeParseResponse(data, message.deviceId, cfg.devices) };
    }
    case "CREATE_TICKET": {
      const cfg = await requirePlatformConfig();
      const payload = {
        parse_token: message.parseToken || null,
        device_id: message.deviceId,
        message_template_id: message.messageTemplateId || null,
        page: message.page || {},
        text: message.parseToken ? undefined : (message.text || ""),
        source: {
          type: "browser_assistant",
          url: message.page?.url || sender?.tab?.url || "",
          title: message.page?.title || sender?.tab?.title || ""
        }
      };
      const data = await apiFetch(cfg, "/api/plugin/alerts", {
        method: "POST",
        body: JSON.stringify(removeUndefined(payload))
      });
      return { data };
    }
    case "GET_MESSAGE_TEMPLATES": {
      const cfg = await requirePlatformConfig();
      const params = new URLSearchParams({ type: "message" });
      if (message.deviceId) params.set("device_id", String(message.deviceId));
      const data = await apiFetch(cfg, `/api/plugin/templates?${params.toString()}`, { method: "GET" });
      return { data };
    }
    case "SEND_TICKET_WEBHOOK": {
      const cfg = await requirePlatformConfig();
      if (!message.alertId) throw new Error("缺少工单 ID，无法发送通报");
      const data = await apiFetch(cfg, `/api/plugin/alerts/${message.alertId}/send-webhook`, {
        method: "POST",
        body: JSON.stringify({ message_template_id: message.messageTemplateId || null })
      });
      return { data };
    }
    case "PLATFORM_ANALYZE": {
      const cfg = await requirePlatformConfig();
      const payload = {
        parse_token: message.parseToken || null,
        device_id: message.deviceId,
        page: message.page || {},
        text: message.parseToken ? undefined : (message.text || "")
      };
      const data = await apiFetch(cfg, "/api/plugin/investigate", {
        method: "POST",
        body: JSON.stringify(removeUndefined(payload))
      });
      const result = normalizeAnalysisResult(data);
      result.analysis_mode = result.analysis_mode || "smart";
      result.evidence_scope = result.evidence_scope || "platform_enriched";
      return { data: result };
    }
    case "QUICK_ANALYZE": {
      const cfg = await getConfig();
      if (!cfg.quickAI?.enabled || !cfg.quickAI?.baseUrl || !cfg.quickAI?.apiKey || !cfg.quickAI?.model) {
        throw new Error("尚未配置快速研判 AI");
      }
      const data = await callQuickAI(cfg.quickAI, message.text || "", false, message.page || {});
      return { data };
    }
    case "CORRELATE_ANALYZE": {
      const cfg = await getConfig();
      if (!cfg.quickAI?.enabled || !cfg.quickAI?.baseUrl || !cfg.quickAI?.apiKey || !cfg.quickAI?.model) {
        throw new Error("尚未配置快速研判 AI，无法执行关联分析");
      }
      const data = await correlateAlertsWithQuickAI(cfg.quickAI, message.items || [], message.page || {});
      return { data };
    }
    case "SET_ASSISTANT_ENABLED": {
      const cfg = await getConfig();
      cfg.ui = cfg.ui || {};
      cfg.ui.assistantEnabled = !!message.enabled;
      await saveConfig(cfg);
      const active = await applyAssistantVisibilityToActiveTab(cfg.ui.assistantEnabled, cfg.devices || [], cfg);
      applyAssistantVisibilityAcrossTabs(cfg.ui.assistantEnabled, cfg.devices || [], { skipTabId: active?.tabId }).catch((e) => {
        console.warn("EFF Assistant: background visibility fan-out failed", e);
      });
      return { ui: { assistantEnabled: cfg.ui.assistantEnabled } };
    }
    case "GET_ACTIVE_TAB_CONTEXT": {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0] || null;
      const cfg = await getConfig();
      const device = tab?.url ? detectDeviceForUrl(tab.url, cfg.devices || []) : null;
      let widget = null;
      if (tab?.id && /^https?:/i.test(tab.url || "")) {
        // Popup 打开时做一次轻量自愈：全局已开启时，任意 http(s) 页面都补注入助手；
        // Device 只影响平台增强能力，不再影响宠物是否显示。
        if (cfg.ui?.assistantEnabled) {
          try {
            await ensureContentScript(tab.id);
            await pushRuntimeConfigToTab(tab.id, cfg);
            await sendTabMessage(tab.id, { type: "SET_WIDGET_VISIBILITY", visible: true });
          } catch (_) {}
        }
        try {
          widget = await sendTabMessage(tab.id, { type: "GET_WIDGET_STATUS" }, 700);
        } catch (_) {}
      }
      return {
        tab: tab ? { id: tab.id, url: tab.url || "", title: tab.title || "" } : null,
        device,
        widget
      };
    }
    case "SET_ACTIVE_TAB_WIDGET": {
      // 兼容旧 Popup 消息：显示/隐藏不再是“当前页面私有状态”，
      // 而是全局助手偏好。匹配设备的新标签页/新窗口会自动继承。
      const cfg = await getConfig();
      cfg.ui = cfg.ui || {};
      cfg.ui.assistantEnabled = !!message.visible;
      await saveConfig(cfg);
      const active = await applyAssistantVisibilityToActiveTab(cfg.ui.assistantEnabled, cfg.devices || [], cfg);
      applyAssistantVisibilityAcrossTabs(cfg.ui.assistantEnabled, cfg.devices || [], { skipTabId: active?.tabId }).catch((e) => {
        console.warn("EFF Assistant: background visibility fan-out failed", e);
      });

      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0] || null;
      let result = null;
      let device = null;
      if (tab?.id && /^https?:/i.test(tab.url || "")) {
        device = detectDeviceForUrl(tab.url || "", cfg.devices || []);
        // 未配置/未识别设备时仍允许当前页预览宠物。
        if (cfg.ui.assistantEnabled) await ensureContentScript(tab.id);
        try {
          result = await sendTabMessage(tab.id, { type: "SET_WIDGET_VISIBILITY", visible: cfg.ui.assistantEnabled });
        } catch (_) {}
      }
      return { widget: result, device, ui: { assistantEnabled: cfg.ui.assistantEnabled } };
    }
    case "REFRESH_ACTIVE_TAB": {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0] || null;
      if (!tab?.id || !/^https?:/i.test(tab.url || "")) throw new Error("当前页面不支持解析");
      const cfg = await getConfig();
      const device = detectDeviceForUrl(tab.url || "", cfg.devices || []) || null;
      await ensureContentScript(tab.id);
      const result = await sendTabMessage(tab.id, { type: "REFRESH_PARSE" }, 100000);
      const mode = cfg.platform?.connected && device ? "platform" : "local";
      return { widget: result, device, mode };
    }
    case "GET_ACTIVE_PAGE_TEXT": {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0] || null;
      if (!tab?.id || !/^https?:/i.test(tab.url || "")) throw new Error("当前页面不支持读取");
      await ensureContentScript(tab.id);
      const result = await sendTabMessage(tab.id, { type: "GET_PAGE_TEXT" }, 3000);
      return { data: result };
    }
    case "RUN_ACTIVE_TAB_WIDGET_ACTION": {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0] || null;
      if (!tab?.id || !/^https?:/i.test(tab.url || "")) throw new Error("当前页面不支持页面助手操作");
      await ensureContentScript(tab.id);
      const result = await sendTabMessage(tab.id, { type: "RUN_WIDGET_ACTION", action: message.action }, 610000);
      return { data: result };
    }
    case "SHOW_ACTIVE_TAB_WIDGET_DETAIL": {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0] || null;
      if (!tab?.id || !/^https?:/i.test(tab.url || "")) throw new Error("当前页面不支持页面助手操作");
      await ensureContentScript(tab.id);
      const result = await sendTabMessage(tab.id, { type: "SHOW_WIDGET_DETAIL", action: message.action }, 3000);
      return { data: result };
    }
    case "ADD_HISTORY_ITEM": {
      const item = normalizeHistoryItem(message.item, sender?.tab);
      const history = await getHistory();
      const next = [item, ...history.filter((x) => x.id !== item.id)].slice(0, HISTORY_LIMIT);
      await chrome.storage.local.set({ [HISTORY_KEY]: next });
      return { item, history: publicHistory(next) };
    }
    case "GET_HISTORY": {
      const history = await getHistory();
      return { history: publicHistory(history) };
    }
    case "RESTORE_HISTORY_ITEM": {
      const history = await getHistory();
      const item = history.find((x) => x.id === message.id);
      if (!item) throw new Error("未找到该历史记录");
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0] || null;
      if (!tab?.id || !/^https?:/i.test(tab.url || "")) throw new Error("当前页面不支持恢复到助手");
      const cfg = await getConfig();
      if (!cfg.ui?.assistantEnabled) {
        cfg.ui = cfg.ui || {};
        cfg.ui.assistantEnabled = true;
        await saveConfig(cfg);
      }
      await ensureContentScript(tab.id);
      await pushRuntimeConfigToTab(tab.id, cfg);
      const result = await sendTabMessage(tab.id, { type: "RESTORE_HISTORY_ITEM", item }, 3000);
      return { widget: result };
    }
    case "OPEN_OPTIONS": {
      await chrome.runtime.openOptionsPage();
      return {};
    }
    case "OPEN_HISTORY_DETAIL": {
      const hash = message.id ? `#history=${encodeURIComponent(message.id)}` : "#history";
      await chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html${hash}`) });
      return {};
    }
    case "OPEN_URL": {
      if (message.url && /^https?:\/\//i.test(message.url)) {
        await chrome.tabs.create({ url: message.url });
      }
      return {};
    }
    default:
      throw new Error("未知插件消息类型");
  }
}

async function getHistory() {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(data?.[HISTORY_KEY]) ? data[HISTORY_KEY].filter((x) => x && typeof x === "object") : [];
}

function normalizeHistoryItem(raw, tab) {
  const now = Date.now();
  const kind = ["ticket", "smart", "quick", "correlation"].includes(raw?.kind) ? raw.kind : "quick";
  return {
    id: String(raw?.id || `${now}-${Math.random().toString(16).slice(2)}`),
    kind,
    title: String(raw?.title || historyKindLabel(kind)),
    summary: String(raw?.summary || "").slice(0, 220),
    createdAt: Number(raw?.createdAt) || now,
    page: {
      url: String(raw?.page?.url || tab?.url || ""),
      title: String(raw?.page?.title || tab?.title || "")
    },
    payload: raw?.payload && typeof raw.payload === "object" ? raw.payload : {}
  };
}

function publicHistory(history) {
  return history.map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    createdAt: item.createdAt,
    page: item.page || {}
  }));
}

function historyKindLabel(kind) {
  return kind === "ticket" ? "生成工单" : kind === "smart" ? "智能研判" : kind === "correlation" ? "关联分析" : "快速研判";
}

async function ensureContentScript(tabId) {
  if (tabInjectionLocks.has(tabId)) return tabInjectionLocks.get(tabId);
  const task = ensureContentScriptInner(tabId).finally(() => tabInjectionLocks.delete(tabId));
  tabInjectionLocks.set(tabId, task);
  return task;
}

async function ensureContentScriptInner(tabId) {
  try {
    const status = await sendTabMessage(tabId, { type: "GET_WIDGET_STATUS" }, 600);
    if (status) return;
  } catch (_) {}
  await withTimeout(chrome.scripting.executeScript({ target: { tabId }, files: ["content/content.js"] }), TAB_INJECTION_TIMEOUT_MS, "注入助手超时");
  await new Promise((resolve) => setTimeout(resolve, 60));
}

function sendTabMessage(tabId, message, timeoutMs = TAB_MESSAGE_TIMEOUT_MS) {
  return withTimeout(chrome.tabs.sendMessage(tabId, message), timeoutMs, "页面助手响应超时");
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message || "操作超时");
      err.kind = "timeout";
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function detectDeviceForUrl(url, devices) {
  const matches = [];
  for (const d of devices || []) {
    for (const p of d.url_patterns || []) {
      if (matchGlobUrl(url, p)) matches.push({ d, score: String(p).replace(/\*/g, "").length });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return matches[0]?.d || null;
}

function matchGlobUrl(value, pattern) {
  const escaped = String(pattern || "").split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  try { return new RegExp(`^${escaped}$`, "i").test(String(value || "")); } catch (_) { return false; }
}

async function syncDevices(throwIfNotConnected = true) {
  const cfg = await getConfig();
  if (!cfg.platform.connected || !cfg.platform.baseUrl || !cfg.platform.token) {
    if (throwIfNotConnected) throw new Error("EFF-Monitoring 尚未连接");
    return { devices: cfg.devices || [] };
  }
  const data = await apiFetch(cfg, "/api/plugin/devices", { method: "GET" });
  const devices = Array.isArray(data) ? data : (data.devices || []);
  cfg.devices = devices
    .filter((d) => d && d.id != null)
    .map((d) => ({
      id: d.id,
      name: d.name || `Device-${d.id}`,
      vendor: d.vendor || "",
      product: d.product || "",
      url_patterns: Array.isArray(d.url_patterns) ? d.url_patterns : (d.url_pattern ? [d.url_pattern] : [])
    }));
  cfg.devicesSyncedAt = new Date().toISOString();
  await saveConfig(cfg);
  await registerDeviceScripts(cfg.devices);

  // 已经注入页面的 content script 可能仍持有同步前的 devices 快照。
  // 每次同步后主动广播最新配置，让页面立即重新执行 URL -> Device 匹配。
  const active = await refreshActiveTabAfterConfigSync(cfg);
  await broadcastRuntimeConfig(cfg, { skipTabId: active?.tabId });
  if (cfg.ui?.assistantEnabled) {
    await applyAssistantVisibilityAcrossTabs(true, cfg.devices, { skipTabId: active?.tabId });
  }
  return { devices: cfg.devices, devicesSyncedAt: cfg.devicesSyncedAt };
}

async function syncPluginState() {
  const cfg = await getConfig();
  let platformSynced = false;
  if (cfg.platform?.connected && cfg.platform?.baseUrl && cfg.platform?.token) {
    await syncDevices(false);
    platformSynced = true;
  } else {
    await saveConfig(cfg);
    await broadcastRuntimeConfig(cfg);
    if (cfg.ui?.assistantEnabled) {
      await applyAssistantVisibilityAcrossTabs(true, cfg.devices || []);
    }
  }
  const latest = await getConfig();
  return {
    platformSynced,
    devices: latest.devices || [],
    devicesSyncedAt: latest.devicesSyncedAt || null,
    ui: {
      assistantEnabled: latest.ui?.assistantEnabled === true,
      theme: normalizeTheme(latest.ui?.theme)
    },
    quickAI: {
      enabled: !!latest.quickAI?.enabled,
      configured: !!(latest.quickAI?.baseUrl && latest.quickAI?.model),
      model: latest.quickAI?.model || ""
    }
  };
}

async function registerDeviceScripts(devices) {
  await unregisterDeviceScripts();
  const matches = [...new Set((devices || []).flatMap((d) => d.url_patterns || []).map(toMatchPattern).filter(Boolean))];
  if (!matches.length) return;
  const granted = [];
  for (const match of matches) {
    try {
      const ok = await chrome.permissions.contains({ origins: [match] });
      if (ok) granted.push(match);
    } catch (_) {}
  }
  if (!granted.length) return;
  try {
    await chrome.scripting.registerContentScripts([{
      id: CONTENT_SCRIPT_ID,
      matches: granted,
      js: ["content/content.js"],
      runAt: "document_idle",
      persistAcrossSessions: true
    }]);
  } catch (e) {
    console.warn("EFF Assistant: failed to register device content script", e);
  }
}

async function unregisterDeviceScripts() {
  try {
    const current = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    if (current.length) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch (_) {}
}

async function applyAssistantVisibilityToActiveTab(enabled, devices, cfg) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0] || null;
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) return null;
  const matchedDevice = detectDeviceForUrl(tab.url || "", devices || []);
  if (enabled && (matchedDevice || tab.id)) {
    try {
      await ensureContentScript(tab.id);
      await pushRuntimeConfigToTab(tab.id, cfg);
    } catch (_) {}
  }
  try {
    await sendTabMessage(tab.id, { type: "SET_WIDGET_VISIBILITY", visible: !!enabled });
  } catch (_) {}
  return { tabId: tab.id };
}

async function applyAssistantVisibilityAcrossTabs(enabled, devices, options = {}) {
  const tabs = await chrome.tabs.query({});
  const cfg = await getConfig();
  const targets = tabs.filter((tab) => tab?.id && tab.id !== options.skipTabId && /^https?:/i.test(tab.url || ""));
  let index = 0;
  const workers = Array.from({ length: Math.min(5, targets.length) }, async () => {
    while (index < targets.length) {
      const tab = targets[index++];
      await applyAssistantVisibilityToTab(tab, enabled, devices, cfg);
    }
  });
  await Promise.all(workers);
}

async function applyAssistantVisibilityToTab(tab, enabled, devices, cfg) {
  if (enabled) {
    try {
      await ensureContentScript(tab.id);
      await pushRuntimeConfigToTab(tab.id, cfg);
    } catch (_) {}
  }
  try {
    await sendTabMessage(tab.id, { type: "SET_WIDGET_VISIBILITY", visible: !!enabled });
  } catch (_) {}
}

async function maybeEnsureAssistantOnTab(tabId, url) {
  if (!tabId || !/^https?:/i.test(url || "")) return false;
  const cfg = await getConfig();
  if (!cfg.ui?.assistantEnabled) return false;

  await ensureContentScript(tabId);
  await pushRuntimeConfigToTab(tabId, cfg);
  try {
    await sendTabMessage(tabId, { type: "SET_WIDGET_VISIBILITY", visible: true });
  } catch (_) {}
  return true;
}

function contentRuntimeSnapshot(cfg) {
  return {
    platform: publicPlatform(cfg.platform),
    devices: cfg.devices || [],
    devicesSyncedAt: cfg.devicesSyncedAt || null,
    ui: {
      petPosition: cfg.ui?.petPosition || null,
      assistantEnabled: cfg.ui?.assistantEnabled === true,
      theme: normalizeTheme(cfg.ui?.theme)
    },
    quickAI: {
      enabled: !!cfg.quickAI?.enabled,
      protocol: normalizeAIProtocol(cfg.quickAI?.protocol),
      configured: !!(cfg.quickAI?.baseUrl && cfg.quickAI?.model),
      model: cfg.quickAI?.model || "",
      sendRawText: cfg.quickAI?.sendRawText !== false,
      authMode: normalizeAuthMode(cfg.quickAI?.authMode),
      endpointMode: normalizeEndpointMode(cfg.quickAI?.endpointMode),
      openaiWire: normalizeOpenAIWire(cfg.quickAI?.openaiWire)
    }
  };
}

async function pushRuntimeConfigToTab(tabId, cfg, options = {}) {
  try {
    await sendTabMessage(tabId, {
      type: "CONFIG_UPDATED",
      state: contentRuntimeSnapshot(cfg),
      forceRefresh: !!options.forceRefresh
    }, 900);
  } catch (_) {}
}

async function broadcastRuntimeConfig(cfg, options = {}) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab?.id || tab.id === options.skipTabId || !/^https?:/i.test(tab.url || "")) continue;
    await pushRuntimeConfigToTab(tab.id, cfg);
  }
}

async function refreshActiveTabAfterConfigSync(cfg) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0] || null;
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) return null;
  try {
    await ensureContentScript(tab.id);
    await pushRuntimeConfigToTab(tab.id, cfg, { forceRefresh: true });
    if (cfg.ui?.assistantEnabled) {
      await sendTabMessage(tab.id, { type: "SET_WIDGET_VISIBILITY", visible: true }, 1200);
    }
    if (detectDeviceForUrl(tab.url || "", cfg.devices || [])) {
      await sendTabMessage(tab.id, { type: "REFRESH_PARSE" }, 100000);
    }
  } catch (e) {
    console.debug("EFF Assistant: active tab refresh after config sync skipped", e?.message || e);
  }
  return { tabId: tab.id };
}

async function requirePlatformConfig() {
  const cfg = await getConfig();
  if (!cfg.platform.connected || !cfg.platform.baseUrl || !cfg.platform.token) {
    throw new Error("EFF-Monitoring 尚未连接，请先打开插件设置完成初始化");
  }
  return cfg;
}

async function apiFetch(cfg, path, init = {}) {
  const timeoutMs = init.timeoutMs || platformTimeoutForPath(path);
  return apiFetchWith(cfg.platform.baseUrl, cfg.platform.token, path, { ...init, timeoutMs });
}

async function apiFetchWith(baseUrl, token, path, init = {}) {
  const url = buildApiUrl(baseUrl, path);
  const timeoutMs = Number(init.timeoutMs || PLATFORM_TIMEOUTS.default);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/json");
  if (init.body != null) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let resp;
  try {
    const { timeoutMs: _timeoutMs, signal: _signal, ...fetchInit } = init;
    resp = await fetch(url, { ...fetchInit, headers, cache: "no-store", signal: controller.signal });
  } catch (e) {
    const timedOut = e?.name === "AbortError";
    const err = new Error(timedOut ? `连接平台超时（${Math.round(timeoutMs / 1000)} 秒）：${url}` : `无法连接 ${url}：${e.message}`);
    err.kind = timedOut ? "timeout" : "network";
    err.cause = e;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = { detail: text }; }
  }
  if (!resp.ok) {
    const err = new Error(data?.detail || data?.message || `HTTP ${resp.status}`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data ?? {};
}

function platformTimeoutForPath(path) {
  if (/\/me$/i.test(path)) return PLATFORM_TIMEOUTS.me;
  if (/\/devices$/i.test(path)) return PLATFORM_TIMEOUTS.devices;
  if (/\/parse$/i.test(path)) return PLATFORM_TIMEOUTS.parse;
  if (/\/alerts$/i.test(path)) return PLATFORM_TIMEOUTS.alerts;
  if (/\/templates(?:\?|$)/i.test(path)) return PLATFORM_TIMEOUTS.templates;
  if (/\/send-webhook$/i.test(path)) return PLATFORM_TIMEOUTS.alerts;
  if (/\/investigate$/i.test(path)) return PLATFORM_TIMEOUTS.investigate;
  return PLATFORM_TIMEOUTS.default;
}

function buildApiUrl(baseUrl, path) {
  let base = normalizeBaseUrl(baseUrl);
  let p = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/api") && p.startsWith("/api/")) p = p.slice(4);
  return `${base}${p}`;
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function publicPlatform(platform) {
  return {
    baseUrl: platform.baseUrl || "",
    connected: !!platform.connected,
    platformName: platform.platformName || "EFF-Monitoring",
    version: platform.version || "",
    workspace: (platform.workspace && typeof platform.workspace === "object" ? platform.workspace.name : platform.workspace) || "",
    platformAI: !!platform.platformAI,
    username: platform.username || "",
    tokenMasked: platform.token ? `${platform.token.slice(0, 8)}********` : ""
  };
}

function applyPlatformMeta(target, data) {
  target.platformName = data.platform || data.platform_name || "EFF-Monitoring";
  target.version = data.version || "";
  const ws = data.workspace; target.workspace = (ws && typeof ws === "object" ? ws.name : ws) || data.workspace_name || "";
  target.username = data.user?.username || data.username || "";
  target.platformAI = !!(data.capabilities?.platform_ai ?? data.platform_ai_enabled ?? data.platform_ai);
}

async function getConfig() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  return deepMerge(structuredClone(DEFAULT_CONFIG), raw[STORAGE_KEY] || {});
}

async function saveConfig(cfg) {
  await chrome.storage.local.set({ [STORAGE_KEY]: cfg });
}

function deepMerge(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

function toMatchPattern(pattern) {
  const p = String(pattern || "").trim();
  if (!p) return null;
  if (/^https?:\/\/[^/]+\/.*$/i.test(p)) return p;
  try {
    const u = new URL(p.replace(/\*/g, "x"));
    return `${u.protocol}//${u.host}/*`;
  } catch (_) {
    return null;
  }
}

function normalizeParseResponse(data, deviceId, devices) {
  if (!data || typeof data !== "object") data = {};
  const parsed = data.fields || data.parsed_fields || data.parsed || {};
  const device = data.device || devices?.find((d) => String(d.id) === String(deviceId)) || { id: deviceId, name: `Device-${deviceId}` };
  const fields = {
    src_ip: firstNonEmpty(parsed.src_ip, parsed.source_ip, parsed.srcIp, data.src_ip),
    dst_ip: firstNonEmpty(parsed.dst_ip, parsed.destination_ip, parsed.dest_ip, parsed.dstIp, data.dst_ip),
    event_type: firstNonEmpty(parsed.event_type, parsed.event_name, parsed.alert_name, parsed.attack_type, data.event_type)
  };
  const srcContext = normalizeContext(data.src_context || data.source_context || {});
  const dstContext = normalizeContext(data.dst_context || data.destination_context || {});

  // Transitional mapping from existing parser results.
  if (!srcContext.tags.length && Array.isArray(data.ip_list_alerts)) {
    for (const item of data.ip_list_alerts) {
      const ip = item.ip || item.value || "";
      const label = item.label || item.name || item.list_name || item.type || "名单命中";
      const target = ip && ip === fields.dst_ip ? dstContext : srcContext;
      target.tags.push({ type: String(item.type || "list"), label: String(label), severity: /黑|恶意|block/i.test(label) ? "danger" : "info" });
    }
  }
  const assetCtx = data.asset_context || {};
  addAssetTags(srcContext, assetCtx.src_asset || assetCtx.source_asset);
  addAssetTags(dstContext, assetCtx.dst_asset || assetCtx.destination_asset || assetCtx.dest_asset);

  return {
    ...data,
    parse_token: data.parse_token || null,
    device: { id: device.id ?? deviceId, name: device.name || `Device-${deviceId}` },
    fields,
    src_context: srcContext,
    dst_context: dstContext
  };
}

function normalizeContext(ctx) {
  const tags = [];
  for (const t of (ctx.tags || [])) {
    if (typeof t === "string") tags.push({ type: "tag", label: t, severity: "info" });
    else if (t?.label) tags.push({ type: t.type || "tag", label: t.label, severity: t.severity || "info" });
  }
  return { ...ctx, tags };
}

function addAssetTags(target, asset) {
  if (!asset) return;
  target.asset = target.asset || asset;
  const values = [];
  if (asset.criticality) values.push(asset.criticality);
  if (asset.importance) values.push(asset.importance);
  if (Array.isArray(asset.tags)) values.push(...asset.tags);
  for (const value of values.filter(Boolean)) {
    const label = String(value);
    if (!target.tags.some((t) => t.label === label)) {
      target.tags.push({ type: "asset", label, severity: /核心|高|重要/i.test(label) ? "danger" : "info" });
    }
  }
}

async function callQuickAI(config, rawText, isTest, page = {}) {
  const quick = {
    enabled: true,
    protocol: normalizeAIProtocol(config?.protocol),
    baseUrl: normalizeBaseUrl(config?.baseUrl || ""),
    apiKey: String(config?.apiKey || "").trim(),
    model: String(config?.model || "").trim(),
    sendRawText: config?.sendRawText !== false,
    authMode: normalizeAuthMode(config?.authMode),
    endpointMode: normalizeEndpointMode(config?.endpointMode),
    openaiWire: normalizeOpenAIWire(config?.openaiWire),
    customHeaders: String(config?.customHeaders || "").trim()
  };
  if (!quick.baseUrl || !quick.model) throw new Error("快速 AI 配置不完整");

  if (!isTest && !quick.sendRawText) {
    throw new Error("已关闭“发送当前页面告警文本”，快速研判没有可用页面证据");
  }

  if (isTest) {
    return invokeQuickProvider(quick, '你是连通性测试助手。只回复 {"ok":true}。', '这是连通性测试。只返回一个紧凑 JSON 对象，不要解释。', 64);
  }

  // 混合路由两阶段研判。
  // Stage 0 本地 Router 只决定“是否可以跳过页面分类”，不直接输出攻击结论。
  // 强告警上下文直接进入 Stage 2；模糊页面才调用轻量 Stage 1，从而兼顾速度与误判率。
  const route = inspectQuickRoute(rawText, page);
  let scene;

  if (route.direct_stage2) {
    scene = {
      page_type: route.suggested_page_type,
      confidence: route.confidence,
      reason: route.reason,
      scene_source: "local_router",
      actionable: true,
      context_uncertain: false,
      route_mode: "direct_stage2",
      route_label: "快速路径 · 直接攻击研判"
    };
  } else {
    const cacheKey = quickSceneCacheKey(rawText, page, quick);
    const cached = await getQuickSceneCache(cacheKey);
    if (cached) {
      scene = {
        ...cached,
        scene_source: "cache",
        route_mode: cached.actionable ? "stage1_cache_stage2" : "stage1_cache_end",
        route_label: cached.actionable ? "分类缓存 · 直接攻击研判" : "分类缓存 · 页面分类结束"
      };
    } else {
      scene = await classifyQuickPageMini(quick, quick.sendRawText ? rawText : "", page);
      await setQuickSceneCache(cacheKey, scene);
      scene.route_mode = scene.actionable ? "stage1_stage2" : "stage1_end";
      scene.route_label = scene.actionable ? "轻量分类 → 攻击研判" : "轻量分类 · 页面分类结束";
    }

    const strongEnoughForUncertainStage2 = route.score >= 4 && route.event_signal_count >= 2 && !route.strong_non_alert;
    if (scene.actionable) {
      if (scene.confidence < 70) {
        if (strongEnoughForUncertainStage2) {
          scene.context_uncertain = true;
          scene.route_mode = "uncertain_stage2";
          scene.route_label = "分类不确定 → 保守攻击研判";
          scene.reason = `${scene.reason || "页面分类置信度不足"}；本地检测到较强具体事件特征，因此进入保守攻击研判。`;
        } else {
          return buildUncertainQuickResult(scene, route);
        }
      }
    } else {
      if (scene.page_type !== "无法确认" && scene.confidence >= 75) {
        const result = buildNonAlertQuickResult(scene);
        result.stage_route = scene.route_mode;
        result.stage_route_label = scene.route_label;
        result.router_score = route.score;
        return result;
      }
      if (strongEnoughForUncertainStage2) {
        scene = {
          ...scene,
          page_type: route.suggested_page_type,
          actionable: true,
          context_uncertain: true,
          route_mode: "uncertain_stage2",
          route_label: "分类不确定 → 保守攻击研判",
          reason: `${scene.reason || "页面分类置信度不足"}；本地检测到较强具体事件特征，因此进入保守攻击研判。`
        };
      } else {
        return buildUncertainQuickResult(scene, route);
      }
    }
  }

  // Stage 2：正式攻击研判。
  const selectedText = quick.sendRawText ? buildQuickEvidenceText(rawText) : "（未发送当前页面正文）";
  const uncertaintyRule = scene.context_uncertain
    ? "当前页面上下文存在不确定性。必须保守判断；除非输入中存在直接、明确的成功/失败证据，否则优先使用‘无法确认’，不得仅凭漏洞描述或攻击关键词推断攻击结果。"
    : "当前页面上下文已具备较高置信度的具体安全事件/攻击日志特征。";
  const systemPrompt = `你是 EFF Assistant 的浏览器侧安全告警快速研判模块。页面路由判定当前上下文为“${scene.page_type}”。${uncertaintyRule}

任务：
1. 从页面中尽量识别 device、src_ip、dst_ip、event_type。不要因为页面出现多个 IP 就随意指定源/目的；无法确定时返回空字符串。
2. verdict_labels 必须是数组，且只能从以下固定枚举中选择，可多选：业务行为、存在攻击意图、攻击失败、攻击成功、无法确认。Stage 2 不得返回“非告警事件”。
3. verdict_labels 必须遵守互斥规则：
   - “业务行为”和“存在攻击意图”绝不能同时出现；业务行为也不能和攻击成功/攻击失败同时出现。
   - “攻击成功”和“攻击失败”绝不能同时出现。
   - “无法确认”不能和“攻击成功”或“攻击失败”同时出现；若攻击意图明确但攻击结果证据不足，可使用 [“存在攻击意图”,“无法确认”]。
   - 若选择“攻击成功”或“攻击失败”，必须同时选择“存在攻击意图”。
4. 标签语义：
   - 业务行为：有明确证据表明属于正常/预期业务活动。
   - 存在攻击意图：存在扫描、利用载荷、恶意命令、异常攻击请求等明确攻击性特征。
   - 攻击失败：存在攻击意图，且有明确拦截、无效响应、利用未达成等失败证据。
   - 攻击成功：存在攻击意图，且有明确命令执行、敏感数据返回、WebShell/持久化、控制成功等成功证据。
   - 无法确认：现有页面证据不足以确认性质或攻击结果。
5. 输出一段可直接给 SOC 值守人员阅读的 summary，优先说明源/目的、关键载荷或行为、响应/结果证据以及最终判断。
6. 输出 analysis_steps，形成 3-5 个证据链维度。建议覆盖：业务/访问合理性、攻击特征、响应证据、失陷/后续行为、综合判断；只保留输入中有证据支持的维度。每项格式为 {title,status,detail}。
7. 关键依据只能引用输入中真实存在的特征，不得虚构威胁情报、资产等级、历史告警、主机执行结果等未提供信息。不输出处置建议。
8. 严格输出 JSON 对象，不要 Markdown。字段固定为：device、src_ip、dst_ip、event_type、verdict_labels、conclusion、confidence、risk_level、summary、analysis_steps、evidence。confidence 为 0-100 整数；verdict_labels 为字符串数组；analysis_steps 为对象数组；evidence 为字符串数组。`;

  const contextLines = [
    `研判路由：${scene.route_label || "攻击研判"}`,
    `页面类型：${scene.page_type}`,
    `页面分类置信度：${scene.confidence}`,
    `页面上下文不确定：${scene.context_uncertain ? "是" : "否"}`,
    `本地路由评分：${route.score}`,
    `页面标题：${String(page?.title || "未知")}`,
    `页面URL：${String(page?.url || "未知")}`,
    `URL本地识别设备：${String(page?.detected_device || "未识别")}`,
    "证据范围：仅浏览器当前页面可见文本；未使用平台解析、资产、情报、历史告警或经验库。"
  ];

  const userPrompt = `${contextLines.join("\n")}

当前页面可见文本（已做相关性压缩，保持原文，不代表平台正则解析结果）：
${selectedText}`;

  const first = await invokeQuickProvider(quick, systemPrompt, userPrompt, 4096);
  let parsed = parseQuickAnalysisPayload(first.text);

  if (!parsed.ok || !hasUsefulQuickPayload(parsed.value) || first.truncated) {
    const retrySystem = `你是安全告警快速研判模块。当前页面路由为“${scene.page_type}”。禁止输出思考过程、Markdown、代码块或解释文字。
只返回一个完整 JSON 对象。字段仅允许：device,src_ip,dst_ip,event_type,verdict_labels,conclusion,confidence,risk_level,summary,analysis_steps,evidence。
verdict_labels 只能从 [“业务行为”,“存在攻击意图”,“攻击失败”,“攻击成功”,“无法确认”] 中选择，并严格遵守互斥规则：业务行为不能与攻击类标签组合；攻击成功与攻击失败互斥；无法确认不能与攻击成功/攻击失败组合；攻击成功/攻击失败必须同时包含存在攻击意图。
summary 不超过 180 个汉字；analysis_steps 最多 4 项，每项 detail 不超过 90 个汉字；evidence 最多 5 项。无法确认的字段使用空字符串，不要虚构证据。${scene.context_uncertain ? "当前上下文存在不确定性，证据不足时必须使用无法确认。" : ""}`;
    const retryUser = `${contextLines.join("\n")}

页面证据：
${selectedText}`;
    const second = await invokeQuickProvider(quick, retrySystem, retryUser, 4096);
    parsed = parseQuickAnalysisPayload(second.text);
  }

  if (!parsed.ok || !hasUsefulQuickPayload(parsed.value)) {
    const preview = shortErrorText(parsed.raw || first.text || "");
    const error = new Error(`模型返回内容不符合快速研判结构${preview ? `：${preview}` : ""}`);
    error.kind = "compat";
    throw error;
  }

  const result = normalizeAnalysisResult(parsed.value);
  result.analysis_mode = "quick";
  result.evidence_scope = "page_only";
  result.page_type = scene.page_type;
  result.scene_confidence = scene.confidence;
  result.scene_reason = scene.reason;
  result.stage_route = scene.route_mode || "stage2";
  result.stage_route_label = scene.route_label || "攻击研判";
  result.router_score = route.score;
  result.context_uncertain = !!scene.context_uncertain;
  return result;
}

async function correlateAlertsWithQuickAI(config, items, page = {}) {
  const quick = {
    enabled: true,
    protocol: normalizeAIProtocol(config?.protocol),
    baseUrl: normalizeBaseUrl(config?.baseUrl || ""),
    apiKey: String(config?.apiKey || "").trim(),
    model: String(config?.model || "").trim(),
    sendRawText: config?.sendRawText !== false,
    authMode: normalizeAuthMode(config?.authMode),
    endpointMode: normalizeEndpointMode(config?.endpointMode),
    openaiWire: normalizeOpenAIWire(config?.openaiWire),
    customHeaders: String(config?.customHeaders || "").trim()
  };
  if (!quick.baseUrl || !quick.model) throw new Error("快速 AI 配置不完整");
  const alerts = (Array.isArray(items) ? items : []).slice(0, 8).map((item, index) => ({
    index: index + 1,
    title: item?.title || `告警 ${index + 1}`,
    page: item?.page || {},
    summary: String(item?.summary || "").slice(0, 300),
    text: String(item?.text || "").slice(0, 12000),
    result: compactCorrelationResult(item?.result || item?.payload?.quickResult || item?.payload?.analysisResult || item?.payload?.result || {})
  }));
  if (alerts.length < 2) throw new Error("关联分析至少需要 2 条告警线索");

  const systemPrompt = `你是 SOC 告警关联分析助手。你会收到多个安全告警页面线索，可能包含原始告警文本或已有结构化研判结果。请判断它们是否存在同源攻击、同一攻击链、相同目标资产、相似攻击手法或时间/行为上的关联，并判断攻击结果和处置优先级。
严格输出 JSON 对象，不要 Markdown。字段固定为：relation_verdict、attack_outcome、risk_change、priority、optional_labels、verdict_labels、conclusion、confidence、risk_level、summary、analysis_steps、evidence。
固定字段枚举：
1. relation_verdict 只能选：同源攻击、同一攻击链、相同目标资产、相似攻击手法、无有效关联、无法确认。
2. attack_outcome 只能选：攻击成功、攻击失败、疑似成功、未见成功证据、无法确认。
3. risk_change 只能选：风险升级、风险持平、风险降低、无法确认。
4. priority 只能选：立即处置、优先排查、持续观察、可归档、无法确认。
optional_labels 可从以下标签选择多个：同一源IP、同一目标IP、同一时间窗口、横向移动迹象、持久化迹象、批量扫描、暴力破解、漏洞利用、命令执行、数据下载、资产失陷、凭据风险。
verdict_labels 必须按顺序包含四个固定结论 [relation_verdict, attack_outcome, risk_change, priority]，再追加 optional_labels；不要把“无法确认”与明确结论混用。
analysis_steps 为 3-6 项，每项格式 {title,status,detail}，建议覆盖：主体关联、目标关联、攻击手法、结果影响、综合判断。不要虚构输入以外的情报。`;
  const userPrompt = `当前页面：${String(page?.title || "")} ${String(page?.url || "")}

待关联告警 JSON：
${JSON.stringify(alerts, null, 2)}`;
  const response = await invokeQuickProvider(quick, systemPrompt, userPrompt, 4096);
  let parsed = parseQuickAnalysisPayload(response.text);

  // 首次解析失败时，用简化 prompt 重试一次 —— 和 callQuickAI 保持一致的重试策略
  if (!parsed.ok || !parsed.value) {
    const retryPrompt = systemPrompt + `\n\n【重要】只返回一个纯 JSON 对象，不要加任何解释、Markdown 或代码块。`;
    const retryUser = `当前页面：${String(page?.title || "")} ${String(page?.url || "")}\n\n待关联告警：\n${alerts.map((a) => `告警${a.index}：${a.title}\n${a.summary}\n${(a.text || "").slice(0, 8000)}`).join("\n\n---\n\n")}`;
    const retryResponse = await invokeQuickProvider(quick, retryPrompt, retryUser, 4096);
    parsed = parseQuickAnalysisPayload(retryResponse.text);
  }

  if (!parsed.ok || !parsed.value) {
    const preview = shortErrorText(parsed.raw || response.text || "");
    throw new Error(`模型返回内容不符合关联分析结构${preview ? `：${preview}` : ""}`);
  }
  const result = normalizeCorrelationAnalysisResult(normalizeAnalysisResult(parsed.value), parsed.value);
  result.analysis_mode = "correlation";
  result.evidence_scope = "detached_alerts";
  result.page_type = "关联分析";
  return result;
}

function compactCorrelationResult(result) {
  const steps = Array.isArray(result?.analysis_steps) ? result.analysis_steps.slice(0, 5) : [];
  const evidence = Array.isArray(result?.evidence) ? result.evidence.slice(0, 6) : [];
  return {
    device: result?.device || "",
    src_ip: result?.src_ip || "",
    dst_ip: result?.dst_ip || "",
    event_type: result?.event_type || "",
    verdict_labels: Array.isArray(result?.verdict_labels) ? result.verdict_labels : [],
    conclusion: result?.conclusion || "",
    confidence: result?.confidence ?? null,
    risk_level: result?.risk_level || "",
    summary: result?.summary || "",
    analysis_steps: steps,
    evidence
  };
}

const QUICK_PAGE_TYPES = ["安全告警详情", "漏洞情报", "资产页面", "攻击日志", "新闻文章", "普通页面", "无法确认"];

function inspectQuickRoute(rawText, page = {}) {
  const title = String(page?.title || "");
  const url = String(page?.url || "");
  const text = `${title}\n${url}\n${String(rawText || "").slice(0, 30000)}`;
  const lower = text.toLowerCase();

  const knownDevice = !!page?.detected_device;
  const parsedConcreteEvent = false;
  const hasSrc = /(源\s*ip|源ip|source\s*ip|src[_\s-]*ip|client[_\s-]*ip|remote[_\s-]*(addr|ip)|external[_\s-]*ip|攻击\s*ip|攻击ip|攻击源|攻击者\s*(ip|视角)?)/i.test(text);
  const hasDst = /(目的\s*ip|目的ip|目标\s*ip|target[_\s-]*ip|destination\s*ip|dst[_\s-]*ip|dest[_\s-]*ip|server[_\s-]*ip|victim[_\s-]*ip|受害\s*ip|受害ip|受害者\s*(ip|视角)?)/i.test(text);
  const hasTuple = hasSrc && hasDst;
  const hasEventDetail = /(告警中心|告警列表|告警时间|告警详情|事件概述|事件时间|发生时间|事件详情|事件来源|事件描述|攻击详情|详细信息|最近发生于|原始告警信息|检测规则|检测描述|处置状态|alert\s*detail|incident\s*detail|rule\s*id|规则\s*(id|编号|命中|详情)|告警名称|事件名称|原始告警列表|检测与关联证据|event[_\s-]*type|event[_\s-]*id|threat[_\s-]*name|risk[_\s-]*name|alert[_\s-]*(name|id)|alarm[_\s-]*(name|id))/i.test(text);
  const hasRawLog = /(request\s+headers?|response\s+headers?|http\/1\.[01]|http\/2|raw\s*log|原始日志|请求报文|响应报文|原始报文|日志详情|HTTP\s*请求与响应取证|status_code\s*=|severity\s*=|log_id\s*=|log_index\s*=|"(log_type|event_type|index|timestamp|@timestamp|id)"\s*:)/i.test(text);
  const hasPayload = /(payload\s*[:：]|攻击载荷|载荷\s*[:：]|请求体|request\s*body|body\s*[:：]|cmd\s*=|jndi:|<script|union\s+select|\.\.\/|\/bin\/sh|powershell|反序列化|命令执行|远程代码执行|恶意脚本|敏感文件|uid=\d+|exitCode\s*=\s*0|process_tree|file_event|wget\s+|curl\s+)/i.test(text);
  const hasRequestResponse = /(request|response|请求|响应|HTTP\s*请求|HTTP\s*响应|响应正文)/i.test(text) && /(status|状态码|header|body|报文|返回|200\s+OK|HTTP\s*200|命令回显|exitCode|uid=)/i.test(text);
  const hasSecurityProductContext = /(waf|rasp|ndr|edr|hids|siem|ips|ids|xdr|tdp|蜜罐|探针|防护|态势感知|安全告警|攻击告警|威胁告警|威胁检测|安全监测|安全运营|Web\s*攻击检测|Web访问|传感器|采集设备|设备来源|日志类型|产品类型|厂商)/i.test(text);
  const hasExploitSuccessEvidence = /(攻击成功|attack_result\s*=\s*success|命令回显|uid=\d+|exitCode\s*=\s*0|process_tree|file_event|WebShell|写入记录|漏洞利用成功)/i.test(text);
  const hasExploitFailureEvidence = /(攻击失败|attack_result\s*=\s*fail|请求被拒绝|已阻断|设备动作\s*[:：]?\s*阻断|HTTP\/1\.1\s+403|403\s+Forbidden|拦截|未成功|失败证据)/i.test(text);

  const vulnerabilityArticle = /(漏洞详情|漏洞公告|受影响版本|修复建议|安全公告|漏洞编号|cvss|poc|exp|在野利用|vulnerability\s*(detail|description|advisory)|cve-\d{4}-\d+)/i.test(text);
  const articleContext = /(新闻|博客|研究报告|技术文章|公众号|作者|发布时间|news|blog|article|research|readme|repository)/i.test(text);
  const assetContext = /(资产详情|资产清单|主机详情|域名详情|端口列表|服务指纹|asset\s*detail|asset\s*inventory)/i.test(text);
  const devPortal = /github\.com|gitlab\.com|gitee\.com/.test(lower) && !/(alert|incident|security-event|attack-log)/i.test(url);
  const strongNonAlert = devPortal || ((vulnerabilityArticle || articleContext || assetContext) && !hasEventDetail && !hasRawLog && !hasTuple);

  let score = 0;
  const signals = [];
  if (knownDevice) { score += 2; signals.push("已识别安全设备"); }
  if (parsedConcreteEvent) { score += 6; signals.push("页面已解析具体事件字段"); }
  if (hasTuple) { score += 2; signals.push("存在源/目的IP语义"); }
  if (hasEventDetail) { score += 2; signals.push("存在具体告警/事件详情字段"); }
  if (hasRawLog) { score += 2; signals.push("存在原始请求/响应/日志"); }
  if (hasPayload) { score += 1; signals.push("存在攻击载荷/请求体特征"); }
  if (hasRequestResponse) { score += 1; signals.push("存在请求/响应上下文"); }
  if (hasSecurityProductContext) { score += 1; signals.push("存在安全设备/告警上下文"); }
  if (hasExploitSuccessEvidence) { score += 2; signals.push("存在攻击成功结果证据"); }
  if (hasExploitFailureEvidence) { score += 2; signals.push("存在攻击失败/阻断结果证据"); }
  const weakStandaloneContext = !hasEventDetail && !hasRawLog && !hasTuple && !hasRequestResponse;
  if (weakStandaloneContext && vulnerabilityArticle) score -= 2;
  if (weakStandaloneContext && articleContext) score -= 2;
  if (weakStandaloneContext && assetContext) score -= 2;
  if (devPortal) score -= 4;

  const eventSignalCount = [hasTuple, hasEventDetail, hasRawLog, hasPayload, hasRequestResponse, hasExploitSuccessEvidence, hasExploitFailureEvidence].filter(Boolean).length;
  const direct = parsedConcreteEvent || (score >= 6 && eventSignalCount >= 2 && !strongNonAlert);
  const suggested = hasRawLog && !hasEventDetail ? "攻击日志" : "安全告警详情";
  const confidence = parsedConcreteEvent ? 96 : Math.max(78, Math.min(94, 74 + Math.max(0, score) * 3));
  const reason = direct
    ? `本地路由检测到高置信具体事件上下文（${signals.join("、") || "告警特征"}），跳过页面分类以降低等待时间。`
    : `当前页面告警上下文强度不足以直接研判（路由评分 ${score}），先执行轻量页面分类。`;

  return {
    score,
    signals,
    event_signal_count: eventSignalCount,
    direct_stage2: direct,
    strong_non_alert: strongNonAlert,
    suggested_page_type: suggested,
    confidence,
    reason
  };
}

async function classifyQuickPageMini(quick, rawText, page = {}) {
  const sample = buildMiniSceneClassificationText(rawText);

  const systemPrompt = `你是浏览器安全助手的轻量页面场景分类器。只判断页面类型，不分析攻击成功/失败。
可选标签只有：安全告警详情、漏洞情报、资产页面、攻击日志、新闻文章、普通页面、无法确认。
只有页面呈现某一次具体告警/事件/会话/原始日志时，才能选安全告警详情或攻击日志。漏洞说明、CVE、PoC、EXP、攻击案例文章不等于真实告警。
只输出一行：标签|置信度。置信度为0-100整数。例如：漏洞情报|96。不要解释。`;

  const userPrompt = `页面标题：${String(page?.title || "未知")}
页面URL：${String(page?.url || "未知")}
URL本地识别设备：${String(page?.detected_device || "未识别")}

页面文本抽样：
${sample}`;

  const response = await invokeQuickProvider(quick, systemPrompt, userPrompt, 48);
  const parsed = parseMiniSceneClassification(response.text);
  if (!parsed.page_type) {
    return {
      page_type: "无法确认",
      confidence: 0,
      reason: "轻量页面分类返回格式无法可靠解析，未强制本地判定页面类型。",
      scene_source: "ai_unparsed",
      actionable: false,
      context_uncertain: true
    };
  }
  return {
    page_type: parsed.page_type,
    confidence: parsed.confidence,
    reason: buildSceneReason(parsed.page_type, "ai"),
    scene_source: "ai",
    actionable: parsed.page_type === "安全告警详情" || parsed.page_type === "攻击日志",
    context_uncertain: parsed.page_type === "无法确认"
  };
}

function parseMiniSceneClassification(content) {
  let raw = String(content || "").trim();
  if (!raw) return { page_type: "", confidence: 0 };
  raw = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json|javascript|text)?/gi, "")
    .replace(/```/g, "")
    .trim();

  // 兼容模型返回 JSON / wrapper。
  const json = parseQuickAnalysisPayload(raw);
  if (json.ok && json.value && typeof json.value === "object") {
    const type = findPageTypeInObject(json.value);
    const confidence = findSceneConfidenceInObject(json.value);
    if (type) return { page_type: type, confidence: confidence ?? 82 };
  }

  let type = "";
  for (const candidate of QUICK_PAGE_TYPES) {
    if (raw.includes(candidate)) { type = candidate; break; }
  }
  if (!type && raw.length <= 260) type = normalizeQuickPageType(raw, false);
  if (!type) return { page_type: "", confidence: 0 };

  const m = raw.match(/(?:^|[|｜:\s])([0-9]{1,3})(?:\s*%|\b)/);
  const confidence = m ? Math.max(0, Math.min(100, Number(m[1]))) : 82;
  return { page_type: type, confidence };
}

function findPageTypeInObject(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 3) return "";
  const keys = ["page_type", "pageType", "scene_type", "sceneType", "category", "type", "页面类型", "场景类型", "页面场景"];
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) {
      const raw = String(value[key]).trim();
      if (!raw) continue;
      if (QUICK_PAGE_TYPES.includes(raw)) return raw;
      const mapped = normalizeQuickPageType(raw, false);
      if (mapped) return mapped;
    }
  }
  for (const key of ["result", "data", "output", "classification", "scene", "page"]) {
    const nested = value[key];
    if (nested && typeof nested === "object") {
      const found = findPageTypeInObject(nested, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

function findSceneConfidenceInObject(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 3) return null;
  for (const key of ["confidence", "score", "probability", "置信度"]) {
    if (value[key] !== undefined && value[key] !== null) {
      let n = Number(String(value[key]).replace("%", ""));
      if (Number.isFinite(n)) {
        if (n > 0 && n <= 1) n *= 100;
        return Math.max(0, Math.min(100, Math.round(n)));
      }
    }
  }
  for (const key of ["result", "data", "output", "classification", "scene", "page"]) {
    const nested = value[key];
    if (nested && typeof nested === "object") {
      const found = findSceneConfidenceInObject(nested, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function normalizeQuickPageType(value, fallbackToNormal = true) {
  const raw = String(value || "").trim();
  if (QUICK_PAGE_TYPES.includes(raw)) return raw;
  if (/无法确认|uncertain|unknown|unsure/i.test(raw)) return "无法确认";
  if (/告警|事件详情|alert/i.test(raw)) return "安全告警详情";
  if (/漏洞|cve|vulnerability|情报/i.test(raw)) return "漏洞情报";
  if (/资产|asset|主机|域名|端口/i.test(raw)) return "资产页面";
  if (/攻击日志|原始日志|日志|request|traffic/i.test(raw)) return "攻击日志";
  if (/新闻|文章|博客|研究|news|article/i.test(raw)) return "新闻文章";
  if (/普通|normal|general|other/i.test(raw)) return "普通页面";
  return fallbackToNormal ? "普通页面" : "";
}

function buildMiniSceneClassificationText(rawText) {
  const text = String(rawText || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return "（当前页面无可见文本）";
  const lines = text.split("\n").map((x) => x.trim()).filter(Boolean);
  const head = lines.slice(0, 55);
  const keywords = /(告警|事件|源\s*ip|目的\s*ip|payload|request|response|原始日志|漏洞|cve-|修复建议|受影响版本|资产|新闻|博客|article|alert|incident)/i;
  const relevant = [];
  for (let i = 55; i < lines.length && relevant.length < 45; i++) {
    if (keywords.test(lines[i])) relevant.push(lines[i]);
  }
  return [...head, ...(relevant.length ? ["...关键片段...", ...relevant] : [])].join("\n").slice(0, 4800);
}

function buildSceneReason(pageType, source) {
  const prefix = source === "cache" ? "复用页面分类缓存；" : "轻量页面分类完成；";
  const detail = {
    "安全告警详情": "识别到具体告警/事件上下文，将继续攻击研判。",
    "攻击日志": "识别到具体日志/请求/连接记录，将继续攻击研判。",
    "漏洞情报": "当前属于漏洞知识或情报页面，不代表发生了具体攻击事件。",
    "资产页面": "当前属于资产管理/详情页面，不进入攻击成功或失败研判。",
    "新闻文章": "当前属于文章或资讯内容，不进入攻击成功或失败研判。",
    "普通页面": "当前未识别到具体安全告警或攻击日志上下文。",
    "无法确认": "当前页面场景无法可靠确认，不强制产生非告警或攻击结论。"
  }[pageType] || "当前页面场景无法确认。";
  return `${prefix}${detail}`;
}

function buildNonAlertQuickResult(scene) {
  const type = scene.page_type || "普通页面";
  const reason = scene.reason || `当前页面识别为${type}，不属于具体安全告警或攻击日志。`;
  return {
    page_type: type,
    scene_confidence: scene.confidence,
    scene_reason: reason,
    scene_source: scene.scene_source || "ai",
    device: "",
    src_ip: "",
    dst_ip: "",
    event_type: "",
    verdict_labels: ["非告警事件"],
    attack_intent: "",
    attack_outcome: "",
    conclusion: "非告警事件",
    confidence: scene.confidence,
    risk_level: "未知",
    summary: `当前页面识别为“${type}”，不属于针对具体会话/资产的安全告警或攻击日志，因此跳过攻击成功/失败研判。`,
    analysis_steps: [
      { title: "页面场景识别", status: type, detail: reason }
    ],
    evidence: [reason],
    stage: "scene_classification",
    stage_route: scene.route_mode || "stage1_end",
    stage_route_label: scene.route_label || "轻量分类 · 页面分类结束"
  };
}

function buildUncertainQuickResult(scene, route) {
  const reason = scene?.reason || "当前页面上下文不足以可靠确认是否属于具体安全告警。";
  return {
    page_type: scene?.page_type || "无法确认",
    scene_confidence: Number(scene?.confidence || 0),
    scene_reason: reason,
    scene_source: scene?.scene_source || "uncertain",
    device: "",
    src_ip: "",
    dst_ip: "",
    event_type: "",
    verdict_labels: ["无法确认"],
    attack_intent: "",
    attack_outcome: "无法确认",
    conclusion: "无法确认",
    confidence: Number(scene?.confidence || 0),
    risk_level: "未知",
    summary: "当前页面既没有足够强的具体告警/攻击日志特征，页面分类置信度也不足。为避免把漏洞文章、资产页或普通页面误判为真实攻击，本次不继续执行攻击成功/失败判断。",
    analysis_steps: [
      { title: "页面上下文", status: "无法确认", detail: reason },
      { title: "本地路由", status: `评分 ${route?.score ?? 0}`, detail: "本地 Router 仅用于决定是否跳过页面分类，不直接产生攻击结论。" }
    ],
    evidence: [],
    stage: "scene_uncertain",
    stage_route: "stage1_uncertain_end",
    stage_route_label: "轻量分类 · 上下文无法确认",
    router_score: route?.score ?? 0
  };
}

function fastSceneHash(input) {
  const text = String(input || "");
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function quickSceneCacheKey(rawText, page = {}, quick = {}) {
  const url = String(page?.url || "").split("#")[0];
  const title = String(page?.title || "");
  const device = String(page?.detected_device || "");
  const text = String(rawText || "");
  const provider = `${quick?.protocol || ""}|${quick?.model || ""}`;
  const material = `${provider}\n${url}\n${title}\n${device}\n${text.slice(0, 60000)}\n${text.slice(-6000)}`;
  return `scene:${fastSceneHash(material)}`;
}

async function getQuickSceneCache(key) {
  const now = Date.now();
  const local = QUICK_SCENE_CACHE.get(key);
  if (local && local.expires_at > now) return { ...local.scene };
  if (local) QUICK_SCENE_CACHE.delete(key);

  try {
    if (!chrome.storage?.session) return null;
    const obj = await chrome.storage.session.get(QUICK_SCENE_SESSION_KEY);
    const cache = obj?.[QUICK_SCENE_SESSION_KEY] || {};
    const item = cache[key];
    if (!item || item.expires_at <= now) return null;
    QUICK_SCENE_CACHE.set(key, item);
    return { ...item.scene };
  } catch (_) {
    return null;
  }
}

async function setQuickSceneCache(key, scene) {
  const item = {
    expires_at: Date.now() + QUICK_SCENE_CACHE_TTL_MS,
    scene: {
      page_type: scene.page_type,
      confidence: scene.confidence,
      reason: scene.reason,
      actionable: !!scene.actionable,
      context_uncertain: !!scene.context_uncertain,
      scene_source: "ai"
    }
  };
  QUICK_SCENE_CACHE.set(key, item);
  while (QUICK_SCENE_CACHE.size > QUICK_SCENE_CACHE_LIMIT) {
    const first = QUICK_SCENE_CACHE.keys().next().value;
    QUICK_SCENE_CACHE.delete(first);
  }
  try {
    if (!chrome.storage?.session) return;
    const obj = await chrome.storage.session.get(QUICK_SCENE_SESSION_KEY);
    const cache = obj?.[QUICK_SCENE_SESSION_KEY] || {};
    cache[key] = item;
    const entries = Object.entries(cache)
      .filter(([, v]) => v?.expires_at > Date.now())
      .sort((a, b) => (b[1]?.expires_at || 0) - (a[1]?.expires_at || 0))
      .slice(0, QUICK_SCENE_CACHE_LIMIT);
    await chrome.storage.session.set({ [QUICK_SCENE_SESSION_KEY]: Object.fromEntries(entries) });
  } catch (_) {}
}

function buildQuickEvidenceText(rawText) {
  const text = String(rawText || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return "（当前页面无可见文本）";
  const MAX = 22000;
  if (text.length <= MAX) return text;

  // 超长页面不直接截断开头：优先保留告警字段、IP、URL、Payload、漏洞/攻击相关行及上下文。
  const lines = text.split("\n");
  const keywords = /(告警|攻击|事件|风险|威胁|源 ?ip|目的 ?ip|源地址|目的地址|src|dst|source|destination|payload|请求|request|uri|url|漏洞|cve-|sql|xss|rce|命令执行|webshell|扫描|探测|恶意|拦截|命中|severity|alert|attack|exploit|malware|shell)/i;
  const ipv4 = /(?:^|[^\d])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?:[^\d]|$)/;
  const keep = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (keywords.test(lines[i]) || ipv4.test(lines[i])) {
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j);
    }
  }
  // 保留少量页面头部上下文，便于识别产品/设备名称。
  for (let i = 0; i < Math.min(lines.length, 35); i++) keep.add(i);
  const selected = [...keep].sort((a, z) => a - z).map((i) => lines[i]).join("\n").trim();
  if (!selected) return `${text.slice(0, Math.floor(MAX / 2))}\n...（中间内容省略）...\n${text.slice(-Math.floor(MAX / 2))}`;
  if (selected.length <= MAX) return selected;
  return `${selected.slice(0, Math.floor(MAX * 0.72))}\n...（相关页面文本过长，已压缩）...\n${selected.slice(-Math.floor(MAX * 0.28))}`;
}


async function testQuickAIConnection(config) {
  const quick = normalizeQuickProvider(config);
  if (!quick.baseUrl || !quick.model) throw new Error("测试前请填写 API 地址和模型");

  const authMode = authCandidates(quick, quick.protocol)[0];
  if (quick.protocol === "anthropic") {
    const endpoint = anthropicMessageEndpointCandidates(quick)[0];
    if (!endpoint) throw new Error("无法生成 Anthropic Messages 测试端点");
    const body = {
      model: quick.model,
      max_tokens: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }]
    };
    const data = await fetchJsonWithTimeout(endpoint, {
      method: "POST",
      headers: providerHeaders(quick, authMode, "anthropic"),
      body: JSON.stringify(body),
      cache: "no-store"
    }, 5500, "Anthropic 快速连接测试");
    QUICK_AI_LAST_ROUTE = { url: endpoint, authMode, wire: "anthropic_messages", label: "快速连接测试", purpose: "test" };
    return { summary: "Anthropic Messages 端点连接正常", response_type: data?.type || "message" };
  }

  const route = openAIRequestCandidates(quick)[0];
  if (!route?.url) throw new Error("无法生成 OpenAI 兼容测试端点");
  const body = route.wire === "responses"
    ? { model: quick.model, input: "ping", max_output_tokens: 1 }
    : { model: quick.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 };
  const data = await fetchJsonWithTimeout(route.url, {
    method: "POST",
    headers: providerHeaders(quick, authMode, "openai"),
    body: JSON.stringify(body),
    cache: "no-store"
  }, 5500, "OpenAI 快速连接测试");
  QUICK_AI_LAST_ROUTE = { url: route.url, authMode, wire: route.wire, label: "快速连接测试", purpose: "test" };
  return { summary: "OpenAI 兼容端点连接正常", response_type: data?.object || "response" };
}

async function fetchJsonWithTimeout(url, init, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs || 5000)));
  try {
    const resp = await fetch(url, { ...(init || {}), signal: controller.signal });
    return await parseFetchResponse(resp, label || "请求", url);
  } catch (e) {
    if (e?.name === "AbortError") {
      const err = new Error(`连接测试超时（>${Math.ceil((timeoutMs || 5000) / 1000)}s）`);
      err.kind = "network";
      err.url = url;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function listQuickAIModels(config) {
  const quick = normalizeQuickProvider(config);
  if (!quick.baseUrl || !quick.apiKey) throw new Error("获取模型前请填写 API 地址");

  // 参考 CC Switch 的做法：模型发现只是辅助能力，不作为 Provider 可用性的前置条件。
  // 第三方 Anthropic 兼容网关经常只实现 Messages 而没有 /models，因此发现失败应允许手工填写模型。
  try {
    const result = quick.protocol === "anthropic"
      ? await discoverAnthropicModels(quick)
      : await discoverOpenAIModels(quick);
    return { models: normalizeModelList(result.data), discovery: result.meta || null, warning: "" };
  } catch (e) {
    if (isModelDiscoveryOptionalError(e)) {
      return {
        models: [],
        discovery: null,
        warning: `当前 Provider 未提供可用的模型列表接口（${friendlyProviderError(e)}）。可直接手工填写模型 ID，这不影响“测试 AI”和快速研判。`
      };
    }
    throw e;
  }
}

function normalizeQuickProvider(config) {
  return {
    enabled: config?.enabled !== false,
    protocol: normalizeAIProtocol(config?.protocol),
    baseUrl: normalizeBaseUrl(config?.baseUrl || ""),
    apiKey: String(config?.apiKey || "").trim(),
    model: String(config?.model || "").trim(),
    sendRawText: config?.sendRawText !== false,
    authMode: normalizeAuthMode(config?.authMode),
    endpointMode: normalizeEndpointMode(config?.endpointMode),
    openaiWire: normalizeOpenAIWire(config?.openaiWire),
    customHeaders: String(config?.customHeaders || "").trim()
  };
}

async function discoverAnthropicModels(quick) {
  const endpoints = anthropicModelEndpointCandidates(quick);
  if (!endpoints.length) {
    const e = new Error("完整 URL 模式下无法可靠推导模型列表接口");
    e.kind = "model_discovery_unsupported";
    throw e;
  }
  return discoverModelsFast(quick, "anthropic", endpoints);
}

async function discoverOpenAIModels(quick) {
  const endpoints = openAIModelEndpointCandidates(quick);
  if (!endpoints.length) {
    const e = new Error("完整 URL 模式下无法可靠推导模型列表接口");
    e.kind = "model_discovery_unsupported";
    throw e;
  }
  return discoverModelsFast(quick, "openai", endpoints);
}

async function discoverModelsFast(quick, protocol, endpoints) {
  const authMode = authCandidates(quick, protocol)[0];
  const label = protocol === "anthropic" ? "Anthropic 模型发现" : "OpenAI 模型发现";
  const unique = [...new Set(endpoints.map(normalizeBaseUrl).filter(Boolean))];
  const attempts = unique.map(async (url) => {
    try {
      const data = await fetchJsonWithTimeout(url, {
        method: "GET",
        headers: providerHeaders(quick, authMode, protocol),
        cache: "no-store"
      }, 3200, label);
      const models = normalizeModelList(data);
      if (!models.length) {
        const e = new Error("接口响应正常，但未发现模型列表");
        e.kind = "compat";
        e.url = url;
        throw e;
      }
      return { data, meta: { url, authMode, wire: "models", label, purpose: "models" } };
    } catch (e) {
      e.url = e.url || url;
      throw e;
    }
  });

  try {
    const result = await Promise.any(attempts);
    QUICK_AI_LAST_ROUTE = result.meta;
    return result;
  } catch (aggregate) {
    const errors = Array.isArray(aggregate?.errors) ? aggregate.errors : [];
    const last = errors[errors.length - 1] || aggregate;
    const err = enhanceProviderError(last);
    err.attemptedUrls = unique;
    throw err;
  }
}

async function requestAnthropicCompatible(quickInput, purpose, body) {
  const quick = normalizeQuickProvider(quickInput);
  if (purpose === "models") return (await discoverAnthropicModels(quick)).data;
  const endpoints = anthropicMessageEndpointCandidates(quick);
  const routes = expandAuthRoutes(endpoints.map((url) => ({ url, wire: "anthropic_messages" })), authCandidates(quick, "anthropic"));
  const result = await requestJsonAcrossRoutes({
    label: "Anthropic Messages",
    cacheKey: `anthropic|${quick.baseUrl}|messages|${quick.authMode}|${quick.endpointMode}`,
    routes,
    initForRoute: (route) => ({
      method: "POST",
      headers: providerHeaders(quick, route.authMode, "anthropic"),
      body: JSON.stringify(body)
    }),
    purpose: "inference",
    timeoutMs: 600000
  });
  if (!result.data || !Array.isArray(result.data.content)) {
    const e = new Error("上游响应不符合 Anthropic Messages 响应结构：缺少 content[]");
    e.kind = "compat";
    e.url = result.meta?.url || quick.baseUrl;
    throw e;
  }
  return result.data;
}

async function requestOpenAICompatible(quickInput, systemPrompt, userPrompt, maxTokens = 4096) {
  const quick = normalizeQuickProvider(quickInput);
  const routes = expandAuthRoutes(openAIRequestCandidates(quick), authCandidates(quick, "openai"));
  const result = await requestJsonAcrossRoutes({
    label: "OpenAI 兼容",
    cacheKey: `openai|${quick.baseUrl}|request|${quick.authMode}|${quick.endpointMode}|${quick.openaiWire}`,
    routes,
    timeoutMs: 600000,
    initForRoute: (route) => {
      const body = route.wire === "responses"
        ? {
            model: quick.model,
            instructions: systemPrompt,
            input: userPrompt,
            max_output_tokens: maxTokens
          }
        : {
            model: quick.model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ],
            max_tokens: maxTokens
          };
      return {
        method: "POST",
        headers: providerHeaders(quick, route.authMode, "openai"),
        body: JSON.stringify(body)
      };
    },
    purpose: "inference"
  });
  return result.data;
}

async function requestOpenAIModels(quickInput) {
  const quick = normalizeQuickProvider(quickInput);
  return (await discoverOpenAIModels(quick)).data;
}

async function requestJsonAcrossRoutes({ label, cacheKey, routes, initForRoute, purpose, timeoutMs = 0 }) {
  const ordered = orderCachedRoutes(cacheKey, routes);
  const attempts = [];
  let lastError = null;
  const blockedUrls = new Set();

  for (const route of ordered) {
    if (blockedUrls.has(route.url)) continue;
    const fetchController = timeoutMs > 0 ? new AbortController() : null;
    const fetchTimer = fetchController ? setTimeout(() => fetchController.abort(), timeoutMs) : null;
    try {
      const fetchInit = { ...initForRoute(route), cache: "no-store" };
      if (fetchController) fetchInit.signal = fetchController.signal;
      const resp = await fetch(route.url, fetchInit);
      const data = await parseFetchResponse(resp, label, route.url);
      while (QUICK_AI_ROUTE_CACHE.size >= QUICK_AI_ROUTE_CACHE_LIMIT) {
        const first = QUICK_AI_ROUTE_CACHE.keys().next().value;
        QUICK_AI_ROUTE_CACHE.delete(first);
      }
      QUICK_AI_ROUTE_CACHE.set(cacheKey, route);
      QUICK_AI_LAST_ROUTE = { url: route.url, authMode: route.authMode, wire: route.wire, label, purpose };
      return { data, meta: QUICK_AI_LAST_ROUTE };
    } catch (e) {
      if (fetchController && e?.name === "AbortError") {
        e.kind = "network";
        e.message = `AI 推理超时（>${Math.round(timeoutMs / 1000)}s）：${route.url}`;
      }
      e.url = e.url || route.url;
      e.authMode = route.authMode;
      e.wire = route.wire;
      lastError = e;
      attempts.push({ url: route.url, authMode: route.authMode, wire: route.wire, status: e.status, kind: e.kind, message: e.message });

      // 余额、限流、模型不存在等业务错误说明“端点已经通了”，继续猜路径/鉴权只会掩盖真实问题。
      if (isProviderBusinessError(e)) throw enhanceProviderError(e);
      // 5xx/网络错误不是协议探测问题，避免无意义地轰炸同一上游。
      if (e.kind === "network" || (Number(e.status) >= 500 && Number(e.status) <= 599)) throw enhanceProviderError(e);
      // 鉴权方式与端点均为显式协议配置；规范模式不通过轮询 Header 猜测认证。
      if (e.kind === "endpoint" || e.kind === "compat") blockedUrls.add(route.url);
      if (!isCompatibilityRetryable(e, purpose)) throw enhanceProviderError(e);
    } finally {
      if (fetchTimer) clearTimeout(fetchTimer);
    }
  }

  const err = compatibilityError(label, attempts);
  if (lastError?.kind === "model_discovery_unsupported") err.kind = lastError.kind;
  throw err;
}

function expandAuthRoutes(routes, authModes) {
  const out = [];
  for (const route of routes) for (const authMode of authModes) out.push({ ...route, authMode });
  return dedupeProviderRoutes(out);
}

function authCandidates(quick, protocol) {
  const selected = normalizeAuthMode(quick.authMode);
  if (selected !== "protocol") return [selected];
  // 严格按协议默认认证，不再自动轮询多个 Header：
  // Anthropic Messages -> x-api-key；OpenAI -> Authorization: Bearer。
  return [protocol === "anthropic" ? "x-api-key" : "bearer"];
}

function providerHeaders(quick, authMode, protocol) {
  const headers = { "Content-Type": "application/json", "Accept": "application/json" };
  const effectiveAuth = authMode === "protocol"
    ? (protocol === "anthropic" ? "x-api-key" : "bearer")
    : authMode;

  if (protocol === "anthropic") {
    // Anthropic Messages API 规范要求的版本头。兼容 Provider 可忽略，但客户端仍应发送。
    headers["anthropic-version"] = "2023-06-01";
  }

  const key = String(quick.apiKey || "").trim();
  if (key) {
    if (effectiveAuth === "x-api-key") headers["x-api-key"] = key;
    else if (effectiveAuth === "api-key") headers["api-key"] = key;
    else headers.Authorization = `Bearer ${key}`;
  }

  // 合并用户自定义请求头，用于私有化部署或自定义网关
  parseCustomHeaders(quick.customHeaders).forEach(([key, value]) => {
    if (key && value && !headers[key]) headers[key] = value;
  });
  return headers;
}

function parseCustomHeaders(raw) {
  const pairs = [];
  const text = String(raw || "").trim();
  if (!text) return pairs;
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) pairs.push([key, value]);
  }
  return pairs;
}

function normalizeModelList(items) {
  let list = items;
  if (!Array.isArray(list) && list && typeof list === "object") {
    list = list.data || list.models || list.items || list.result || list.results || list?.data?.models || [];
  }
  return [...new Set((Array.isArray(list) ? list : []).map((x) => {
    if (typeof x === "string") return x;
    return x?.id || x?.name || x?.model || x?.slug || x?.model_id || "";
  }).filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
}

function normalizeAIProtocol(value) {
  const v = String(value || "openai").toLowerCase();
  if (v === "anthropic" || v === "claude" || v === "anthropic-compatible") return "anthropic";
  return "openai";
}

function normalizeAuthMode(value) {
  const v = String(value || "protocol").toLowerCase();
  // 旧配置中的 auto 迁移为“协议默认”，不再通过轮询 Header 猜认证方式。
  if (v === "auto" || v === "default" || v === "protocol-default") return "protocol";
  return ["protocol", "x-api-key", "bearer", "api-key"].includes(v) ? v : "protocol";
}

function normalizeEndpointMode(value) {
  return String(value || "base").toLowerCase() === "full" ? "full" : "base";
}

function normalizeOpenAIWire(value) {
  const v = String(value || "chat").toLowerCase();
  // 旧配置中的 auto 迁移到最通用的 Chat Completions；如使用 Responses 请显式选择。
  if (v === "auto") return "chat";
  return ["chat", "responses"].includes(v) ? v : "chat";
}

function anthropicMessageEndpointCandidates(quickInput) {
  const quick = typeof quickInput === "string" ? normalizeQuickProvider({ protocol: "anthropic", baseUrl: quickInput }) : quickInput;
  const base = normalizeBaseUrl(quick.baseUrl);
  if (!base) return [];
  if (quick.endpointMode === "full") return [base];
  if (/\/v1\/messages$/i.test(base)) return [base];
  if (/\/v1$/i.test(base)) return [`${base}/messages`];
  // ANTHROPIC_BASE_URL 语义：SDK 会在 Base URL 后请求 /v1/messages。
  return [`${base}/v1/messages`];
}

function anthropicModelEndpointCandidates(quickInput) {
  const quick = typeof quickInput === "string" ? normalizeQuickProvider({ protocol: "anthropic", baseUrl: quickInput }) : quickInput;
  const base = normalizeBaseUrl(quick.baseUrl);
  if (!base) return [];
  if (quick.endpointMode === "full") {
    if (/\/v1\/messages$/i.test(base)) return [base.replace(/\/messages$/i, "/models")];
    return [];
  }

  // 部分双协议网关会把 Anthropic 推理挂在 /anthropic/v1/messages，
  // 但模型列表仍放在同域服务根 /v1/models，例如：
  //   https://api.xiaomimimo.com/anthropic -> https://api.xiaomimimo.com/v1/models
  // 这里只从用户填写的 URL 同域推导服务根，不根据模型名或 Provider 名改写域名。
  if (/\/v1\/models$/i.test(base)) return [base];
  if (/\/v1\/messages$/i.test(base)) return [base.replace(/\/messages$/i, "/models")];
  if (/\/v1$/i.test(base)) return [`${base}/models`];
  const root = deriveSameOriginAnthropicRoot(base);
  return dedupeUrls([`${root}/v1/models`, `${root}/models`, `${base}/v1/models`, `${base}/models`]);
}

function deriveSameOriginAnthropicRoot(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return "";
  try {
    const u = new URL(base);
    const path = String(u.pathname || "")
      .replace(/\/+$/g, "")
      .replace(/\/anthropic(?:\/v1(?:\/messages)?)?$/i, "");
    u.pathname = path || "/";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/g, "");
  } catch (_) {
    return base
      .replace(/\/+$/g, "")
      .replace(/\/anthropic(?:\/v1(?:\/messages)?)?$/i, "");
  }
}

function dedupeUrls(urls) {
  const seen = new Set();
  return (urls || []).map(normalizeBaseUrl).filter((url) => {
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function openAIRequestCandidates(quickInput) {
  const quick = typeof quickInput === "string" ? normalizeQuickProvider({ protocol: "openai", baseUrl: quickInput }) : quickInput;
  const base = normalizeBaseUrl(quick.baseUrl);
  if (!base) return [];
  if (quick.endpointMode === "full") {
    const wire = quick.openaiWire === "responses" || /\/responses$/i.test(base) ? "responses" : "chat";
    return [{ url: base, wire }];
  }
  if (/\/chat\/completions$/i.test(base)) return [{ url: base, wire: "chat" }];
  if (/\/responses$/i.test(base)) return [{ url: base, wire: "responses" }];
  const wire = quick.openaiWire === "responses" ? "responses" : "chat";
  const resourcePath = wire === "responses" ? "responses" : "chat/completions";
  const urls = /\/v1$/i.test(base)
    ? [`${base}/${resourcePath}`]
    : [`${base}/${resourcePath}`, `${base}/v1/${resourcePath}`];
  return dedupeUrls(urls).map((url) => ({ url, wire }));
}

function openAIModelEndpointCandidates(quickInput) {
  const quick = typeof quickInput === "string" ? normalizeQuickProvider({ protocol: "openai", baseUrl: quickInput }) : quickInput;
  const base = normalizeBaseUrl(quick.baseUrl);
  if (!base) return [];
  if (/\/models$/i.test(base)) return [base];
  if (quick.endpointMode === "full") {
    if (/\/chat\/completions$/i.test(base)) return [base.replace(/\/chat\/completions$/i, "/models")];
    if (/\/responses$/i.test(base)) return [base.replace(/\/responses$/i, "/models")];
    return [];
  }
  // OpenAI 官方模型列表为 GET /v1/models。兼容 Provider 若把 Base URL 写到 /v1，
  // 走 {base}/models；若只写服务根，则同时尝试 {base}/models 和 {base}/v1/models。
  return /\/v1$/i.test(base) ? [`${base}/models`] : dedupeUrls([`${base}/models`, `${base}/v1/models`]);
}

async function parseFetchResponse(resp, label, url) {
  const text = await resp.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { detail: text }; }
  if (!resp.ok) {
    const raw = data?.error?.message || data?.error?.type || data?.error?.code || data?.detail || data?.message || `${label} HTTP ${resp.status}`;
    const msg = shortErrorText(raw);
    const error = new Error(msg);
    error.status = resp.status;
    error.url = url;
    error.data = data;
    error.kind = classifyProviderError(resp.status, msg, data);
    throw error;
  }
  return data;
}

function classifyProviderError(status, message, data) {
  const s = Number(status || 0);
  const text = `${message || ""} ${JSON.stringify(data || {})}`.toLowerCase();
  if (/insufficient.*balance|balance.*insufficient|余额不足|insufficient.*quota|quota.*exceed|credit.*insufficient|payment required/.test(text) || s === 402) return "quota";
  if (/rate.?limit|too many requests|限流|频率|tpm|rpm/.test(text) || s === 429) return "rate_limit";
  if (/model.*not found|unknown model|invalid model|模型.*不存在|模型.*无效|unsupported model/.test(text)) return "model";
  if (/invalid.*api.?key|missing.*api.?key|unauthori[sz]ed|forbidden|authentication|鉴权|认证|api key.*invalid/.test(text) || s === 401 || s === 403) return "auth";
  if (/not found|unknown endpoint|unsupported endpoint|method not allowed|no route|route not found|404/.test(text) || s === 404 || s === 405) return "endpoint";
  if (/unsupported media|content.?type|schema|invalid request|validation|unprocessable|messages.*required|input.*required/.test(text) || [400, 415, 422].includes(s)) return "compat";
  if (s >= 500) return "provider";
  return "unknown";
}

function isProviderBusinessError(error) {
  return ["quota", "rate_limit", "model"].includes(error?.kind);
}

function isCompatibilityRetryable(error, purpose) {
  const kind = error?.kind;
  if (kind === "auth" || kind === "endpoint" || kind === "compat") return true;
  if (purpose === "models" && [404, 405].includes(Number(error?.status))) return true;
  return false;
}

function isModelDiscoveryOptionalError(error) {
  return error?.kind === "model_discovery_unsupported" || ["endpoint", "auth", "compat", "unknown"].includes(error?.kind) || [400, 401, 403, 404, 405, 415, 422].includes(Number(error?.status));
}

function enhanceProviderError(error) {
  const msg = shortErrorText(error?.message || "请求失败");
  let text = msg;
  if (error?.kind === "quota") text = `接口已连通，但上游账户余额/额度不足：${msg}`;
  else if (error?.kind === "rate_limit") text = `接口已连通，但触发上游限流：${msg}`;
  else if (error?.kind === "model") text = `接口已连通，但当前模型不可用：${msg}`;
  else if (error?.kind === "auth") text = `上游鉴权失败：${msg}`;
  else if (error?.kind === "endpoint") text = `未找到兼容接口端点：${msg}`;
  const out = new Error(`${text}${error?.url ? ` · ${error.url}` : ""}`);
  out.status = error?.status;
  out.kind = error?.kind;
  out.data = error?.data;
  out.url = error?.url;
  return out;
}

function friendlyProviderError(error) {
  return shortErrorText(enhanceProviderError(error).message);
}

function compatibilityError(label, attempts) {
  const last = attempts[attempts.length - 1] || {};
  const tried = [...new Set(attempts.map((x) => x.url).filter(Boolean))];
  const details = last.message ? shortErrorText(last.message) : "未找到兼容接口";
  const error = new Error(`${label} 未探测到可用组合：${details}${tried.length ? `（已尝试 ${tried.length} 个端点）` : ""}`);
  error.status = last.status;
  error.kind = last.kind || "unknown";
  return error;
}

function orderCachedRoutes(cacheKey, routes) {
  const cached = QUICK_AI_ROUTE_CACHE.get(cacheKey);
  if (!cached) return routes;
  const keyOf = (r) => `${r.url}|${r.authMode || ""}|${r.wire || ""}`;
  return [cached, ...routes.filter((r) => keyOf(r) !== keyOf(cached))];
}

function shortErrorText(value) {
  const text = String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 320) || "请求失败";
}

function dedupeProviderRoutes(routes) {
  const seen = new Set();
  return routes.filter((r) => {
    const key = `${normalizeBaseUrl(r.url)}|${r.authMode || ""}|${r.wire || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((r) => ({ ...r, url: normalizeBaseUrl(r.url) }));
}

function uniqUrls(values) {
  return [...new Set(values.filter(Boolean).map((x) => normalizeBaseUrl(x)))];
}

function dedupeRoutes(routes) { return dedupeProviderRoutes(routes); }

async function readJsonResponse(resp, label) {
  return parseFetchResponse(resp, label, resp.url || "");
}

function extractProviderText(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (typeof data?.output_text === "string") return data.output_text;
  const choice = data?.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice;
  if (Array.isArray(choice)) return choice.map((x) => typeof x === "string" ? x : (x?.text || x?.content || "")).filter(Boolean).join("\n");
  const anthropic = Array.isArray(data?.content) ? data.content.map((x) => typeof x === "string" ? x : (x?.text || "")).filter(Boolean).join("\n") : "";
  if (anthropic) return anthropic;
  const responseText = extractOpenAIResponseText(data);
  if (responseText) return responseText;
  if (typeof data?.message?.content === "string") return data.message.content;
  if (typeof data?.result === "string") return data.result;
  return "";
}

function extractOpenAIResponseText(data) {
  const out = [];
  for (const item of (data?.output || [])) {
    for (const c of (item?.content || [])) {
      if (c?.text) out.push(c.text);
      if (c?.type === "output_text" && c?.text) out.push(c.text);
    }
  }
  return out.join("\n");
}

function parseQuickAnalysisPayload(content) {
  if (content && typeof content === "object") return { ok: true, value: content, raw: "" };
  let raw = String(content || "").trim();
  if (!raw) return { ok: false, value: null, raw: "" };

  // 常见兼容模型会把思考过程或代码围栏一起塞进 content。
  raw = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json|javascript)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const direct = tryParseJsonCandidate(raw);
  if (direct) return { ok: true, value: direct, raw };

  // 用引号感知的括号扫描提取第一个完整 JSON 对象，避免 lastIndexOf("}") 把后续解释文本吞进去。
  const objects = extractBalancedJsonObjects(raw);
  for (const candidate of objects) {
    const value = tryParseJsonCandidate(candidate);
    if (value && typeof value === "object") return { ok: true, value, raw };
  }

  return { ok: false, value: null, raw };
}


function hasUsefulQuickPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const d = value?.result && typeof value.result === "object" ? value.result : value;
  const texts = [d.conclusion, d.summary, d.event_type];
  if (Array.isArray(d.verdict_labels) && d.verdict_labels.length) return true;
  if (texts.some((x) => x !== undefined && x !== null && String(x).trim())) return true;
  if (Array.isArray(d.analysis_steps) && d.analysis_steps.length) return true;
  if (Array.isArray(d.evidence) && d.evidence.length) return true;
  return false;
}

function tryParseJsonCandidate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const variants = [
    text,
    text.replace(/,\s*([}\]])/g, "$1")
  ];
  for (const v of variants) {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_) {}
  }
  return null;
}

function extractBalancedJsonObjects(text) {
  const out = [];
  let start = -1;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

async function invokeQuickProvider(quick, systemPrompt, userPrompt, maxTokens = 4096) {
  let data;
  if (quick.protocol === "anthropic") {
    const body = {
      model: quick.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }]
    };
    data = await requestAnthropicCompatible(quick, "messages", body);
  } else {
    data = await requestOpenAICompatible(quick, systemPrompt, userPrompt, maxTokens);
  }
  return {
    data,
    text: extractProviderText(data),
    truncated: providerOutputWasTruncated(data)
  };
}

function providerOutputWasTruncated(data) {
  const stopReason = String(data?.stop_reason || data?.choices?.[0]?.finish_reason || "").toLowerCase();
  if (["max_tokens", "length", "max_output_tokens"].includes(stopReason)) return true;
  if (String(data?.status || "").toLowerCase() === "incomplete") return true;
  if (data?.incomplete_details) return true;
  return false;
}

function normalizeAnalysisResult(data) {
  const d = data?.result && typeof data.result === "object" ? data.result : (data || {});
  const verdictLabels = normalizeVerdictLabels(d);
  const freeText = firstNonEmpty(
    d.conclusion,
    d.summary,
    d.conclusion_summary,
    d.analysis,
    d.markdown,
    d.content,
    d.text,
    d.raw,
    data?.markdown,
    data?.content,
    data?.text,
    data?.raw,
    ""
  );
  const markdownConclusion = extractMarkdownSection(freeText, ["研判结论", "结论", "综合判断", "最终结论"]);
  const markdownSummary = extractMarkdownSection(freeText, ["结论摘要", "摘要", "总结", "分析摘要"]);
  const steps = normalizeAnalysisSteps(d.analysis_steps || d.reasoning_steps || d.analysis_dimensions || []);
  const stepConclusion = firstNonEmpty(
    ...steps
      .filter((x) => /结论|判断|攻击特征/i.test(`${x.title || ""} ${x.status || ""}`))
      .map((x) => x.detail)
  );
  return {
    page_type: firstNonEmpty(d.page_type, data?.page_type, ""),
    scene_confidence: normalizeConfidence(d.scene_confidence ?? data?.scene_confidence),
    scene_reason: firstNonEmpty(d.scene_reason, data?.scene_reason, ""),
    device: firstNonEmpty(d.device, d.device_name, d.source_device, ""),
    src_ip: firstNonEmpty(d.src_ip, d.source_ip, ""),
    dst_ip: firstNonEmpty(d.dst_ip, d.destination_ip, ""),
    event_type: firstNonEmpty(d.event_type, d.event, d.alert_type, ""),
    verdict_labels: verdictLabels,
    // 保留旧字段只用于兼容旧缓存/旧模型响应；UI 不再直接展示自由文本标签。
    attack_intent: verdictLabels.includes("存在攻击意图") ? "存在攻击意图" : "",
    attack_outcome: verdictLabels.includes("攻击成功") ? "攻击成功" : (verdictLabels.includes("攻击失败") ? "攻击失败" : (verdictLabels.includes("无法确认") ? "无法确认" : "")),
    relation_verdict: firstNonEmpty(d.relation_verdict, d.relation, d.correlation_verdict, ""),
    risk_change: firstNonEmpty(d.risk_change, d.risk_trend, ""),
    priority: firstNonEmpty(d.priority, d.disposal_priority, d.handling_priority, ""),
    optional_labels: Array.isArray(d.optional_labels) ? d.optional_labels.map(String) : [],
    conclusion: firstMeaningfulText(d.conclusion, d.verdict, markdownConclusion, stepConclusion, typeof d.result === "string" ? d.result : "", deriveConclusionFromVerdicts(verdictLabels)),
    confidence: normalizeConfidence(d.confidence),
    risk_level: firstNonEmpty(d.risk_level, d.risk, d.severity, "未知"),
    summary: firstMeaningfulText(d.summary, d.conclusion_summary, markdownSummary, d.analysis, markdownConclusion, stepConclusion, ""),
    analysis_steps: steps,
    evidence: Array.isArray(d.evidence) ? d.evidence.map(String) : (Array.isArray(d.key_evidence) ? d.key_evidence.map(String) : []),
    workbench_url: d.workbench_url || data?.workbench_url || "",
    analysis_mode: firstNonEmpty(d.analysis_mode, data?.analysis_mode, ""),
    evidence_scope: firstNonEmpty(d.evidence_scope, data?.evidence_scope, "")
  };
}

const QUICK_VERDICT_LABELS = ["业务行为", "存在攻击意图", "攻击失败", "攻击成功", "非告警事件", "同源攻击", "同一攻击链", "相同目标资产", "相似手法", "风险升级", "无法确认"];
const CORRELATION_RELATION_VERDICTS = ["同源攻击", "同一攻击链", "相同目标资产", "相似攻击手法", "无有效关联", "无法确认"];
const CORRELATION_ATTACK_OUTCOMES = ["攻击成功", "攻击失败", "疑似成功", "未见成功证据", "无法确认"];
const CORRELATION_RISK_CHANGES = ["风险升级", "风险持平", "风险降低", "无法确认"];
const CORRELATION_PRIORITIES = ["立即处置", "优先排查", "持续观察", "可归档", "无法确认"];
const CORRELATION_OPTIONAL_LABELS = ["同一源IP", "同一目标IP", "同一时间窗口", "横向移动迹象", "持久化迹象", "批量扫描", "暴力破解", "漏洞利用", "命令执行", "数据下载", "资产失陷", "凭据风险"];

function normalizeCorrelationAnalysisResult(result, raw = {}) {
  const labels = Array.isArray(raw?.verdict_labels) ? raw.verdict_labels.map(String) : [];
  const optionalRaw = Array.isArray(raw?.optional_labels) ? raw.optional_labels : [];
  const relation = normalizeCorrelationEnum(firstNonEmpty(raw?.relation_verdict, raw?.relation, raw?.correlation_verdict, firstMatchingLabel(labels, CORRELATION_RELATION_VERDICTS), ""), CORRELATION_RELATION_VERDICTS, "无法确认");
  const outcome = normalizeCorrelationEnum(firstNonEmpty(raw?.attack_outcome, raw?.attack_result, firstMatchingLabel(labels, CORRELATION_ATTACK_OUTCOMES), deriveCorrelationOutcome(raw, result), ""), CORRELATION_ATTACK_OUTCOMES, "无法确认");
  const riskChange = normalizeCorrelationEnum(firstNonEmpty(raw?.risk_change, raw?.risk_trend, firstMatchingLabel(labels, CORRELATION_RISK_CHANGES), ""), CORRELATION_RISK_CHANGES, "无法确认");
  const priority = normalizeCorrelationEnum(firstNonEmpty(raw?.priority, raw?.disposal_priority, raw?.handling_priority, firstMatchingLabel(labels, CORRELATION_PRIORITIES), deriveCorrelationPriority(raw, result, riskChange, outcome), ""), CORRELATION_PRIORITIES, "无法确认");
  const optionalLabels = [...labels, ...optionalRaw].map(mapCorrelationOptionalLabel).filter(Boolean);
  const uniqueOptional = [...new Set(optionalLabels)].filter((label) => ![relation, outcome, riskChange, priority, "无法确认"].includes(label));
  result.relation_verdict = relation;
  result.attack_outcome = outcome;
  result.risk_change = riskChange;
  result.priority = priority;
  result.optional_labels = uniqueOptional.slice(0, 8);
  result.verdict_labels = [relation, outcome, riskChange, priority, ...result.optional_labels]
    .filter((label, index, arr) => label && (label !== "无法确认" || index < 4) && arr.indexOf(label) === index);
  result.conclusion = firstMeaningfulText(result.conclusion, `${relation}，${outcome}，${riskChange}，${priority}`);
  return result;
}

function normalizeCorrelationEnum(value, allowed, fallback) {
  const mapped = mapCorrelationLabel(value);
  if (allowed.includes(mapped)) return mapped;
  const text = String(value || "").replace(/[\s_\-]/g, "");
  const direct = allowed.find((item) => item.replace(/[\s_\-]/g, "") === text);
  return direct || fallback;
}

function firstMatchingLabel(labels, allowed) {
  for (const label of labels || []) {
    const mapped = mapCorrelationLabel(label);
    if (allowed.includes(mapped)) return mapped;
  }
  return "";
}

function mapCorrelationLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const compact = text.replace(/[\s_\-]/g, "");
  const all = [...CORRELATION_RELATION_VERDICTS, ...CORRELATION_ATTACK_OUTCOMES, ...CORRELATION_RISK_CHANGES, ...CORRELATION_PRIORITIES];
  const direct = all.find((item) => item.replace(/[\s_\-]/g, "") === compact);
  if (direct) return direct;
  if (/相似手法|相同手法|攻击手法相似/.test(compact)) return "相似攻击手法";
  if (/无关联|无有效关联|未关联|不相关/.test(compact)) return "无有效关联";
  if (/疑似成功|可能成功|部分成功/.test(compact)) return "疑似成功";
  if (/未见成功|无成功证据|未发现成功|没有成功证据/.test(compact)) return "未见成功证据";
  if (/风险持平|风险不变/.test(compact)) return "风险持平";
  if (/风险降低|风险下降/.test(compact)) return "风险降低";
  if (/立即处置|紧急处置|立刻处置/.test(compact)) return "立即处置";
  if (/优先排查|优先处理|优先处置/.test(compact)) return "优先排查";
  if (/持续观察|继续观察|观察/.test(compact)) return "持续观察";
  if (/可归档|归档|低优先级/.test(compact)) return "可归档";
  if (/攻击成功|利用成功|失陷|控制成功/.test(compact)) return "攻击成功";
  if (/攻击失败|利用失败|未成功|阻断/.test(compact)) return "攻击失败";
  if (/风险升级|升级|扩大/.test(compact)) return "风险升级";
  if (/同源攻击|同一来源|同源/.test(compact)) return "同源攻击";
  if (/同一攻击链|攻击链/.test(compact)) return "同一攻击链";
  if (/相同目标资产|同一目标|同一资产/.test(compact)) return "相同目标资产";
  if (/无法确认|证据不足|未知|不确定/.test(compact)) return "无法确认";
  return "";
}

function mapCorrelationOptionalLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const compact = text.replace(/[\s_\-]/g, "");
  const direct = CORRELATION_OPTIONAL_LABELS.find((item) => item.replace(/[\s_\-]/g, "") === compact);
  if (direct) return direct;
  if (/同一源IP|相同源IP|同源IP/.test(compact)) return "同一源IP";
  if (/同一目标IP|相同目标IP|目标IP相同/.test(compact)) return "同一目标IP";
  if (/同一时间|相近时间|时间窗口/.test(compact)) return "同一时间窗口";
  if (/横向移动/.test(compact)) return "横向移动迹象";
  if (/持久化|计划任务|自启动/.test(compact)) return "持久化迹象";
  if (/批量扫描|扫描/.test(compact)) return "批量扫描";
  if (/暴力破解|爆破/.test(compact)) return "暴力破解";
  if (/漏洞利用|RCE|反序列化|注入/.test(compact)) return "漏洞利用";
  if (/命令执行|远程执行|执行命令/.test(compact)) return "命令执行";
  if (/数据下载|下载/.test(compact)) return "数据下载";
  if (/资产失陷|主机失陷|已控/.test(compact)) return "资产失陷";
  if (/凭据|账号|口令|密码/.test(compact)) return "凭据风险";
  return "";
}

function deriveCorrelationOutcome(raw, result) {
  const text = `${JSON.stringify(raw || {})}\n${result?.summary || ""}\n${result?.conclusion || ""}`;
  if (/攻击成功|利用成功|成功登录|uid=|exitCode\s*=?\s*0|写入|下载|计划任务|已控制|失陷/.test(text)) return "攻击成功";
  if (/攻击失败|利用失败|已阻断|未成功|无成功证据|未见成功/.test(text)) return "攻击失败";
  return "";
}

function deriveCorrelationPriority(raw, result, riskChange, outcome) {
  const risk = String(result?.risk_level || raw?.risk_level || "");
  if (outcome === "攻击成功" || riskChange === "风险升级" || /高|危急|严重/.test(risk)) return "立即处置";
  if (outcome === "疑似成功" || /中/.test(risk)) return "优先排查";
  if (outcome === "攻击失败" || outcome === "未见成功证据") return "持续观察";
  return "";
}

function normalizeVerdictLabels(d) {
  const raw = [];
  const source = Array.isArray(d?.verdict_labels) ? d.verdict_labels
    : (Array.isArray(d?.labels) ? d.labels : (Array.isArray(d?.verdict_tags) ? d.verdict_tags : []));
  for (const item of source) {
    const mapped = mapVerdictLabel(item);
    if (mapped) raw.push(mapped);
  }

  // 向后兼容旧 schema：attack_intent / attack_outcome。
  const legacyIntent = firstNonEmpty(d?.attack_intent, d?.intent, d?.malicious_intent, "");
  const legacyOutcome = firstNonEmpty(d?.attack_outcome, d?.outcome, d?.attack_result, d?.exploit_result, "");
  const li = mapVerdictLabel(legacyIntent);
  const lo = mapVerdictLabel(legacyOutcome);
  if (li) raw.push(li);
  if (lo) raw.push(lo);

  const set = new Set(raw.filter((x) => QUICK_VERDICT_LABELS.includes(x)));
  const correlationLabels = ["同源攻击", "同一攻击链", "相同目标资产", "相似手法", "风险升级"].filter((label) => set.has(label));
  if (correlationLabels.length) return correlationLabels;
  const hasSuccess = set.has("攻击成功");
  const hasFailure = set.has("攻击失败");
  const hasIntent = set.has("存在攻击意图") || hasSuccess || hasFailure;
  const hasBusiness = set.has("业务行为");
  const hasNonAlert = set.has("非告警事件");
  const hasUnknown = set.has("无法确认");

  // 互斥冲突采用保守规范化，禁止出现逻辑不成立的组合。
  if (hasSuccess && hasFailure) return ["存在攻击意图", "无法确认"];
  if (hasSuccess) return ["存在攻击意图", "攻击成功"];
  if (hasFailure) return ["存在攻击意图", "攻击失败"];
  if (hasIntent && hasBusiness) return ["存在攻击意图", "无法确认"];
  if (hasIntent) return hasUnknown ? ["存在攻击意图", "无法确认"] : ["存在攻击意图"];
  if (hasNonAlert) return ["非告警事件"];
  if (hasBusiness) return ["业务行为"];
  if (hasUnknown) return ["无法确认"];
  return ["无法确认"];
}

function mapVerdictLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (QUICK_VERDICT_LABELS.includes(text)) return text;
  const compact = text.replace(/[\s_\-]/g, "");
  if (/非告警|非安全事件|不是告警|情报页面|文档页面/.test(compact)) return "非告警事件";
  if (/业务行为|正常业务|业务访问|合法业务|正常访问/.test(compact)) return "业务行为";
  if (/攻击成功|利用成功|执行成功|已失陷|失陷成功|控制成功/.test(compact)) return "攻击成功";
  if (/攻击失败|利用失败|利用未成功|未成功利用|拦截成功|未达成利用/.test(compact)) return "攻击失败";
  if (/攻击意图|恶意意图|恶意攻击|明确攻击|存在攻击|漏洞利用尝试|攻击尝试/.test(compact)) return "存在攻击意图";
  if (/无法确认|证据不足|无法判断|结果未知|未知|不确定|待确认/.test(compact)) return "无法确认";
  return "";
}

function deriveConclusionFromVerdicts(labels) {
  if (labels.includes("攻击成功")) return "攻击成功";
  if (labels.includes("攻击失败")) return "攻击失败";
  if (labels.includes("存在攻击意图")) return labels.includes("无法确认") ? "存在攻击意图，结果无法确认" : "存在攻击意图";
  if (labels.includes("业务行为")) return "业务行为";
  if (labels.includes("非告警事件")) return "非告警事件";
  return "无法确认";
}

function extractMarkdownSection(value, headings) {
  const text = String(value || "").trim();
  if (!text) return "";
  const normalized = text.replace(/\r\n/g, "\n");
  for (const heading of headings) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`(?:^|\\n)#{1,6}\\s*${escaped}\\s*[:：]?\\s*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s+|\\n\\*\\*[^*]+\\*\\*\\s*[:：]?|$)`, "i"),
      new RegExp(`(?:^|\\n)\\*\\*\\s*${escaped}\\s*\\*\\*\\s*[:：]?\\s*([\\s\\S]*?)(?=\\n#{1,6}\\s+|\\n\\*\\*[^*]+\\*\\*\\s*[:：]?|$)`, "i"),
      new RegExp(`(?:^|\\n)${escaped}\\s*[:：]\\s*([^\\n]+(?:\\n(?!\\s*(?:#{1,6}\\s+|\\*\\*[^*]+\\*\\*\\s*[:：]|[\\u4e00-\\u9fa5A-Za-z ]{2,16}\\s*[:：])).*)*)`, "i")
    ];
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      const section = cleanMarkdownSnippet(match?.[1] || "");
      if (section) return section;
    }
  }
  return "";
}

function cleanMarkdownSnippet(value) {
  return String(value || "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/#{1,6}\s*/g, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeAnalysisSteps(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map((item, i) => {
    if (typeof item === "string") return { title: `证据 ${i + 1}`, status: "", detail: item };
    const x = item || {};
    return {
      title: firstNonEmpty(x.title, x.name, x.dimension, `证据 ${i + 1}`),
      status: firstNonEmpty(x.status, x.verdict, x.result, ""),
      detail: firstNonEmpty(x.detail, x.description, x.reason, x.evidence, "")
    };
  }).filter((x) => x.detail || x.status);
}

function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // 0 < n < 1 → probability scale, convert to 0-100
  if (n > 0 && n < 1) return Math.round(n * 100);
  return Math.round(Math.max(0, Math.min(100, n)));
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return "";
}

function firstMeaningfulText(...values) {
  for (const v of values) {
    const text = cleanMarkdownSnippet(v);
    if (!text || isPlaceholderHeading(text)) continue;
    return text;
  }
  return "";
}

function isPlaceholderHeading(value) {
  const text = String(value || "").replace(/[：:。.\s#*`]/g, "").trim();
  return ["研判结论", "结论", "综合判断", "最终结论", "结论摘要", "摘要", "总结", "分析摘要"].includes(text);
}

function removeUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function normalizeTheme(value) {
  return value === "light" ? "light" : "dark";
}

function formatError(error) {
  return {
    message: error?.message || String(error || "未知错误"),
    kind: error?.kind || null,
    status: error?.status || null,
    detail: error?.data || null
  };
}
