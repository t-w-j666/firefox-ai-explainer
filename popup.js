(function () {
  "use strict";

  const browserApi = globalThis.browser ?? globalThis.chrome;

  const $ = (id) => document.getElementById(id);
  const DEFAULTS = {
    apiBaseUrl: "https://api.deepseek.com",
    modelName: "deepseek-chat",
  };

  // ---- 加载并显示状态 ----
  async function load() {
    const keys = ["apiKey", "apiBaseUrl", "modelName"];
    const obj = await browserApi.storage.local.get(keys);

    $("apiKey").value = obj.apiKey ?? "";
    $("apiBaseUrl").value = obj.apiBaseUrl ?? DEFAULTS.apiBaseUrl;
    $("modelName").value = obj.modelName ?? DEFAULTS.modelName;

    updateStatusDot(!!obj.apiKey);
    updateModelHint(obj.modelName);
  }

  function updateStatusDot(hasKey) {
    const dot = $("statusDot");
    dot.className = "status-dot" + (hasKey ? " ok" : " fail");
    dot.title = hasKey ? "API Key 已配置" : "未配置 API Key";
  }

  function updateModelHint(model) {
    const el = $("modelHint");
    el.textContent = model && model !== DEFAULTS.modelName
      ? `当前模型：${model}`
      : "";
  }

  // ---- 保存 ----
  async function save() {
    const data = {
      apiKey: $("apiKey").value.trim(),
      apiBaseUrl: $("apiBaseUrl").value.trim().replace(/\/+$/, ""),
      modelName: $("modelName").value.trim(),
    };

    if (!data.apiKey) {
      showMsg("请填写 API Key", true);
      return;
    }

    await browserApi.storage.local.set(data);
    updateStatusDot(true);
    updateModelHint(data.modelName);
    showMsg("✓ 已保存", false);
  }

  // ---- 测试连接 ----
  async function test() {
    const apiKey = $("apiKey").value.trim();
    const apiBaseUrl = $("apiBaseUrl").value.trim().replace(/\/+$/, "");
    const modelName = $("modelName").value.trim();

    if (!apiKey || !apiBaseUrl || !modelName) {
      showMsg("请先填写完整配置", true);
      return;
    }

    const btn = $("testBtn");
    btn.disabled = true;
    btn.textContent = "测试中…";
    $("statusDot").className = "status-dot loading";

    try {
      const res = await fetch(`${apiBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: "user", content: "回复ok" }],
          stream: false,
          max_tokens: 10,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        showMsg(`✗ ${res.status} ${text.slice(0, 120)}`, true);
        $("statusDot").className = "status-dot fail";
        return;
      }

      showMsg("✓ 连接成功", false);
      $("statusDot").className = "status-dot ok";
    } catch (err) {
      showMsg(`✗ ${err.message}`, true);
      $("statusDot").className = "status-dot fail";
    } finally {
      btn.disabled = false;
      btn.textContent = "测试";
    }
  }

  // ---- 打开完整设置页 ----
  function openOptions() {
    if (browserApi.runtime.openOptionsPage) {
      browserApi.runtime.openOptionsPage();
    } else {
      // fallback for older Firefox
      const url = browserApi.runtime.getURL("options.html");
      window.open(url);
    }
    window.close(); // 关闭 popup
  }

  function showMsg(text, isError) {
    const el = $("statusMsg");
    el.textContent = text;
    el.className = "status-msg visible" + (isError ? " error" : "");
    if (!isError) {
      setTimeout(() => el.classList.remove("visible"), 2500);
    }
  }

  // ---- 绑定事件 ----
  document.addEventListener("DOMContentLoaded", () => {
    load();

    $("saveBtn").addEventListener("click", save);
    $("testBtn").addEventListener("click", test);
    $("openOptions").addEventListener("click", (e) => {
      e.preventDefault();
      openOptions();
    });
  });
})();