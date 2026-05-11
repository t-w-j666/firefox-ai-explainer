(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const browserApi = globalThis.browser ?? globalThis.chrome;

  const STORE_KEY_PROFILES = "apiProfiles";
  const STORE_KEY_ACTIVE = "activeProfileId";
  const DEFAULTS = {
    apiBaseUrl: "",
    modelName: "",
  };

  let profiles = [];
  let activeId = null;

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** 迁移旧版扁平配置 → profiles 数组 */
  async function migrateIfNeeded() {
    const existing = await browserApi.storage.local.get([
      STORE_KEY_PROFILES, "apiKey", "apiBaseUrl", "modelName",
    ]);
    if (existing[STORE_KEY_PROFILES] && existing[STORE_KEY_PROFILES].length > 0) return;

    const oldKey = (existing.apiKey || "").trim();
    const oldUrl = ((existing.apiBaseUrl || DEFAULTS.apiBaseUrl).trim()).replace(/\/+$/, "");
    const oldModel = (existing.modelName || DEFAULTS.modelName).trim();

    if (!oldKey && !existing[STORE_KEY_PROFILES]) return;

    const defaultProfile = {
      id: genId(),
      name: "默认方案",
      apiKey: oldKey,
      apiBaseUrl: oldUrl || DEFAULTS.apiBaseUrl,
      modelName: oldModel || DEFAULTS.modelName,
      isDefault: true,
    };

    await browserApi.storage.local.set({
      [STORE_KEY_PROFILES]: [defaultProfile],
      [STORE_KEY_ACTIVE]: defaultProfile.id,
    });
  }

  async function loadFromStorage() {
    await migrateIfNeeded();

    const obj = await browserApi.storage.local.get([STORE_KEY_PROFILES, STORE_KEY_ACTIVE]);
    profiles = obj[STORE_KEY_PROFILES] || [];
    activeId = obj[STORE_KEY_ACTIVE] || null;

    if (activeId && !profiles.some(p => p.id === activeId)) {
      activeId = profiles.length > 0 ? profiles[0].id : null;
    }
  }

  async function persist() {
    await browserApi.storage.local.set({
      [STORE_KEY_PROFILES]: profiles,
      [STORE_KEY_ACTIVE]: activeId,
    });
  }

  function findActive() {
    return profiles.find(p => p.id === activeId) || null;
  }

  // ---- 加载已保存的值 ----
  async function loadSettings() {
    await loadFromStorage();
    const p = findActive();
    if (p) {
      $(apiKeyId).value = p.apiKey || "";
      $(apiBaseUrlId).value = p.apiBaseUrl || DEFAULTS.apiBaseUrl;
      $(modelNameId).value = p.modelName || DEFAULTS.modelName;
    } else {
      $(apiKeyId).value = "";
      $(apiBaseUrlId).value = DEFAULTS.apiBaseUrl;
      $(modelNameId).value = DEFAULTS.modelName;
    }
  }

  // ---- 保存 ----
  async function saveSettings() {
    const apiKey = $(apiKeyId).value.trim();
    const apiBaseUrl = $(apiBaseUrlId).value.trim().replace(/\/+$/, "");
    const modelName = $(modelNameId).value.trim();

    if (!apiKey) { showStatus("请填写 API Key", true); return; }
    if (!apiBaseUrl) { showStatus("请填写 API Base URL", true); return; }
    if (!modelName) { showStatus("请填写模型名称", true); return; }

    await loadFromStorage();

    // 同时写回扁平键（向后兼容，background 回退读取用）
    await browserApi.storage.local.set({ apiKey, apiBaseUrl, modelName });

    let p = findActive();
    if (p) {
      p.apiKey = apiKey;
      p.apiBaseUrl = apiBaseUrl;
      p.modelName = modelName;
    } else {
      // 没有活跃方案 → 新建一个
      p = {
        id: genId(),
        name: "默认方案",
        apiKey,
        apiBaseUrl,
        modelName,
        isDefault: true,
      };
      profiles.push(p);
      activeId = p.id;
    }

    await persist();
    showStatus("✓ 已保存", false);
  }

  // ---- 清空 ----
  async function resetSettings() {
    const p = findActive();
    if (!p) {
      showStatus("没有可清空的配置", true);
      return;
    }
    const confirmed = confirm(`确定要清空方案"${p.name}"的所有配置吗？`);
    if (!confirmed) return;

    p.apiKey = "";
    p.apiBaseUrl = "";
    p.modelName = "";
    await persist();

    // 同时清空扁平键
    await browserApi.storage.local.set({ apiKey: "", apiBaseUrl: "", modelName: "" });

    $(apiKeyId).value = "";
    $(apiBaseUrlId).value = "";
    $(modelNameId).value = "";
    showStatus("✓ 已清空", false);
  }

  const apiKeyId = "apiKey";
  const apiBaseUrlId = "apiBaseUrl";
  const modelNameId = "modelName";

  // ---- 测试连接 ----
  async function testConnection() {
    const apiKey = $(apiKeyId).value.trim();
    const apiBaseUrl = $(apiBaseUrlId).value.trim().replace(/\/+$/, "");
    const modelName = $(modelNameId).value.trim();

    if (!apiKey || !apiBaseUrl || !modelName) {
      showTestResult("✗ 请先填写完整配置后再测试", true);
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
      const response = await fetch(`${apiBaseUrl}/chat/completions`, {
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
              content: "回复ok",
            },
          ],
          stream: false,
          max_tokens: 512,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        showTestResult(
          `✗ 请求失败（${response.status}）：${text.slice(0, 500)}`,
          true
        );
        return;
      }

      const data = await response.json();
      if (data.error) {
        const msg = data.error.message || JSON.stringify(data.error);
        showTestResult(`✗ API 错误：${msg.slice(0, 500)}`, true);
        return;
      }
      const choice = data.choices?.[0];
      const reply = choice?.message?.content || choice?.message?.reasoning_content || "";
      if (!choice || !reply) {
        showTestResult("✗ API 响应中无有效内容（content 与 reasoning_content 均为空），请检查模型配置：\n" + JSON.stringify(data, null, 2).slice(0, 500), true);
        return;
      }
      showTestResult(`✓ 连接成功 — ${reply.slice(0, 200)}`, false);
    } catch (err) {
      // 区分 JSON 解析失败与其他网络错误
      if (err instanceof SyntaxError) {
        showTestResult("✗ API 返回了非 JSON 响应", true);
      } else {
        showTestResult(`✗ ${err.message}`, true);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "测试";
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

    // ---- 自动保存：输入即落盘 ----//
    ["apiKey", "apiBaseUrl", "modelName"].forEach((id) => {
      $(id).addEventListener("input", async () => {
        await loadFromStorage();
        const p = findActive();
        if (!p) return;
        p.apiKey = $(apiKeyId).value.trim();
        p.apiBaseUrl = $(apiBaseUrlId).value.trim().replace(/\/+$/, "");
        p.modelName = $(modelNameId).value.trim();
        await persist();
      });
    });

    $("saveBtn").addEventListener("click", saveSettings);
    $("testBtn").addEventListener("click", testConnection);
    $("resetBtn").addEventListener("click", resetSettings);
  });
})();