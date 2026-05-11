/**
 * 后台脚本：直调 OpenAI 兼容 API（DeepSeek / OpenAI 等）。
 * API Key 从 storage.local 读取（由 options/popup 页面配置）。
 */

const browserApi = globalThis.browser ?? globalThis.chrome;

/* ===================================================================
 * 日志工具 — 同时写入 console + 内存环形缓冲区
 * =================================================================== */
const LOG_MAX = 200;
let logEntries = [];

function pushLog(level, message, data) {
  const entry = { level, message, data, timestamp: Date.now() };
  logEntries.push(entry);
  if (logEntries.length > LOG_MAX) logEntries.shift();
}

const log = {
  debug: (msg, data) => {
    console.debug("[AI Explainer]", msg, data ?? "");
    pushLog("debug", msg, data);
  },
  info: (msg, data) => {
    console.info("[AI Explainer]", msg, data ?? "");
    pushLog("info", msg, data);
  },
  warn: (msg, data) => {
    console.warn("[AI Explainer]", msg, data ?? "");
    pushLog("warn", msg, data);
  },
  error: (msg, data) => {
    console.error("[AI Explainer]", msg, data ?? "");
    pushLog("error", msg, data);
  },
};

/* ===================================================================
 * 调用记录 (callRecords) — 每条记录完整的输入/过程/输出
 * =================================================================== */
const CALL_RECORDS_MAX = 50;
let callRecords = [];
let callIdSeq = 0;

function generateCallId() {
  return `call_${Date.now()}_${callIdSeq++}`;
}

function pushCallRecord(record) {
  callRecords.unshift(record);
  if (callRecords.length > CALL_RECORDS_MAX) callRecords.pop();
}

function classifyError(status, errorMessage) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  if (status >= 500) return "server_error";
  if (errorMessage?.includes("AbortError") || errorMessage?.includes("timeout") || errorMessage?.includes("超时"))
    return "timeout";
  if (errorMessage?.includes("fetch") || errorMessage?.includes("NetworkError") || errorMessage?.includes("net::ERR"))
    return "network";
  return "unknown";
}

/* ===================================================================
 * 常量
 * =================================================================== */
const DEFAULT_SYSTEM_PROMPT =
  "你是一个专业的文本解释助手。当用户选中一段文本时，请用简洁易懂的语言解释其含义、背景和用途。";

const STORE_KEY_PROMPT_PROFILES = "promptProfiles";
const STORE_KEY_ACTIVE_PROMPT = "activePromptProfileId";

const MAX_CONTEXT_CHARS = 6000;

/* ===================================================================
 * API 调用统计
 * =================================================================== */
const API_STATS_KEY = "apiStats";

async function getApiStats() {
  const obj = await browserApi.storage.local.get(API_STATS_KEY);
  return obj[API_STATS_KEY] || {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    timeoutCalls: 0,
    totalDurationMs: 0,
    lastCallAt: null,
  };
}

async function recordApiCall(success, durationMs, timeout = false) {
  try {
    const stats = await getApiStats();
    stats.totalCalls++;
    stats.totalDurationMs += durationMs;
    stats.lastCallAt = Date.now();
    if (timeout) stats.timeoutCalls++;
    else if (success) stats.successfulCalls++;
    else stats.failedCalls++;
    await browserApi.storage.local.set({ [API_STATS_KEY]: stats });
  } catch (e) {
    log.error("写入 API 统计失败", e);
  }
}

/* ===================================================================
 * 配置读取
 * =================================================================== */
async function getApiConfig() {
  const obj = await browserApi.storage.local.get([
    "apiProfiles", "activeProfileId",
    "apiKey", "apiBaseUrl", "modelName",
  ]);

  const profiles = obj.apiProfiles;
  const activeId = obj.activeProfileId;
  if (profiles && profiles.length > 0) {
    const active = activeId
      ? profiles.find(p => p.id === activeId)
      : profiles[0];
    if (active) {
      log.info("使用配置方案", active.name, `(${active.modelName})`);
      return {
        apiKey: (active.apiKey || "").trim(),
        apiBaseUrl: ((active.apiBaseUrl || "").trim()).replace(/\/+$/, ""),
        modelName: (active.modelName || "").trim(),
      };
    }
  }

  log.warn("未找到配置方案，回退到旧版扁平存储");
  return {
    apiKey: (obj.apiKey || "").trim(),
    apiBaseUrl: ((obj.apiBaseUrl || "").trim()).replace(/\/+$/, ""),
    modelName: (obj.modelName || "").trim(),
  };
}

function buildUserPrompt(text, context) {
  const ctx = (context || "").trim() || "（无额外上下文）";
  const truncated = ctx.length > MAX_CONTEXT_CHARS
    ? ctx.slice(0, MAX_CONTEXT_CHARS) + "\n…（上下文已截断）"
    : ctx;
  return `划选词句：\n${text}\n\n上下文：\n${truncated}`;
}

/* ===================================================================
 * 连接处理器 — 处理 content script 的 SSE 流式请求
 * =================================================================== */
browserApi.runtime.onConnect.addListener((port) => {
  if (port.name !== "ai-explainer-sse") return;
  log.info("收到内容脚本连接");

  let abortController = null;

  port.onDisconnect.addListener(() => {
    if (abortController) {
      log.debug("端口断开，中止请求");
      abortController.abort();
      abortController = null;
    }
  });

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "start") return;
    log.info("收到解释请求", { textLen: msg.text?.length, contextLen: msg.context?.length });

    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;

    const timeoutMs = typeof msg.timeoutMs === "number" && msg.timeoutMs > 0
      ? msg.timeoutMs
      : 120000;
    const timer = setTimeout(() => signal.abort(), timeoutMs);
    const startTime = performance.now();

    // 创建调用记录
    const callId = generateCallId();
    const userPrompt = buildUserPrompt(msg.text, msg.context ?? "");
    const userPromptForRecord = userPrompt;

    let callRecord = {
      callId,
      timestamp: Date.now(),
      success: false,
      input: {
        selectedText: msg.text || "",
        context: msg.context || "",
        fullPrompt: "",
        modelName: "",
        apiBaseUrl: "",
      },
      process: {
        durationMs: 0,
        chunkCount: 0,
      },
      output: {
        fullText: null,
        rawResponse: null,
        error: null,
        errorType: null,
        statusCode: null,
      },
      requestPayload: null,
    };

    void (async () => {
      // 1) 读取配置
      let config;
      try {
        config = await getApiConfig();
      } catch (e) {
        log.error("读取配置异常", e);
        clearTimeout(timer);
        callRecord.output.error = "读取配置失败。";
        pushCallRecord(callRecord);
        safePost(port, { type: "error", message: "读取配置失败。" });
        safePost(port, { type: "done" });
        return;
      }

      if (!config.apiKey) {
        log.warn("API Key 未配置");
        clearTimeout(timer);
        callRecord.output.error = "未配置 API Key";
        callRecord.output.errorType = "auth";
        pushCallRecord(callRecord);
        safePost(port, { type: "error", message: "未配置 API Key。请在扩展设置中配置。" });
        safePost(port, { type: "done" });
        return;
      }

      callRecord.input.modelName = config.modelName;
      callRecord.input.apiBaseUrl = config.apiBaseUrl;

      // 2) 构造请求
      const url = `${config.apiBaseUrl}/chat/completions`;

      // 从 storage 读取当前活动的提示词方案
      const promptStore = await browserApi.storage.local.get([STORE_KEY_PROMPT_PROFILES, STORE_KEY_ACTIVE_PROMPT]);
      const allPrompts = promptStore[STORE_KEY_PROMPT_PROFILES] || [];
      const activePid = promptStore[STORE_KEY_ACTIVE_PROMPT];
      const matched = allPrompts.find(p => p.id === activePid);
      const systemPromptContent = matched ? matched.content : DEFAULT_SYSTEM_PROMPT;
      callRecord.input.fullPrompt = `${systemPromptContent}\n\n${userPromptForRecord}`;

      const bodyPayload = {
        model: config.modelName,
        messages: [
          { role: "system", content: systemPromptContent },
          { role: "user", content: userPromptForRecord },
        ],
        stream: true,
        temperature: 0.3,
      };
      const body = JSON.stringify(bodyPayload);

      callRecord.requestPayload = {
        url,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
          Accept: "text/event-stream",
        },
        body: bodyPayload,
      };

      log.debug("发送 API 请求", { url, model: config.modelName });

      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
            Accept: "text/event-stream",
          },
          body,
          signal,
          cache: "no-store",
        });
      } catch (e) {
        clearTimeout(timer);
        const elapsed = performance.now() - startTime;
        callRecord.process.durationMs = Math.round(elapsed);
        if (signal.aborted) {
          log.warn("请求超时或被中止", elapsed.toFixed(0) + "ms");
          callRecord.output.error = "请求超时";
          callRecord.output.errorType = "timeout";
          await recordApiCall(false, elapsed, true);
          pushCallRecord(callRecord);
          safePost(port, { type: "done" });
          return;
        }
        log.error("网络请求失败", e?.message || e);
        callRecord.output.error = e?.message || String(e);
        callRecord.output.errorType = classifyError(null, e?.message);
        await recordApiCall(false, elapsed);
        const errMsg =
          e?.name === "AbortError"
            ? `请求超时（${timeoutMs / 1000}s）。请检查网络连接。`
            : `无法连接 API 服务（${config.apiBaseUrl}）：${e?.message || e}`;
        pushCallRecord(callRecord);
        safePost(port, { type: "error", message: errMsg });
        safePost(port, { type: "done" });
        return;
      }

      clearTimeout(timer);

      if (!res.ok) {
        let detail = "";
        try {
          detail = await res.text();
        } catch (e) {
          log.error("读取错误响应体失败", e);
        }
        const elapsed = performance.now() - startTime;
        callRecord.process.durationMs = Math.round(elapsed);
        callRecord.output.error = `API 返回 ${res.status}：${detail.slice(0, 500)}`;
        callRecord.output.errorType = classifyError(res.status);
        callRecord.output.statusCode = res.status;
        log.error("API 返回错误", { status: res.status, detail: detail.slice(0, 200) });
        await recordApiCall(false, elapsed);
        pushCallRecord(callRecord);
        safePost(port, {
          type: "error",
          message: `API 返回 ${res.status}：${detail.slice(0, 500)}`,
        });
        safePost(port, { type: "done" });
        return;
      }

      log.info("API 请求成功，开始解析 SSE 流");

      // 3) 解析 SSE 流
      const reader = res.body?.getReader();
      if (!reader) {
        log.error("无法获取响应流 reader");
        const elapsed = performance.now() - startTime;
        callRecord.process.durationMs = Math.round(elapsed);
        callRecord.output.error = "无法读取响应流。";
        callRecord.output.errorType = "unknown";
        await recordApiCall(false, elapsed);
        pushCallRecord(callRecord);
        safePost(port, { type: "error", message: "无法读取响应流。" });
        safePost(port, { type: "done" });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let chunkCount = 0;
      let fullOutputText = "";
      let rawResponseLines = [];

      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const block of parts) {
            for (const line of block.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const raw = trimmed.slice(5).trim();
              if (raw === "[DONE]") {
                const elapsed = performance.now() - startTime;
                callRecord.process.durationMs = Math.round(elapsed);
                callRecord.process.chunkCount = chunkCount;
                callRecord.output.fullText = fullOutputText;
                callRecord.output.rawResponse = rawResponseLines.join("\n");
                callRecord.success = true;
                log.debug("SSE 完成", { chunks: chunkCount, duration: elapsed.toFixed(0) + "ms" });
                await recordApiCall(true, elapsed);
                pushCallRecord(callRecord);
                safePost(port, { type: "done" });
                return;
              }
              let obj;
              try {
                obj = JSON.parse(raw);
              } catch {
                log.warn("SSE JSON 解析失败", raw.slice(0, 80));
                continue;
              }
              rawResponseLines.push(raw);
              const delta = obj?.choices?.[0]?.delta;
              const textDelta = delta?.content || delta?.reasoning_content || "";
              if (textDelta) {
                chunkCount++;
                fullOutputText += textDelta;
                safePost(port, { type: "chunk", text: textDelta });
              }
              const finishReason = obj?.choices?.[0]?.finish_reason;
              if (finishReason === "stop" || finishReason === "length") {
                const elapsed = performance.now() - startTime;
                callRecord.process.durationMs = Math.round(elapsed);
                callRecord.process.chunkCount = chunkCount;
                callRecord.output.fullText = fullOutputText;
                callRecord.output.rawResponse = rawResponseLines.join("\n");
                callRecord.success = true;
                log.debug("SSE finish", { reason: finishReason, chunks: chunkCount, duration: elapsed.toFixed(0) + "ms" });
                await recordApiCall(true, elapsed);
                pushCallRecord(callRecord);
                safePost(port, { type: "done" });
                return;
              }
            }
          }
        }
      } catch (e) {
        const elapsed = performance.now() - startTime;
        callRecord.process.durationMs = Math.round(elapsed);
        callRecord.process.chunkCount = chunkCount;
        callRecord.output.fullText = fullOutputText;
        callRecord.output.rawResponse = rawResponseLines.join("\n");
        if (!signal.aborted) {
          log.error("SSE 读取异常", e?.message || e);
          callRecord.output.error = e?.message || String(e);
          callRecord.output.errorType = classifyError(null, e?.message);
          await recordApiCall(false, elapsed);
          pushCallRecord(callRecord);
          safePost(port, { type: "error", message: e?.message || String(e) });
        } else {
          log.warn("SSE 被中止", { chunks: chunkCount, duration: elapsed.toFixed(0) + "ms" });
          callRecord.output.error = "请求被中止";
          callRecord.output.errorType = "timeout";
          await recordApiCall(false, elapsed, true);
          pushCallRecord(callRecord);
        }
        safePost(port, { type: "done" });
        return;
      }

      // 流正常结束（未收到 [DONE] 或 finish_reason）
      const elapsed = performance.now() - startTime;
      callRecord.process.durationMs = Math.round(elapsed);
      callRecord.process.chunkCount = chunkCount;
      callRecord.output.fullText = fullOutputText;
      callRecord.output.rawResponse = rawResponseLines.join("\n");
      callRecord.success = true;
      await recordApiCall(true, elapsed);
      pushCallRecord(callRecord);
      safePost(port, { type: "done" });
    })();
  });
});

function safePost(port, payload) {
  try {
    port.postMessage(payload);
  } catch {
    log.debug("port.postMessage 失败：端口已关闭");
  }
}

/* ===================================================================
 * 消息处理器 — 日志页查询 & 配置信息
 * =================================================================== */
function clearLogEntries() {
  logEntries = [];
}

browserApi.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getLogEntries") {
    sendResponse({ entries: logEntries.slice() });
    return true;
  }
  if (msg.type === "clearLogEntries") {
    clearLogEntries();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "getApiStats") {
    getApiStats().then(stats => sendResponse({ stats }));
    return true;
  }
  if (msg.type === "getProfilesInfo") {
    browserApi.storage.local.get(["apiProfiles", "activeProfileId"]).then(obj => {
      const profiles = obj.apiProfiles || [];
      const activeId = obj.activeProfileId || null;
      const active = activeId ? profiles.find(p => p.id === activeId) : profiles[0] || null;
      sendResponse({
        profiles: profiles.map(p => ({ id: p.id, name: p.name, modelName: p.modelName })),
        activeProfile: active ? { name: active.name, modelName: active.modelName } : null,
      });
    });
    return true;
  }

  // === 调用记录 (callRecords) 消息 ===
  if (msg.type === "getCallRecords") {
    sendResponse({ records: callRecords.slice() });
    return true;
  }

  if (msg.type === "getCallRecord") {
    const record = callRecords.find(r => r.callId === msg.callId);
    sendResponse({ record: record || null });
    return true;
  }

  if (msg.type === "clearCallRecords") {
    callRecords = [];
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "deleteCallRecord") {
    callRecords = callRecords.filter(r => r.callId !== msg.callId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "rerunCall") {
    handleRerun(msg.callId).then(result => sendResponse(result));
    return true;
  }
});

/* ===================================================================
 * 重新运行 — 用已保存的请求体重新执行 API 调用（非流式）
 * =================================================================== */
async function handleRerun(callId) {
  const record = callRecords.find(r => r.callId === callId);
  if (!record) return { error: "记录不存在" };
  if (!record.requestPayload) return { error: "请求体数据不完整" };

  const payload = record.requestPayload;
  const bodyPayload = JSON.parse(JSON.stringify(payload.body));
  bodyPayload.stream = false;
  const body = JSON.stringify(bodyPayload);

  let config;
  try {
    config = await getApiConfig();
  } catch (e) {
    return { error: "读取配置失败" };
  }

  const newCallId = generateCallId();
  const startTime = performance.now();

  const newRecord = {
    callId: newCallId,
    timestamp: Date.now(),
    success: false,
    input: { ...record.input },
    process: { durationMs: 0, chunkCount: 0 },
    output: { fullText: null, rawResponse: null, error: null, errorType: null, statusCode: null },
    requestPayload: payload,
  };

  try {
    const res = await fetch(payload.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
      cache: "no-store",
    });

    const elapsed = Math.round(performance.now() - startTime);
    newRecord.process.durationMs = elapsed;

    if (res.ok) {
      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content || JSON.stringify(json);
      newRecord.output.fullText = text;
      newRecord.output.rawResponse = JSON.stringify(json, null, 2);
      newRecord.success = true;
      await recordApiCall(true, elapsed);
    } else {
      const detail = await res.text().catch(() => "");
      newRecord.output.error = `API 返回 ${res.status}：${detail.slice(0, 500)}`;
      newRecord.output.errorType = classifyError(res.status);
      newRecord.output.statusCode = res.status;
      await recordApiCall(false, elapsed);
    }
  } catch (e) {
    const elapsed = Math.round(performance.now() - startTime);
    newRecord.process.durationMs = elapsed;
    newRecord.output.error = e?.message || String(e);
    newRecord.output.errorType = classifyError(null, e?.message);
    await recordApiCall(false, elapsed);
  }

  pushCallRecord(newRecord);
  return { ok: true, callId: newCallId };
}