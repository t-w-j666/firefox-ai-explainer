/**
 * 后台脚本：代替 content script 发起 fetch。
 * GitHub 等站点页面的 CSP 会拦截页面环境下的 localhost 请求；
 * 扩展后台不受页面 connect-src 限制（仍受 manifest host_permissions 约束）。
 */

const browserApi = globalThis.browser ?? globalThis.chrome;

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

    const timeoutMs =
      typeof msg.timeoutMs === "number" && msg.timeoutMs > 0
        ? msg.timeoutMs
        : 120000;
    const timer = setTimeout(() => signal.abort(), timeoutMs);

    const base = String(msg.apiBase || "").replace(/\/$/, "");
    const url = `${base}/explain/stream`;

    void (async () => {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            text: msg.text,
            context: msg.context ?? "",
          }),
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
            ? `请求超时（${timeoutMs / 1000}s）。请确认后端已启动：python main.py`
            : "无法连接后端。请确认已在本机运行 FastAPI（默认 http://127.0.0.1:8765），且 manifest 中 host_permissions 包含该地址。";
        safePost(port, { type: "error", message: errMsg });
        safePost(port, { type: "done" });
        return;
      }

      clearTimeout(timer);

      if (!res.ok) {
        let detail = res.statusText;
        try {
          detail = await res.text();
        } catch {
          /* ignore */
        }
        safePost(port, {
          type: "error",
          message: `后端返回 ${res.status}：${detail.slice(0, 400)}`,
        });
        safePost(port, { type: "done" });
        return;
      }

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
              if (raw === "[DONE]") continue;
              let obj;
              try {
                obj = JSON.parse(raw);
              } catch {
                continue;
              }
              if (obj.chunk) {
                safePost(port, { type: "chunk", text: String(obj.chunk) });
              }
              if (obj.error) {
                safePost(port, { type: "error", message: String(obj.error) });
              }
              if (obj.done) {
                safePost(port, { type: "done" });
                return;
              }
            }
          }
        }
      } catch (e) {
        if (!signal.aborted) {
          safePost(port, {
            type: "error",
            message: e?.message || String(e),
          });
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
