/**
 * 后台脚本：直调 OpenAI 兼容 API（DeepSeek / OpenAI 等）。
 * 不再依赖本地 Python 后端。API Key 从 storage.local 读取（由 options 页面配置）。
 */

const browserApi = globalThis.browser ?? globalThis.chrome;

// 与 main.py 原 LEXICAL_SYSTEM 一致的提示词
const SYSTEM_PROMPT =
  "##对陌生概念或者术语进行讲解，不仅要讲清楚'是什么'，还要讲清楚'有什么'，'怎么用'\n" +
  "##输出格式为纯文本输出，不要使用markdown格式";

const MAX_CONTEXT_CHARS = 6000;

/** 从 storage 读取 API 配置 */
async function getApiConfig() {
  const keys = ["apiKey", "apiBaseUrl", "modelName"];
  const obj = await browserApi.storage.local.get(keys);
  const apiKey = (obj.apiKey || "").trim();
  const apiBaseUrl = ((obj.apiBaseUrl || "https://api.deepseek.com").trim()).replace(/\/+$/, "");
  const modelName = (obj.modelName || "deepseek-chat").trim();
  return { apiKey, apiBaseUrl, modelName };
}

/** 构造用户提示词（与 main.py _build_user_prompt 一致） */
function buildUserPrompt(text, context) {
  const ctx = (context || "").trim() || "（无额外上下文）";
  const truncated = ctx.length > MAX_CONTEXT_CHARS ? ctx.slice(0, MAX_CONTEXT_CHARS) + "\n…（上下文已截断）" : ctx;
  return `划选词句：\n${text}\n\n上下文：\n${truncated}`;
}

browserApi.runtime.onConnect.addListener((port) => {
  if (port.name !== "ai-explainer-sse") return;

  let abortController = null;

  port.onDisconnect.addListener(() => {
    abortController?.abort();
    abortController = null;
  });

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "start") return;

    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;

    const timeoutMs = typeof msg.timeoutMs === "number" && msg.timeoutMs > 0 ? msg.timeoutMs : 120000;
    const timer = setTimeout(() => signal.abort(), timeoutMs);

    void (async () => {
      // 1) 读取配置
      let config;
      try {
        config = await getApiConfig();
      } catch {
        clearTimeout(timer);
        safePost(port, { type: "error", message: "读取配置失败。" });
        safePost(port, { type: "done" });
        return;
      }

      if (!config.apiKey) {
        clearTimeout(timer);
        safePost(port, {
          type: "error",
          message:
            "未配置 API Key。请在扩展管理页面 → 选项 中设置 API Key。",
        });
        safePost(port, { type: "done" });
        return;
      }

      // 2) 构造请求
      const url = `${config.apiBaseUrl}/v1/chat/completions`;
      const body = JSON.stringify({
        model: config.modelName,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(msg.text, msg.context ?? "") },
        ],
        stream: true,
        temperature: 0.3,
      });

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
        if (signal.aborted) {
          safePost(port, { type: "done" });
          return;
        }
        const errMsg =
          e?.name === "AbortError"
            ? `请求超时（${timeoutMs / 1000}s）。请检查网络连接。`
            : `无法连接 API 服务（${config.apiBaseUrl}）：${e?.message || e}`;
        safePost(port, { type: "error", message: errMsg });
        safePost(port, { type: "done" });
        return;
      }

      clearTimeout(timer);

      if (!res.ok) {
        let detail = "";
        try {
          detail = await res.text();
        } catch { /* ignore */ }
        safePost(port, {
          type: "error",
          message: `API 返回 ${res.status}：${detail.slice(0, 500)}`,
        });
        safePost(port, { type: "done" });
        return;
      }

      // 3) 解析 SSE 流
      const reader = res.body?.getReader();
      if (!reader) {
        safePost(port, { type: "error", message: "无法读取响应流。" });
        safePost(port, { type: "done" });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

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
                safePost(port, { type: "done" });
                return;
              }
              let obj;
              try {
                obj = JSON.parse(raw);
              } catch {
                continue;
              }
              const delta = obj?.choices?.[0]?.delta;
              if (delta?.content) {
                safePost(port, { type: "chunk", text: String(delta.content) });
              }
              if (obj?.choices?.[0]?.finish_reason === "stop") {
                safePost(port, { type: "done" });
                return;
              }
            }
          }
        }
      } catch (e) {
        if (!signal.aborted) {
          safePost(port, { type: "error", message: e?.message || String(e) });
        }
      }

      safePost(port, { type: "done" });
    })();
  });
});

function safePost(port, payload) {
  try {
    port.postMessage(payload);
  } catch {
    /* port 已关闭 */
  }
}