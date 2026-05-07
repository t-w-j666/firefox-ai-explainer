/**
 * AI Text Explainer — Content Script
 *
 * 流程（与后端透明对齐）：
 * 1) mouseup → window.getSelection() 取划选文本与 Range 矩形（视口坐标）
 * 2) 在 Shadow DOM 内显示「AI 解释」浮动按钮（position: fixed）
 * 3) 点击按钮 → fetch(POST /explain/stream, JSON { text, context })，Accept: text/event-stream
 * 4) 通过 runtime.connect 交给 background.js 发起 fetch + SSE 解析（绕过 GitHub 等站的 CSP）。
 *
 * 性能：mouseup 仅调度短延迟 + rAF；不在滚动/输入事件上做重逻辑。
 * 稳定性：超时（AbortController）、网络失败、非 2xx 均有可读提示。
 */

(() => {
  "use strict";

  const ext = globalThis.browser ?? globalThis.chrome;

  /** 默认后端根 URL；可通过 storage.local.apiBaseUrl 覆盖（字符串，无末尾斜杠亦可） */
  const DEFAULT_API_BASE = "http://127.0.0.1:8765";

  /** 流式请求超时（毫秒）；后端未启动时会较快失败 */
  const STREAM_TIMEOUT_MS = 120000;

  /** 划选变化去抖（毫秒），减轻拖拽选中时的频繁布局 */
  const SELECTION_DEBOUNCE_MS = 48;

  /** 提交给后端的上下文最大字符数（与 main.py 默认协调） */
  const MAX_CONTEXT_CHARS = 6000;

  let shadowHost = null;
  /** @type {ShadowRoot | null} */
  let shadowRoot = null;
  let cssLoadedPromise = null;

  let debounceTimer = 0;
  /** @type {{ text: string; context: string; rect: DOMRect } | null} */
  let pendingExplain = null;

  /** 当前流式请求的中止控制器（关闭浮层时 abort，避免浪费_token） */
  let streamAbortController = null;

  function getApiBase() {
    if (!ext?.storage?.local?.get) return Promise.resolve(DEFAULT_API_BASE);

    try {
      const res = ext.storage.local.get(["apiBaseUrl"]);
      if (res && typeof res.then === "function") {
        return res
          .then((obj) => {
            const v = obj?.apiBaseUrl;
            return typeof v === "string" && v.trim() ? v.trim() : DEFAULT_API_BASE;
          })
          .catch(() => DEFAULT_API_BASE);
      }
    } catch {
      return Promise.resolve(DEFAULT_API_BASE);
    }

    return new Promise((resolve) => {
      ext.storage.local.get(["apiBaseUrl"], (obj) => {
        if (ext.runtime?.lastError) {
          resolve(DEFAULT_API_BASE);
          return;
        }
        const v = obj?.apiBaseUrl;
        resolve(typeof v === "string" && v.trim() ? v.trim() : DEFAULT_API_BASE);
      });
    });
  }

  function loadCssIntoShadow(sr) {
    if (!cssLoadedPromise) {
      const url = ext.runtime.getURL("popup.css");
      cssLoadedPromise = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`加载 popup.css 失败: ${r.status}`);
          return r.text();
        })
        .then((text) => {
          const style = document.createElement("style");
          style.textContent = text;
          sr.appendChild(style);
        })
        .catch((e) => {
          console.error("[AI Explainer]", e);
          const style = document.createElement("style");
          style.textContent =
            ":host{font-family:system-ui,sans-serif}.ai-card{padding:12px;background:#fff;color:#111}";
          sr.appendChild(style);
        });
    }
    return cssLoadedPromise;
  }

  function ensureUi() {
    if (shadowHost && shadowRoot) return shadowRoot;
    shadowHost = document.createElement("div");
    shadowHost.id = "ai-text-explainer-extension-root";
    shadowRoot = shadowHost.attachShadow({ mode: "open" });
    document.documentElement.appendChild(shadowHost);

    const root = document.createElement("div");
    root.className = "ai-root";
    root.innerHTML = `
      <button type="button" class="ai-fab" id="aiFab" aria-label="AI 解释">AI 解释</button>
      <div class="ai-overlay" id="aiOverlay" data-open="false"></div>
      <section class="ai-card" id="aiCard" data-open="false" role="dialog" aria-modal="true" aria-labelledby="aiCardTitle">
        <header class="ai-card-header">
          <h2 class="ai-card-title" id="aiCardTitle">词汇解释</h2>
          <button type="button" class="ai-close" id="aiClose" aria-label="关闭">×</button>
        </header>
        <div class="ai-selection-preview" id="aiSelPreview"></div>
        <div class="ai-body ai-loading" id="aiBody">连接后端并生成解释中…</div>
        <div class="ai-error" id="aiError" hidden></div>
        <div class="ai-footer-hint">流式输出 · 点击空白区域关闭</div>
      </section>
    `;
    shadowRoot.appendChild(root);

    const fab = shadowRoot.getElementById("aiFab");
    const overlay = shadowRoot.getElementById("aiOverlay");
    const card = shadowRoot.getElementById("aiCard");
    const closeBtn = shadowRoot.getElementById("aiClose");

    fab.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!pendingExplain?.text) return;
      const payload = { ...pendingExplain };
      openPanel(payload);
      void runStream(payload);
    });

    function closePanel() {
      streamAbortController?.abort();
      streamAbortController = null;
      overlay.dataset.open = "false";
      card.dataset.open = "false";
      pendingExplain = null;
      hideFab(shadowRoot);
    }

    closeBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      closePanel();
    });

    overlay.addEventListener("click", () => closePanel());

    card.addEventListener("click", (ev) => ev.stopPropagation());

    return shadowRoot;
  }

  /**
   * 获取划选周围的可见文本作为 context（块级祖先 innerText，围绕选中片段截取）。
   */
  function getContextAroundSelection(sel, selectedText, maxLen) {
    if (!sel.rangeCount) return "";
    const range = sel.getRangeAt(0);
    let node = range.commonAncestorContainer;
    const el =
      node.nodeType === Node.ELEMENT_NODE
        ? /** @type {Element} */ (node)
        : node.parentElement;
    const block =
      el?.closest?.(
        "article,section,main,p,li,td,th,blockquote,pre,code,[role='article']",
      ) ?? el?.closest?.("div") ?? document.body;
    let full = "";
    try {
      full = block.innerText ?? block.textContent ?? "";
    } catch {
      full = document.body.innerText ?? "";
    }
    full = full.replace(/\s+/g, " ").trim();
    const idx = full.indexOf(selectedText);
    const half = Math.max(0, Math.floor((maxLen - selectedText.length) / 2));
    if (idx === -1) return full.slice(0, maxLen);
    const start = Math.max(0, idx - half);
    return full.slice(start, start + maxLen);
  }

  function hideFab(sr) {
    if (!sr) return;
    const fab = sr.getElementById("aiFab");
    if (!fab) return;
    fab.dataset.visible = "false";
    pendingExplain = null;
  }

  function placeFab(sr, rect) {
    const fab = sr.getElementById("aiFab");
    if (!fab) return;
    const pad = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    fab.dataset.visible = "true";
    fab.style.left = "0";
    fab.style.top = "0";
    void fab.offsetWidth;
    const bw = fab.offsetWidth || 88;
    const bh = fab.offsetHeight || 32;

    /* position:fixed → 视口坐标，勿加 scrollX/Y */
    let vx = rect.left + pad;
    let vy = rect.bottom + pad;
    if (vx + bw > vw - 8) vx = Math.max(8, vw - bw - 8);
    if (vy + bh > vh - 8) vy = Math.max(8, rect.top - bh - pad);
    fab.style.left = `${vx}px`;
    fab.style.top = `${vy}px`;
  }

  function handleSelectionChange() {
    const sr = ensureUi();
    const sel = window.getSelection();
    const text = sel?.toString()?.trim() ?? "";

    if (!text || !sel || sel.rangeCount === 0) {
      hideFab(sr);
      return;
    }

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width < 2 && rect.height < 2) {
      hideFab(sr);
      return;
    }

    const contextRaw = getContextAroundSelection(sel, text, MAX_CONTEXT_CHARS);
    pendingExplain = {
      text,
      context: contextRaw.slice(0, MAX_CONTEXT_CHARS),
      rect,
    };
    placeFab(sr, rect);
  }

  function onMouseUp(ev) {
    if (ev.button !== 0) return;
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      window.requestAnimationFrame(() => handleSelectionChange());
    }, SELECTION_DEBOUNCE_MS);
  }

  /** 滚动或缩放时隐藏按钮，避免错位；不重算布局以省开销 */
  function onViewportChange() {
    const sr = shadowRoot;
    if (sr) hideFab(sr);
  }

  function openPanel(payload) {
    const sr = ensureUi();
    const fab = sr.getElementById("aiFab");
    if (fab) fab.dataset.visible = "false";

    const overlay = sr.getElementById("aiOverlay");
    const card = sr.getElementById("aiCard");
    const preview = sr.getElementById("aiSelPreview");
    const body = sr.getElementById("aiBody");
    const errEl = sr.getElementById("aiError");

    overlay.dataset.open = "true";
    card.dataset.open = "true";

    const r = payload.rect;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = Math.min(420, vw - 32);
    let cx = r.right + 12;
    let cy = r.top;
    if (cx + cw > vw - 16) cx = Math.max(16, r.left - cw - 12);
    if (cx < 16) cx = 16;
    cy = Math.max(16, Math.min(cy, vh - 120));
    card.style.left = `${cx}px`;
    card.style.top = `${cy}px`;

    preview.innerHTML = `<strong>划选</strong>：${escapeHtml(payload.text.slice(0, 200))}${
      payload.text.length > 200 ? "…" : ""
    }`;
    body.textContent = "";
    body.classList.add("ai-loading");
    errEl.hidden = true;
    errEl.textContent = "";

    const cursor = document.createElement("span");
    cursor.className = "ai-cursor";
    body.appendChild(cursor);
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * 经后台脚本转发 SSE（避免 github.com 等页面的 CSP 拦截 fetch localhost）。
   */
  function streamExplainViaBackground(
    apiBase,
    text,
    context,
    onChunk,
    onError,
    outerSignal,
  ) {
    return new Promise((resolve) => {
      let settled = false;
      let port;

      const finish = () => {
        if (settled) return;
        settled = true;
        outerSignal?.removeEventListener("abort", onAbort);
        resolve();
      };

      const onAbort = () => {
        try {
          port?.disconnect();
        } catch {
          /* ignore */
        }
        finish();
      };

      if (outerSignal?.aborted) {
        finish();
        return;
      }
      outerSignal?.addEventListener("abort", onAbort, { once: true });

      try {
        port = ext.runtime.connect({ name: "ai-explainer-sse" });
      } catch (e) {
        onError("无法连接扩展后台，请在 about:debugging 中重新加载本扩展。");
        finish();
        return;
      }

      port.onMessage.addListener(function onMsg(msg) {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "chunk" && msg.text) onChunk(String(msg.text));
        if (msg.type === "error" && msg.message) onError(String(msg.message));
        if (msg.type === "done") {
          port.onMessage.removeListener(onMsg);
          try {
            port.disconnect();
          } catch {
            /* ignore */
          }
          finish();
        }
      });

      port.onDisconnect.addListener(() => {
        port.onMessage.removeListener(onMsg);
        finish();
      });

      try {
        port.postMessage({
          type: "start",
          apiBase,
          text,
          context,
          timeoutMs: STREAM_TIMEOUT_MS,
        });
      } catch {
        onError("无法连接扩展后台，请在 about:debugging 中重新加载本扩展。");
        try {
          port.disconnect();
        } catch {
          /* ignore */
        }
        finish();
      }
    });
  }

  async function runStream(payload) {
    const sr = ensureUi();
    const body = sr.getElementById("aiBody");
    const errEl = sr.getElementById("aiError");

    streamAbortController?.abort();
    streamAbortController = new AbortController();
    const outerSignal = streamAbortController.signal;

    await loadCssIntoShadow(sr);

    let plain = "";
    const applyBody = () => {
      body.classList.remove("ai-loading");
      body.textContent = plain;
      const cursor = document.createElement("span");
      cursor.className = "ai-cursor";
      body.appendChild(cursor);
    };

    const onChunk = (chunk) => {
      plain += chunk;
      applyBody();
    };

    const onError = (msg) => {
      if (outerSignal.aborted) return;
      errEl.hidden = false;
      errEl.textContent = msg;
      body.classList.remove("ai-loading");
      const cursor = body.querySelector(".ai-cursor");
      if (cursor) cursor.remove();
    };

    const apiBase = await getApiBase();
    await streamExplainViaBackground(
      apiBase,
      payload.text,
      payload.context,
      onChunk,
      onError,
      outerSignal,
    );

    streamAbortController = null;

    const cursor = body.querySelector(".ai-cursor");
    if (cursor) cursor.remove();
  }

  async function init() {
    ensureUi();
    await loadCssIntoShadow(shadowRoot);

    document.addEventListener("mouseup", onMouseUp, { passive: true });
    /* 键盘 Shift+方向键 选区结束时同步按钮位置（去抖，避免 selectionchange 风暴） */
    document.addEventListener(
      "keyup",
      () => {
        window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
          window.requestAnimationFrame(() => handleSelectionChange());
        }, SELECTION_DEBOUNCE_MS + 40);
      },
      { passive: true },
    );
    window.addEventListener("scroll", onViewportChange, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", onViewportChange, { passive: true });
  }

  void init();
})();
