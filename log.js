(function () {
  "use strict";

  const browserApi = globalThis.browser ?? globalThis.chrome;
  const $ = (id) => document.getElementById(id);

  let filterValue = "all";
  let allRecords = [];

  // ── Error Diagnosis ──
  const ERROR_DIAG = {
    auth:         { label: "API Key 无效或已过期",   suggestion: "检查扩展设置 → 方案管理 → API Key" },
    timeout:      { label: "请求超时",               suggestion: "检查网络连接，或增大超时时间" },
    server_error: { label: "模型服务暂时不可用",     suggestion: "稍后重试，或切换到其他模型" },
    quota:        { label: "API 调用额度已用完",     suggestion: "检查 API 余额，或更换 API Key" },
    network:      { label: "无法连接到 API 服务",    suggestion: "检查网络或 API Base URL 是否正确" },
    unknown:      { label: "未知错误",               suggestion: "查看响应详情" },
  };

  function getDiag(type) {
    return ERROR_DIAG[type] || ERROR_DIAG.unknown;
  }

  // ── Helpers ──
  function el(tag, cls, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  function txt(text) {
    return document.createTextNode(String(text));
  }

  // ── Stats ──
  function renderStats(stats) {
    $("statTotal").textContent = stats.totalCalls || 0;
    $("statSuccess").textContent = stats.successfulCalls || 0;
    $("statFail").textContent = stats.failedCalls || 0;
    $("statTimeout").textContent = stats.timeoutCalls || 0;
  }

  function renderConfig(info) {
    if (info.activeProfile) {
      $("cfgName").textContent = info.activeProfile.name;
      $("cfgName").className = "";
      $("cfgModel").textContent = info.activeProfile.modelName;
      $("cfgModel").className = "";
    } else {
      $("cfgName").textContent = "（无配置方案）";
      $("cfgName").className = "none";
      $("cfgModel").textContent = "—";
      $("cfgModel").className = "none";
    }
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  function formatDate(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${formatTime(ts)}`;
  }

  // ── Card Rendering ──
  function renderCards(records) {
    allRecords = records;
    const container = $("callList");
    container.textContent = "";

    const filtered = filterValue === "all"
      ? records
      : records.filter(r => {
          if (filterValue === "success") return r.success;
          if (filterValue === "fail") return !r.success && r.output?.errorType !== "timeout";
          if (filterValue === "timeout") return r.output?.errorType === "timeout";
          return true;
        });

    if (filtered.length === 0) {
      const emptyDiv = el("div", "call-empty");
      if (records.length === 0) {
        const icon = el("span", "big-icon");
        icon.textContent = "📋";
        emptyDiv.appendChild(icon);
        emptyDiv.appendChild(el("br"));
        emptyDiv.appendChild(txt("暂无调用记录"));
        emptyDiv.appendChild(el("br"));
        const hint = el("span");
        hint.style.cssText = "font-size:0.75rem;color:#94a3b8";
        hint.textContent = "在网页中划词使用「AI 解释」后，记录会出现在这里";
        emptyDiv.appendChild(hint);
      } else {
        emptyDiv.textContent = "没有匹配的记录";
      }
      container.appendChild(emptyDiv);
      return;
    }

    for (const r of filtered) {
      container.appendChild(buildCard(r));
    }
  }

  function buildCard(r) {
    const success = r.success;
    const errorType = r.output?.errorType;
    const isTimeout = errorType === "timeout";

    // 状态文字
    let statusText, statusClass;
    if (success) { statusText = "✓ 成功"; statusClass = "ok"; }
    else if (isTimeout) { statusText = "⏱ 超时"; statusClass = "timeout"; }
    else { statusText = "✗ 失败"; statusClass = "fail"; }

    const cardClass = success ? "" : (isTimeout ? "call-timeout" : "call-fail");
    const modelName = r.input?.modelName || "—";
    const duration = r.process?.durationMs != null ? (r.process.durationMs / 1000).toFixed(1) + "s" : "—";
    const chunkCount = r.process?.chunkCount ?? 0;
    const selectedText = r.input?.selectedText || "";
    const context = r.input?.context || "";
    const fullPrompt = r.input?.fullPrompt || "";
    const outputText = r.output?.fullText || "";
    const rawResponse = r.output?.rawResponse || "";

    const card = el("div", `call-card ${cardClass}`.trim());
    card.dataset.callId = r.callId;

    // ── 头部 ──
    const header = el("div", "call-header");
    const timeSpan = el("span", "call-time");
    timeSpan.textContent = formatDate(r.timestamp);
    header.appendChild(timeSpan);

    const statusSpan = el("span", `call-status ${statusClass}`);
    statusSpan.textContent = statusText;
    header.appendChild(statusSpan);

    const modelSpan = el("span", "call-model");
    modelSpan.textContent = modelName;
    header.appendChild(modelSpan);

    const durSpan = el("span", "call-duration");
    durSpan.textContent = duration;
    header.appendChild(durSpan);

    card.appendChild(header);

    // ── 输入区 ──
    const inputSection = el("div", "call-section");
    const inputTitle = el("div", "section-title");
    inputTitle.textContent = "📥 输入";
    inputSection.appendChild(inputTitle);

    const selField = el("div", "field");
    const selLabel = el("label");
    selLabel.textContent = "选中文本：";
    selField.appendChild(selLabel);
    selField.appendChild(txt(" "));
    const selCode = el("code");
    selCode.textContent = selectedText;
    selField.appendChild(selCode);
    inputSection.appendChild(selField);

    const ctxField = el("div", "field");
    const ctxLabel = el("label");
    ctxLabel.textContent = "上下文：";
    ctxField.appendChild(ctxLabel);
    ctxField.appendChild(txt(" "));
    const ctxCode = el("code");
    ctxCode.textContent = context.length > 120 ? context.slice(0, 120) + "…" : context;
    ctxField.appendChild(ctxCode);
    inputSection.appendChild(ctxField);

    // 折叠：完整 Prompt
    const collDiv = el("div", "collapsible");
    const promptTrigger = el("span", "collapse-trigger");
    promptTrigger.dataset.target = `prompt_${r.callId}`;
    promptTrigger.textContent = "完整 Prompt";
    collDiv.appendChild(promptTrigger);
    const promptBody = el("div", "collapse-body");
    promptBody.id = `prompt_${r.callId}`;
    promptBody.textContent = fullPrompt;
    collDiv.appendChild(promptBody);
    inputSection.appendChild(collDiv);

    card.appendChild(inputSection);

    // ── 过程区 ──
    const procSection = el("div", "call-section");
    const procTitle = el("div", "section-title");
    procTitle.textContent = "⚙️ 过程";
    procSection.appendChild(procTitle);

    const modelField = el("div", "field");
    modelField.textContent = `模型：${modelName}`;
    procSection.appendChild(modelField);

    const durField = el("div", "field");
    durField.textContent = `耗时：${duration}`;
    const chunkHint = el("span");
    chunkHint.style.cssText = "color:#94a3b8;font-size:0.7rem";
    chunkHint.textContent = ` · 数据块 ${chunkCount} 个`;
    durField.appendChild(chunkHint);
    procSection.appendChild(durField);

    card.appendChild(procSection);

    // ── 输出区 ──
    const outSection = el("div", "call-section");
    const outTitle = el("div", "section-title");
    outTitle.textContent = "📤 输出";
    outSection.appendChild(outTitle);

    const outTextDiv = el("div", "output-text");
    outTextDiv.textContent = outputText || "（无输出）";
    if (!outputText) outTextDiv.style.color = "#94a3b8";
    outSection.appendChild(outTextDiv);

    if (rawResponse) {
      const rawCollDiv = el("div", "collapsible");
      rawCollDiv.style.marginTop = "0.5rem";
      const rawTrigger = el("span", "collapse-trigger");
      rawTrigger.dataset.target = `raw_${r.callId}`;
      rawTrigger.textContent = "原始响应";
      rawCollDiv.appendChild(rawTrigger);
      const rawBody = el("div", "collapse-body");
      rawBody.id = `raw_${r.callId}`;
      rawBody.textContent = rawResponse;
      rawCollDiv.appendChild(rawBody);
      outSection.appendChild(rawCollDiv);
    }

    card.appendChild(outSection);

    // ── 错误诊断（仅在失败时显示） ──
    if (!success && (errorType || r.output?.error)) {
      const errSection = el("div", "call-section");
      const errTitle = el("div", "section-title");
      errTitle.textContent = "❗ " + (errorType ? "错误诊断" : "错误信息");
      errSection.appendChild(errTitle);

      const errBox = el("div", "call-error");
      if (errorType) {
        const diag = getDiag(errorType);
        const errTypeDiv = el("div", "err-type");
        errTypeDiv.textContent = diag.label;
        errBox.appendChild(errTypeDiv);
        const sugDiv = el("div", "err-suggestion");
        sugDiv.textContent = "💡 " + diag.suggestion;
        errBox.appendChild(sugDiv);
      } else {
        const errTypeDiv = el("div", "err-type");
        errTypeDiv.textContent = "未知错误";
        errBox.appendChild(errTypeDiv);
      }
      if (r.output?.error) {
        const detDiv = el("div", "err-detail");
        detDiv.textContent = r.output.error.slice(0, 300);
        errBox.appendChild(detDiv);
      }
      errSection.appendChild(errBox);
      card.appendChild(errSection);
    }

    // ── 操作按钮 ──
    const actions = el("div", "call-actions");
    const copyBtn = el("button", "btn-copy-payload", { "data-call-id": r.callId });
    copyBtn.textContent = "📋 复制请求体";
    actions.appendChild(copyBtn);

    const rerunBtn = el("button", "btn-rerun", { "data-call-id": r.callId });
    rerunBtn.textContent = "🔄 重新运行";
    actions.appendChild(rerunBtn);

    const delBtn = el("button", "btn-delete-record", { "data-call-id": r.callId });
    delBtn.style.cssText = "margin-left:auto;color:#dc2626;border-color:#fecaca";
    delBtn.textContent = "🗑 删除";
    actions.appendChild(delBtn);

    card.appendChild(actions);

    return card;
  }

  // ── 折叠切换 ──
  function setupCollapse() {
    document.getElementById("callList").addEventListener("click", (e) => {
      const trigger = e.target.closest(".collapse-trigger");
      if (!trigger) return;
      const targetId = trigger.dataset.target;
      const body = document.getElementById(targetId);
      if (!body) return;
      const isOpen = body.classList.toggle("open");
      trigger.classList.toggle("expanded", isOpen);
    });
  }

  // ── 复制请求体 ──
  async function handleCopyPayload(callId) {
    const resp = await browserApi.runtime.sendMessage({ type: "getCallRecord", callId });
    const record = resp?.record;
    if (!record?.requestPayload) {
      alert("请求体数据不可用");
      return;
    }
    const payload = record.requestPayload;
    const text = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      showToast("请求体已复制到剪贴板");
    } catch {
      // 兜底：通过后台脚本复制（扩展环境 Clipboard API 通常可用）
      try {
        const blob = new Blob([text], { type: "text/plain" });
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
        showToast("请求体已复制到剪贴板");
      } catch {
        alert("复制失败，请手动复制。");
      }
    }
  }

  // ── 重新运行 ──
  async function handleRerun(callId) {
    const btn = document.querySelector(`.btn-rerun[data-call-id="${callId}"]`);
    if (btn) { btn.textContent = "⏳ 运行中…"; btn.disabled = true; }
    const resp = await browserApi.runtime.sendMessage({ type: "rerunCall", callId });
    if (btn) { btn.textContent = "🔄 重新运行"; btn.disabled = false; }
    if (resp?.error) {
      alert("重新运行失败：" + resp.error);
      return;
    }
    showToast("重新运行完成");
    await loadAll();
  }

  // ── 删除单条记录 ──
  async function handleDelete(callId) {
    if (!confirm("确定删除这条记录？")) return;
    await browserApi.runtime.sendMessage({ type: "deleteCallRecord", callId });
    showToast("已删除");
    await loadAll();
  }

  // ── Toast ──
  let toastTimer = null;
  function showToast(msg) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.style.cssText = `
        position:fixed; bottom:2rem; left:50%; transform:translateX(-50%);
        background:#1e293b; color:#fff; padding:0.6rem 1.2rem; border-radius:8px;
        font-size:0.8125rem; z-index:9999; transition:opacity 0.2s; opacity:0;
        pointer-events:none; white-space:nowrap;`;
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = "1";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = "0"; }, 2200);
  }

  // ── 按钮事件绑定（事件委托） ──
  function setupCardActions() {
    document.getElementById("callList").addEventListener("click", (e) => {
      const copyBtn = e.target.closest(".btn-copy-payload");
      if (copyBtn) {
        handleCopyPayload(copyBtn.dataset.callId);
        return;
      }
      const rerunBtn = e.target.closest(".btn-rerun");
      if (rerunBtn) {
        handleRerun(rerunBtn.dataset.callId);
        return;
      }
      const deleteBtn = e.target.closest(".btn-delete-record");
      if (deleteBtn) {
        handleDelete(deleteBtn.dataset.callId);
        return;
      }
    });
  }

  // ── 数据加载 ──
  async function loadAll() {
    try {
      const [statsResp, profResp, recordsResp] = await Promise.all([
        browserApi.runtime.sendMessage({ type: "getApiStats" }),
        browserApi.runtime.sendMessage({ type: "getProfilesInfo" }),
        browserApi.runtime.sendMessage({ type: "getCallRecords" }),
      ]);
      if (statsResp?.stats) renderStats(statsResp.stats);
      if (profResp) renderConfig(profResp);
      if (recordsResp?.records) renderCards(recordsResp.records);
      $("refreshTime").textContent = `上次刷新：${formatTime(Date.now())}`;
    } catch (e) {
      const container = $("callList");
      container.textContent = "";
      const errDiv = el("div", "call-empty");
      errDiv.textContent = "加载失败：" + e.message;
      container.appendChild(errDiv);
    }
  }

  async function clearRecords() {
    if (!confirm("确定清空所有调用记录？")) return;
    try {
      await browserApi.runtime.sendMessage({ type: "clearCallRecords" });
      await loadAll();
    } catch (e) {
      console.error("清空记录失败", e);
    }
  }

  // ── 筛选 ──
  function setupFilters() {
    const tags = $("filterRow").querySelectorAll(".filter-tag");
    tags.forEach(tag => {
      tag.addEventListener("click", () => {
        tags.forEach(t => t.classList.remove("active"));
        tag.classList.add("active");
        filterValue = tag.dataset.filter;
        renderCards(allRecords);
      });
    });
  }

  // ── 返回 ──
  function goBack() {
    if (browserApi.runtime.openOptionsPage) {
      browserApi.runtime.openOptionsPage();
    } else {
      window.open(browserApi.runtime.getURL("options.html"));
    }
  }

  // ── 启动 ──
  document.addEventListener("DOMContentLoaded", () => {
    loadAll();
    setupFilters();
    setupCollapse();
    setupCardActions();

    $("refreshBtn").addEventListener("click", loadAll);
    $("clearBtn").addEventListener("click", clearRecords);
    $("backBtn").addEventListener("click", goBack);
  });
})();