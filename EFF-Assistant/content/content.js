(() => {
  if (window.__EFF_ASSISTANT_LOADED__) return;
  window.__EFF_ASSISTANT_LOADED__ = true;

  const HOST_ID = "eff-assistant-root";
  const PET_SIZE = 58;
  const EDGE_GAP = 14;
  const PANEL_GAP = 14;

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
    toast: null
  };

  let host;
  let shadow;
  let refreshTimer = null;
  let toastTimer = null;
  let outsideBound = false;
  let actionHideTimer = null;
  let suppressPetClick = false;
  let lastPointer = { x: -9999, y: -9999 };
  let quickResultGraceUntil = 0;
  let quickResultHasBeenEntered = false;
  let ticketPanelHoldUntil = 0;

  bootstrap().catch((e) => console.error("EFF Assistant bootstrap failed", e));

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
  });

  async function refreshRuntimeState() {
    const response = await send({ type: "GET_STATE" });
    if (!response.ok) return false;
    state.platform = response.platform;
    state.devices = response.devices || [];
    state.quickAI = response.quickAI || { enabled: false, configured: false };
    state.visible = response.ui?.assistantEnabled === true;
    state.device = detectDevice(location.href, state.devices) || null;
    if (!state.petPosition) state.petPosition = normalizeSavedPosition(response.ui?.petPosition);
    return true;
  }

  async function bootstrap() {
    const ok = await refreshRuntimeState();
    if (!ok) return;

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
    shadow.innerHTML = `<style>${styles()}</style><div class="shell"></div>`;
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
    const pet = state.petPosition;
    const statusClass = petStatusClass();
    const activityClass = state.activity !== "idle" ? "busy" : "";

    let html = `
      <div class="pet ${statusClass} ${activityClass}" data-role="pet" style="${positionStyle(pet)}" title="${escapeHtml(petTooltip())}">
        <div class="pet-core">
          <div class="pet-face"><span></span><span></span></div>
        </div>
        <i class="pet-status"></i>
        <i class="pet-tail"></i>
      </div>
    `;

    if (state.menuOpen) html += renderActionDock();
    if (state.toast) html += renderToast();

    shell.innerHTML = html;
    bindPetInteractions();
    bindDockEvents();
    bindAnalysisEvents();
    requestAnimationFrame(adjustActionTipsIntoViewport);
  }

  function renderActionDock() {
    const hasPlatform = !!state.platform?.connected;
    const actionCount = hasPlatform ? 3 : 1;
    const placement = dockPlacement(actionCount);
    const busyClass = state.busy.ticket ? "ticket-busy" : state.busy.smart ? "smart-busy" : state.busy.quick ? "quick-busy" : "";
    const platformHint = !state.platform?.connected ? "需要先连接 EFF-Monitoring" : (!state.device ? "当前页面尚未识别设备" : "");
    const ticketHint = platformHint || "使用平台解析结果创建 EFF 工作台工单，并进入现有工单流转。";
    const smartHint = platformHint || (!state.platform?.platformAI
      ? "平台 AI 当前不可用；请先在 EFF-Monitoring 中启用平台 AI。"
      : "调用 EFF-Monitoring 平台 AI，结合平台资产、情报与历史经验进行深度研判。");
    const quickReady = !!(state.quickAI?.enabled && state.quickAI?.configured);
    const quickHint = !quickReady
      ? "尚未配置快速研判 AI；配置后无需连接 EFF-Monitoring，也可直接读取当前页面文本进行研判。"
      : "无需连接 EFF-Monitoring：直接读取当前页面可见文本，由插件 AI 自动识别告警关键字段并快速研判。";

    return `
      <div class="action-cluster ${placement.side} ${placement.vertical} ${busyClass}" data-role="dock" style="left:${placement.left}px;top:${placement.top}px">
        ${hasPlatform ? renderTicketHoverAction(ticketHint, !!state.busy.ticket) : ""}
        ${hasPlatform ? renderSmartHoverAction(smartHint, !!state.busy.smart) : ""}
        ${renderQuickHoverAction(quickHint, !!state.busy.quick)}
      </div>
    `;
  }

  function renderHoverAction(action, icon, label, hint, disabled) {
    return `
      <div class="action-item">
        <button class="action-btn ${action}" data-act="${action}" ${disabled ? "disabled" : ""} aria-label="${escapeHtml(label)}">
          <span class="action-icon">${icon}</span><b>${escapeHtml(label)}</b>
        </button>
        <div class="action-tip" role="tooltip"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(hint)}</span></div>
      </div>
    `;
  }

  function renderTicketHoverAction(hint, disabled) {
    const result = state.ticketResult;
    const summary = ticketSummaryData();
    const hasPlatform = !!(state.platform?.connected && state.device);
    const templateOptions = state.messageTemplates.length
      ? state.messageTemplates.map((tpl) => `<option value="${escapeHtml(String(tpl.id))}" ${String(tpl.id) === String(state.selectedMessageTemplateId || "") ? "selected" : ""}>${escapeHtml(tpl.name)}${tpl.is_default ? "（默认）" : ""}</option>`).join("")
      : `<option value="">默认消息模板</option>`;
    const tags = renderTicketTags(summary);
    const messageReady = !!(result?.formatted_chat || state.parseResult?.formatted_chat);
    const tipBody = hasPlatform ? `
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
    ` : `<strong>生成工单</strong><span>${escapeHtml(hint)}</span>`;
    const keepVisible = state.busy.ticket || Date.now() < ticketPanelHoldUntil;
    const tipClass = hasPlatform ? ` interactive ticket-panel${keepVisible ? " force-visible" : ""}` : "";

    return `
      <div class="action-item ticket-item">
        <button class="action-btn ticket" data-act="ticket" ${disabled ? "disabled" : ""} aria-label="生成工单">
          <span class="action-icon">▣</span><b>${state.busy.ticket ? "生成中…" : "生成工单"}</b>
        </button>
        <div class="action-tip ticket-tip${tipClass}" role="tooltip">${tipBody}</div>
      </div>
    `;
  }

  function renderSmartHoverAction(hint, disabled) {
    const result = state.analysisResult;
    let tipBody = `<strong>智能研判</strong><span>${escapeHtml(hint)}</span>`;
    let tipClass = "";

    if (state.busy.smart) {
      tipClass = " interactive smart-running";
      tipBody = `
        <div class="quick-inline-head"><strong>智能研判</strong><span class="quick-inline-status running"><i></i>平台证据增强中</span></div>
        <div class="quick-inline-loading"><b></b><span>正在调用 EFF-Monitoring，结合解析字段、资产、情报、相似告警和历史经验研判…</span></div>
      `;
    } else if (result) {
      tipClass = " interactive smart-result";
      const view = smartInlineView(result);
      const chips = view.labels.map((label) => `<em class="qtag ${verdictClass(label)}">${escapeHtml(label)}</em>`).join("");
      const steps = renderQuickInlineSteps({ analysis_steps: view.steps, evidence: view.evidence });
      tipBody = `
        <div class="quick-inline-head">
          <strong>智能研判</strong>
          <span class="quick-inline-status ok"><i></i>研判完成</span>
        </div>
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
        <button class="quick-inline-copy" data-act="copy-analysis">复制研判结果</button>
      `;
    }

    return `
      <div class="action-item smart-item">
        <button class="action-btn smart" data-act="smart" ${disabled ? "disabled" : ""} aria-label="智能研判">
          <span class="action-icon">◎</span><b>${state.busy.smart ? "研判中…" : "智能研判"}</b>
        </button>
        <div class="action-tip smart-tip${tipClass}" role="tooltip">${tipBody}</div>
      </div>
    `;
  }

  function renderQuickHoverAction(hint, disabled) {
    const result = state.quickResult;
    let tipBody = `<strong>快速研判</strong><span>${escapeHtml(hint)}</span>`;
    let tipClass = "";

    if (state.busy.quick) {
      tipClass = " interactive quick-running";
      tipBody = `
        <div class="quick-inline-head"><strong>快速研判</strong><span class="quick-inline-status running"><i></i>AI 正在分析当前页面</span></div>
        <div class="quick-inline-loading"><b></b><span>正在检查页面上下文；强告警特征将直接研判，模糊页面先做轻量分类…</span></div>
      `;
    } else if (result) {
      tipClass = " interactive quick-result";
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
        <div class="quick-inline-head">
          <strong>快速研判</strong>
          <span class="quick-inline-status ok"><i></i>研判完成</span>
        </div>
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
        <button class="quick-inline-copy" data-act="copy-quick-inline">复制研判结果</button>
      `;
    }

    return `
      <div class="action-item quick-item">
        <button class="action-btn quick" data-act="quick" ${disabled ? "disabled" : ""} aria-label="快速研判">
          <span class="action-icon">ϟ</span><b>${state.busy.quick ? "研判中…" : "快速研判"}</b>
        </button>
        <div class="action-tip quick-tip${tipClass}" role="tooltip">${tipBody}</div>
      </div>
    `;
  }

  function verdictClass(label) {
    const map = {
      "业务行为": "business",
      "存在攻击意图": "intent",
      "攻击失败": "failed",
      "攻击成功": "success",
      "非告警事件": "nonalert",
      "无法确认": "unknown"
    };
    return map[label] || "unknown";
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
        state.analysisOpen = !!preDragViewState.analysisOpen;
      } else {
        state.menuOpen = false;
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
      state.ticketResult = null;
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

    shadow.querySelectorAll('[data-act="ticket"]').forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        holdTicketPanel();
        state.menuOpen = true;
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
      state.menuOpen = true;
      await analyze("smart");
    });

    shadow.querySelector('[data-act="quick"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      state.menuOpen = true;
      await analyze("quick");
    });

    shadow.querySelector('[data-act="copy-quick-inline"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      await copyQuickResult();
    });
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
      if (Date.now() < ticketPanelHoldUntil) {
        scheduleActionButtonsClose(260);
        return;
      }

      // 研判刚完成时给予 3 秒“可达窗口”，直到鼠标真正进入结果卡为止。
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

    // 2) 再构造整个宠物/按钮/结果区域的“交互包络矩形”。
    //    绝对定位结果卡与按钮之间即使存在视觉间距，也不会产生 Hover 断层。
    const left = Math.min(...rects.map((r) => r.left)) - pad;
    const right = Math.max(...rects.map((r) => r.right)) + pad;
    const top = Math.min(...rects.map((r) => r.top)) - pad;
    const bottom = Math.max(...rects.map((r) => r.bottom)) + pad;
    return x >= left && x <= right && y >= top && y <= bottom;
  }

  function adjustActionTipsIntoViewport() {
    if (!shadow || !state.menuOpen) return;
    const tips = Array.from(shadow.querySelectorAll('.action-tip.interactive'));
    for (const tip of tips) {
      tip.style.marginLeft = "0px";
      tip.style.marginTop = "0px";
    }

    requestAnimationFrame(() => {
      if (!shadow || !state.menuOpen) return;
      for (const tip of tips) {
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
      render();
    }, true);

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (state.menuOpen || state.analysisOpen) {
        state.menuOpen = false;
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
      render();
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

    state.busy[busyKey] = true;
    if (isQuick) {
      state.menuOpen = true;
      state.quickResult = null;
      quickResultHasBeenEntered = false;
      quickResultGraceUntil = Date.now() + 3000;
    } else {
      state.analysisOpen = false;
      state.menuOpen = true;
      state.analysisResult = null;
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
        state.quickResult = resp.data;
        state.menuOpen = true;
        quickResultHasBeenEntered = false;
        quickResultGraceUntil = Date.now() + 3000;
      } else {
        state.analysisResult = resp.data;
        state.analysisKind = "smart";
        state.analysisOpen = false;
        state.menuOpen = true;
      }
      state.busy[busyKey] = false;
      render();
    } catch (e) {
      state.busy[busyKey] = false;
      render();
      showToast(`研判失败：${e.message}`, true);
    }
  }


  function collectPageText() {
    const oldDisplay = host?.style.display || "";
    if (host) host.style.display = "none";

    let text = "";
    try {
      text = document.body?.innerText || document.documentElement?.innerText || "";
    } finally {
      if (host) host.style.display = oldDisplay || "block";
    }
    return normalizeText(text);
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
    const width = 126;
    const height = Math.max(38, actionCount * 38 + Math.max(0, actionCount - 1) * 8);
    const maxTipWidth = Math.min(384, Math.max(240, window.innerWidth - EDGE_GAP * 2 - width - 12));
    const leftNeed = width + 8 + maxTipWidth;
    const rightNeed = width + 8 + maxTipWidth;
    const leftSpace = pet.x - EDGE_GAP;
    const rightSpace = window.innerWidth - (pet.x + PET_SIZE) - EDGE_GAP;
    let rightHalf = pet.x + PET_SIZE / 2 > window.innerWidth / 2;
    if (rightHalf && leftSpace < leftNeed && rightSpace > leftSpace) rightHalf = false;
    if (!rightHalf && rightSpace < rightNeed && leftSpace > rightSpace) rightHalf = true;
    const bottomHalf = pet.y + PET_SIZE / 2 > window.innerHeight / 2;
    let left = rightHalf ? pet.x - width - PANEL_GAP : pet.x + PET_SIZE + PANEL_GAP;
    let top = pet.y + PET_SIZE / 2 - height / 2;
    const minLeft = rightHalf ? EDGE_GAP + maxTipWidth + 8 : EDGE_GAP;
    const maxLeft = rightHalf ? window.innerWidth - width - EDGE_GAP : window.innerWidth - width - maxTipWidth - 8 - EDGE_GAP;
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

  function showToast(text, error = false) {
    state.toast = { text, error };
    clearTimeout(toastTimer);
    render();
    toastTimer = setTimeout(() => {
      state.toast = null;
      render();
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

  function send(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: { message: chrome.runtime.lastError.message } });
      else resolve(response || { ok: false, error: { message: "插件后台无响应" } });
    }));
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
      .pet-tail{position:absolute;left:50%;bottom:-10px;transform:translateX(-50%);width:0;height:0;border-left:9px solid transparent;border-right:9px solid transparent;border-top:10px solid #7656ff;filter:drop-shadow(0 0 6px rgba(118,86,255,.7))}
      .pet-status{position:absolute;right:0;top:1px;width:11px;height:11px;border-radius:50%;background:#5f7188;border:2px solid #08111e;box-shadow:0 0 8px rgba(95,113,136,.5)}
      .pet.ready .pet-status,.pet.connected .pet-status{background:#2bd99b;box-shadow:0 0 9px rgba(43,217,155,.8)}
      .pet.disconnected .pet-status{background:#ff6672;box-shadow:0 0 9px rgba(255,102,114,.75)}
      .pet.unrecognized .pet-status{background:#ffbd55;box-shadow:0 0 9px rgba(255,189,85,.65)}
      .pet.working .pet-core{animation:petPulse 1.05s ease-in-out infinite alternate;border-color:#9f79ff;box-shadow:0 0 0 3px rgba(115,84,236,.14),0 0 30px rgba(130,83,245,.58)}
      .pet.working .pet-status{background:#9d79ff;box-shadow:0 0 10px rgba(157,121,255,.8)}
      @keyframes petPulse{from{transform:scale(.96)}to{transform:scale(1.035)}}

      .action-cluster{position:fixed;width:126px;display:flex;flex-direction:column;gap:8px;pointer-events:auto;animation:popIn .14s ease-out}
      .action-item{position:relative;pointer-events:auto}
      /* 扩大 Hover Bridge；配合 JS 逻辑 Hover Zone，消除按钮与结果卡之间的交互断层。 */
      .quick-item::after,.ticket-item::after,.smart-item::after{content:"";position:absolute;top:-14px;bottom:-14px;width:30px;pointer-events:auto;z-index:1}
      .action-cluster.dock-left .quick-item::after{right:100%}
      .action-cluster.dock-right .quick-item::after{left:100%}
      .action-cluster.dock-left .ticket-item::after{right:100%}
      .action-cluster.dock-right .ticket-item::after{left:100%}
      .action-cluster.dock-left .smart-item::after{right:100%}
      .action-cluster.dock-right .smart-item::after{left:100%}
      .action-btn{width:126px;height:38px;border:1px solid transparent;border-radius:11px;display:flex;align-items:center;gap:9px;padding:0 12px;color:#fff;cursor:pointer;box-shadow:0 10px 24px rgba(0,0,0,.30);transition:transform .13s ease,filter .13s ease,box-shadow .13s ease}
      .action-btn:hover:not(:disabled){transform:translateY(-1px) scale(1.025);filter:brightness(1.08);box-shadow:0 13px 30px rgba(0,0,0,.38)}
      .action-btn:disabled{opacity:.42;cursor:not-allowed}
      .action-btn b{font-size:11.5px;font-weight:650;letter-spacing:.1px}.action-icon{width:19px;text-align:center;font-size:14px;opacity:.98}
      .action-btn.ticket{background:linear-gradient(135deg,#176fe0,#3d68d8);border-color:#5a9aff}
      .action-btn.smart{background:linear-gradient(135deg,#7246dc,#a245df);border-color:#a978f1}
      .action-btn.quick{background:linear-gradient(135deg,#168b86,#39aaa0);border-color:#5fd0c2}
      .action-tip{position:absolute;top:50%;width:238px;transform:translateY(-50%) scale(.97);padding:10px 11px;border-radius:10px;background:rgba(9,19,33,.985);border:1px solid rgba(91,151,220,.38);box-shadow:0 14px 34px rgba(0,0,0,.42);opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease,transform .12s ease;z-index:2}
      .action-tip strong{display:block;color:#f0f6ff;font-size:11px;margin-bottom:4px}.action-tip span{display:block;color:#9eb1c7;font-size:10px;line-height:1.5}
      .action-cluster.dock-left .action-tip{right:calc(100% + 8px)}
      .action-cluster.dock-right .action-tip{left:calc(100% + 8px)}
      .action-item:hover .action-tip{opacity:1;visibility:visible;transform:translateY(-50%) scale(1)}
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
      .smart-tip.interactive{width:min(362px,calc(100vw - 166px));max-height:min(540px,calc(100vh - 28px));overflow:auto;pointer-events:auto;padding:13px 14px;border-color:rgba(157,121,255,.48);box-shadow:0 18px 42px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.025)}
      .quick-tip.interactive{width:min(362px,calc(100vw - 166px));max-height:min(500px,calc(100vh - 28px));overflow:auto;pointer-events:auto;padding:13px 14px;border-color:rgba(73,145,224,.48);box-shadow:0 18px 42px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.025)}
      .action-cluster.dock-down .quick-tip.interactive{top:0;bottom:auto;transform:scale(.985);transform-origin:top center}
      .action-cluster.dock-up .quick-tip.interactive{top:auto;bottom:0;transform:scale(.985);transform-origin:bottom center}
      .action-cluster.dock-down .smart-tip.interactive{top:0;bottom:auto;transform:scale(.985);transform-origin:top center}
      .action-cluster.dock-up .smart-tip.interactive{top:auto;bottom:0;transform:scale(.985);transform-origin:bottom center}
      .action-item:hover .quick-tip.interactive{transform:scale(1)}
      .action-item:hover .smart-tip.interactive{transform:scale(1)}
      .quick-inline-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.quick-inline-head>strong{margin:0!important;font-size:12px!important}.quick-inline-status{display:inline-flex!important;align-items:center!important;gap:5px;color:#7f96ad!important;font-size:9px!important;white-space:nowrap}.quick-inline-status i{width:6px;height:6px;border-radius:50%;background:#64768b}.quick-inline-status.ok{color:#72dda9!important}.quick-inline-status.ok i{background:#2bd99b;box-shadow:0 0 7px rgba(43,217,155,.7)}.quick-inline-status.running{color:#c1a9ff!important}.quick-inline-status.running i{background:#9d79ff;box-shadow:0 0 7px rgba(157,121,255,.75);animation:petPulse .8s ease-in-out infinite alternate}
      .quick-inline-loading{display:flex;align-items:center;gap:9px;padding:11px;border-radius:9px;background:rgba(112,70,221,.10);border:1px solid rgba(143,104,237,.18)}.quick-inline-loading b{width:12px;height:12px;border-radius:50%;border:2px solid rgba(183,157,255,.25);border-top-color:#b59aff;animation:qspin .8s linear infinite}.quick-inline-loading span{font-size:9.6px;color:#b6c4d4;line-height:1.45}@keyframes qspin{to{transform:rotate(360deg)}}
      .quick-inline-verdict{margin-bottom:9px;padding:9px 10px;border-radius:9px;background:linear-gradient(135deg,rgba(30,61,100,.28),rgba(17,34,57,.16));border:1px solid rgba(76,132,194,.15)}.smart-result .quick-inline-verdict{padding:8px 10px}.quick-inline-label{display:block!important;margin-bottom:7px;color:#7188a2!important;font-size:8.5px!important;font-weight:600;letter-spacing:.15px}.quick-inline-tags{display:flex;gap:6px;flex-wrap:wrap}.qtag{font-style:normal;display:inline-flex;align-items:center;min-height:23px;padding:0 9px;border-radius:999px;font-size:9.3px;font-weight:700;letter-spacing:.05px}.qtag.business{color:#77dfaa;background:rgba(42,190,132,.12);border:1px solid rgba(81,218,162,.24)}.qtag.intent{color:#ff929b;background:rgba(231,76,91,.14);border:1px solid rgba(255,105,118,.27)}.qtag.failed{color:#f5bd69;background:rgba(231,153,54,.12);border:1px solid rgba(246,176,75,.25)}.qtag.success{color:#ff7382;background:rgba(222,57,80,.17);border:1px solid rgba(255,91,112,.31);box-shadow:inset 0 0 12px rgba(219,60,82,.05)}.qtag.nonalert{color:#82b9f0;background:rgba(60,132,207,.12);border:1px solid rgba(89,157,226,.23)}.qtag.unknown{color:#aebccc;background:rgba(111,132,155,.11);border:1px solid rgba(133,155,180,.19)}
      .quick-inline-meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}.quick-inline-meta span{display:inline-flex!important;max-width:100%;padding:4px 7px;border-radius:6px;background:rgba(65,122,187,.08);border:1px solid rgba(79,143,214,.14);font-size:8.8px!important;color:#91a9c1!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .quick-inline-summary{padding:9px 10px;border-radius:8px;background:rgba(58,106,162,.08);border-left:2px solid rgba(75,151,232,.68);color:#d8e3ee;font-size:9.7px;line-height:1.55;margin-bottom:9px}.smart-result .quick-inline-summary{font-size:10px;line-height:1.62;color:#e2edf8}
      .quick-inline-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:9px}.quick-inline-metrics span{min-width:0;display:block!important;padding:6px 7px;border-radius:7px;background:rgba(255,255,255,.03);color:#71879f!important;font-size:8px!important}.quick-inline-metrics b{display:block;margin-top:2px;color:#e6eef7;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.quick-inline-metrics b.risk{color:#ff8791}
      .quick-inline-reasons{border-top:1px solid rgba(255,255,255,.055)}.quick-inline-reason{display:grid;grid-template-columns:23px 1fr;gap:7px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05)}.quick-inline-reason>b{width:20px;height:20px;border-radius:6px;display:flex;align-items:center;justify-content:center;background:rgba(54,124,205,.11);border:1px solid rgba(78,151,230,.18);color:#70b1f3;font-size:8px}.quick-inline-reason>div{min-width:0}.quick-inline-reason strong{display:block!important;margin:0 0 2px!important;color:#dfe9f3!important;font-size:9.3px!important}.quick-inline-reason span{display:block!important;color:#96a9bd!important;font-size:8.8px!important;line-height:1.45}.quick-inline-empty{padding:8px 0;color:#8fa1b5;font-size:9px;line-height:1.45}
      .quick-inline-copy{width:100%;height:29px;margin-top:9px;border:1px solid #344d6b;border-radius:7px;background:#14243a;color:#cfddec;font-size:9.5px;font-weight:600;cursor:pointer}.quick-inline-copy:hover{filter:brightness(1.1)}

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
    `;
  }
})();
