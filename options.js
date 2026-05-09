(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const STORAGE_KEYS = {
    apiKey: "apiKey",
    apiBaseUrl: "apiBaseUrl",
    modelName: "modelName",
  };

  const DEFAULTS = {
    apiKey: "",
    apiBaseUrl: "https://api.deepseek.com",
    modelName: "deepseek-chat",
  };

  const browserApi = globalThis.browser ?? globalThis.chrome;

  // ---- 加载已保存的值 ----
  async function loadSettings() {
    const obj = await browserApi.storage.local.get(Object.values(STORAGE_KEYS));
    $("apiKey").value = obj.apiKey ?? DEFAULTS.apiKey;
    $("apiBaseUrl").value = obj.apiBaseUrl ?? DEFAULTS.apiBaseUrl;
    $("modelName").value = obj.modelName ?? DEFAULTS.modelName;
  }

  // ---- 保存 ----
  async function saveSettings() {
    const data = {
      apiKey: $("apiKey").value.trim(),
      apiBaseUrl: $("apiBaseUrl").value.trim().replace(/\/+$/, ""),
      modelName: $("modelName").value.trim(),
    };

    // 基本校验
    if (!data.apiKey) {
      showStatus("请填写 API Key", true);
      return;
    }
    if (!data.apiBaseUrl) {
      showStatus("请填写 API Base URL", true);
      return;
    }
    if (!data.modelName) {
      showStatus("请填写模型名称", true);
      return;
    }

    await browserApi.storage.local.set(data);
    showStatus("✓ 已保存", false);
  }

  // ---- 测试连接 ----
  async function testConnection() {
    const apiKey = $("apiKey").value.trim();
    const apiBaseUrl = $("apiBaseUrl").value.trim().replace(/\/+$/, "");
    const modelName = $("modelName").value.trim();

    if (!apiKey || !apiBaseUrl || !modelName) {
      showTestResult("请先填写完整配置后再测试。", true);
      return;
    }

    const resultEl = $("testResult");
    const outputEl = $("testOutput");
    resultEl.classList.add("visible");
    outputEl.textContent = "连接中…";
    outputEl.className = "";

    const btn = $("testBtn");
    btn.disabled = true;
    btn.textContent = "测试中…";

    try {
      const response = await fetch(`${apiBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            {
              role: "user",
              content: "请回复'连接成功'这四个字，不要加其他内容。",
            },
          ],
          stream: false,
          max_tokens: 20,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        showTestResult(
          `请求失败（${response.status} ${response.statusText}）：\n${text.slice(0, 500)}`,
          true
        );
        return;
      }

      const data = await response.json();
      const reply =
        data?.choices?.[0]?.message?.content ?? "(无返回内容)";
      showTestResult(`✓ 连接成功\n\n模型返回：${reply}`, false);
    } catch (err) {
      showTestResult(`连接失败：${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "测试连接";
    }
  }

  function showStatus(msg, isError) {
    const el = $("statusMsg");
    el.textContent = msg;
    el.className = "status visible" + (isError ? " error" : "");
    setTimeout(() => {
      el.classList.remove("visible");
    }, 3000);
  }

  function showTestResult(text, isError) {
    const outputEl = $("testOutput");
    outputEl.textContent = text;
    outputEl.className = isError ? "test-error" : "";
  }

  // ---- 事件绑定 ----
  document.addEventListener("DOMContentLoaded", () => {
    loadSettings();
    $("saveBtn").addEventListener("click", saveSettings);
    $("testBtn").addEventListener("click", testConnection);
  });
})();