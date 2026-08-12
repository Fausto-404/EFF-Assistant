(() => {
  if (window.__EFF_ASSISTANT_LOADED__) return;
  window.__EFF_ASSISTANT_LOADED__ = true;

  const HOST_ID = "eff-assistant-root";
  const HISTORY_KEY = "effAssistantOperationHistory";
  const CORRELATION_KEY = "effAssistantCorrelationClues";
  const HISTORY_LIMIT = 30;
  const CORRELATION_LIMIT = 12;
  const PET_SIZE = 58;
  const EDGE_GAP = 14;
  const PANEL_GAP = 14;

  const SEND_TIMEOUTS = {
    QUICK_ANALYZE: 620000,
    PLATFORM_ANALYZE: 620000,
    CORRELATE_ANALYZE: 620000,
    CREATE_TICKET: 120000,
    PARSE_PAGE: 100000,
    SEND_TICKET_WEBHOOK: 30000,
    SAVE_UI_STATE: 6000,
    OPEN_URL: 3000,
    default: 15000
  };

  const state = {
    platform: null,
    devices: [],
    quickAI: null,
    device: null,
    parseResult: null,
    pageText: "",
    parseToken: null,
    visible: true,
    menuOpen: false,
    activeAction: null,
    detachedPanels: [],
    correlationItems: [],
    analysisOpen: false,
    analysisResult: null,
    analysisKind: null,
    quickResult: null,
    messageTemplates: [],
    messageTemplatesLoadedFor: null,
    selectedMessageTemplateId: null,
    ticketResult: null,
    busy: { ticket: false, smart: false, quick: false },
    activity: "idle",
    currentUrl: location.href,
    lastPageKey: "",
    petPosition: null,
    theme: "dark",
    toast: null
  };

  let host;
  let shadow;
  let refreshTimer = null;
  let toastTimer = null;
  let petFlashTimer = null;
  let tooltipShowTimer = null;
  let tooltipHideTimer = null;
  let activeTooltipAnchor = null;
  let tooltipState = { visible: false, text: "", x: 0, y: 0 };
  let outsideBound = false;
  let actionHideTimer = null;
  let suppressPetClick = false;
  let lastPointer = { x: -9999, y: -9999 };
  let quickResultGraceUntil = 0;
  let quickResultHasBeenEntered = false;
  let renderPending = false;
  let contextLost = false;
  let ticketPanelHoldUntil = 0;
  let activeQuickRun = null;
  let activeSmartRun = null;

  bootstrap().catch((e) => console.error("EFF Assistant bootstrap failed", e));

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[CORRELATION_KEY]) return;
    const items = Array.isArray(changes[CORRELATION_KEY].newValue) ? changes[CORRELATION_KEY].newValue : [];
    state.correlationItems = items.filter((item) => item && typeof item === "object").slice(0, CORRELATION_LIMIT);
    if (host && state.visible && state.activeAction === "correlate") updateCorrelationTipDOM();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TOGGLE_WIDGET") {
      if (!host) mountWidget();
      state.visible = !state.visible;
      applyVisibility();
      sendResponse(widgetStatus());
      return;
    }
    if (message?.type === "SET_WIDGET_VISIBILITY") {
      if (!host) mountWidget();
      state.visible = !!message.visible;
      if (!state.visible) closeTransientViews();
      applyVisibility();
      sendResponse(widgetStatus());
      return;
    }
    if (message?.type === "CONFIG_UPDATED") {
      const incoming = message.state || {};
      const oldDeviceId = state.device?.id == null ? null : String(state.device.id);

      if (incoming.platform) state.platform = incoming.platform;
      if (Array.isArray(incoming.devices)) state.devices = incoming.devices;
      if (incoming.quickAI) state.quickAI = incoming.quickAI;
      if (typeof incoming.ui?.assistantEnabled === "boolean") state.visible = incoming.ui.assistantEnabled;
      if (incoming.ui?.theme) state.theme = normalizeTheme(incoming.ui.theme);
      if (incoming.ui?.petPosition && !state.petPosition) state.petPosition = normalizeSavedPosition(incoming.ui.petPosition);

      state.device = detectDevice(location.href, state.devices) || null;
      const newDeviceId = state.device?.id == null ? null : String(state.device.id);
      const deviceChanged = oldDeviceId !== newDeviceId;
      const forceRefresh = !!message.forceRefresh;
      if (deviceChanged || forceRefresh) {
        state.parseResult = null;
        state.parseToken = null;
        state.pageText = "";
        state.lastPageKey = "";
        state.analysisOpen = false;
        state.activeAction = null;
        state.analysisResult = null;
        state.quickResult = null;
        state.messageTemplates = [];
        state.messageTemplatesLoadedFor = null;
        state.selectedMessageTemplateId = null;
        state.ticketResult = null;
        state.activity = "idle";
      }

      if (!host) mountWidget();
      applyVisibility();
      render();
      if (state.visible && state.platform?.connected && state.device && (forceRefresh || deviceChanged || !state.parseResult)) {
        parseCurrentPage(true).catch((e) => console.debug("EFF Assistant: parse after config update skipped", e?.message || e));
      }
      sendResponse(widgetStatus());
      return;
    }
    if (message?.type === "GET_WIDGET_STATUS") {
      sendResponse(widgetStatus());
      return;
    }
    if (message?.type === "REFRESH_PARSE") {
      parseCurrentPage(true)
        .then(() => sendResponse(widgetStatus()))
        .catch((e) => sendResponse({ ...widgetStatus(), error: e.message }));
      return true;
    }
    if (message?.type === "GET_PAGE_TEXT") {
      const text = state.pageText || collectPageText();
      sendResponse({ text, length: text.length, url: location.href, title: document.title });
      return;
    }
    if (message?.type === "RESTORE_HISTORY_ITEM") {
      restoreHistoryItem(message.item);
      sendResponse(widgetStatus());
      return;
    }
    if (message?.type === "SHOW_WIDGET_DETAIL") {
      showWidgetDetail(message.action)
        .then(() => sendResponse(actionStatus(message.action)))
        .catch((e) => sendResponse({ ...actionStatus(message.action), error: e.message }));
      return true;
    }
    if (message?.type === "RUN_WIDGET_ACTION") {
      runWidgetAction(message.action)
        .then((result) => sendResponse(result))
        .catch((e) => sendResponse({ ...actionStatus(message.action), error: e.message }));
      return true;
    }
  });

  async function refreshRuntimeState() {
    const response = await send({ type: "GET_STATE" });
    if (!response.ok) return false;
    state.platform = response.platform;
    state.devices = response.devices || [];
    state.quickAI = response.quickAI || { enabled: false, configured: false };
    state.visible = response.ui?.assistantEnabled === true;
    state.theme = normalizeTheme(response.ui?.theme);
    state.device = detectDevice(location.href, state.devices) || null;
    if (!state.petPosition) state.petPosition = normalizeSavedPosition(response.ui?.petPosition);
    return true;
  }

  async function bootstrap() {
    const ok = await refreshRuntimeState();
    if (!ok) return;

    await loadCorrelationItems().catch(() => []);
    mountWidget();
    await parseCurrentPage(false);
    startSpaWatcher();
  }

  function mountWidget() {
    if (document.getElementById(HOST_ID)) {
      host = document.getElementById(HOST_ID);
      shadow = host.shadowRoot;
      applyVisibility();
      return;
    }

    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "pointer-events:none",
      "display:block"
    ].join(";");

    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${styles()}</style><div class="shell"></div><div class="eff-tooltip-layer"></div>`;
    document.documentElement.appendChild(host);

    ensurePetPosition();
    render();
    bindOutsideInteractions();
  }

  function applyVisibility() {
    if (!host) return;
    host.style.display = state.visible ? "block" : "none";
    if (state.visible) render();
  }

  function render() {
    if (!shadow || !state.visible) return;
    ensurePetPosition();

    const shell = shadow.querySelector(".shell");
    shell.className = `shell ${themeClass()}`;
    const pet = state.petPosition;
    const statusClass = petStatusClass();
    const activityClass = state.activity !== "idle" ? "busy" : "";

    let html = `
      <div class="pet ${statusClass} ${activityClass}" data-role="pet" data-pet-status="${escapeHtml(state._petFlash || "")}" style="${positionStyle(pet)}" title="${escapeHtml(petTooltip())}">
        <div class="pet-core">
          <div class="pet-face"><span></span><span></span></div>
        </div>
        <i class="pet-status"></i>
        <i class="pet-tail"></i>
      </div>
    `;

    if (state.menuOpen) html += renderActionDock();
    html += renderDetachedPanels();
    if (state.toast) html += renderToast();

    shell.innerHTML = html;
    bindPetInteractions();
    bindDockEvents();
    bindDetachedPanelEvents();
    bindPanelIconTooltips(shadow);
    bindAnalysisEvents();
    requestAnimationFrame(adjustActionTipsIntoViewport);
  }

  function renderActionDock() {
    const hasPlatform = !!state.platform?.connected;
    const showTicket = hasPlatform || !!state.ticketResult;
    const showSmart = hasPlatform || !!state.analysisResult;
    const actionCount = [showTicket, showSmart, true, true].filter(Boolean).length;
    const placement = dockPlacement(actionCount);
    const busyClass = state.busy.ticket ? "ticket-busy" : state.busy.smart ? "smart-busy" : state.busy.quick ? "quick-busy" : "";
    const platformHint = !state.platform?.connected ? "需要先连接 EFF-Monitoring" : (!state.device ? "当前页面尚未识别设备" : "");
    const ticketHint = platformHint || (state.busy.ticket
      ? "工单生成中…"
      : state.ticketResult
        ? "工单已生成，点击查看详情"
        : "点击生成工单，基于平台解析结果创建并流转");
    const smartHint = platformHint || (!state.platform?.platformAI
      ? "平台 AI 当前不可用"
      : state.busy.smart
        ? "研判中…"
        : state.analysisResult
          ? "点击查看智能研判结果"
          : "点击进行平台增强智能研判");
    const quickReady = !!(state.quickAI?.enabled && state.quickAI?.configured);
    const quickHint = !quickReady
      ? "未配置插件 AI，请先在设置页启用快速研判。"
      : state.busy.quick
        ? "研判中…"
        : state.quickResult
          ? "点击查看快速研判结果"
          : "点击闪电按钮快速研判当前页面";

    return `
      <div class="action-cluster ${placement.side} ${placement.vertical} ${busyClass}" data-role="dock" style="left:${placement.left}px;top:${placement.top}px">
        ${showTicket ? renderTicketHoverAction(ticketHint, !hasPlatform || !!state.busy.ticket) : ""}
        ${showSmart ? renderSmartHoverAction(smartHint, !hasPlatform || !state.platform?.platformAI || !!state.busy.smart) : ""}
        ${renderQuickHoverAction(quickHint, !!state.busy.quick)}
        ${renderCorrelationHoverAction()}
      </div>
    `;
  }

  function renderHoverAction(action, icon, label, hint, disabled) {
    const active = state.activeAction === action;
    return `
      <div class="action-item">
        <button class="action-btn ${action}${active ? " active" : ""}" data-act="open-action" data-action="${action}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
          <span class="action-icon">${icon}</span>
        </button>
        <div class="action-tip${active ? " force-visible" : ""}" role="tooltip"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(hint)}</span></div>
      </div>
    `;
  }

  function renderTicketHoverAction(hint, disabled) {
    const result = state.ticketResult;
    const summary = ticketSummaryData();
    const hasPlatform = !!(state.platform?.connected && state.device);
    const canShowTicketDetail = hasPlatform || !!result;
    const templateOptions = state.messageTemplates.length
      ? state.messageTemplates.map((tpl) => `<option value="${escapeHtml(String(tpl.id))}" ${String(tpl.id) === String(state.selectedMessageTemplateId || "") ? "selected" : ""}>${escapeHtml(tpl.name)}${tpl.is_default ? "（默认）" : ""}</option>`).join("")
      : `<option value="">默认消息模板</option>`;
    const tags = renderTicketTags(summary);
    const messageReady = !!(result?.formatted_chat || state.parseResult?.formatted_chat);
    const active = state.activeAction === "ticket";
    const tipBody = canShowTicketDetail ? `
      <div class="ticket-card-head">
        <strong>生成工单</strong>
        <span class="ticket-state ${result ? "ok" : state.busy.ticket ? "running" : ""}">${result ? "已创建" : state.busy.ticket ? "创建中" : "待创建"}</span>
      </div>
      <div class="ticket-kv"><span>设备</span><b>${escapeHtml(summary.device || "-")}</b></div>
      <div class="ticket-kv ticket-kv-stack"><span>源IP</span><div><b>${escapeHtml(summary.srcIp || "-")}</b>${renderTicketIpTags(summary.srcTags)}</div></div>
      <div class="ticket-kv ticket-kv-stack"><span>目标IP</span><div><b>${escapeHtml(summary.dstIp || "-")}</b>${renderTicketIpTags(summary.dstTags)}</div></div>
      <div class="ticket-kv"><span>事件</span><b>${escapeHtml(summary.eventType || "-")}</b></div>
      <label class="ticket-template">
        <span>通报模板</span>
        <select data-act="ticket-template">${templateOptions}</select>
      </label>
      ${result?.alert_hash ? `<div class="ticket-hash">${escapeHtml(result.alert_hash)}</div>` : ""}
      <div class="ticket-actions">
        <button data-act="ticket" ${disabled ? "disabled" : ""}>${result ? "重新生成" : "创建工单"}</button>
        <button data-act="copy-ticket-message" ${messageReady ? "" : "disabled"}>复制消息</button>
        <button data-act="send-ticket-webhook" ${result?.alert_id ? "" : "disabled"}>发送通报</button>
      </div>
    ` : `<strong>点击生成工单</strong><span>${escapeHtml(hint)}</span>`;
    const keepVisible = active || state.busy.ticket || Date.now() < ticketPanelHoldUntil;
    const tipClass = canShowTicketDetail ? ` interactive ticket-panel${keepVisible ? " force-visible" : ""}` : "";

    return `
      <div class="action-item ticket-item">
        <button class="action-btn ticket${active ? " active" : ""}" data-act="open-action" data-action="ticket" aria-label="${state.busy.ticket ? "生成中" : "生成工单"}" title="${state.busy.ticket ? "生成中" : "生成工单"}">
          <span class="action-icon">▣</span>
        </button>
        <div class="action-tip ticket-tip${tipClass}" role="tooltip">${tipBody}</div>
      </div>
    `;
  }

  function renderSmartHoverAction(hint, disabled) {
    const result = state.analysisResult;
    const active = state.activeAction === "smart";
    let tipBody = `
      <div class="quick-drag-head"><div class="panel-drag-grip" aria-hidden="true"></div><div class="quick-inline-head"><div class="panel-header-info"><strong>点击智能研判</strong><span class="quick-inline-status"><i></i>待研判</span></div></div></div>
      <div class="quick-inline-summary">${escapeHtml(hint)}</div>
      <button class="quick-inline-copy primary" data-act="smart" ${disabled ? "disabled" : ""}>开始智能研判</button>
    `;
    let tipClass = active ? " interactive smart-detail force-visible" : "";

    if (state.busy.smart) {
      tipClass = ` interactive smart-running${active ? " force-visible" : ""}`;
      tipBody = `
        <div class="quick-drag-head"><div class="panel-drag-grip" aria-hidden="true"></div><div class="quick-inline-head"><div class="panel-header-info"><strong>研判中</strong><span class="quick-inline-status running"><i></i>增强中</span></div></div></div>
        <div class="quick-inline-loading"><b></b><span>正在调用 EFF-Monitoring，结合解析字段、资产、情报、相似告警和历史经验研判…</span></div>
      `;
    } else if (result) {
      tipClass = ` interactive smart-result${active ? " force-visible" : ""}`;
      const view = smartInlineView(result);
      const chips = view.labels.map((label) => `<em class="qtag ${verdictClass(label)}">${escapeHtml(label)}</em>`).join("");
      const steps = renderQuickInlineSteps({ analysis_steps: view.steps, evidence: view.evidence });
      tipBody = `
        <div class="quick-drag-head"><div class="panel-drag-grip" aria-hidden="true"></div><div class="quick-inline-head">
          <div class="panel-header-info"><strong>智能研判</strong><span class="quick-inline-status ok"><i></i>完成</span></div><div class="panel-header-actions"><button class="panel-icon-btn" data-no-drag data-act="smart" data-tooltip="重新研判" aria-label="重新研判" ${disabled ? "disabled" : ""}><svg viewBox="0 0 16 16"><path d="M1.5 8a6.5 6.5 0 0111.8-4.2M14.5 8a6.5 6.5 0 01-11.8 4.2M1.5 3v3.5H5M14.5 13v-3.5H11"/></svg></button><button class="panel-icon-btn" data-no-drag data-act="copy-analysis" data-tooltip="复制研判结果" aria-label="复制研判结果"><svg viewBox="0 0 16 16"><rect x="5" y="1" width="9" height="12" rx="1"/><path d="M3 4v9a1 1 0 001 1h7"/></svg></button><button class="panel-icon-btn" data-no-drag data-act="show-collected-text" data-tooltip="查看采集原文" aria-label="查看采集原文"><svg viewBox="0 0 16 16"><path d="M3 2h7a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><line x1="5" y1="5" x2="9" y2="5"/><line x1="5" y1="8" x2="11" y2="8"/><line x1="5" y1="11" x2="10" y2="11"/></svg></button><button class="inline-detail-btn" data-act="open-history-detail" data-kind="smart">查看详情</button></div>
        </div></div>
        <div class="quick-inline-verdict">
          <span class="quick-inline-label">研判结论</span>
          <div class="quick-inline-tags">${chips}</div>
        </div>
        <div class="quick-inline-meta">${view.meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
        <div class="quick-inline-summary">${escapeHtml(view.summary || "当前证据不足，无法形成稳定结论。")}</div>
        <div class="quick-inline-metrics">
          <span>置信度 <b>${escapeHtml(view.confidence)}</b></span>
          <span>风险 <b class="risk">${escapeHtml(view.risk)}</b></span>
          <span>证据链 <b>${escapeHtml(String(view.evidenceCount))} 项</b></span>
        </div>
        <div class="quick-inline-reasons">${steps}</div>
      `;
    }

    return `
      <div class="action-item smart-item">
        <button class="action-btn smart${active ? " active" : ""}" data-act="open-action" data-action="smart" aria-label="${state.busy.smart ? "智能研判中" : "智能研判"}" title="${state.busy.smart ? "智能研判中" : "智能研判"}">
          <span class="action-icon">◎</span>
        </button>
        <div class="action-tip smart-tip${tipClass}" data-detach-kind="${active ? "smart" : ""}" role="tooltip">${tipBody}</div>
      </div>
    `;
  }

  function renderQuickHoverAction(hint, disabled) {
    const result = state.quickResult;
    const active = state.activeAction === "quick";
    let tipBody = `
      <div class="quick-drag-head"><div class="panel-drag-grip" aria-hidden="true"></div><div class="quick-inline-head"><div class="panel-header-info"><strong>点击快速研判</strong><span class="quick-inline-status"><i></i>待研判</span></div></div></div>
      <div class="quick-inline-summary">${escapeHtml(hint)}</div>
    `;
    let tipClass = active ? " interactive quick-detail force-visible" : "";

    if (state.busy.quick) {
      tipClass = ` interactive quick-running${active ? " force-visible" : ""}`;
      tipBody = `
        <div class="quick-drag-head"><div class="panel-drag-grip" aria-hidden="true"></div><div class="quick-inline-head"><div class="panel-header-info"><strong>研判中</strong><span class="quick-inline-status running"><i></i>分析中</span></div></div></div>
        <div class="quick-inline-loading"><b></b><span>正在检查页面上下文；强告警特征将直接研判，模糊页面先做轻量分类…</span></div>
      `;
    } else if (result) {
      tipClass = ` interactive quick-result${active ? " force-visible" : ""}`;
      const conf = result.confidence == null ? "-" : `${Math.round(Number(result.confidence) || 0)}%`;
      const labels = Array.isArray(result.verdict_labels) && result.verdict_labels.length ? result.verdict_labels : ["无法确认"];
      const chips = labels.map((label) => `<em class="qtag ${verdictClass(label)}">${escapeHtml(label)}</em>`).join("");
      const steps = renderQuickInlineSteps(result);
      const meta = [];
      if (result.page_type) meta.push(`<span>页面类型：${escapeHtml(result.page_type)}</span>`);
      if (result.stage_route_label) meta.push(`<span>路径：${escapeHtml(result.stage_route_label)}</span>`);
      if (result.src_ip || result.dst_ip) meta.push(`<span>${escapeHtml(result.src_ip || "-")} → ${escapeHtml(result.dst_ip || "-")}</span>`);
      if (result.event_type) meta.push(`<span>${escapeHtml(result.event_type)}</span>`);
      if (result.device) meta.push(`<span>${escapeHtml(result.device)}</span>`);
      const evidenceCount = Math.max((result.analysis_steps || []).length, (result.evidence || []).length);
      tipBody = `
        <div class="quick-drag-head"><div class="panel-drag-grip" aria-hidden="true"></div><div class="quick-inline-head">
          <div class="panel-header-info"><strong>快速研判</strong><span class="quick-inline-status ok"><i></i>完成</span></div><div class="panel-header-actions"><button class="panel-icon-btn" data-no-drag data-act="quick" data-tooltip="重新研判" aria-label="重新研判" ${disabled ? "disabled" : ""}><svg viewBox="0 0 16 16"><path d="M1.5 8a6.5 6.5 0 0111.8-4.2M14.5 8a6.5 6.5 0 01-11.8 4.2M1.5 3v3.5H5M14.5 13v-3.5H11"/></svg></button><button class="panel-icon-btn" data-no-drag data-act="copy-quick-inline" data-tooltip="复制研判结果" aria-label="复制研判结果"><svg viewBox="0 0 16 16"><rect x="5" y="1" width="9" height="12" rx="1"/><path d="M3 4v9a1 1 0 001 1h7"/></svg></button><button class="panel-icon-btn" data-no-drag data-act="show-collected-text" data-tooltip="查看采集原文" aria-label="查看采集原文"><svg viewBox="0 0 16 16"><path d="M3 2h7a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><line x1="5" y1="5" x2="9" y2="5"/><line x1="5" y1="8" x2="11" y2="8"/><line x1="5" y1="11" x2="10" y2="11"/></svg></button><button class="inline-detail-btn" data-act="open-history-detail" data-kind="quick">查看详情</button></div>
        </div></div>
        <div class="quick-inline-verdict">
          <span class="quick-inline-label">研判结论</span>
          <div class="quick-inline-tags">${chips}</div>
        </div>
        ${meta.length ? `<div class="quick-inline-meta">${meta.join("")}</div>` : ""}
        <div class="quick-inline-summary">${escapeHtml(result.summary || result.conclusion || "当前证据不足，无法形成稳定结论。")}</div>
        <div class="quick-inline-metrics">
          <span>置信度 <b>${escapeHtml(conf)}</b></span>
          <span>风险 <b class="risk">${escapeHtml(result.risk_level || "未知")}</b></span>
          <span>证据链 <b>${escapeHtml(String(evidenceCount || 0))} 项</b></span>
        </div>
        <div class="quick-inline-reasons">${steps}</div>
      `;
    }

    return `
      <div class="action-item quick-item">
        <button class="action-btn quick${active ? " active" : ""}" data-act="open-action" data-action="quick" aria-label="${state.busy.quick ? "快速研判中" : "快速研判"}" title="${state.busy.quick ? "快速研判中" : "快速研判"}">
          <span class="action-icon">ϟ</span>
        </button>
        <div class="action-tip quick-tip${tipClass}" data-detach-kind="${active ? "quick" : ""}" role="tooltip">${tipBody}</div>
      </div>
    `;
  }

  // 手术式更新关联线索弹框内容，不触发全量 render()，彻底消除采集/删除线索时的闪烁。
  function updateCorrelationTipDOM() {
    const tip = shadow?.querySelector(".correlate-tip");
    if (!tip) return;

    const clues = state.correlationItems || [];

    // 更新标题和线索数量
    const headStrong = tip.querySelector(".quick-inline-head strong");
    if (headStrong) headStrong.textContent = clues.length ? "关联分析线索" : "点击采集当前告警";
    const status = tip.querySelector(".quick-inline-status");
    if (status) status.innerHTML = `<i></i>${escapeHtml(String(clues.length))} 条`;

    // 更新线索列表
    const list = tip.querySelector(".correlate-list");
    if (list) {
      list.innerHTML = clues.length
        ? clues.map((item, index) => `
          <div class="correlate-row">
            <b>${String(index + 1).padStart(2, "0")}</b>
            <span>
              <strong>${escapeHtml(item.title || `告警线索 ${index + 1}`)}</strong>
              <em>${escapeHtml(item.summary || item.url || "已采集当前页面告警文本")}</em>
            </span>
            <button data-act="remove-correlation-clue" data-id="${escapeHtml(item.id)}" title="删除">×</button>
          </div>
        `).join("")
        : `<div class="quick-inline-empty">点击按钮采集当前页面告警为线索；切换告警页后再次点击，可继续追加告警 2、告警 3…</div>`;

      // 重新绑定删除按钮
      list.querySelectorAll('[data-act="remove-correlation-clue"]').forEach((btn) => {
        btn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          state.correlationItems = state.correlationItems.filter((item) => item.id !== ev.currentTarget.dataset.id);
          await saveCorrelationItems(state.correlationItems);
          updateCorrelationTipDOM();
        });
      });
    }

    // 更新清空按钮状态
    const clearBtn = tip.querySelector('[data-act="clear-correlation-clues"]');
    if (clearBtn) clearBtn.disabled = clues.length === 0;

    // 更新关联分析按钮状态
    const runBtn = shadow.querySelector('[data-act="run-correlation"]');
    if (runBtn) runBtn.disabled = clues.length < 2;
  }

  function renderCorrelationHoverAction() {
    const active = state.activeAction === "correlate";
    const clues = state.correlationItems || [];
    const rows = clues.length ? clues.map((item, index) => `
      <div class="correlate-row">
        <b>${String(index + 1).padStart(2, "0")}</b>
        <span>
          <strong>${escapeHtml(item.title || `告警线索 ${index + 1}`)}</strong>
          <em>${escapeHtml(item.summary || item.url || "已采集当前页面告警文本")}</em>
        </span>
        <button data-act="remove-correlation-clue" data-id="${escapeHtml(item.id)}" title="删除">×</button>
      </div>
    `).join("") : `<div class="quick-inline-empty">点击按钮采集当前页面告警为线索；切换告警页后再次点击，可继续追加告警 2、告警 3…</div>`;
    return `
      <div class="action-item correlate-item">
        <button class="action-btn correlate${active ? " active" : ""}" data-act="open-action" data-action="correlate" aria-label="关联分析" title="关联分析">
          <span class="action-icon">⛓</span>
        </button>
        <div class="action-tip correlate-tip interactive${active ? " force-visible" : ""}" role="tooltip">
          <div class="quick-inline-head"><strong>${clues.length ? "关联分析线索" : "点击采集当前告警"}</strong><span class="quick-inline-status"><i></i>${escapeHtml(String(clues.length))} 条</span></div>
          <div class="correlate-list">${rows}</div>
          <div class="correlate-actions">
            <button data-act="capture-correlation-clue">采集当前告警</button>
            <button data-act="clear-correlation-clues" ${clues.length ? "" : "disabled"}>清空</button>
          </div>
          <button class="quick-inline-copy primary" data-act="run-correlation" ${clues.length < 2 ? "disabled" : ""}>开始关联分析</button>
        </div>
      </div>
    `;
  }

  function renderDetachedPanels() {
    return state.detachedPanels.map((panel) => renderDetachedPanel(panel)).join("");
  }

  function renderDetachedPanel(panel) {
    if (panel.minimized) {
      return `<button class="detached-bubble ${escapeHtml(panel.kind)}" data-panel-id="${escapeHtml(panel.id)}" style="left:${panel.position.x}px;top:${panel.position.y}px" data-tooltip="${escapeHtml(panel.title)}" aria-label="${escapeHtml(panel.title)}"><span class="detached-bubble-icon" aria-hidden="true">${renderPanelBubbleIcon(panel)}</span></button>`;
    }
    if (panel.kind === "quick" || panel.kind === "smart") {
      const tipKind = panel.kind === "smart" ? "smart" : "quick";
      const statusClass = panel.status === "running" ? `${tipKind}-running` : panel.status === "error" ? `${tipKind}-result` : `${tipKind}-result`;
      return `
        <section class="action-tip ${tipKind}-tip interactive force-visible detached-action-tip ${statusClass}" data-panel-id="${escapeHtml(panel.id)}" style="left:${panel.position.x}px;top:${panel.position.y}px">
          ${renderDetachedActionTipBody(panel)}
        </section>
      `;
    }
    return `
      <section class="detached-panel ${escapeHtml(panel.kind)}" data-panel-id="${escapeHtml(panel.id)}" style="left:${panel.position.x}px;top:${panel.position.y}px">
        <header class="detached-head" data-role="panel-drag">
          <div>
            <strong>${escapeHtml(panel.title || panelKindLabel(panel.kind))}</strong>
            <span>${escapeHtml(panel.status === "running" ? "分析中" : panel.status === "error" ? "失败" : "已完成")}</span>
          </div>
          <div class="detached-actions">
            ${panel.kind !== "text" ? renderPanelActions(panel, false, false) : ""}
            ${panel.kind !== "text" && panel.status === "done"
              ? `<button class="panel-icon-btn" data-no-drag data-act="panel-history-detail" data-tooltip="查看详情" aria-label="查看详情"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><line x1="8" y1="8" x2="8" y2="5"/><circle cx="8" cy="10.5" r=".75" fill="currentColor" stroke="none"/></svg></button>`
              : ``}
            ${panel.kind === "text"
              ? `<button class="panel-icon-btn" data-no-drag data-act="panel-copy-text" data-tooltip="复制" aria-label="复制采集文本"><svg viewBox="0 0 16 16"><rect x="5" y="1" width="9" height="12" rx="1"/><path d="M3 4v9a1 1 0 001 1h7"/></svg></button>`
              : ``}
            <button class="panel-icon-btn" data-no-drag data-act="panel-close" data-tooltip="关闭" aria-label="关闭"><svg viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg></button>
          </div>
        </header>
        <div class="detached-body">${renderDetachedPanelBody(panel)}</div>
      </section>
    `;
  }

  function renderDetachedPanelBody(panel) {
    if (panel.kind === "text") {
      return `
        <div class="text-panel-meta">${escapeHtml(panel.page?.url || location.href)} · ${escapeHtml(String((panel.text || "").length))} 字符</div>
        <pre class="text-panel-content">${escapeHtml(panel.text || "暂无可查看的采集文本")}</pre>
      `;
    }
    if (panel.status === "running") {
      return `<div class="quick-inline-loading"><b></b><span>${escapeHtml(panel.loadingText || "分析中…")}</span></div>`;
    }
    if (panel.status === "error") {
      return `<div class="quick-inline-summary error-text">${escapeHtml(panel.error || "分析失败")}</div>`;
    }
    const result = panel.result || {};
    const labels = panel.kind === "correlation" ? correlationPrimaryLabels(result) : (Array.isArray(result.verdict_labels) && result.verdict_labels.length ? result.verdict_labels : ["无法确认"]);
    const chips = labels.map((label) => `<em class="qtag ${verdictClass(label)}">${escapeHtml(label)}</em>`).join("");
    const optionalLabels = panel.kind === "correlation" ? correlationOptionalLabels(result) : [];
    const optionalChips = optionalLabels.map((label) => `<em class="qtag optional">${escapeHtml(label)}</em>`).join("");
    const conf = result.confidence == null ? "-" : `${Math.round(Number(result.confidence) || 0)}%`;
    const steps = renderQuickInlineSteps(result);
    const meta = [];
    if (result.src_ip || result.dst_ip) meta.push(`<span>${escapeHtml(result.src_ip || "-")} → ${escapeHtml(result.dst_ip || "-")}</span>`);
    if (result.event_type) meta.push(`<span>${escapeHtml(result.event_type)}</span>`);
    if (result.page_type) meta.push(`<span>${escapeHtml(result.page_type)}</span>`);
    return `
      <div class="quick-inline-verdict"><span class="quick-inline-label">研判结论</span><div class="quick-inline-tags">${chips}</div></div>
      ${optionalChips ? `<div class="quick-inline-verdict optional-verdict"><span class="quick-inline-label">关联特征</span><div class="quick-inline-tags">${optionalChips}</div></div>` : ""}
      ${meta.length ? `<div class="quick-inline-meta">${meta.join("")}</div>` : ""}
      <div class="quick-inline-summary">${escapeHtml(result.summary || result.conclusion || "当前证据不足，无法形成稳定结论。")}</div>
      <div class="quick-inline-metrics">
        <span>置信度 <b>${escapeHtml(conf)}</b></span>
        <span>风险 <b class="risk">${escapeHtml(result.risk_level || "未知")}</b></span>
        <span>证据链 <b>${escapeHtml(String(Math.max((result.analysis_steps || []).length, (result.evidence || []).length, 0)))} 项</b></span>
      </div>
      <div class="quick-inline-reasons">${steps}</div>
    `;
  }

  // 生成 Header 图标按钮，根据不同任务类型和状态决定显示哪些
  function renderPanelActions(panel, showDetail = true, showClose = true) {
    const kind = panel.kind;
    const done = panel.status === "done";
    const hasResult = done && !!panel.result;
    const hasSourceText = typeof panel.text === "string" && panel.text.trim().length > 0;
    let html = "";
    // 重新研判：done 或 error
    if (done || panel.status === "error") {
      html += `<button class="panel-icon-btn" data-no-drag data-act="panel-rerun" data-kind="${escapeHtml(kind === "correlation" ? "correlate-run" : kind)}" data-tooltip="${kind === "correlation" ? "重新分析" : "重新研判"}" aria-label="${kind === "correlation" ? "重新分析" : "重新研判"}"><svg viewBox="0 0 16 16"><path d="M1.5 8a6.5 6.5 0 0111.8-4.2M14.5 8a6.5 6.5 0 01-11.8 4.2M1.5 3v3.5H5M14.5 13v-3.5H11"/></svg></button>`;
    }
    // 复制结果：done 且真正有结果
    if (hasResult) {
      html += `<button class="panel-icon-btn" data-no-drag data-act="panel-copy" data-panel-id="${escapeHtml(panel.id)}" data-tooltip="复制研判结果" aria-label="复制研判结果"><svg viewBox="0 0 16 16"><rect x="5" y="1" width="9" height="12" rx="1"/><path d="M3 4v9a1 1 0 001 1h7"/></svg></button>`;
    }
    // 查看原文：done 且确实采集到了正文
    if (done && hasSourceText) {
      const sourceLabel = kind === "correlation" ? "查看关联告警" : "查看采集原文";
      html += `<button class="panel-icon-btn" data-no-drag data-act="panel-show-source-text" data-panel-id="${escapeHtml(panel.id)}" data-tooltip="${sourceLabel}" aria-label="${sourceLabel}"><svg viewBox="0 0 16 16"><path d="M3 2h7a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><line x1="5" y1="5" x2="9" y2="5"/><line x1="5" y1="8" x2="11" y2="8"/><line x1="5" y1="11" x2="10" y2="11"/></svg></button>`;
    }
    // 查看详情：done 且真正有结果
    if (showDetail && hasResult) {
      html += `<button class="panel-icon-btn" data-no-drag data-act="panel-history-detail" data-tooltip="查看详情" aria-label="查看详情"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><line x1="8" y1="8" x2="8" y2="5"/><circle cx="8" cy="10.5" r=".75" fill="currentColor" stroke="none"/></svg></button>`;
    }
    // 关闭：永远可用
    if (showClose) {
      html += `<button class="panel-icon-btn" data-no-drag data-act="panel-close" data-tooltip="关闭" aria-label="关闭"><svg viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg></button>`;
    }
    return html;
  }

  function renderDetachedActionTipBody(panel) {
    const actions = renderPanelActions(panel, true, true);
    const label = escapeHtml(panelKindLabel(panel.kind));
    if (panel.status === "running") {
      const runningText = panel.kind === "smart" ? "增强中" : "分析中";
      return `
        <div class="quick-drag-head" data-role="panel-drag"><div class="panel-drag-grip" aria-hidden="true"></div><div class="quick-inline-head"><div class="panel-header-info"><strong>${label}</strong><span class="quick-inline-status running"><i></i>${escapeHtml(runningText)}</span></div><div class="panel-header-actions">${actions}</div></div></div>
        <div class="quick-inline-loading"><b></b><span>${escapeHtml(panel.loadingText || "分析中…")}</span></div>
      `;
    }
    if (panel.status === "error") {
      return `
        <div class="quick-drag-head" data-role="panel-drag"><div class="panel-drag-grip" aria-hidden="true"></div><div class="quick-inline-head"><div class="panel-header-info"><strong>${label}</strong><span class="quick-inline-status"><i></i>失败</span></div><div class="panel-header-actions">${actions}</div></div></div>
        <div class="quick-inline-summary error-text">${escapeHtml(panel.error || "分析失败")}</div>
      `;
    }
    return panel.kind === "smart" ? renderSmartDetachedResult(panel) : renderQuickDetachedResult(panel);
  }

  function renderSmartDetachedResult(panel) {
    const view = smartInlineView(panel.result || {});
    const chips = view.labels.map((label) => `<em class="qtag ${verdictClass(label)}">${escapeHtml(label)}</em>`).join("");
    const steps = renderQuickInlineSteps({ analysis_steps: view.steps, evidence: view.evidence });
    const actions = renderPanelActions(panel, true, true);
    return `
      <div class="quick-drag-head" data-role="panel-drag"><div class="panel-drag-grip" aria-hidden="true"></div><div class="quick-inline-head"><div class="panel-header-info"><strong>智能研判</strong><span class="quick-inline-status ok"><i></i>完成</span></div><div class="panel-header-actions">${actions}</div></div></div>
      <div class="quick-inline-body"><div class="quick-inline-verdict"><span class="quick-inline-label">研判结论</span><div class="quick-inline-tags">${chips}</div></div>
      <div class="quick-inline-meta">${view.meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
      <div class="quick-inline-summary">${escapeHtml(view.summary || "当前证据不足，无法形成稳定结论。")}</div>
      <div class="quick-inline-metrics">
        <span>置信度 <b>${escapeHtml(view.confidence)}</b></span>
        <span>风险 <b class="risk">${escapeHtml(view.risk)}</b></span>
        <span>证据链 <b>${escapeHtml(String(view.evidenceCount))} 项</b></span>
      </div>
      <div class="quick-inline-reasons">${steps}</div></div>
    `;
  }

  function renderQuickDetachedResult(panel) {
    const result = panel.result || {};
    const conf = result.confidence == null ? "-" : `${Math.round(Number(result.confidence) || 0)}%`;
    const labels = Array.isArray(result.verdict_labels) && result.verdict_labels.length ? result.verdict_labels : ["无法确认"];
    const chips = labels.map((label) => `<em class="qtag ${verdictClass(label)}">${escapeHtml(label)}</em>`).join("");
    const steps = renderQuickInlineSteps(result);
    const meta = [];
    if (result.page_type) meta.push(`<span>页面类型：${escapeHtml(result.page_type)}</span>`);
    if (result.stage_route_label) meta.push(`<span>路径：${escapeHtml(result.stage_route_label)}</span>`);
    if (result.src_ip || result.dst_ip) meta.push(`<span>${escapeHtml(result.src_ip || "-")} → ${escapeHtml(result.dst_ip || "-")}</span>`);
    if (result.event_type) meta.push(`<span>${escapeHtml(result.event_type)}</span>`);
    if (result.device) meta.push(`<span>${escapeHtml(result.device)}</span>`);
    const evidenceCount = Math.max((result.analysis_steps || []).length, (result.evidence || []).length);
    const actions = renderPanelActions(panel, true, true);
    return `
      <div class="quick-drag-head" data-role="panel-drag"><div class="panel-drag-grip" aria-hidden="true"></div><div class="quick-inline-head"><div class="panel-header-info"><strong>快速研判</strong><span class="quick-inline-status ok"><i></i>完成</span></div><div class="panel-header-actions">${actions}</div></div></div>
      <div class="quick-inline-body"><div class="quick-inline-verdict"><span class="quick-inline-label">研判结论</span><div class="quick-inline-tags">${chips}</div></div>
      ${meta.length ? `<div class="quick-inline-meta">${meta.join("")}</div>` : ""}
      <div class="quick-inline-summary">${escapeHtml(result.summary || result.conclusion || "当前证据不足，无法形成稳定结论。")}</div>
      <div class="quick-inline-metrics">
        <span>置信度 <b>${escapeHtml(conf)}</b></span>
        <span>风险 <b class="risk">${escapeHtml(result.risk_level || "未知")}</b></span>
        <span>证据链 <b>${escapeHtml(String(evidenceCount || 0))} 项</b></span>
      </div>
      <div class="quick-inline-reasons">${steps}</div></div>
    `;
  }

  function verdictClass(label) {
    const map = {
      "业务行为": "business",
      "存在攻击意图": "intent",
      "攻击失败": "failed",
      "攻击成功": "success",
      "疑似成功": "success",
      "未见成功证据": "failed",
      "非告警事件": "nonalert",
      "同源攻击": "intent",
      "同一攻击链": "success",
      "相同目标资产": "nonalert",
      "相似手法": "failed",
      "相似攻击手法": "failed",
      "风险升级": "success",
      "风险持平": "nonalert",
      "风险降低": "business",
      "立即处置": "success",
      "优先排查": "failed",
      "持续观察": "nonalert",
      "可归档": "business",
      "无有效关联": "nonalert",
      "无法确认": "unknown"
    };
    return map[label] || "unknown";
  }

  function correlationPrimaryLabels(result) {
    return [
      result?.relation_verdict || firstExistingLabel(result?.verdict_labels, ["同源攻击", "同一攻击链", "相同目标资产", "相似攻击手法", "相似手法", "无有效关联", "无法确认"]) || "无法确认",
      result?.attack_outcome || firstExistingLabel(result?.verdict_labels, ["攻击成功", "攻击失败", "疑似成功", "未见成功证据", "无法确认"]) || "无法确认",
      result?.risk_change || firstExistingLabel(result?.verdict_labels, ["风险升级", "风险持平", "风险降低", "无法确认"]) || "无法确认",
      result?.priority || firstExistingLabel(result?.verdict_labels, ["立即处置", "优先排查", "持续观察", "可归档", "无法确认"]) || "无法确认"
    ].map((label) => label === "相似手法" ? "相似攻击手法" : label);
  }

  function correlationOptionalLabels(result) {
    const primary = new Set(correlationPrimaryLabels(result));
    const optional = Array.isArray(result?.optional_labels) ? result.optional_labels : [];
    const labels = Array.isArray(result?.verdict_labels) ? result.verdict_labels : [];
    return [...new Set([...optional, ...labels])]
      .map((label) => label === "相似手法" ? "相似攻击手法" : label)
      .filter((label) => label && !primary.has(label) && label !== "无法确认")
      .slice(0, 10);
  }

  function firstExistingLabel(labels, allowed) {
    const set = new Set(Array.isArray(labels) ? labels.map((x) => String(x || "")) : []);
    return allowed.find((label) => set.has(label)) || "";
  }

  function smartInlineView(result) {
    const summary = ticketSummaryData();
    const fields = state.parseResult?.fields || {};
    const labels = normalizeInlineVerdicts(result.verdict_labels, [
      result.conclusion,
      result.summary,
      result.attack_outcome,
      fields.attack_result,
      fields.result,
      fields.response_code,
      fields.device_action
    ]);
    const meta = ["平台证据增强"];
    const src = firstNonEmpty(result.src_ip, summary.srcIp);
    const dst = firstNonEmpty(result.dst_ip, summary.dstIp);
    if (src || dst) meta.push(`${src || "-"} → ${dst || "-"}`);
    const eventType = firstNonEmpty(result.event_type, summary.eventType);
    if (eventType) meta.push(eventType);
    const device = firstNonEmpty(result.device, summary.device);
    if (device) meta.push(device);

    const cleanSummary = conciseInlineText(firstNonEmpty(result.conclusion, result.summary, ""), 190);
    const steps = smartInlineSteps(result);
    const evidence = Array.isArray(result.evidence) ? result.evidence.map((x) => conciseInlineText(x, 150)).filter(Boolean) : [];
    return {
      labels,
      meta,
      summary: cleanSummary,
      confidence: result.confidence == null ? "-" : `${Math.round(Number(result.confidence) || 0)}%`,
      risk: firstNonEmpty(result.risk_level, result.risk, "未知"),
      evidenceCount: Math.max(steps.length, evidence.length, 0),
      steps,
      evidence
    };
  }

  function normalizeInlineVerdicts(rawLabels, textSources) {
    const set = new Set((Array.isArray(rawLabels) ? rawLabels : []).map(String).filter(Boolean));
    const text = textSources.map((x) => String(x || "")).join("\n");
    if (/攻击失败|攻击未成功|请求被拒绝|被阻断|阻断|拦截|403|失败/i.test(text)) set.add("攻击失败");
    if (/攻击成功|利用成功|命令执行成功|写入成功|getshell|webshell\s*上传成功/i.test(text)) set.add("攻击成功");
    if ((set.has("攻击失败") || set.has("攻击成功")) && !set.has("存在攻击意图")) set.add("存在攻击意图");
    if (!set.size && /无法确认|证据不足|不能确认/i.test(text)) set.add("无法确认");
    if (set.has("攻击成功")) return ["存在攻击意图", "攻击成功"];
    if (set.has("攻击失败")) return ["存在攻击意图", "攻击失败"];
    if (set.has("存在攻击意图")) return set.has("无法确认") ? ["存在攻击意图", "无法确认"] : ["存在攻击意图"];
    if (set.has("业务行为")) return ["业务行为"];
    if (set.has("非告警事件")) return ["非告警事件"];
    return ["无法确认"];
  }

  function smartInlineSteps(result) {
    const raw = Array.isArray(result.analysis_steps) ? result.analysis_steps : [];
    const steps = raw
      .filter((step) => step && (step.detail || step.title))
      .map((step) => ({
        title: conciseInlineText(step.title || "研判依据", 18),
        status: conciseInlineText(step.status || "", 12),
        detail: conciseInlineText(step.detail || "", 145)
      }))
      .filter((step) => step.detail && !/^已按业务行为/.test(step.detail));
    if (steps.length) return steps.slice(0, 3);

    const evidence = Array.isArray(result.evidence) ? result.evidence : [];
    return evidence.slice(0, 3).map((item, i) => ({
      title: `关键证据 ${i + 1}`,
      status: "",
      detail: conciseInlineText(item, 145)
    }));
  }

  function conciseInlineText(value, maxLen) {
    const text = String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[`*_#>]/g, "")
      .replace(/\[(事实|推断|判断|证据)\]/g, "$1")
      .replace(/^\s*[-•]\s*/gm, "")
      .replace(/\n{2,}/g, "\n")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "";
    return text.length > maxLen ? `${text.slice(0, maxLen).replace(/[，,。；;：:]?$/, "")}…` : text;
  }

  function renderQuickInlineSteps(result) {
    let steps = Array.isArray(result.analysis_steps) ? result.analysis_steps.slice(0, 4) : [];
    if (!steps.length) steps = (result.evidence || []).slice(0, 4).map((x, i) => ({ title: `依据 ${i + 1}`, status: "", detail: x }));
    if (!steps.length) return `<div class="quick-inline-empty">当前页面证据不足，未形成可验证的证据链。</div>`;
    return steps.map((step, i) => {
      const title = conciseInlineText(step?.title || `依据 ${i + 1}`, 22);
      const status = conciseInlineText(step?.status || "", 12);
      const detail = conciseInlineText(step?.detail || "", 170);
      return `<div class="quick-inline-reason"><b>${String(i + 1).padStart(2, "0")}</b><div><strong>${escapeHtml(title)}${status ? ` · ${escapeHtml(status)}` : ""}</strong><span>${escapeHtml(detail)}</span></div></div>`;
    }).join("");
  }

  function ticketSummaryData() {
    const result = state.ticketResult || {};
    const parsed = state.parseResult || result || {};
    const fields = result.fields || parsed.fields || {};
    const srcContext = result.src_context || parsed.src_context || fields.src_asset_context || (fields.asset_context || {}).src_asset || {};
    const dstContext = result.dst_context || parsed.dst_context || fields.dst_asset_context || (fields.asset_context || {}).dst_asset || {};
    return {
      device: result.device?.name || parsed.device?.name || state.device?.name || "",
      srcIp: firstNonEmpty(fields.src_ip, fields.source_ip, result.src_ip, parsed.src_ip),
      dstIp: firstNonEmpty(fields.dst_ip, fields.destination_ip, fields.dest_ip, result.dst_ip, parsed.dst_ip),
      eventType: firstNonEmpty(fields.event_type, fields.alert_name, fields.attack_type, result.event_type, parsed.event_type),
      srcTags: normalizeTicketTags(srcContext),
      dstTags: normalizeTicketTags(dstContext)
    };
  }

  function normalizeTicketTags(ctx) {
    const labels = [];
    const criticalityLabel = { low: "低价值", medium: "中价值", high: "高价值", critical: "核心资产" };
    const push = (value) => {
      const label = String(value || "").trim();
      if (label && !labels.includes(label)) labels.push(label);
    };
    push(ctx?.name);
    push(criticalityLabel[ctx?.criticality] || ctx?.criticality || ctx?.importance);
    push(ctx?.area);
    if (ctx?.owner) push(`负责人:${ctx.owner}`);
    for (const tag of (ctx?.tags || [])) push(typeof tag === "string" ? tag : tag?.label);
    for (const tag of (ctx?.labels || [])) push(typeof tag === "string" ? tag : tag?.label);
    return labels.slice(0, 6);
  }

  function renderTicketTags(summary) {
    const chips = [];
    for (const tag of summary.srcTags || []) chips.push(`<em class="${ticketTagClass(tag)}">源 ${escapeHtml(tag)}</em>`);
    for (const tag of summary.dstTags || []) chips.push(`<em class="${ticketTagClass(tag)}">目 ${escapeHtml(tag)}</em>`);
    return chips.join("");
  }

  function renderTicketIpTags(tags) {
    const chips = (tags || []).map((tag) => `<em class="${ticketTagClass(tag)}">${escapeHtml(tag)}</em>`).join("");
    return chips ? `<div class="ticket-ip-tags">${chips}</div>` : "";
  }

  function ticketTagClass(tag) {
    const text = String(tag || "");
    if (/黑名单|黑名|blacklist|block|封禁|恶意/i.test(text)) return "tag-blacklist";
    if (/白名单|白名|whitelist|allow|可信|放行/i.test(text)) return "tag-whitelist";
    if (/核心资产|高价值|重要|critical|high/i.test(text)) return "tag-critical";
    return "tag-normal";
  }


  function renderAnalysisPanel() {
    const result = state.analysisResult || {};
    const conf = result.confidence == null ? "-" : `${Math.round(Number(result.confidence) || 0)}%`;
    const placement = panelPlacement(352, estimateAnalysisHeight(result));
    const evidence = (result.evidence || [])
      .slice(0, 6)
      .map((x, i) => `<li><b>${i + 1}</b><span>${escapeHtml(x)}</span></li>`)
      .join("") || `<li><span>暂无可展示关键依据</span></li>`;

    return `
      <section class="analysis-panel" data-role="analysis-panel" style="left:${placement.left}px;top:${placement.top}px;width:352px">
        <header class="panel-head">
          <div>
            <h3>AI智能研判结果</h3>
            <p class="connection ok"><i></i>已完成研判</p>
          </div>
          <button class="panel-close" data-act="analysis-close" title="关闭">×</button>
        </header>
        <div class="analysis-body">
          <div class="metric single"><span>结论</span><strong class="danger">${escapeHtml(result.conclusion || "待人工确认")}</strong></div>
          <div class="metric-grid">
            <div><span>置信度</span><strong>${escapeHtml(conf)}</strong></div>
            <div><span>风险等级</span><strong class="danger">${escapeHtml(result.risk_level || "未知")}</strong></div>
          </div>
          <div class="section"><h4>结论摘要</h4><p>${escapeHtml(result.summary || "暂无摘要")}</p></div>
          <div class="section"><h4>关键依据</h4><ol>${evidence}</ol></div>
          <div class="result-actions">
            <button class="result-btn primary" data-act="open-workbench">打开工作台</button>
            <button class="result-btn" data-act="copy-analysis">复制结果</button>
          </div>
        </div>
      </section>
    `;
  }


  function renderQuickAnalysisSteps(result) {
    let steps = Array.isArray(result.analysis_steps) ? result.analysis_steps.slice(0, 5) : [];
    if (!steps.length) {
      steps = (result.evidence || []).slice(0, 5).map((x, i) => ({ title: `关键证据 ${i + 1}`, status: "已确认", detail: x }));
    }
    if (!steps.length) return `<div class="reason-row empty"><div class="reason-index">—</div><div class="reason-content"><strong>证据不足</strong><p>当前页面没有足够证据支持进一步拆解。</p></div></div>`;
    return steps.map((step, i) => {
      const title = step?.title || `证据 ${i + 1}`;
      const status = step?.status || "";
      const detail = step?.detail || "";
      return `<div class="reason-row"><div class="reason-index">${String(i + 1).padStart(2, "0")}</div><div class="reason-content"><div class="reason-line"><strong>${escapeHtml(title)}</strong>${status ? `<span>${escapeHtml(status)}</span>` : ""}</div><p>${escapeHtml(detail)}</p></div></div>`;
    }).join("");
  }

  function renderQuickRecognition(result) {
    const hasAny = result.device || result.src_ip || result.dst_ip || result.event_type;
    if (!hasAny) return "";
    return `
      <div class="quick-recognition">
        <div><span>设备/来源</span><strong>${escapeHtml(result.device || "未识别")}</strong></div>
        <div><span>源IP</span><strong>${escapeHtml(result.src_ip || "-")}</strong></div>
        <div><span>目的IP</span><strong>${escapeHtml(result.dst_ip || "-")}</strong></div>
        <div><span>事件</span><strong>${escapeHtml(result.event_type || "未识别")}</strong></div>
      </div>
    `;
  }

  function renderToast() {
    const pos = toastPlacement();
    return `<div class="toast ${state.toast?.error ? "error" : ""}" style="left:${pos.left}px;top:${pos.top}px">${escapeHtml(state.toast?.text || "")}</div>`;
  }

  function bindPetInteractions() {
    const pet = shadow.querySelector('[data-role="pet"]');
    if (!pet) return;

    let pointerId = null;
    let start = null;
    let origin = null;
    let moved = false;
    let preDragViewState = null;

    pet.addEventListener("pointerenter", () => {
      if (pointerId != null || pet.classList.contains("dragging")) return;
      showActionButtons();
    });
    pet.addEventListener("pointerleave", (e) => {
      rememberPointer(e);
      scheduleActionButtonsClose();
    });

    pet.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      clearActionHideTimer();
      pointerId = e.pointerId;
      start = { x: e.clientX, y: e.clientY };
      origin = { ...state.petPosition };
      moved = false;
      pet.setPointerCapture?.(pointerId);
      pet.classList.add("drag-ready");
      e.preventDefault();
    });

    pet.addEventListener("pointermove", (e) => {
      if (pointerId !== e.pointerId || !start || !origin) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) > 4) {
        moved = true;
        preDragViewState = isAnyActionBusy() ? null : {
          menuOpen: state.menuOpen,
          analysisOpen: state.analysisOpen
        };
        state.menuOpen = false;
        state.activeAction = null;
        state.analysisOpen = false;
        quickResultGraceUntil = 0;
        shadow.querySelector('[data-role="dock"]')?.remove();
        shadow.querySelector('[data-role="analysis-panel"]')?.remove();
        pet.classList.add("dragging");
      }
      if (!moved) return;

      state.petPosition = clampPosition({ x: origin.x + dx, y: origin.y + dy });
      pet.style.left = `${state.petPosition.x}px`;
      pet.style.top = `${state.petPosition.y}px`;
      e.preventDefault();
    });

    const endDrag = async (e) => {
      if (pointerId !== e.pointerId) return;
      try { pet.releasePointerCapture?.(pointerId); } catch (_) {}
      pet.classList.remove("dragging", "drag-ready");
      const wasMoved = moved;
      pointerId = null;
      start = null;
      origin = null;
      moved = false;

      if (wasMoved) {
        suppressPetClick = true;
        setTimeout(() => { suppressPetClick = false; }, 0);
        await savePetPosition();
        state.menuOpen = false;
        state.activeAction = null;
        state.analysisOpen = false;
        preDragViewState = null;
        render();
      } else {
        preDragViewState = null;
      }
    };

    pet.addEventListener("pointerup", endDrag);
    pet.addEventListener("pointercancel", (e) => {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      start = null;
      origin = null;
      moved = false;
      if (preDragViewState) {
        state.menuOpen = !!preDragViewState.menuOpen;
        state.activeAction = state.menuOpen ? state.activeAction : null;
        state.analysisOpen = !!preDragViewState.analysisOpen;
      } else {
        state.menuOpen = false;
        state.activeAction = null;
        state.analysisOpen = false;
      }
      preDragViewState = null;
      render();
    });

    pet.addEventListener("click", (e) => {
      if (suppressPetClick) return;
      e.preventDefault();
      state.parseResult = null;
      state.parseToken = null;
      state.lastPageKey = "";
      // 保留工单结果，避免用户误触丢失已生成的工单数据。
      showToast("正在重新解析当前页面...");
      parseCurrentPage(true).catch((err) => showToast(`重新解析失败：${err.message}`, true));
    });
  }

  function bindDockEvents() {
    const dock = shadow.querySelector('[data-role="dock"]');
    dock?.addEventListener("pointerenter", clearActionHideTimer);
    dock?.addEventListener("pointerleave", (e) => {
      rememberPointer(e);
      scheduleActionButtonsClose();
    });

    // 快速研判按钮和结果卡共享一个逻辑 Hover Zone。
    // 结果卡不再依赖 .action-item:hover 才可见，避免鼠标穿过绝对定位间隙时瞬间消失。
    const quickItem = shadow.querySelector('.quick-item');
    const quickTip = shadow.querySelector('.quick-tip.interactive');
    const ticketItem = shadow.querySelector('.ticket-item');
    const ticketTip = shadow.querySelector('.ticket-tip.interactive');
    const smartItem = shadow.querySelector('.smart-item');
    const smartTip = shadow.querySelector('.smart-tip.interactive');
    quickItem?.addEventListener("pointerenter", clearActionHideTimer);
    quickItem?.addEventListener("pointerleave", (e) => {
      rememberPointer(e);
      scheduleActionButtonsClose();
    });
    quickTip?.addEventListener("pointerenter", () => {
      quickResultHasBeenEntered = true;
      clearActionHideTimer();
    });
    quickTip?.addEventListener("pointerleave", (e) => {
      rememberPointer(e);
      scheduleActionButtonsClose();
    });
    ticketItem?.addEventListener("pointerenter", clearActionHideTimer);
    ticketItem?.addEventListener("pointerleave", (e) => {
      rememberPointer(e);
      scheduleActionButtonsClose();
    });
    ticketTip?.addEventListener("pointerenter", clearActionHideTimer);
    ticketTip?.addEventListener("pointerleave", (e) => {
      rememberPointer(e);
      scheduleActionButtonsClose();
    });
    smartItem?.addEventListener("pointerenter", clearActionHideTimer);
    smartItem?.addEventListener("pointerleave", (e) => {
      rememberPointer(e);
      scheduleActionButtonsClose();
    });
    smartTip?.addEventListener("pointerenter", clearActionHideTimer);
    smartTip?.addEventListener("pointerleave", (e) => {
      rememberPointer(e);
      scheduleActionButtonsClose();
    });

    shadow.querySelectorAll('[data-act="open-action"]').forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const action = e.currentTarget?.dataset?.action || null;
        if (!action) return;
        clearActionHideTimer();

        if (action === "quick" && !state.quickResult && !state.busy.quick) {
          await analyze("quick");
          return;
        }
        if (action === "correlate") {
          await captureCorrelationClue();
          await loadCorrelationItems();
          state.menuOpen = true;
          state.activeAction = "correlate";
          scheduleRender();
          return;
        }

        state.menuOpen = true;
        state.activeAction = action;
        scheduleRender();
        if (action === "ticket") {
          ensureMessageTemplates().catch((err) => console.debug("EFF Assistant: template sync skipped", err?.message || err));
        }
      });
    });

    shadow.querySelectorAll('[data-act="ticket"]').forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        holdTicketPanel();
        await createTicket();
      });
    });

    shadow.querySelector('[data-act="ticket-template"]')?.addEventListener("change", async (e) => {
      e.stopPropagation();
      holdTicketPanel(5000);
      state.selectedMessageTemplateId = e.target.value || null;
      state.ticketResult = null;
      state.lastPageKey = "";
      await parseCurrentPage(true);
      holdTicketPanel(5000);
      render();
    });

    shadow.querySelector('[data-act="copy-ticket-message"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      holdTicketPanel();
      await copyTicketMessage();
    });

    shadow.querySelector('[data-act="send-ticket-webhook"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      holdTicketPanel();
      await sendTicketWebhook();
    });

    shadow.querySelector('[data-act="smart"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      clearActionHideTimer();
      state.menuOpen = true;
      state.activeAction = "smart";
      await analyze("smart");
    });

    shadow.querySelector('[data-act="quick"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      clearActionHideTimer();
      state.menuOpen = true;
      state.activeAction = "quick";
      await analyze("quick");
    });

    shadow.querySelector('[data-act="copy-quick-inline"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      await copyQuickResult();
    });

    shadow.querySelectorAll('[data-act="show-collected-text"]').forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        showCollectedTextPanel();
      });
    });
    shadow.querySelectorAll('[data-act="open-history-detail"]').forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const kind = btn.dataset.kind || "quick";
        const result = kind === "smart" ? state.analysisResult : state.quickResult;
        await openHistoryDetailForResult(kind, result);
      });
    });

    shadow.querySelectorAll('.action-tip.force-visible[data-detach-kind]').forEach((tip) => bindActionTipDetach(tip));

    shadow.querySelector('[data-act="run-correlation"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      await runCorrelationAnalysis();
    });

    shadow.querySelector('[data-act="capture-correlation-clue"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      await captureCorrelationClue();
      updateCorrelationTipDOM();
    });

    shadow.querySelector('[data-act="clear-correlation-clues"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      state.correlationItems = [];
      await saveCorrelationItems([]);
      updateCorrelationTipDOM();
    });

    shadow.querySelectorAll('[data-act="remove-correlation-clue"]').forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        state.correlationItems = state.correlationItems.filter((item) => item.id !== e.currentTarget.dataset.id);
        await saveCorrelationItems(state.correlationItems);
        updateCorrelationTipDOM();
      });
    });
  }

  function bindDetachedPanelEvents() {
    shadow.querySelectorAll('[data-act="panel-copy-text"]').forEach((btn) => btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.closest("[data-panel-id]")?.dataset.panelId;
      const panel = state.detachedPanels.find((item) => item.id === id);
      const text = panel?.text || "";
      if (!text.trim()) return showToast("暂无可复制的采集文本", true);
      await navigator.clipboard.writeText(text).catch(() => {});
      showToast("采集文本已复制");
    }));
    shadow.querySelectorAll('[data-act="panel-copy"]').forEach((btn) => btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await copyPanelResult(btn.dataset.panelId);
    }));
    shadow.querySelectorAll('[data-act="panel-show-source-text"]').forEach((btn) => btn.addEventListener("click", (e) => {
      e.stopPropagation();
      showPanelSourceText(btn.dataset.panelId);
    }));
    shadow.querySelectorAll('[data-act="panel-history-detail"]').forEach((btn) => btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.closest("[data-panel-id]")?.dataset.panelId;
      const panel = state.detachedPanels.find((item) => item.id === id);
      if (!panel) return;
      await openHistoryDetailForResult(panel.kind, panel.result);
    }));
    shadow.querySelectorAll('[data-act="panel-rerun"]').forEach((btn) => btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (btn.dataset.kind === "correlate-run") {
        await runCorrelationAnalysis();
        return;
      }
      state.menuOpen = true;
      state.activeAction = btn.dataset.kind || "quick";
      await analyze(btn.dataset.kind || "quick");
    }));
    shadow.querySelectorAll('[data-act="panel-minimize"]').forEach((btn) => btn.addEventListener("click", (e) => {
      e.stopPropagation();
      updateDetachedPanel(btn.closest("[data-panel-id]")?.dataset.panelId, (panel) => { panel.minimized = true; });
    }));
    shadow.querySelectorAll('[data-act="panel-close"]').forEach((btn) => btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.closest("[data-panel-id]")?.dataset.panelId;
      state.detachedPanels = state.detachedPanels.filter((panel) => panel.id !== id);
      render();
    }));
    shadow.querySelectorAll('[data-role="panel-drag"]').forEach((head) => bindPanelDrag(head));
    shadow.querySelectorAll('.detached-bubble').forEach((bubble) => bindPanelDrag(bubble));
    // 为 detached panels 和 inline 结果卡中的图标绑定 tooltip
    shadow.querySelectorAll(".detached-panel,.detached-action-tip,.quick-tip,.smart-tip,.correlate-tip").forEach((node) => bindPanelIconTooltips(node));
  }

  function bindActionTipDetach(tip) {
    let pointerId = null;
    let start = null;
    let origin = null;
    let detached = false;
    let seamNode = null;
    let seamPanel = null;

    tip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button,input,select,textarea,a,[data-no-drag]")) return;
      if (!e.target.closest(".quick-drag-head")) return;
      const kind = tip.dataset.detachKind;
      if (!kind) return;
      const rect = tip.getBoundingClientRect();
      pointerId = e.pointerId;
      start = { x: e.clientX, y: e.clientY };
      origin = { x: rect.left, y: rect.top };
      detached = false;
      seamNode = null;
      seamPanel = null;
      // pointerdown 即 Capture；第一个真实位移才 Detach（Zero Threshold）
      tip.setPointerCapture?.(pointerId);
    });

    tip.addEventListener("pointermove", (e) => {
      if (pointerId !== e.pointerId || !start || !origin) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (dx === 0 && dy === 0) return;

      if (!detached) {
        detached = true;
        tip.style.transition = "none";
        tip.style.cursor = "grabbing";
        e.stopPropagation();
        detachCurrentResult(tip.dataset.detachKind, { x: origin.x + dx, y: origin.y + dy });
        const newPanel = state.detachedPanels[0];
        if (newPanel) {
          seamPanel = newPanel;
          seamNode = shadow.querySelector(`[data-panel-id="${cssEscape(newPanel.id)}"]`);
          if (seamNode) {
            seamNode.style.transition = "none";
            seamNode.style.cursor = "grabbing";
          }
        }
        return;
      }

      // 分离后在新面板上继续跟手拖拽
      if (!seamPanel || !seamNode) return;
      seamPanel.position = clampDetachedPosition(
        { x: origin.x + dx, y: origin.y + dy },
        seamPanel.minimized
      );
      seamNode.style.left = `${seamPanel.position.x}px`;
      seamNode.style.top = `${seamPanel.position.y}px`;
    });
    const end = (e) => {
      if (pointerId !== e.pointerId) return;
      try { tip.releasePointerCapture?.(pointerId); } catch (_) {}
      tip.style.transition = "";
      tip.style.cursor = "";
      if (seamNode) {
        seamNode.style.transition = "";
        seamNode.style.cursor = "";
      }
      // 清理移出视口的 dock
      const offDock = shadow.querySelector('[data-role="dock"]');
      if (offDock && offDock.style.left === "-9999px") offDock.remove();
      pointerId = null;
      start = null;
      origin = null;
      detached = false;
      seamNode = null;
      seamPanel = null;
    };
    tip.addEventListener("pointerup", end);
    tip.addEventListener("pointercancel", end);
  }

  function showActionButtons() {
    clearActionHideTimer();
    if (state.menuOpen || !state.visible) return;
    state.menuOpen = true;
    render();
    ensureMessageTemplates().catch((e) => console.debug("EFF Assistant: template sync skipped", e?.message || e));
  }

  async function ensureMessageTemplates() {
    if (!state.platform?.connected || !state.device) return;
    const deviceKey = String(state.device.id);
    if (state.messageTemplatesLoadedFor === deviceKey) return;
    const resp = await send({ type: "GET_MESSAGE_TEMPLATES", deviceId: state.device.id });
    if (!resp.ok) throw new Error(resp.error?.message || "模板同步失败");
    state.messageTemplates = Array.isArray(resp.data?.templates) ? resp.data.templates : [];
    state.messageTemplatesLoadedFor = deviceKey;
    if (!state.selectedMessageTemplateId && state.messageTemplates.length) {
      const defaultTemplate = state.messageTemplates.find((tpl) => tpl.is_default) || state.messageTemplates[0];
      state.selectedMessageTemplateId = defaultTemplate?.id || null;
      state.lastPageKey = "";
    }
    if (state.menuOpen) render();
  }

  function scheduleActionButtonsClose(delay = 520) {
    clearActionHideTimer();
    actionHideTimer = setTimeout(() => {
      if (state.activeAction) return;

      if (Date.now() < ticketPanelHoldUntil) {
        scheduleActionButtonsClose(260);
        return;
      }

      // 研判刚完成时给予 3 秒"可达窗口"，直到鼠标真正进入结果卡为止。
      // 这避免用户从宠物/按钮向大结果卡移动时，因为途中经过空白像素而被收起。
      if (state.quickResult && !quickResultHasBeenEntered && Date.now() < quickResultGraceUntil) {
        scheduleActionButtonsClose(260);
        return;
      }

      if (isPointerInsideAssistantHoverZone(lastPointer.x, lastPointer.y)) {
        return;
      }

      if (state.menuOpen) {
        state.menuOpen = false;
        render();
      }
    }, delay);
  }

  function isPointerInsideAssistantHoverZone(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !shadow) return false;
    const nodes = [
      shadow.querySelector('[data-role="pet"]'),
      shadow.querySelector('[data-role="dock"]'),
      shadow.querySelector('.ticket-tip.interactive'),
      shadow.querySelector('.smart-tip.interactive'),
      shadow.querySelector('.quick-tip.interactive')
    ].filter((node) => node && isHoverNodeVisible(node));
    if (!nodes.length) return false;

    const rects = nodes.map((node) => node.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return false;
    const pad = 18;

    // 1) 任意真实组件周边 18px 都属于 Hover Zone。
    if (rects.some((r) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad)) {
      return true;
    }

    // 2) 再构造整个宠物/按钮/结果区域的"交互包络矩形"。
    //    绝对定位结果卡与按钮之间即使存在视觉间距，也不会产生 Hover 断层。
    const left = Math.min(...rects.map((r) => r.left)) - pad;
    const right = Math.max(...rects.map((r) => r.right)) + pad;
    const top = Math.min(...rects.map((r) => r.top)) - pad;
    const bottom = Math.max(...rects.map((r) => r.bottom)) + pad;
    return x >= left && x <= right && y >= top && y <= bottom;
  }

  function adjustActionTipsIntoViewport() {
    if (!shadow || !state.menuOpen) return;
    const tips = Array.from(shadow.querySelectorAll('.action-tip.interactive:not(.detached-action-tip)'));
    for (const tip of tips) {
      tip.style.marginLeft = "0px";
      tip.style.marginTop = "0px";
      tip.style.left = "";
      tip.style.right = "";
      tip.style.top = "";
      tip.style.bottom = "";
      tip.style.position = "";
      tip.style.transform = "";
    }

    requestAnimationFrame(() => {
      if (!shadow || !state.menuOpen) return;
      for (const tip of tips) {
        if (tip.classList.contains("force-visible")) {
          positionFixedActionTip(tip);
          continue;
        }

        const rect = tip.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;

        let shiftX = 0;
        let shiftY = 0;
        const maxRight = window.innerWidth - EDGE_GAP;
        const maxBottom = window.innerHeight - EDGE_GAP;

        if (rect.left < EDGE_GAP) shiftX = EDGE_GAP - rect.left;
        else if (rect.right > maxRight) shiftX = maxRight - rect.right;

        if (rect.top < EDGE_GAP) shiftY = EDGE_GAP - rect.top;
        else if (rect.bottom > maxBottom) shiftY = maxBottom - rect.bottom;

        tip.style.marginLeft = `${Math.round(shiftX)}px`;
        tip.style.marginTop = `${Math.round(shiftY)}px`;
      }
    });
  }

  function positionFixedActionTip(tip) {
    const item = tip.closest(".action-item");
    const button = item?.querySelector(".action-btn");
    if (!button) return;

    const buttonRect = button.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    if (!tipRect.width || !tipRect.height) return;

    const dock = shadow.querySelector('[data-role="dock"]');
    const preferLeft = dock?.classList.contains("dock-left");
    const dockUp = dock?.classList.contains("dock-up");
    const edgeAlignedTip = tip.classList.contains("quick-tip") || tip.classList.contains("smart-tip");
    const gap = 14;
    const width = tipRect.width;
    const height = tipRect.height;

    let left = preferLeft ? buttonRect.left - width - gap : buttonRect.right + gap;
    if (left < EDGE_GAP || left + width > window.innerWidth - EDGE_GAP) {
      left = preferLeft ? buttonRect.right + gap : buttonRect.left - width - gap;
    }

    let top = edgeAlignedTip
      ? (dockUp ? buttonRect.bottom - height : buttonRect.top)
      : buttonRect.top + buttonRect.height / 2 - height / 2;
    left = clamp(left, EDGE_GAP, window.innerWidth - width - EDGE_GAP);
    top = clamp(top, EDGE_GAP, window.innerHeight - height - EDGE_GAP);

    tip.style.position = "fixed";
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.style.right = "auto";
    tip.style.bottom = "auto";
    tip.style.marginLeft = "0px";
    tip.style.marginTop = "0px";
    tip.style.transform = "scale(1)";
  }

  function rememberPointer(e) {
    if (!e) return;
    lastPointer = { x: e.clientX, y: e.clientY };
  }

  function isHoverNodeVisible(node) {
    if (!node) return false;
    if (!node.classList?.contains("action-tip")) return true;
    const style = getComputedStyle(node);
    return style.visibility !== "hidden" && Number(style.opacity || 0) > 0.01;
  }

  function clearActionHideTimer() {
    if (actionHideTimer) clearTimeout(actionHideTimer);
    actionHideTimer = null;
  }

  function holdTicketPanel(ms = 3500) {
    ticketPanelHoldUntil = Date.now() + ms;
    clearActionHideTimer();
    state.menuOpen = true;
    state.activeAction = "ticket";
  }

  function bindDetachHandle(handle) {
    let pointerId = null;
    let start = null;
    let detached = false;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      pointerId = e.pointerId;
      start = { x: e.clientX, y: e.clientY };
      detached = false;
      handle.setPointerCapture?.(pointerId);
      e.stopPropagation();
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (pointerId !== e.pointerId || !start || detached) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
      detached = true;
      detachCurrentResult(handle.dataset.kind, {
        x: e.clientX - 205,
        y: e.clientY - 22
      });
    });
    const end = (e) => {
      if (pointerId !== e.pointerId) return;
      try { handle.releasePointerCapture?.(pointerId); } catch (_) {}
      pointerId = null;
      start = null;
      detached = false;
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      render();
    });
  }

  function detachCurrentResult(kind, position = null) {
    let panel = null;
    let toastText = "";

    if (kind === "quick") {
      if (state.busy.quick && activeQuickRun) {
        panel = createDetachedPanel({
          kind: "quick", status: "running", title: "快速研判",
          runId: activeQuickRun.id, loadingText: "分析中…", position,
          text: activeQuickRun?.sourceText || "", page: activeQuickRun?.page
        });
        activeQuickRun.detachedPanelId = panel.id;
        state.busy.quick = false;
        toastText = "已独立为研判窗口，可继续分析其他告警";
      } else if (state.quickResult) {
        panel = createDetachedPanel({ kind: "quick", status: "done", title: "快速研判", result: state.quickResult, position, text: state.pageText || "" });
        state.quickResult = null;
      }
    } else if (kind === "smart") {
      if (state.busy.smart && activeSmartRun) {
        panel = createDetachedPanel({
          kind: "smart", status: "running", title: "智能研判",
          runId: activeSmartRun.id, loadingText: "增强中…", position,
          text: activeSmartRun?.sourceText || "", page: activeSmartRun?.page
        });
        activeSmartRun.detachedPanelId = panel.id;
        state.busy.smart = false;
      } else if (state.analysisResult) {
        panel = createDetachedPanel({ kind: "smart", status: "done", title: "智能研判", result: state.analysisResult, position, text: state.pageText || "" });
        state.analysisResult = null;
      }
    }

    if (!panel) return;

    state.activeAction = null;
    state.menuOpen = false;

    // 手术式 DOM：把 dock 及其 fixed 子元素移出视口（不能 remove/display:none，否则 pointer capture 丢失），注入独立面板。
    const dock = shadow.querySelector('[data-role="dock"]');
    if (dock) {
      dock.style.position = "fixed";
      dock.style.left = "-9999px";
      dock.style.top = "-9999px";
      // result card 是 position:fixed（positionFixedActionTip 设置），不随 dock 移动，需单独移走
      const tips = dock.querySelectorAll('.action-tip[style*="position: fixed"]');
      for (const t of tips) { t.style.left = "-9999px"; t.style.top = "-9999px"; }
    }
    injectPanelToDOM(panel);

    if (toastText) showToast(toastText);
  }

  function createDetachedPanel(input) {
    const index = state.detachedPanels.length;
    const panel = {
      id: input.id || `panel-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      kind: input.kind || "quick",
      status: input.status || "done",
      title: input.title || panelKindLabel(input.kind),
      result: input.result || null,
      text: input.text || "",
      error: input.error || "",
      runId: input.runId || "",
      loadingText: input.loadingText || "",
      minimized: false,
      page: { url: location.href, title: document.title },
      createdAt: Date.now(),
      position: clampDetachedPosition(input.position || defaultDetachedPosition(index), false)
    };
    state.detachedPanels.unshift(panel);
    return panel;
  }

  function defaultDetachedPosition(index = 0) {
    const width = 390;
    const x = clamp(window.innerWidth - width - 96 - (index % 3) * 28, EDGE_GAP, window.innerWidth - 88);
    const y = clamp(EDGE_GAP + (index % 5) * 34, EDGE_GAP, window.innerHeight - 88);
    return { x: Math.round(x), y: Math.round(y) };
  }

  function updateDetachedPanel(id, updater) {
    const panel = state.detachedPanels.find((item) => item.id === id);
    if (!panel) return;
    updater(panel);
    panel.position = clampDetachedPosition(panel.position, panel.minimized);
    render();
  }

  function setDetachedRunResult(run, result) {
    const panel = state.detachedPanels.find((item) => item.id === run?.detachedPanelId);
    if (!panel) return false;
    panel.status = "done";
    panel.result = result;
    panel.error = "";
    panel.title = panel.title || panelKindLabel(panel.kind);
    render();
    return true;
  }

  function setDetachedRunError(run, error) {
    const panel = state.detachedPanels.find((item) => item.id === run?.detachedPanelId);
    if (!panel) return false;
    panel.status = "error";
    panel.error = error?.message || String(error || "分析失败");
    render();
    return true;
  }

  const dragBoundNodes = new WeakSet();

  // Bubble 是 <button> 但整体是 Click+Drag Surface，不能当做 Header Action 被排除
  function isPanelDragExcludedTarget(target, head, isBubble) {
    if (!target) return false;
    // Bubble 整体是交互表面，不排除
    if (isBubble && (target === head || head.contains(target))) return false;
    return !!target.closest("button,a,input,textarea,select,[role='button'],[data-no-drag]");
  }

  function bindPanelDrag(head) {
    if (!head || dragBoundNodes.has(head)) return;
    dragBoundNodes.add(head);

    let pointerId = null;
    let start = null;
    let origin = null;
    let dragMoved = false;
    let suppressClick = false;
    const panelNode = head.closest("[data-panel-id]") || head;
    const id = panelNode?.dataset.panelId;
    const isBubble = head.classList?.contains("detached-bubble");

    head.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (isPanelDragExcludedTarget(e.target, head, isBubble)) return;
      const panel = state.detachedPanels.find((item) => item.id === id);
      if (!panel) return;
      pointerId = e.pointerId;
      start = { x: e.clientX, y: e.clientY };
      origin = { ...panel.position };
      dragMoved = false;
      suppressClick = false;
      head.setPointerCapture?.(pointerId);
    });

    // 阻止浏览器原生文本拖拽和选中
    head.addEventListener("dragstart", (e) => e.preventDefault());
    head.addEventListener("selectstart", (e) => e.preventDefault());

    head.addEventListener("pointermove", (e) => {
      if (pointerId !== e.pointerId || !start || !origin) return;
      const panel = state.detachedPanels.find((item) => item.id === id);
      if (!panel) return;

      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (dx === 0 && dy === 0) return;

      if (!dragMoved) {
        dragMoved = true;
        if (panelNode) {
          panelNode.style.transition = "none";
          panelNode.style.cursor = "grabbing";
        }
        e.preventDefault();
      }

      panel.position = clampDetachedPosition({ x: origin.x + dx, y: origin.y + dy }, panel.minimized);
      const node = shadow.querySelector(`[data-panel-id="${cssEscape(id)}"]`);
      if (node) {
        node.style.left = `${panel.position.x}px`;
        node.style.top = `${panel.position.y}px`;
      }
    });

    // 单击 Header → 缩小/展开；拖动后不触发
    head.addEventListener("click", (e) => {
      if (isPanelDragExcludedTarget(e.target, head, isBubble)) return;
      if (suppressClick) { suppressClick = false; return; }
      if (isBubble) {
        updateDetachedPanel(panelNode?.dataset.panelId, (p) => { p.minimized = false; });
      } else {
        const panel = state.detachedPanels.find((item) => item.id === id);
        if (panel && !panel.minimized) {
          updateDetachedPanel(id, (p) => { p.minimized = true; });
        }
      }
    });

    const end = (e) => {
      if (pointerId !== e.pointerId) return;
      try { head.releasePointerCapture?.(pointerId); } catch (_) {}
      if (dragMoved) suppressClick = true;
      if (panelNode) {
        panelNode.style.transition = "";
        panelNode.style.cursor = "";
      }
      pointerId = null;
      start = null;
      origin = null;
      dragMoved = false;
    };
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  }

  function clampDetachedPosition(pos, minimized = false) {
    const maxX = window.innerWidth - (minimized ? 52 : 240) - EDGE_GAP;
    const maxY = window.innerHeight - (minimized ? 52 : 80) - EDGE_GAP;
    return {
      x: Math.round(clamp(Number(pos?.x) || EDGE_GAP, EDGE_GAP, Math.max(EDGE_GAP, maxX))),
      y: Math.round(clamp(Number(pos?.y) || EDGE_GAP, EDGE_GAP, Math.max(EDGE_GAP, maxY)))
    };
  }

  async function loadCorrelationItems() {
    const data = await chrome.storage.local.get(CORRELATION_KEY);
    const items = Array.isArray(data?.[CORRELATION_KEY]) ? data[CORRELATION_KEY] : [];
    state.correlationItems = items.filter((item) => item && typeof item === "object").slice(0, CORRELATION_LIMIT);
    return state.correlationItems;
  }

  async function saveCorrelationItems(items) {
    const next = (Array.isArray(items) ? items : []).slice(0, CORRELATION_LIMIT);
    state.correlationItems = next;
    await chrome.storage.local.set({ [CORRELATION_KEY]: next });
  }

  async function captureCorrelationClue() {
    const existing = await loadCorrelationItems();
    const text = collectPageText();
    if (!text || text.length < 12) {
      showToast("当前页面没有可采集的告警文本", true);
      return existing;
    }
    const hash = simpleHash(`${location.href}|${text}`);
    const clue = {
      id: `${Date.now()}-${hash}`,
      hash,
      title: document.title || `告警线索 ${existing.length + 1}`,
      url: location.href,
      summary: buildCorrelationClueSummary(text),
      text: text.slice(0, 24000),
      createdAt: Date.now()
    };
    const withoutSame = existing.filter((item) => item.hash !== hash);
    const next = [clue, ...withoutSame].slice(0, CORRELATION_LIMIT);
    await saveCorrelationItems(next);
    showToast(`已采集关联分析线索（${next.length} 条）`);
    return next;
  }

  function buildCorrelationClueSummary(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  function updatePanelInDOM(panel) {
    const old = shadow?.querySelector(`[data-panel-id="${cssEscape(panel.id)}"]`);
    if (old) old.remove();
    injectPanelToDOM(panel);
  }

  async function runCorrelationAnalysis() {
    const selected = await loadCorrelationItems();
    if (selected.length < 2) {
      showToast("请至少采集 2 条告警线索", true);
      return;
    }
    // 复用已有面板，避免重复创建；全程手术式 DOM，不触发 render()
    let panel = state.detachedPanels.find((p) => p.kind === "correlation" && p.status !== "error");
    if (panel) {
      panel.status = "running";
      panel.result = null;
      panel.error = "";
      panel.loadingText = `正在关联分析 ${selected.length} 条告警线索…`;
      panel.text = buildCorrelationSourceText(selected);
      updatePanelInDOM(panel);
    } else {
      panel = createDetachedPanel({
        kind: "correlation", status: "running", title: "关联分析",
        loadingText: `正在关联分析 ${selected.length} 条告警线索…`,
        text: buildCorrelationSourceText(selected)
      });
      state.activeAction = null;
      state.menuOpen = false;
      const dock = shadow.querySelector('[data-role="dock"]');
      if (dock) {
        dock.style.position = "fixed"; dock.style.left = "-9999px"; dock.style.top = "-9999px";
        const tips = dock.querySelectorAll('.action-tip[style*="position: fixed"]');
        for (const t of tips) { t.style.left = "-9999px"; t.style.top = "-9999px"; }
      }
      injectPanelToDOM(panel);
    }

    try {
      let resp = await send({
        type: "CORRELATE_ANALYZE",
        items: selected.map((item) => ({
          id: item.id, title: item.title,
          page: { url: item.url, title: item.title },
          text: item.text, summary: item.summary
        })),
        page: { url: location.href, title: document.title }
      });
      if (!resp.ok && /未知插件消息类型|不符合.*结构|parse|json/i.test(resp.error?.message || "")) {
        resp = await send({
          type: "QUICK_ANALYZE",
          text: buildCorrelationFallbackText(selected),
          page: { url: location.href, title: `关联分析：${document.title}`, detected_device: state.device?.name || "" }
        });
      }
      if (!resp.ok) throw new Error(resp.error?.message || "关联分析失败");
      panel.status = "done";
      panel.result = resp.data;
      updatePanelInDOM(panel);
      saveOperationHistory("correlation", resp.data);
      flashPetStatus("success");
    } catch (e) {
      panel.status = "error";
      panel.error = e.message;
      updatePanelInDOM(panel);
      flashPetStatus("error");
    }
  }

  // 绕过 render() 直接将单个面板 HTML 注入 shell DOM，避免 innerHTML 全量重建导致的闪烁。
  function injectPanelToDOM(panel) {
    const shellEl = shadow?.querySelector(".shell");
    if (!shellEl) return;
    const html = renderDetachedPanel(panel);
    // 创建临时容器解析 HTML
    const temp = document.createElement("div");
    temp.innerHTML = html;
    const node = temp.firstElementChild;
    if (!node) return;
    // 插入到 toast 之前（toast 在最顶层）
    const toast = shellEl.querySelector(".toast");
    if (toast) shellEl.insertBefore(node, toast);
    else shellEl.appendChild(node);
    // 为注入的节点绑定拖拽和按钮事件
    bindDetachedPanelNode(node, panel);
  }

  // 统一 Drag Handle 定位：全量 render 和手术式 inject 两条路径复用同一规则
  function getPanelDragHandle(node) {
    if (!node) return null;
    if (node.matches(".detached-bubble")) return node;
    return node.querySelector('[data-role="panel-drag"]');
  }

  function bindDetachedDragForNode(node) {
    const handle = getPanelDragHandle(node);
    if (handle) bindPanelDrag(handle);
    return handle;
  }

  function bindDetachedPanelNode(node, panel) {
    const id = panel.id;
    const kind = panel.kind;
    const head = bindDetachedDragForNode(node);
    bindPanelIconTooltips(node);

    // 关闭
    node.querySelector('[data-act="panel-close"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      state.detachedPanels = state.detachedPanels.filter((p) => p.id !== id);
      node.remove();
      // 清理拖拽分离时遗留的屏幕外 dock
      const offDock = shadow.querySelector('[data-role="dock"]');
      if (offDock && offDock.style.left === "-9999px") offDock.remove();
    });

    // 复制研判结果（quick / smart / correlation 面板）
    node.querySelector('[data-act="panel-copy"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      await copyPanelResult(id);
    });

    // 查看采集原文
    node.querySelector('[data-act="panel-show-source-text"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      showPanelSourceText(id);
    });

    // 查看历史详情
    node.querySelector('[data-act="panel-history-detail"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const p = state.detachedPanels.find((item) => item.id === id);
      if (!p?.result) return;
      await openHistoryDetailForResult(p.kind, p.result);
    });

    // 重新研判（quick / smart 面板）
    node.querySelector('[data-act="panel-rerun"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const rerunKind = e.currentTarget?.dataset?.kind || kind;
      if (rerunKind === "correlate-run") {
        await runCorrelationAnalysis();
        return;
      }
      state.menuOpen = true;
      state.activeAction = rerunKind || "quick";
      await analyze(rerunKind || "quick");
    });

    // 复制文本（text 面板专用）
    node.querySelector('[data-act="panel-copy-text"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const p = state.detachedPanels.find((item) => item.id === id);
      const t = p?.text || "";
      if (!t.trim()) return showToast("暂无可复制的采集文本", true);
      await navigator.clipboard.writeText(t).catch(() => {});
      showToast("采集文本已复制");
    });

  }

  function showCollectedTextPanel() {
    const text = state.pageText || collectPageText();
    if (!text || text.trim().length < 2) {
      showToast("当前页面暂无可查看的采集文本", true);
      return;
    }
    const existing = state.detachedPanels.find((panel) => panel.kind === "text" && panel.page?.url === location.href);
    if (existing) {
      // 已存在则移除旧 DOM 节点，更新面板数据，再注入新 DOM——全程不触发 render()
      const oldNode = shadow.querySelector(`[data-panel-id="${cssEscape(existing.id)}"]`);
      if (oldNode) oldNode.remove();
      existing.text = text;
      existing.minimized = false;
      existing.createdAt = Date.now();
      existing.position = defaultDetachedPosition(0);
      state.detachedPanels = [existing, ...state.detachedPanels.filter((p) => p.id !== existing.id)];
      injectPanelToDOM(existing);
    } else {
      const panel = createDetachedPanel({
        kind: "text",
        status: "done",
        title: "采集文本",
        text,
        position: defaultDetachedPosition(state.detachedPanels.length)
      });
      injectPanelToDOM(panel);
    }
  }

  function showPanelSourceText(panelId) {
    const panel = state.detachedPanels.find((item) => item.id === panelId);
    const text = panel?.text || "";
    if (!text.trim()) {
      showToast("暂无可查看的采集原文", true);
      return;
    }
    const newPanel = createDetachedPanel({
      kind: "text",
      status: "done",
      title: `${panelKindLabel(panel.kind)}原文`,
      text,
      position: defaultDetachedPosition(state.detachedPanels.length)
    });
    injectPanelToDOM(newPanel);
  }

  async function showWidgetDetail(action) {
    const normalized = normalizeWidgetAction(action);
    if (!normalized) return;
    if (normalized === "correlate" || normalized === "correlate-run") await loadCorrelationItems();
    if (!host) mountWidget();
    state.visible = true;
    state.menuOpen = true;
    state.activeAction = normalized === "correlate" || normalized === "correlate-run" ? "correlate" : normalized;
    if (normalized === "ticket") {
      ensureMessageTemplates().catch((err) => console.debug("EFF Assistant: template sync skipped", err?.message || err));
    }
    render();
  }

  async function runWidgetAction(action) {
    const normalized = normalizeWidgetAction(action);
    if (!normalized) throw new Error("未知助手操作");
    await showWidgetDetail(normalized);
    if (normalized === "quick") await analyze("quick");
    else if (normalized === "smart") await analyze("smart");
    else if (normalized === "ticket") await createTicket();
    else if (normalized === "correlate") await captureCorrelationClue();
    else if (normalized === "correlate-run") await runCorrelationAnalysis();
    render();
    return actionStatus(normalized);
  }

  function normalizeWidgetAction(action) {
    const value = String(action || "").trim();
    if (value === "quick" || value === "smart" || value === "ticket" || value === "correlate" || value === "correlate-run") return value;
    if (value === "correlation") return "correlate";
    return "";
  }

  function actionStatus(action) {
    const normalized = normalizeWidgetAction(action);
    const quick = state.quickResult || {};
    const smart = state.analysisResult || {};
    const ticket = state.ticketResult || {};
    const status = normalized === "quick"
      ? (state.busy.quick ? "running" : state.quickResult ? "done" : "idle")
      : normalized === "smart"
        ? (state.busy.smart ? "running" : state.analysisResult ? "done" : "idle")
        : normalized === "ticket"
          ? (state.busy.ticket ? "running" : state.ticketResult ? "done" : "idle")
          : "done";
    const result = normalized === "quick" ? quick : normalized === "smart" ? smart : normalized === "ticket" ? ticket : null;
    const labels = Array.isArray(result?.verdict_labels) ? result.verdict_labels : [];
    return {
      action: normalized === "correlate-run" ? "correlate" : normalized,
      status,
      summary: normalized === "correlate" || normalized === "correlate-run"
        ? `${(state.correlationItems || []).length} 条关联线索`
        : firstNonEmpty(result?.summary, result?.conclusion, result?.alert_hash, result?.id, ""),
      labels,
      confidence: result?.confidence ?? null,
      risk: result?.risk_level || "",
      clueCount: (state.correlationItems || []).length,
      widget: widgetStatus()
    };
  }

  function panelKindLabel(kind) {
    return kind === "smart" ? "智能研判" : kind === "ticket" ? "生成工单" : kind === "correlation" ? "关联分析" : kind === "text" ? "采集文本" : "快速研判";
  }

  function renderPanelBubbleIcon(panel) {
    const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    switch (panel.kind) {
      case "quick": return svg('<polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>');     // bolt
      case "smart": return svg('<path d="M12 2l2.4 7.2h7.6l-6 4.8 2.4 7.2-6-4.8-6 4.8 2.4-7.2-6-4.8h7.6z"/>'); // sparkle
      case "correlation": return svg('<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><line x1="7" y1="7" x2="11" y2="17"/><line x1="17" y1="7" x2="13" y2="17"/>'); // network
      case "text": return svg('<path d="M4 3h16a1 1 0 011 1v16a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="12" y2="16"/>'); // file-text
      case "ticket": return svg('<path d="M4 4h16v4a3 3 0 000 6v4H4v-4a3 3 0 000-6V4z"/>'); // ticket
      default: return svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/>'); // generic
    }
  }

  function panelSummary(panel) {
    return firstNonEmpty(panel.result?.summary, panel.result?.conclusion, panel.page?.title, panelKindLabel(panel.kind));
  }

  function buildCorrelationFallbackText(items) {
    const alerts = items.map((item, index) => ({
      index: index + 1,
      title: item.title || `告警线索 ${index + 1}`,
      url: item.url || "",
      summary: item.summary || "",
      text: String(item.text || "").slice(0, 12000)
    }));
    return `关联分析任务：请对以下多个安全告警页面线索进行关联分析，判断是否同源攻击、同一攻击链、相同目标资产、相似手法或风险升级。请输出综合结论、置信度、风险等级、摘要和证据链。\n\n${JSON.stringify(alerts, null, 2)}`;
  }

  function buildCorrelationSourceText(items) {
    return (Array.isArray(items) ? items : []).map((item, index) => [
      `告警线索 ${index + 1}`,
      `标题：${item.title || "-"}`,
      `地址：${item.url || "-"}`,
      `摘要：${item.summary || "-"}`,
      "",
      item.text || ""
    ].join("\n")).join("\n\n------------------------------\n\n");
  }


  async function copyQuickResult() {
    const r = state.quickResult || {};
    const lines = [
      `页面类型：${r.page_type || ""}`,
      `研判路径：${r.stage_route_label || ""}`,
      `设备/来源：${r.device || ""}`,
      `源IP：${r.src_ip || ""}`,
      `目的IP：${r.dst_ip || ""}`,
      `事件：${r.event_type || ""}`,
      `研判标签：${(r.verdict_labels || ["无法确认"]).join("、")}`,
      `综合判断：${r.conclusion || ""}`,
      `置信度：${r.confidence == null ? "-" : r.confidence + "%"}`,
      `风险等级：${r.risk_level || ""}`,
      `结论摘要：${r.summary || ""}`,
      "证据链分析：",
      ...((r.analysis_steps || []).length
        ? r.analysis_steps.map((x, i) => `${i + 1}. ${x.title || "证据"}${x.status ? ` [${x.status}]` : ""}：${x.detail || ""}`)
        : (r.evidence || []).map((x, i) => `${i + 1}. ${x}`))
    ];
    await navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
    showToast("研判结果已复制");
  }

  async function copyPanelResult(panelId) {
    const panel = state.detachedPanels.find((item) => item.id === panelId);
    if (!panel?.result) return showToast("暂无可复制的研判结果", true);
    const r = panel.result || {};
    const isQuick = panel.kind === "quick";
    const isCorrelation = panel.kind === "correlation";
    const lines = isQuick ? [
      `页面类型：${r.page_type || ""}`,
      `研判路径：${r.stage_route_label || ""}`,
      `设备/来源：${r.device || ""}`,
      `源IP：${r.src_ip || ""}`,
      `目的IP：${r.dst_ip || ""}`,
      `事件：${r.event_type || ""}`,
      `研判标签：${(r.verdict_labels || ["无法确认"]).join("、")}`,
      `综合判断：${r.conclusion || ""}`,
      `置信度：${r.confidence == null ? "-" : r.confidence + "%"}`,
      `风险等级：${r.risk_level || ""}`,
      `结论摘要：${r.summary || ""}`,
      "证据链分析：",
      ...((r.analysis_steps || []).length
        ? r.analysis_steps.map((x, i) => `${i + 1}. ${x.title || "证据"}${x.status ? ` [${x.status}]` : ""}：${x.detail || ""}`)
        : (r.evidence || []).map((x, i) => `${i + 1}. ${x}`))
    ] : isCorrelation ? [
      `关联关系：${r.relation_verdict || correlationPrimaryLabels(r)[0] || "无法确认"}`,
      `攻击结果：${r.attack_outcome || correlationPrimaryLabels(r)[1] || "无法确认"}`,
      `风险变化：${r.risk_change || correlationPrimaryLabels(r)[2] || "无法确认"}`,
      `处置优先级：${r.priority || correlationPrimaryLabels(r)[3] || "无法确认"}`,
      `补充特征：${correlationOptionalLabels(r).join("、") || "-"}`,
      `综合判断：${r.conclusion || ""}`,
      `置信度：${r.confidence == null ? "-" : r.confidence + "%"}`,
      `风险等级：${r.risk_level || ""}`,
      `结论摘要：${r.summary || ""}`,
      "证据链分析：",
      ...((r.analysis_steps || []).length
        ? r.analysis_steps.map((x, i) => `${i + 1}. ${x.title || "证据"}${x.status ? ` [${x.status}]` : ""}：${x.detail || ""}`)
        : (r.evidence || []).map((x, i) => `${i + 1}. ${x}`))
    ] : [
      `结论：${r.conclusion || ""}`,
      `置信度：${r.confidence == null ? "-" : r.confidence + "%"}`,
      `风险等级：${r.risk_level || ""}`,
      `结论摘要：${r.summary || ""}`,
      "证据链分析：",
      ...((r.analysis_steps || []).length
        ? r.analysis_steps.map((x, i) => `${i + 1}. ${x.title || "证据"}${x.status ? ` [${x.status}]` : ""}：${x.detail || ""}`)
        : (r.evidence || []).map((x, i) => `${i + 1}. ${x}`))
    ];
    await navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
    showToast("研判结果已复制");
  }


  function bindAnalysisEvents() {
    shadow.querySelector('[data-act="analysis-close"]')?.addEventListener("click", () => {
      state.analysisOpen = false;
      render();
    });

    shadow.querySelector('[data-act="copy-analysis"]')?.addEventListener("click", async () => {
      const r = state.analysisResult || {};
      const text = [
        `结论：${r.conclusion || ""}`,
        `置信度：${r.confidence == null ? "-" : r.confidence + "%"}`,
        `风险等级：${r.risk_level || ""}`,
        `结论摘要：${r.summary || ""}`,
        "证据链分析：",
        ...((r.analysis_steps || []).length
          ? r.analysis_steps.map((x, i) => `${i + 1}. ${x.title || "证据"}${x.status ? ` [${x.status}]` : ""}：${x.detail || ""}`)
          : (r.evidence || []).map((x, i) => `${i + 1}. ${x}`))
      ].join("\n");
      await navigator.clipboard.writeText(text).catch(() => {});
      showToast("研判结果已复制");
    });

    shadow.querySelector('[data-act="open-workbench"]')?.addEventListener("click", () => {
      const url = state.analysisResult?.workbench_url || state.platform?.baseUrl;
      if (url) send({ type: "OPEN_URL", url });
    });
  }

  function bindOutsideInteractions() {
    if (outsideBound) return;
    outsideBound = true;

    // 全局记录指针坐标，用几何 Hover Zone 判断是否真的离开助手区域。
    document.addEventListener("pointermove", (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
      if (state.menuOpen && isPointerInsideAssistantHoverZone(e.clientX, e.clientY)) {
        clearActionHideTimer();
      }
    }, true);

    document.addEventListener("pointerdown", (e) => {
      if (!state.menuOpen || !host) return;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      if (path.includes(host)) return;
      state.menuOpen = false;
      state.activeAction = null;
      render();
    }, true);

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (state.menuOpen || state.analysisOpen) {
        state.menuOpen = false;
        state.activeAction = null;
        state.analysisOpen = false;
        render();
      }
    }, true);

    window.addEventListener("resize", () => {
      if (!state.petPosition) return;
      const clamped = clampPosition(state.petPosition);
      if (clamped.x !== state.petPosition.x || clamped.y !== state.petPosition.y) {
        state.petPosition = clamped;
        savePetPosition();
      }
      render();
    });
  }

  async function parseCurrentPage(force) {
    // 平台解析是增强能力，不应阻塞独立 Quick AI。未连接 EFF 时只缓存当前页面文本。
    if (!state.platform?.connected) {
      state.pageText = collectPageText();
      state.activity = "idle";
      render();
      return;
    }
    // 解析前若当前 content script 尚未识别设备，再拉一次 background 最新配置。
    if (!state.device) await refreshRuntimeState();
    if (!state.device) {
      state.activity = "idle";
      render();
      return;
    }

    const text = collectPageText();
    state.pageText = text;
    const key = `${state.device.id}|${state.selectedMessageTemplateId || "default"}|${location.href}|${simpleHash(text)}`;
    if (!force && state.lastPageKey === key && state.parseResult) return;
    state.lastPageKey = key;

    state.activity = "parsing";
    render();

    try {
      const resp = await send({
        type: "PARSE_PAGE",
        deviceId: state.device.id,
        messageTemplateId: state.selectedMessageTemplateId,
        text,
        page: { url: location.href, title: document.title }
      });
      if (!resp.ok) throw new Error(resp.error?.message || "解析失败");
      state.parseResult = resp.data;
      state.parseToken = resp.data?.parse_token || null;
      state.activity = "idle";
      render();
    } catch (e) {
      state.activity = "idle";
      render();
      showToast(`解析失败：${e.message}`, true);
    }
  }

  async function createTicket() {
    if (state.busy.ticket) return;
    if (!state.platform?.connected) {
      showToast("请先在插件设置中连接 EFF-Monitoring", true);
      return;
    }
    if (!state.device) {
      showToast("当前页面未识别设备，请先在平台设备配置中启用浏览器助手并配置设备 URL", true);
      return;
    }
    state.busy.ticket = true;
    state.activeAction = "ticket";
    render();

    try {
      if (!state.parseResult) await parseCurrentPage(true);
      const resp = await send({
        type: "CREATE_TICKET",
        parseToken: state.parseToken,
        deviceId: state.device.id,
        messageTemplateId: state.selectedMessageTemplateId,
        text: state.pageText || collectPageText(),
        page: { url: location.href, title: document.title }
      });
      if (!resp.ok) throw new Error(resp.error?.message || "生成工单失败");
      state.ticketResult = resp.data || null;
      state.busy.ticket = false;
      state.menuOpen = true;
      state.activeAction = "ticket";
      render();
      saveOperationHistory("ticket", resp.data);
      showToast(`工单已生成${resp.data?.alert_hash ? `：${resp.data.alert_hash}` : ""}`);
    } catch (e) {
      state.busy.ticket = false;
      render();
      showToast(`生成工单失败：${e.message}`, true);
    }
  }

  async function copyTicketMessage() {
    const text = state.ticketResult?.formatted_chat || state.parseResult?.formatted_chat || "";
    if (!text.trim()) {
      showToast("暂无可复制的格式化消息", true);
      return;
    }
    await navigator.clipboard.writeText(text).catch(() => {});
    showToast("格式化消息已复制");
  }

  async function sendTicketWebhook() {
    const alertId = state.ticketResult?.alert_id || state.ticketResult?.id;
    if (!alertId) {
      showToast("请先生成工单后再发送通报", true);
      return;
    }
    try {
      const resp = await send({
        type: "SEND_TICKET_WEBHOOK",
        alertId,
        messageTemplateId: state.selectedMessageTemplateId
      });
      if (!resp.ok) throw new Error(resp.error?.message || "发送通报失败");
      showToast("通报已发送");
    } catch (e) {
      showToast(`发送通报失败：${e.message}`, true);
    }
  }

  async function analyze(kind) {
    const isQuick = kind === "quick";
    const busyKey = isQuick ? "quick" : "smart";
    if (state.busy[busyKey]) return;

    // 先校验依赖，全部通过后再创建 run，避免 stale activeRun
    if (isQuick) {
      if (!(state.quickAI?.enabled && state.quickAI?.configured)) {
        showToast("尚未配置快速研判 AI，请在插件设置中完成配置", true);
        return;
      }
    } else {
      if (!state.platform?.connected) {
        showToast("请先在插件设置中连接 EFF-Monitoring", true);
        return;
      }
      if (!state.device) {
        showToast("当前页面未识别设备，请先配置设备 URL", true);
        return;
      }
      if (!state.platform?.platformAI) {
        showToast("EFF-Monitoring 平台 AI 当前不可用", true);
        return;
      }
    }

    const sourceText = collectPageText();
    const run = { id: `${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`, detachedPanelId: null, sourceText, page: { url: location.href, title: document.title } };
    if (isQuick) activeQuickRun = run;
    else activeSmartRun = run;

    state.busy[busyKey] = true;
    if (isQuick) {
      state.menuOpen = true;
      state.activeAction = "quick";
      // 重新研判时保留旧结果，loading 态会自然覆盖；避免详情卡闪烁消失。
      if (!state.quickResult) state.quickResult = null;
      quickResultHasBeenEntered = false;
      quickResultGraceUntil = Date.now() + 3000;
    } else {
      state.analysisOpen = false;
      state.menuOpen = true;
      state.activeAction = "smart";
      if (!state.analysisResult) state.analysisResult = null;
    }
    render();

    try {
      let msg;
      if (isQuick) {
        const pageText = collectPageText();
        state.pageText = pageText;
        if (!pageText || pageText.length < 12) throw new Error("当前页面没有可用于研判的可见文本");
        msg = {
          type: "QUICK_ANALYZE",
          text: pageText,
          page: {
            url: location.href,
            title: document.title,
            detected_device: state.device?.name || ""
          }
        };
      } else {
        if (!state.parseResult) await parseCurrentPage(true);
        msg = {
          type: "PLATFORM_ANALYZE",
          parseToken: state.parseToken,
          deviceId: state.device.id,
          text: state.pageText || collectPageText(),
          page: { url: location.href, title: document.title }
        };
      }

      const resp = await send(msg);
      if (!resp.ok) throw new Error(resp.error?.message || "研判失败");

      if (isQuick) {
        if (!setDetachedRunResult(run, resp.data)) {
          state.quickResult = resp.data;
          // 若另一方仍在运行则不抢占 menu，避免后完成者覆盖先完成者的 activeAction。
          if (!state.busy.smart) {
            state.menuOpen = true;
            state.activeAction = "quick";
          }
        }
        quickResultHasBeenEntered = false;
        quickResultGraceUntil = Date.now() + 3000;
        saveOperationHistory("quick", resp.data);
      } else {
        if (!setDetachedRunResult(run, resp.data)) {
          state.analysisResult = resp.data;
          state.analysisKind = "smart";
          state.analysisOpen = false;
          if (!state.busy.quick) {
            state.menuOpen = true;
            state.activeAction = "smart";
          }
        }
        saveOperationHistory("smart", resp.data);
      }
      if (isQuick && activeQuickRun === run) {
        state.busy.quick = false;
        activeQuickRun = null;
      } else if (!isQuick && activeSmartRun === run) {
        state.busy.smart = false;
        activeSmartRun = null;
      }
      flashPetStatus("success");
      render();
    } catch (e) {
      const detachedHandled = setDetachedRunError(run, e);
      if (isQuick && activeQuickRun === run) {
        state.busy.quick = false;
        activeQuickRun = null;
      } else if (!isQuick && activeSmartRun === run) {
        state.busy.smart = false;
        activeSmartRun = null;
      }
      flashPetStatus("error");
      render();
      if (!detachedHandled) showToast(`研判失败：${e.message}`, true);
    }
  }


  function collectPageText() {
    const oldDisplay = host ? host.style.display : null;
    if (host) host.style.display = "none";

    let text = "";
    try {
      text = document.body?.innerText || document.documentElement?.innerText || "";
    } finally {
      if (host) host.style.display = oldDisplay || "";
    }
    return normalizeText(text);
  }

  function restoreHistoryItem(item) {
    if (!item || !item.payload) return;
    if (!host) mountWidget();
    state.visible = true;
    state.menuOpen = true;
    state.analysisOpen = false;
    clearActionHideTimer();

    if (item.kind === "ticket") {
      state.ticketResult = item.payload.ticketResult || item.payload.result || null;
      if (item.payload.parseResult) state.parseResult = item.payload.parseResult;
      state.activeAction = "ticket";
      holdTicketPanel(3000);
    } else if (item.kind === "smart") {
      state.analysisResult = item.payload.analysisResult || item.payload.result || null;
      state.analysisKind = "smart";
      state.activeAction = "smart";
    } else if (item.kind === "correlation") {
      createDetachedPanel({
        kind: "correlation",
        status: "done",
        title: "关联分析",
        result: item.payload.result || null
      });
      state.activeAction = null;
      state.menuOpen = false;
    } else {
      state.quickResult = item.payload.quickResult || item.payload.result || null;
      state.activeAction = "quick";
      quickResultHasBeenEntered = false;
      quickResultGraceUntil = Date.now() + 3000;
    }

    applyVisibility();
    showToast("已恢复历史结果");
  }

  function saveOperationHistory(kind, result) {
    const item = buildHistoryItem(kind, result);
    rememberHistoryId(result, item.id);
    saveHistoryItemLocal(item).catch((e) => console.debug("EFF Assistant: save history skipped", e?.message || e));
    return item;
  }

  async function openHistoryDetailForResult(kind, result) {
    if (!result) return showToast("暂无可查看的详情", true);
    if (!result.__effHistoryId) {
      const item = buildHistoryItem(kind, result);
      rememberHistoryId(result, item.id);
      await saveHistoryItemLocal(item);
      await send({ type: "OPEN_HISTORY_DETAIL", id: item.id });
    } else {
      await send({ type: "OPEN_HISTORY_DETAIL", id: result.__effHistoryId });
    }
  }

  function rememberHistoryId(result, id) {
    if (!result || typeof result !== "object" || !id) return;
    try {
      Object.defineProperty(result, "__effHistoryId", {
        value: id,
        configurable: true,
        writable: true,
        enumerable: false
      });
    } catch (_) {
      result.__effHistoryId = id;
    }
  }

  async function saveHistoryItemLocal(item) {
    if (!chrome.storage?.local) return;
    const data = await chrome.storage.local.get(HISTORY_KEY);
    const history = Array.isArray(data?.[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
    const next = [item, ...history.filter((x) => x?.id !== item.id)].slice(0, HISTORY_LIMIT);
    await chrome.storage.local.set({ [HISTORY_KEY]: next });
  }

  function buildHistoryItem(kind, result) {
    const summary = historySummary(kind, result);
    const titleMap = { ticket: "生成工单", smart: "智能研判", quick: "快速研判", correlation: "关联分析" };
    return {
      id: `${Date.now()}-${kind}-${Math.random().toString(16).slice(2)}`,
      kind,
      title: titleMap[kind] || "操作记录",
      summary,
      createdAt: Date.now(),
      page: { url: location.href, title: document.title },
      payload: kind === "ticket"
        ? { ticketResult: result || null, parseResult: state.parseResult || null }
        : kind === "smart"
          ? { analysisResult: result || null }
          : kind === "correlation"
            ? { result: result || null }
            : { quickResult: result || null }
    };
  }

  function historySummary(kind, result) {
    if (kind === "ticket") {
      const summary = ticketSummaryData();
      return firstNonEmpty(
        result?.alert_hash && `工单已生成：${result.alert_hash}`,
        result?.message,
        `${summary.srcIp || "-"} → ${summary.dstIp || "-"} ${summary.eventType || ""}`.trim(),
        "工单已生成"
      );
    }
    const labels = Array.isArray(result?.verdict_labels) ? result.verdict_labels.join("、") : "";
    return firstNonEmpty(
      result?.summary,
      result?.conclusion,
      labels,
      kind === "smart" ? "智能研判完成" : kind === "correlation" ? "关联分析完成" : "快速研判完成"
    );
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/\t/g, " ")
      .replace(/[ ]{2,}/g, " ")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const text = String(value ?? "").trim();
      if (text) return text;
    }
    return "";
  }

  function startSpaWatcher() {
    setInterval(async () => {
      if (location.href !== state.currentUrl) {
        state.currentUrl = location.href;
        // SPA 跳转后重新获取 background 中最新 Device URL 配置。
        await refreshRuntimeState();
        state.device = detectDevice(location.href, state.devices) || null;
        state.parseResult = null;
        state.parseToken = null;
        state.pageText = "";
        state.lastPageKey = "";
        state.menuOpen = false;
        state.activeAction = null;
        state.analysisOpen = false;
        state.analysisResult = null;
        state.quickResult = null;
        state.activity = "idle";
        render();

        clearTimeout(refreshTimer);
        if (state.device) refreshTimer = setTimeout(() => parseCurrentPage(true), 900);
      }
    }, 1200);
  }

  function detectDevice(url, devices) {
    const matches = [];
    for (const d of devices || []) {
      for (const p of d.url_patterns || []) {
        if (matchGlob(url, p)) matches.push({ d, score: String(p).replace(/\*/g, "").length });
      }
    }
    matches.sort((a, b) => b.score - a.score);
    return matches[0]?.d || null;
  }

  function matchGlob(value, pattern) {
    try {
      const re = new RegExp("^" + String(pattern).split("*").map(escapeRegExp).join(".*") + "$", "i");
      return re.test(value);
    } catch (_) {
      return false;
    }
  }


  function closeTransientViews() {
    state.menuOpen = false;
    state.activeAction = null;
    state.analysisOpen = false;
  }

  function ensurePetPosition() {
    if (!state.petPosition) {
      state.petPosition = defaultPetPosition();
    }
    state.petPosition = clampPosition(state.petPosition);
  }

  function defaultPetPosition() {
    return {
      x: Math.max(EDGE_GAP, window.innerWidth - PET_SIZE - 28),
      y: Math.max(EDGE_GAP, window.innerHeight - PET_SIZE - 28)
    };
  }

  function normalizeSavedPosition(pos) {
    if (!pos || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))) return null;
    return clampPosition({ x: Number(pos.x), y: Number(pos.y) });
  }

  function clampPosition(pos) {
    return {
      x: Math.round(Math.min(Math.max(EDGE_GAP, Number(pos?.x) || 0), Math.max(EDGE_GAP, window.innerWidth - PET_SIZE - EDGE_GAP))),
      y: Math.round(Math.min(Math.max(EDGE_GAP, Number(pos?.y) || 0), Math.max(EDGE_GAP, window.innerHeight - PET_SIZE - EDGE_GAP)))
    };
  }

  async function savePetPosition() {
    if (!state.petPosition) return;
    await send({ type: "SAVE_UI_STATE", ui: { petPosition: state.petPosition } });
  }

  function dockPlacement(actionCount = 3) {
    const pet = state.petPosition;
    const width = 46;
    const buttonHeight = 42;
    const buttonGap = 4;
    const petGap = 4;
    const tipGap = 14;
    const height = Math.max(buttonHeight, actionCount * buttonHeight + Math.max(0, actionCount - 1) * buttonGap);
    const maxTipWidth = Math.min(384, Math.max(240, window.innerWidth - EDGE_GAP * 2 - width - 12));
    const leftNeed = width + tipGap + maxTipWidth;
    const rightNeed = width + tipGap + maxTipWidth;
    const leftSpace = pet.x - EDGE_GAP;
    const rightSpace = window.innerWidth - (pet.x + PET_SIZE) - EDGE_GAP;
    let rightHalf = pet.x + PET_SIZE / 2 > window.innerWidth / 2;
    if (rightHalf && leftSpace < leftNeed && rightSpace > leftSpace) rightHalf = false;
    if (!rightHalf && rightSpace < rightNeed && leftSpace > rightSpace) rightHalf = true;
    const bottomHalf = pet.y + PET_SIZE / 2 > window.innerHeight / 2;
    let left = rightHalf ? pet.x - width - petGap : pet.x + PET_SIZE + petGap;
    let top = pet.y + PET_SIZE / 2 - height / 2;
    const minLeft = rightHalf ? EDGE_GAP + maxTipWidth + tipGap : EDGE_GAP;
    const maxLeft = rightHalf ? window.innerWidth - width - EDGE_GAP : window.innerWidth - width - maxTipWidth - tipGap - EDGE_GAP;
    left = clamp(left, minLeft, maxLeft);
    top = clamp(top, EDGE_GAP, window.innerHeight - height - EDGE_GAP);
    return { left: Math.round(left), top: Math.round(top), side: rightHalf ? "dock-left" : "dock-right", vertical: bottomHalf ? "dock-up" : "dock-down" };
  }

  function panelPlacement(width, height) {
    const pet = state.petPosition;
    const bottomHalf = pet.y + PET_SIZE / 2 > window.innerHeight / 2;
    const rightHalf = pet.x + PET_SIZE / 2 > window.innerWidth / 2;

    let top = bottomHalf ? pet.y - height - PANEL_GAP : pet.y + PET_SIZE + PANEL_GAP;
    let left = rightHalf ? pet.x + PET_SIZE - width : pet.x;

    left = clamp(left, EDGE_GAP, window.innerWidth - width - EDGE_GAP);
    top = clamp(top, EDGE_GAP, window.innerHeight - height - EDGE_GAP);

    return { left: Math.round(left), top: Math.round(top) };
  }

  function toastPlacement() {
    const width = 260;
    const height = 40;
    const p = panelPlacement(width, height);
    return p;
  }


  function estimateAnalysisHeight(result) {
    const evidenceCount = Math.min((result?.evidence || []).length, 6);
    const summaryLen = String(result?.summary || "").length;
    return Math.min(520, 285 + evidenceCount * 28 + Math.min(70, Math.ceil(summaryLen / 26) * 18));
  }


  function isAnyActionBusy() {
    return !!(state.busy.ticket || state.busy.smart || state.busy.quick);
  }

  function petStatusClass() {
    if (isAnyActionBusy() || state.activity === "parsing") return "working";
    if (!state.platform?.connected) return "disconnected";
    if (!state.device) return "unrecognized";
    if (state.parseResult) return "ready";
    return "connected";
  }

  function petTooltip() {
    if (state.busy.quick) return "EFF Assistant：正在快速研判";
    if (state.busy.smart) return "EFF Assistant：正在智能研判";
    if (state.busy.ticket) return "EFF Assistant：正在生成工单";
    if (state.activity === "parsing") return "EFF Assistant：正在解析当前页面";
    if (!state.platform?.connected) return "EFF Assistant：平台未连接";
    if (!state.device) return "EFF Assistant：当前页面未识别设备";
    return `EFF Assistant：${state.device.name}（悬停显示快捷操作）`;
  }

  function statusText() {
    if (!state.platform?.connected) return "平台未连接";
    if (!state.device) return "当前 URL 未匹配已启用浏览器助手的设备";
    if (isAnyActionBusy()) return "处理中…";
    if (!state.parseResult) return "正在读取并解析当前页面";
    const f = state.parseResult.fields || {};
    const count = [f.src_ip, f.dst_ip, f.event_type].filter(Boolean).length;
    return count === 3 ? "已识别当前告警" : `已识别设备，解析字段 ${count}/3`;
  }

  function showTooltip(btn, text) {
    if (!btn?.isConnected) return;
    const layer = shadow.querySelector(".eff-tooltip-layer");
    if (!layer) return;
    activeTooltipAnchor = btn;
    const rect = btn.getBoundingClientRect();
    const tipW = 140;
    const tipH = 26;
    const gap = 7;
    // 默认显示在按钮上方，空间不够则显示在下方
    let top = rect.top - tipH - gap;
    if (top < 6) top = rect.bottom + gap;
    let left = rect.left + rect.width / 2 - tipW / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - tipW - 6));
    tooltipState = { visible: true, text, x: Math.round(left), y: Math.round(top) };
    layer.innerHTML = `<div class="eff-tooltip" style="left:${tooltipState.x}px;top:${tooltipState.y}px">${escapeHtml(text)}</div>`;
  }

  function clearTooltipTimers() {
    if (tooltipShowTimer) { clearTimeout(tooltipShowTimer); tooltipShowTimer = null; }
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
  }

  function hideActiveTooltip() {
    clearTooltipTimers();
    activeTooltipAnchor = null;
    tooltipState = { visible: false, text: "", x: 0, y: 0 };
    const layer = shadow?.querySelector(".eff-tooltip-layer");
    if (layer) layer.innerHTML = "";
  }

  function hideTooltip() {
    clearTooltipTimers();
    tooltipHideTimer = setTimeout(() => {
      tooltipHideTimer = null;
      hideActiveTooltip();
    }, 80);
  }

  function bindPanelIconTooltips(root) {
    if (!root) return;
    root.querySelectorAll(".panel-icon-btn[data-tooltip]").forEach((btn) => {
      if (btn.dataset.tooltipBound === "1") return;
      btn.dataset.tooltipBound = "1";
      btn.addEventListener("mouseenter", () => {
        clearTooltipTimers();
        const anchor = btn;
        tooltipShowTimer = setTimeout(() => {
          tooltipShowTimer = null;
          if (!anchor.isConnected) return;
          showTooltip(anchor, anchor.dataset.tooltip);
        }, 300);
      });
      btn.addEventListener("mouseleave", hideTooltip);
      btn.addEventListener("pointerdown", hideActiveTooltip);
    });
  }

  function flashPetStatus(status, duration = 1200) {
    state._petFlash = status;
    clearTimeout(petFlashTimer);
    render();
    petFlashTimer = setTimeout(() => {
      state._petFlash = "";
      render();
      petFlashTimer = null;
    }, duration);
  }

  function showToast(text, error = false) {
    // 手术式注入 toast，不触发全量 render()，避免无谓的 DOM 重建闪烁。
    state.toast = null; // 防止后续 render 重复创建
    const old = shadow?.querySelector(".toast");
    if (old) old.remove();
    clearTimeout(toastTimer);
    const el = document.createElement("div");
    el.className = `toast${error ? " error" : ""}`;
    const pos = toastPlacement();
    el.style.cssText = `left:${pos.left}px;top:${pos.top}px`;
    el.textContent = text;
    shadow?.querySelector(".shell")?.appendChild(el);
    toastTimer = setTimeout(() => {
      el.remove();
      toastTimer = null;
    }, 2800);
  }

  function widgetStatus() {
    const f = state.parseResult?.fields || {};
    return {
      ok: true,
      loaded: true,
      visible: !!state.visible,
      collapsed: true,
      menuOpen: !!state.menuOpen,
      analysisOpen: !!state.analysisOpen,
      petPosition: state.petPosition ? { ...state.petPosition } : null,
      device: state.device ? { id: state.device.id, name: state.device.name } : null,
      parsed: !!state.parseResult,
      fields: {
        src_ip: f.src_ip || "",
        dst_ip: f.dst_ip || "",
        event_type: f.event_type || ""
      },
      pageTextLength: state.pageText?.length || 0,
      status: statusText()
    };
  }

  function positionStyle(pos) {
    return `left:${Math.round(pos.x)}px;top:${Math.round(pos.y)}px`;
  }

  function themeClass() {
    return normalizeTheme(state.theme) === "light" ? "light" : "dark";
  }

  function normalizeTheme(value) {
    return value === "light" ? "light" : "dark";
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function simpleHash(str) {
    let h = 2166136261;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function send(message, timeoutMs) {
    if (contextLost) return Promise.resolve({ ok: false, error: { kind: "context_lost", message: "插件已重载，请刷新页面" } });
    const ms = timeoutMs || SEND_TIMEOUTS[message?.type] || SEND_TIMEOUTS.default;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, error: { kind: "timeout", message: "插件后台响应超时" } });
      }, ms);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || "";
            if (/context invalidated|extension context/i.test(msg)) contextLost = true;
            resolve({ ok: false, error: { message: msg } });
          } else {
            resolve(response || { ok: false, error: { message: "插件后台无响应" } });
          }
        });
      } catch (e) {
        clearTimeout(timer);
        if (/extension context invalidated/i.test(e?.message || "")) contextLost = true;
        resolve({ ok: false, error: { kind: "context_lost", message: "插件已重载，请刷新页面" } });
      }
    });
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;"
    }[c]));
  }

  function styles() {
    return `
      :host{all:initial}
      *{box-sizing:border-box}
      button{font:inherit}
      .shell{position:fixed;inset:0;pointer-events:none;font-family:Inter,"PingFang SC","Microsoft YaHei",Arial,sans-serif;color:#edf5ff;font-size:13px}

      .pet{position:fixed;width:${PET_SIZE}px;height:${PET_SIZE}px;border-radius:50%;pointer-events:auto;cursor:grab;touch-action:none;user-select:none;filter:drop-shadow(0 12px 22px rgba(0,0,0,.38));transition:filter .18s ease,transform .18s ease}
      .pet:hover{transform:translateY(-1px);filter:drop-shadow(0 15px 26px rgba(0,0,0,.44))}
      .pet.drag-ready{cursor:grabbing}.pet.dragging{cursor:grabbing;transform:scale(1.04);transition:none}
      .pet-core{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 50% 35%,#274d78 0,#13253f 52%,#07111f 100%);border:2px solid #43b7ff;box-shadow:0 0 0 3px rgba(50,139,241,.13),0 0 26px rgba(55,167,255,.46),inset 0 1px 10px rgba(126,222,255,.12);display:flex;align-items:center;justify-content:center}
      .pet-face{width:36px;height:27px;border-radius:13px;background:linear-gradient(180deg,#081826,#06111e);border:1px solid rgba(113,207,255,.7);display:flex;align-items:center;justify-content:center;gap:9px;box-shadow:inset 0 0 12px rgba(47,168,244,.1)}
      .pet-face span{width:6px;height:10px;border-radius:4px;background:#76efff;box-shadow:0 0 10px #37cfff}
      .pet-tail{position:absolute;left:50%;bottom:-10px;transform:translateX(-50%);width:0;height:0;border-left:9px solid transparent;border-right:9px solid transparent;border-top:10px solid var(--eff-tail-idle);filter:drop-shadow(0 0 6px var(--eff-tail-glow));transition:border-top-color .18s ease,filter .18s ease}
      .pet-status{position:absolute;right:0;top:1px;width:11px;height:11px;border-radius:50%;background:#5f7188;border:2px solid #08111e;box-shadow:0 0 8px rgba(95,113,136,.5)}
      .pet.ready .pet-status,.pet.connected .pet-status{background:#2bd99b;box-shadow:0 0 9px rgba(43,217,155,.8)}
      .pet.disconnected .pet-status{background:#ff6672;box-shadow:0 0 9px rgba(255,102,114,.75)}
      .pet.unrecognized .pet-status{background:#ffbd55;box-shadow:0 0 9px rgba(255,189,85,.65)}
      .pet.working .pet-core{animation:petPulse 1.05s ease-in-out infinite alternate;border-color:#9f79ff;box-shadow:0 0 0 3px rgba(115,84,236,.14),0 0 30px rgba(130,83,245,.58)}
      .pet.working .pet-status{background:#9d79ff;box-shadow:0 0 10px rgba(157,121,255,.8)}
      .pet.working .pet-tail{border-top-color:var(--eff-tail-analyzing);filter:drop-shadow(0 0 8px var(--eff-tail-analyzing-glow));animation:tailPulse 1.6s ease-in-out infinite}
      .pet[data-pet-status="success"] .pet-tail{border-top-color:var(--eff-tail-success);filter:drop-shadow(0 0 6px var(--eff-tail-success-glow));animation:none}
      .pet[data-pet-status="error"] .pet-tail{border-top-color:var(--eff-tail-error);filter:drop-shadow(0 0 6px var(--eff-tail-error-glow));animation:none}
      @keyframes petPulse{from{transform:scale(.96)}to{transform:scale(1.035)}}
      @keyframes tailPulse{0%,100%{opacity:.75}50%{opacity:1}}

      .action-cluster{position:fixed;width:46px;display:flex;flex-direction:column;gap:4px;pointer-events:auto;animation:popIn .14s ease-out}
      .action-item{position:relative;pointer-events:auto}
      /* 扩大 Hover Bridge；配合 JS 逻辑 Hover Zone，消除按钮与结果卡之间的交互断层。 */
      .quick-item::after,.ticket-item::after,.smart-item::after,.correlate-item::after{content:"";position:absolute;top:-14px;bottom:-14px;width:42px;pointer-events:auto;z-index:1}
      .action-cluster.dock-left .quick-item::after{right:100%}
      .action-cluster.dock-right .quick-item::after{left:100%}
      .action-cluster.dock-left .ticket-item::after{right:100%}
      .action-cluster.dock-right .ticket-item::after{left:100%}
      .action-cluster.dock-left .smart-item::after{right:100%}
      .action-cluster.dock-right .smart-item::after{left:100%}
      .action-cluster.dock-left .correlate-item::after{right:100%}
      .action-cluster.dock-right .correlate-item::after{left:100%}
      .action-btn{width:46px;height:42px;border:1px solid transparent;border-radius:13px;display:flex;align-items:center;justify-content:center;padding:0;color:#fff;cursor:pointer;box-shadow:0 10px 24px rgba(0,0,0,.30);transition:transform .13s ease,filter .13s ease,box-shadow .13s ease}
      .action-btn:hover:not(:disabled){transform:translateY(-1px) scale(1.025);filter:brightness(1.08);box-shadow:0 13px 30px rgba(0,0,0,.38)}
      .action-btn.active{box-shadow:0 0 0 2px rgba(255,255,255,.18),0 14px 32px rgba(0,0,0,.42);filter:brightness(1.08)}
      .action-btn:disabled{opacity:.42;cursor:not-allowed}
      .action-icon{width:24px;text-align:center;font-size:16px;opacity:.98}
      .action-btn.ticket{background:linear-gradient(135deg,#2f6b9d,#3756ad);border-color:#6fa7e8}
      .action-btn.smart{background:linear-gradient(135deg,#2f6b9d,#3756ad);border-color:#6fa7e8}
      .action-btn.quick{background:linear-gradient(135deg,#2f6b9d,#3756ad);border-color:#6fa7e8}
      .action-btn.correlate{background:linear-gradient(135deg,#2f6b9d,#3756ad);border-color:#6fa7e8}
      .action-tip{position:absolute;top:50%;width:238px;transform:translateY(-50%) scale(.97);padding:10px 11px;border-radius:10px;background:rgba(9,19,33,.985);border:1px solid rgba(91,151,220,.38);box-shadow:0 14px 34px rgba(0,0,0,.42);opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease,transform .12s ease;z-index:2}
      .action-tip strong{display:block;color:#f0f6ff;font-size:11px;margin-bottom:4px}.action-tip span{display:block;color:#9eb1c7;font-size:10px;line-height:1.5}
      .action-cluster.dock-left .action-tip{right:calc(100% + 14px)}
      .action-cluster.dock-right .action-tip{left:calc(100% + 14px)}
      .action-item:hover .action-tip{opacity:1;visibility:visible;transform:translateY(-50%) scale(1)}
      .action-tip.force-visible{opacity:1;visibility:visible;transform:translateY(-50%) scale(1)}
      /* 运行中/已有结果时结果卡由状态驱动常驻可见，不再依赖 CSS :hover 链路。 */
      .quick-tip.interactive.force-visible{opacity:1;visibility:visible}
      .ticket-tip.interactive.force-visible{opacity:1;visibility:visible}
      .smart-tip.interactive.force-visible{opacity:1;visibility:visible}
      .action-cluster.dock-left .quick-tip.interactive.force-visible{transform:translateY(-50%) scale(1)}
      .action-cluster.dock-right .quick-tip.interactive.force-visible{transform:translateY(-50%) scale(1)}
      .action-cluster.dock-left .ticket-tip.interactive.force-visible{transform:translateY(-50%) scale(1)}
      .action-cluster.dock-right .ticket-tip.interactive.force-visible{transform:translateY(-50%) scale(1)}
      .action-cluster.dock-left .smart-tip.interactive.force-visible{transform:translateY(-50%) scale(1)}
      .action-cluster.dock-right .smart-tip.interactive.force-visible{transform:translateY(-50%) scale(1)}
      .ticket-tip.interactive{width:min(292px,calc(100vw - 166px));max-height:min(520px,calc(100vh - 28px));overflow:auto;pointer-events:auto;padding:12px;border-color:rgba(96,161,236,.46);box-shadow:0 18px 42px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.025)}
      .ticket-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}.ticket-card-head>strong{margin:0!important;color:#f1f7ff!important;font-size:12px!important}.ticket-state{display:inline-flex;padding:3px 7px;border-radius:999px;background:rgba(106,125,148,.14);color:#a9bbce;font-size:9px}.ticket-state.ok{color:#72dda9;background:rgba(43,217,155,.12)}.ticket-state.running{color:#c1a9ff;background:rgba(157,121,255,.14)}
      .ticket-kv{display:grid;grid-template-columns:48px 1fr;gap:8px;align-items:center;min-height:30px;padding:5px 7px;border:1px solid rgba(93,145,204,.14);border-radius:8px;background:rgba(49,85,126,.08);margin-top:5px}.ticket-kv span{color:#8ca2b9!important;font-size:9.5px!important}.ticket-kv b{min-width:0;color:#edf5ff;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ticket-kv-stack{align-items:start;padding-top:7px;padding-bottom:7px}.ticket-kv-stack>div{min-width:0}.ticket-ip-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:5px}.ticket-ip-tags em{font-style:normal;max-width:112px;padding:2px 6px;border-radius:6px;background:rgba(92,160,230,.12);border:1px solid rgba(96,166,235,.2);color:#a9cef4;font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ticket-tags{display:flex;gap:5px;flex-wrap:wrap;margin:8px 0 2px}.ticket-tags em{font-style:normal;max-width:124px;padding:3px 7px;border-radius:7px;background:rgba(78,143,212,.11);border:1px solid rgba(96,166,235,.18);color:#a9cef4;font-size:8.7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ticket-ip-tags em.tag-blacklist,.ticket-tags em.tag-blacklist{color:#ffdce0;background:linear-gradient(135deg,rgba(222,57,80,.34),rgba(116,25,42,.24));border-color:rgba(255,98,116,.64);box-shadow:0 0 0 1px rgba(255,98,116,.12),0 0 12px rgba(222,57,80,.20);font-weight:800}
      .ticket-ip-tags em.tag-whitelist,.ticket-tags em.tag-whitelist{color:#c8ffe4;background:linear-gradient(135deg,rgba(31,184,118,.28),rgba(18,99,75,.22));border-color:rgba(79,226,158,.58);box-shadow:0 0 0 1px rgba(79,226,158,.10),0 0 12px rgba(43,217,155,.18);font-weight:800}
      .ticket-ip-tags em.tag-critical,.ticket-tags em.tag-critical{color:#ffd58a;background:rgba(231,153,54,.15);border-color:rgba(246,176,75,.35);font-weight:700}
      .ticket-template{display:block;margin-top:8px}.ticket-template>span{display:block!important;margin-bottom:4px;color:#8ca2b9!important;font-size:9.5px!important}.ticket-template select{width:100%;height:28px;border-radius:7px;border:1px solid rgba(93,145,204,.28);background:#101f34;color:#e5eef8;font-size:10px;padding:0 8px;outline:none}
      .ticket-hash{margin-top:8px;padding:6px 8px;border-radius:7px;background:rgba(43,217,155,.09);border:1px solid rgba(43,217,155,.2);color:#88e6b7;font-size:9.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ticket-actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:9px}.ticket-actions button{height:28px;border:1px solid #344d6b;border-radius:7px;background:#14243a;color:#d6e4f1;font-size:9px;font-weight:650;cursor:pointer}.ticket-actions button:first-child{background:#176fe0;border-color:#5a9aff;color:#fff}.ticket-actions button:disabled{opacity:.42;cursor:not-allowed}.ticket-actions button:hover:not(:disabled){filter:brightness(1.1)}
      .smart-tip.interactive{width:min(344px,calc(100vw - 176px));max-height:min(540px,calc(100vh - 28px));overflow:auto;pointer-events:auto;padding:13px 14px;border-color:rgba(157,121,255,.48);box-shadow:0 18px 42px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.025)}
      .quick-tip.interactive{width:min(344px,calc(100vw - 176px));max-height:min(500px,calc(100vh - 28px));overflow:auto;pointer-events:auto;padding:13px 14px;border-color:rgba(73,145,224,.48);box-shadow:0 18px 42px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.025)}
      .quick-tip.interactive button,.smart-tip.interactive button,.quick-tip.interactive select,.smart-tip.interactive select{cursor:pointer}
      .quick-drag-head{width:100%;box-sizing:border-box;flex:0 0 auto;padding:1px 0 2px 0;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none}.quick-drag-head:active{cursor:grabbing}
      .panel-drag-grip{width:56px;height:4px;border-radius:999px;margin:0 auto 2px auto;background:rgba(180,205,235,0.16);pointer-events:none}
      .shell.light .panel-drag-grip{background:rgba(120,145,175,0.16)}
      .quick-inline-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;user-select:text;-webkit-user-select:text;cursor:default}
      .correlate-tip.interactive{width:min(360px,calc(100vw - 166px));max-height:min(460px,calc(100vh - 28px));overflow:auto;pointer-events:auto;padding:13px 14px;border-color:rgba(112,167,232,.48);box-shadow:0 18px 42px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.025)}
      .action-cluster.dock-down .quick-tip.interactive{top:0;bottom:auto;transform:scale(.985);transform-origin:top center}
      .action-cluster.dock-up .quick-tip.interactive{top:auto;bottom:0;transform:scale(.985);transform-origin:bottom center}
      .action-cluster.dock-down .smart-tip.interactive{top:0;bottom:auto;transform:scale(.985);transform-origin:top center}
      .action-cluster.dock-up .smart-tip.interactive{top:auto;bottom:0;transform:scale(.985);transform-origin:bottom center}
      .action-cluster.dock-down .correlate-tip.interactive{top:0;bottom:auto;transform:scale(.985);transform-origin:top center}
      .action-cluster.dock-up .correlate-tip.interactive{top:auto;bottom:0;transform:scale(.985);transform-origin:bottom center}
      .action-item:hover .quick-tip.interactive{transform:scale(1)}
      .action-item:hover .smart-tip.interactive{transform:scale(1)}
      .action-item:hover .correlate-tip.interactive{transform:scale(1)}
      .quick-inline-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.quick-inline-head>strong{margin:0!important;font-size:12px!important}.quick-inline-status{display:inline-flex!important;align-items:center!important;gap:5px;color:#7f96ad!important;font-size:9px!important;white-space:nowrap}.quick-inline-status i{width:6px;height:6px;border-radius:50%;background:#64768b}.quick-inline-status.ok{color:#72dda9!important}.quick-inline-status.ok i{background:#2bd99b;box-shadow:0 0 7px rgba(43,217,155,.7)}.quick-inline-status.running{color:#c1a9ff!important}.quick-inline-status.running i{background:#9d79ff;box-shadow:0 0 7px rgba(157,121,255,.75);animation:petPulse .8s ease-in-out infinite alternate}
      .panel-header-info{display:flex;align-items:center;gap:10px;min-width:0}.panel-header-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto}
      .inline-head-actions{display:flex;align-items:center;gap:8px}.inline-detail-btn{appearance:none;height:23px;padding:0 8px;border:1px solid rgba(82,139,204,.30);border-radius:999px;background:rgba(35,67,105,.58);color:#b8d7f6;font-size:8.5px;font-weight:700;cursor:pointer}.inline-detail-btn:hover{border-color:rgba(100,174,246,.48);background:rgba(43,85,132,.82);color:#edf7ff}.inline-close-btn{appearance:none;display:inline-grid;place-items:center;width:22px;height:22px;padding:0;border:1px solid rgba(104,150,205,.26);border-radius:50%;background:rgba(14,28,47,.72);color:#8fa8c2;font-size:14px;line-height:1;font-weight:600;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.035)}.inline-close-btn:hover{border-color:rgba(255,111,124,.38);background:rgba(70,25,37,.58);color:#ffd6dc}
      .quick-inline-loading{display:flex;align-items:center;gap:9px;padding:11px;border-radius:9px;background:rgba(112,70,221,.10);border:1px solid rgba(143,104,237,.18)}.quick-inline-loading b{width:12px;height:12px;border-radius:50%;border:2px solid rgba(183,157,255,.25);border-top-color:#b59aff;box-shadow:0 0 8px rgba(139,92,246,.22);animation:qspin .8s linear infinite}.quick-inline-loading span{font-size:9.6px;color:#b6c4d4;line-height:1.45}@keyframes qspin{to{transform:rotate(360deg)}}
      .quick-inline-verdict{margin-bottom:9px;padding:9px 10px;border-radius:9px;background:linear-gradient(135deg,rgba(30,61,100,.28),rgba(17,34,57,.16));border:1px solid rgba(76,132,194,.15)}.smart-result .quick-inline-verdict{padding:8px 10px}.quick-inline-verdict.optional-verdict{margin-top:-3px;background:rgba(36,72,112,.08);border-color:rgba(87,143,207,.11)}.quick-inline-label{display:block!important;margin-bottom:7px;color:#7188a2!important;font-size:8.5px!important;font-weight:600;letter-spacing:.15px}.quick-inline-tags{display:flex;gap:6px;flex-wrap:wrap}.qtag{font-style:normal;display:inline-flex;align-items:center;min-height:23px;padding:0 9px;border-radius:999px;font-size:9.3px;font-weight:700;letter-spacing:.05px}.qtag.business{color:#77dfaa;background:rgba(42,190,132,.12);border:1px solid rgba(81,218,162,.24)}.qtag.intent{color:#ff929b;background:rgba(231,76,91,.14);border:1px solid rgba(255,105,118,.27)}.qtag.failed{color:#f5bd69;background:rgba(231,153,54,.12);border:1px solid rgba(246,176,75,.25)}.qtag.success{color:#ff7382;background:rgba(222,57,80,.17);border:1px solid rgba(255,91,112,.31);box-shadow:inset 0 0 12px rgba(219,60,82,.05)}.qtag.nonalert{color:#82b9f0;background:rgba(60,132,207,.12);border:1px solid rgba(89,157,226,.23)}.qtag.unknown{color:#aebccc;background:rgba(111,132,155,.11);border:1px solid rgba(133,155,180,.19)}.qtag.optional{color:#a9c2dd;background:rgba(74,126,184,.10);border:1px solid rgba(93,154,222,.18);font-weight:650}
      .quick-inline-meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}.quick-inline-meta span{display:inline-flex!important;max-width:100%;padding:4px 7px;border-radius:6px;background:rgba(65,122,187,.08);border:1px solid rgba(79,143,214,.14);font-size:8.8px!important;color:#91a9c1!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .quick-inline-summary{padding:9px 10px;border-radius:8px;background:rgba(58,106,162,.08);border-left:2px solid rgba(75,151,232,.68);color:#d8e3ee;font-size:9.7px;line-height:1.55;margin-bottom:9px}.smart-result .quick-inline-summary{font-size:10px;line-height:1.62;color:#e2edf8}
      .quick-inline-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:9px}.quick-inline-metrics span{min-width:0;display:block!important;padding:6px 7px;border-radius:7px;background:rgba(255,255,255,.03);color:#71879f!important;font-size:8px!important}.quick-inline-metrics b{display:block;margin-top:2px;color:#e6eef7;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.quick-inline-metrics b.risk{color:#ff8791}
      .quick-inline-reasons{border-top:1px solid rgba(255,255,255,.055)}.quick-inline-reason{display:grid;grid-template-columns:23px 1fr;gap:7px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05)}.quick-inline-reason>b{width:20px;height:20px;border-radius:6px;display:flex;align-items:center;justify-content:center;background:rgba(54,124,205,.11);border:1px solid rgba(78,151,230,.18);color:#70b1f3;font-size:8px}.quick-inline-reason>div{min-width:0}.quick-inline-reason strong{display:block!important;margin:0 0 2px!important;color:#dfe9f3!important;font-size:9.3px!important}.quick-inline-reason span{display:block!important;color:#96a9bd!important;font-size:8.8px!important;line-height:1.45}.quick-inline-empty{padding:8px 0;color:#8fa1b5;font-size:9px;line-height:1.45}
      .panel-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:7px;background:transparent;color:rgba(160,186,214,0.72);cursor:pointer;position:relative;flex:none}.panel-icon-btn svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.panel-icon-btn:hover{background:rgba(80,140,210,0.12);color:#cde2f7}.panel-icon-btn:active{background:rgba(80,140,210,0.20)}.panel-icon-btn:disabled{opacity:.3;cursor:not-allowed;background:transparent}.eff-tooltip-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483647}.eff-tooltip{position:fixed;pointer-events:none;white-space:nowrap;padding:5px 9px;border-radius:6px;background:rgba(8,16,28,.96);border:1px solid rgba(80,140,210,.32);color:#d0dff2;font-size:11px;line-height:1.4;box-shadow:0 6px 18px rgba(0,0,0,.35)}
      .shell.light .panel-icon-btn{color:rgba(80,118,155,0.72)}.shell.light .panel-icon-btn:hover{background:rgba(60,110,170,0.10);color:#3b6591}
      .shell.light .eff-tooltip{background:rgba(248,252,255,.98);border-color:rgba(100,140,190,.32);color:#304a66;box-shadow:0 6px 18px rgba(42,79,121,.14)}
      .quick-inline-copy{width:100%;height:29px;margin-top:9px;border:1px solid #344d6b;border-radius:7px;background:#14243a;color:#cfddec;font-size:9.5px;font-weight:600;cursor:pointer}.quick-inline-copy.primary{background:linear-gradient(135deg,#176fce,#315ec0);border-color:#4a91e6;color:#fff}.quick-inline-copy:disabled{opacity:.42;cursor:not-allowed}.quick-inline-copy:hover:not(:disabled){filter:brightness(1.1)}
      .correlate-list{display:grid;gap:7px;margin:8px 0 10px}.correlate-row{display:grid;grid-template-columns:28px minmax(0,1fr) 24px;gap:9px;align-items:center;margin:0;padding:9px 10px;border:1px solid rgba(74,132,199,.22);border-radius:10px;background:linear-gradient(135deg,rgba(55,99,151,.13),rgba(9,22,39,.36));box-shadow:inset 0 1px 0 rgba(255,255,255,.025)}.correlate-row>b{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;background:rgba(69,135,210,.13);border:1px solid rgba(83,151,226,.24);color:#a6d5ff;font-size:10px}.correlate-row span{min-width:0}.correlate-row strong{display:block!important;margin:0 0 4px!important;color:#edf6ff!important;font-size:10px!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.correlate-row em{display:block;color:#8fa5bd;font-style:normal;font-size:8.8px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.correlate-row button{width:24px;height:24px;padding:0;border:1px solid rgba(255,111,124,.28);border-radius:8px;background:rgba(72,24,36,.46);color:#ffadb6;font-size:15px;line-height:20px;font-weight:700;cursor:pointer}.correlate-row button:hover{background:rgba(105,33,49,.72);color:#fff}
      .correlate-actions{display:grid;grid-template-columns:1fr 72px;gap:7px;margin-top:8px}.correlate-actions button{height:30px;border:1px solid rgba(83,139,204,.34);border-radius:8px;background:rgba(20,38,61,.88);color:#cfe0f2;font-size:9.5px;font-weight:700;cursor:pointer}.correlate-actions button:first-child{background:linear-gradient(135deg,rgba(42,145,210,.78),rgba(37,94,166,.86));border-color:rgba(91,166,234,.54);color:#eef8ff}.correlate-actions button:disabled{opacity:.42;cursor:not-allowed}.correlate-actions button:hover:not(:disabled){filter:brightness(1.1)}
      .detached-action-tip{position:fixed!important;right:auto!important;bottom:auto!important;opacity:1!important;visibility:visible!important;pointer-events:auto!important;transform:scale(1)!important;z-index:4;display:flex;flex-direction:column;overflow:hidden;max-height:min(520px,calc(100vh - 28px))}.detached-action-tip:hover{transform:scale(1)!important}.detached-action-tip .quick-inline-head,.detached-head{cursor:grab;user-select:none}.detached-action-tip .quick-inline-head:active,.detached-head:active{cursor:grabbing}.detached-action-tip button,.detached-action-tip pre{cursor:auto}.detached-action-tip .quick-inline-copy{cursor:pointer}
      .detached-panel{position:fixed;width:min(410px,calc(100vw - 28px));max-height:min(640px,calc(100vh - 28px));overflow:hidden;pointer-events:auto;background:linear-gradient(180deg,rgba(12,24,42,.982),rgba(7,16,29,.99));border:1px solid rgba(73,139,215,.55);border-radius:14px;box-shadow:0 22px 52px rgba(0,0,0,.50),inset 0 1px 0 rgba(255,255,255,.035);z-index:4}.detached-panel.smart{border-color:rgba(157,121,255,.58)}.detached-panel.correlation{border-color:rgba(112,167,232,.62)}.detached-panel.text{width:min(520px,calc(100vw - 28px));border-color:rgba(91,210,196,.55)}
      .detached-head{height:43px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px 9px 12px;border-bottom:1px solid rgba(255,255,255,.07);cursor:grab;user-select:none}.detached-head:hover{background:rgba(40,74,117,.10)}.detached-head strong{display:block;color:#f0f7ff;font-size:12px}.detached-head span{display:block;margin-top:2px;color:#7f95ad;font-size:8.5px}.detached-actions{display:flex;gap:5px}.detached-actions button{height:24px;padding:0 7px;border:1px solid rgba(83,129,184,.28);border-radius:7px;background:rgba(18,34,56,.92);color:#9fb8d3;font-size:8.5px;cursor:pointer}.detached-actions button:hover{background:rgba(35,65,101,.92);color:#fff}
      .detached-body{max-height:calc(min(640px,100vh - 28px) - 43px);overflow:auto;padding:12px}
      .detached-bubble{position:fixed;width:46px;height:46px;border-radius:50%;pointer-events:auto;border:1px solid rgba(91,166,234,.56);background:radial-gradient(circle at 50% 35%,#27466f 0,#13243e 55%,#091321 100%);color:#9ee9ff;font-size:14px;font-weight:800;box-shadow:0 16px 34px rgba(0,0,0,.42),0 0 16px rgba(69,157,238,.22);cursor:grab;touch-action:none;user-select:none;z-index:5;display:flex;align-items:center;justify-content:center}.detached-bubble:active{cursor:grabbing}.detached-bubble.smart{color:#d7bcff;border-color:rgba(157,121,255,.62)}.detached-bubble.correlation{color:#b8dcff;border-color:rgba(112,167,232,.68)}.detached-bubble.text{color:#8ee6d7;border-color:rgba(91,210,196,.64)}.detached-bubble.ticket{color:#d7bcff;border-color:rgba(157,121,255,.62)}.detached-bubble-icon{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;pointer-events:none}.detached-bubble-icon svg{width:100%;height:100%}
      .text-panel-meta{margin-bottom:8px;color:#7f95ad;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.text-panel-content{margin:0;max-height:460px;overflow:auto;white-space:pre-wrap;word-break:break-word;padding:10px;border-radius:9px;background:rgba(7,17,31,.76);border:1px solid rgba(91,210,196,.16);color:#c7d7e8;font:9.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
      .error-text{border-left-color:#ff6f7c!important;color:#ffb3bb!important}

      .shell.light{color:#24364b}.shell.light .pet-core{background:radial-gradient(circle at 50% 35%,#e6f7ff 0,#8fc7ee 45%,#2c79b5 100%);border-color:#48a6df;box-shadow:0 0 0 3px rgba(67,156,220,.13),0 0 24px rgba(64,151,218,.34),inset 0 1px 10px rgba(255,255,255,.36)}.shell.light .pet-face{background:linear-gradient(180deg,#f7fcff,#d9eefb);border-color:rgba(44,128,190,.55)}.shell.light .pet-face span{background:#247aa8;box-shadow:0 0 8px rgba(36,122,168,.45)}.shell.light .pet-status{border-color:#f6fbff}.shell.light .action-tip,.shell.light .detached-panel,.shell.light .analysis-panel{background:linear-gradient(180deg,rgba(250,253,255,.97),rgba(236,244,252,.98));border-color:rgba(88,139,198,.42);box-shadow:0 18px 42px rgba(42,77,116,.20),inset 0 1px 0 rgba(255,255,255,.75);color:#24364b}.shell.light .action-tip strong,.shell.light .quick-inline-head>strong,.shell.light .detached-head strong,.shell.light .panel-head h3,.shell.light .quick-recognition strong,.shell.light .quick-meta strong,.shell.light .reason-line strong,.shell.light .section p,.shell.light .quick-summary p{color:#213248!important}.shell.light .action-tip span,.shell.light .quick-inline-status,.shell.light .quick-inline-label,.shell.light .quick-inline-meta span,.shell.light .quick-inline-reason span,.shell.light .detached-head span,.shell.light .text-panel-meta,.shell.light .connection,.shell.light .metric span,.shell.light .metric-grid span,.shell.light .quick-recognition span,.shell.light .quick-meta span,.shell.light .reason-content p,.shell.light .reasoning-title span{color:#637891!important}.shell.light .quick-inline-summary,.shell.light .quick-inline-loading{background:rgba(232,242,252,.86);border-color:rgba(88,139,198,.24);color:#26384d}.shell.light .quick-inline-verdict,.shell.light .quick-inline-metrics span,.shell.light .quick-recognition,.shell.light .quick-meta>div,.shell.light .metric-grid>div,.shell.light .history-like,.shell.light .correlate-row{background:rgba(247,251,255,.82);border-color:rgba(116,150,188,.22)}.shell.light .quick-inline-reasons,.shell.light .quick-inline-reason,.shell.light .reasoning-list,.shell.light .reason-row{border-color:rgba(116,150,188,.22)}.shell.light .quick-inline-reason>b,.shell.light .reason-index,.shell.light .correlate-row>b{background:#e6f2fc;border-color:rgba(88,139,198,.28);color:#3275ad}.shell.light .quick-inline-copy,.shell.light .inline-detail-btn,.shell.light .inline-close-btn,.shell.light .detached-actions button,.shell.light .panel-close,.shell.light .result-btn,.shell.light .correlate-actions button{background:#edf5fc;border-color:#c3d5e9;color:#315b80}.shell.light .quick-inline-copy.primary,.shell.light .result-btn.primary,.shell.light .correlate-actions button:first-child{background:linear-gradient(135deg,#2d83d8,#4071c8);border-color:#6aa3df;color:#fff}.shell.light .text-panel-content{background:#f8fbff;border-color:#c9d9ea;color:#26384d}.shell.light .qtag.business{color:#177b5e;background:#e0f7ee;border-color:rgba(35,165,114,.28)}.shell.light .qtag.intent,.shell.light .qtag.success{color:#bf4051;background:#ffe8ec;border-color:rgba(222,57,80,.28)}.shell.light .qtag.failed{color:#9b6822;background:#fff3dc;border-color:rgba(216,145,45,.30)}.shell.light .qtag.nonalert,.shell.light .qtag.optional{color:#386ea8;background:#e6f3ff;border-color:rgba(74,137,205,.30)}.shell.light .qtag.unknown{color:#68798c;background:#eef3f8;border-color:rgba(125,145,168,.26)}
      .shell.light .quick-inline-metrics span{background:#f2f7fc!important;border:1px solid rgba(118,150,188,.24)!important;color:#6b7f96!important}.shell.light .quick-inline-metrics b{color:#24364b!important;font-weight:800!important;text-shadow:none!important}.shell.light .quick-inline-metrics b.risk{color:#d84d5a!important}.shell.light .quick-inline-metrics{border-bottom:1px solid rgba(116,150,188,.18);padding-bottom:8px}

      .analysis-panel{position:fixed;pointer-events:auto;background:linear-gradient(180deg,rgba(17,30,50,.985),rgba(8,17,30,.99));border:1px solid rgba(73,139,215,.4);border-radius:16px;overflow:hidden;box-shadow:0 22px 52px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.035);animation:popIn .16s ease-out}
      .panel-head{display:flex;align-items:flex-start;justify-content:space-between;padding:14px 15px 11px;border-bottom:1px solid rgba(255,255,255,.07)}
      .panel-head h3{margin:0;font-size:15px;font-weight:700;letter-spacing:.1px}
      .connection{margin:5px 0 0;color:#8ba0b7;font-size:10px}.connection i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:#66798f}.connection.ok{color:#72dda9}.connection.ok i{background:#28d997;box-shadow:0 0 8px rgba(40,217,151,.7)}.connection.bad{color:#ff8992}.connection.bad i{background:#ff6672}
      .panel-close{width:28px;height:28px;border:0;border-radius:8px;background:#17263b;color:#9fb1c5;cursor:pointer;font-size:17px;line-height:28px}.panel-close:hover{background:#21334b;color:#fff}

      .analysis-body{padding:12px 14px 14px}.quick-recognition{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:10px;padding:9px;border-radius:10px;background:rgba(47,127,205,.08);border:1px solid rgba(69,143,218,.18)}.quick-recognition>div{min-width:0}.quick-recognition span{display:block;color:#7f96ad;font-size:9px;margin-bottom:3px}.quick-recognition strong{display:block;color:#e9f3ff;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.metric.single{display:flex;justify-content:space-between;align-items:center;padding:7px 0 10px}.metric span,.metric-grid span{color:#8094aa;font-size:10px}.metric strong,.metric-grid strong{font-size:12px}.danger{color:#ff737e!important}.metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.metric-grid>div{background:rgba(255,255,255,.035);padding:9px;border-radius:8px;display:flex;justify-content:space-between}.section{margin-top:12px}.section h4{font-size:10px;color:#9eb0c5;margin:0 0 6px}.section p{margin:0;color:#d7e1ed;line-height:1.58;font-size:10.5px}.section ol{list-style:none;padding:0;margin:0}.section li{display:flex;gap:8px;margin:7px 0;line-height:1.45;color:#d7e1ed;font-size:10.5px}.section li b{flex:0 0 18px;height:18px;border-radius:50%;background:rgba(65,135,232,.18);color:#79b6ff;text-align:center;line-height:18px;font-size:9px}
      .quick-analysis-panel{max-height:min(720px,calc(100vh - 24px));overflow:auto}.quick-head{background:linear-gradient(90deg,rgba(41,105,176,.10),rgba(112,67,213,.06))}.quick-body{padding:12px 15px 15px}.quick-verdict{display:flex;align-items:center;gap:10px;padding:9px 0 11px;border-bottom:1px solid rgba(255,255,255,.065)}.quick-verdict-label{flex:0 0 auto;color:#8fa3b9;font-size:10.5px;font-weight:600}.verdict-tags{display:flex;gap:7px;flex-wrap:wrap}.verdict-chip{display:inline-flex;align-items:center;min-height:24px;padding:0 9px;border-radius:7px;font-size:10.5px;font-weight:700}.verdict-chip.intent{background:rgba(231,76,91,.16);border:1px solid rgba(255,105,118,.32);color:#ff8993}.verdict-chip.outcome{background:rgba(231,153,54,.14);border:1px solid rgba(246,176,75,.30);color:#f5bb65}.quick-meta{display:grid;grid-template-columns:1.5fr .72fr .72fr;gap:7px;margin-top:11px}.quick-meta>div{min-width:0;padding:9px 10px;border-radius:9px;background:rgba(255,255,255,.032);border:1px solid rgba(255,255,255,.045)}.quick-meta span{display:block;color:#7f95ad;font-size:9px;margin-bottom:4px}.quick-meta strong{display:block;color:#eaf3fd;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.quick-summary{margin-top:10px;padding:11px 12px;border-radius:10px;background:linear-gradient(135deg,rgba(45,111,185,.09),rgba(61,76,116,.05));border-left:3px solid rgba(80,155,234,.72)}.quick-summary p{margin:0;color:#dbe6f2;font-size:10.5px;line-height:1.65}.reasoning-section{margin-top:13px}.reasoning-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}.reasoning-title h4{margin:0;color:#d6e4f3;font-size:11px}.reasoning-title span{color:#657d96;font-size:8.5px}.reasoning-list{border-top:1px solid rgba(255,255,255,.055)}.reason-row{display:grid;grid-template-columns:30px 1fr;gap:9px;padding:10px 1px;border-bottom:1px solid rgba(255,255,255,.055)}.reason-index{width:25px;height:25px;border-radius:7px;display:flex;align-items:center;justify-content:center;background:rgba(54,124,205,.11);border:1px solid rgba(78,151,230,.20);color:#70b1f3;font-size:9px;font-weight:700}.reason-content{min-width:0}.reason-line{display:flex;align-items:center;gap:7px;min-width:0}.reason-line strong{color:#e3edf7;font-size:10.5px}.reason-line span{display:inline-flex;padding:2px 6px;border-radius:999px;background:rgba(96,120,147,.14);border:1px solid rgba(116,145,177,.18);color:#9eb4ca;font-size:8.5px}.reason-content p{margin:4px 0 0;color:#aebfd0;font-size:9.8px;line-height:1.55}.reason-row.empty{opacity:.8}
      .result-actions{display:grid;grid-template-columns:1.1fr 1fr;gap:7px;margin-top:13px}.result-actions.single{grid-template-columns:1fr}.result-btn{height:34px;border:1px solid #344c69;border-radius:9px;background:#16243a;color:#d6e3f1;cursor:pointer;font-weight:600;font-size:10.5px}.result-btn.primary{background:linear-gradient(135deg,#176fce,#315ec0);border-color:#3d88dd;color:#fff}.result-btn:hover{filter:brightness(1.08)}

      .toast{position:fixed;max-width:260px;pointer-events:none;padding:8px 11px;border-radius:9px;background:#142640;border:1px solid #3c6ca5;color:#e6f2ff;box-shadow:0 16px 34px rgba(0,0,0,.4);font-size:10px;line-height:1.4;animation:popIn .14s ease-out}.toast.error{background:#351a24;border-color:#8d4350;color:#ffb0b8}
      @keyframes popIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}

      /* ---- 滚动条样式（仅作用于研判面板内部滚动容器）---- */
      :host{--eff-scroll-thumb:rgba(108,137,174,0.42);--eff-scroll-thumb-hover:rgba(128,166,210,0.68);--eff-scroll-thumb-active:rgba(140,181,224,0.82);--eff-tail-idle:rgba(75,166,225,0.88);--eff-tail-glow:rgba(75,166,225,0.45);--eff-tail-analyzing:#7c5cfc;--eff-tail-analyzing-glow:rgba(124,92,252,0.6);--eff-tail-success:#45d99a;--eff-tail-success-glow:rgba(69,217,154,0.5);--eff-tail-error:#f26d7d;--eff-tail-error-glow:rgba(242,109,125,0.5)}
      .shell.light{--eff-scroll-thumb:rgba(116,143,174,0.38);--eff-scroll-thumb-hover:rgba(91,126,165,0.58);--eff-scroll-thumb-active:rgba(77,111,151,0.72);--eff-tail-idle:rgba(72,145,196,0.88);--eff-tail-glow:rgba(72,145,196,0.4);--eff-tail-analyzing:#7657e8;--eff-tail-analyzing-glow:rgba(118,87,232,0.55);--eff-tail-success:#33b982;--eff-tail-success-glow:rgba(51,185,130,0.45);--eff-tail-error:#df6675;--eff-tail-error-glow:rgba(223,102,117,0.5)}

      .quick-tip.interactive,.smart-tip.interactive,.correlate-tip.interactive,.ticket-tip.interactive,.detached-action-tip,.detached-body,.text-panel-content{scrollbar-width:thin;scrollbar-color:var(--eff-scroll-thumb) transparent}
      .quick-tip.interactive::-webkit-scrollbar,.smart-tip.interactive::-webkit-scrollbar,.correlate-tip.interactive::-webkit-scrollbar,.ticket-tip.interactive::-webkit-scrollbar,.detached-action-tip::-webkit-scrollbar,.detached-body::-webkit-scrollbar,.text-panel-content::-webkit-scrollbar{width:5px}
      .quick-tip.interactive::-webkit-scrollbar-track,.smart-tip.interactive::-webkit-scrollbar-track,.correlate-tip.interactive::-webkit-scrollbar-track,.ticket-tip.interactive::-webkit-scrollbar-track,.detached-action-tip::-webkit-scrollbar-track,.detached-body::-webkit-scrollbar-track,.text-panel-content::-webkit-scrollbar-track{background:transparent}
      .quick-tip.interactive::-webkit-scrollbar-thumb,.smart-tip.interactive::-webkit-scrollbar-thumb,.correlate-tip.interactive::-webkit-scrollbar-thumb,.ticket-tip.interactive::-webkit-scrollbar-thumb,.detached-action-tip::-webkit-scrollbar-thumb,.detached-body::-webkit-scrollbar-thumb,.text-panel-content::-webkit-scrollbar-thumb{background:var(--eff-scroll-thumb);border-radius:999px}
      .quick-tip.interactive::-webkit-scrollbar-thumb:hover,.smart-tip.interactive::-webkit-scrollbar-thumb:hover,.correlate-tip.interactive::-webkit-scrollbar-thumb:hover,.ticket-tip.interactive::-webkit-scrollbar-thumb:hover,.detached-action-tip::-webkit-scrollbar-thumb:hover,.detached-body::-webkit-scrollbar-thumb:hover,.text-panel-content::-webkit-scrollbar-thumb:hover{background:var(--eff-scroll-thumb-hover)}
      .quick-tip.interactive::-webkit-scrollbar-thumb:active,.smart-tip.interactive::-webkit-scrollbar-thumb:active,.correlate-tip.interactive::-webkit-scrollbar-thumb:active,.ticket-tip.interactive::-webkit-scrollbar-thumb:active,.detached-action-tip::-webkit-scrollbar-thumb:active,.detached-body::-webkit-scrollbar-thumb:active,.text-panel-content::-webkit-scrollbar-thumb:active{background:var(--eff-scroll-thumb-active)}

      /* 浅色模式运行态紫色光晕 */
      .shell.light .pet.working .pet-core{animation:petPulse 1.05s ease-in-out infinite alternate;border-color:#9d79ff;box-shadow:0 0 0 3px rgba(139,92,246,.12),0 0 24px rgba(139,92,246,.28),0 0 40px rgba(167,139,250,.18),inset 0 1px 10px rgba(255,255,255,.36)}
      .shell.light .pet.working .pet-status{background:#9d79ff;box-shadow:0 0 0 3px rgba(255,255,255,.7),0 0 10px rgba(139,92,246,.45),0 0 18px rgba(167,139,250,.28)}
      .shell.light .quick-inline-status.running i{box-shadow:0 0 8px rgba(139,92,246,.45),0 0 16px rgba(167,139,250,.25)}
      .shell.light .quick-inline-loading b{box-shadow:0 0 8px rgba(139,92,246,.28);border-top-color:#9d79ff}
      /* 浅色模式完成态绿色光晕 */
      .shell.light .quick-inline-status.ok i{box-shadow:0 0 0 2px rgba(52,211,153,.10),0 0 8px rgba(52,211,153,.32),0 0 14px rgba(34,197,94,.18)}
      .shell.light .pet.ready .pet-status,.shell.light .pet.connected .pet-status{box-shadow:0 0 0 3px rgba(255,255,255,.72),0 0 9px rgba(52,211,153,.42),0 0 16px rgba(34,197,94,.22)}
      .shell.light .pet[data-pet-status="success"] .pet-core{box-shadow:0 0 0 3px rgba(52,211,153,.12),0 0 24px rgba(52,211,153,.28),0 0 40px rgba(34,197,94,.16),inset 0 1px 10px rgba(255,255,255,.36)}
    `;
  }
})();
