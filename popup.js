(function () {
  "use strict";

  const browserApi = globalThis.browser ?? globalThis.chrome;

  /* ===================================================================
   * 日志工具
   * =================================================================== */
  const log = {
    debug: (...args) => console.debug("[AI Explainer:Popup]", ...args),
    info: (...args) => console.info("[AI Explainer:Popup]", ...args),
    warn: (...args) => console.warn("[AI Explainer:Popup]", ...args),
    error: (...args) => console.error("[AI Explainer:Popup]", ...args),
  };

  const $ = (id) => document.getElementById(id);
  const DEFAULTS = {
    apiBaseUrl: "",
    modelName: "",
  };

  // ---- 内部状态 ----
  let profiles = [];
  let activeId = null;
  let isNewProfile = false;

  // ---- 存储读写 ----
  const STORE_KEY_PROFILES = "apiProfiles";
  const STORE_KEY_ACTIVE = "activeProfileId";
  const STORE_KEY_PROMPT_PROFILES = "promptProfiles";
  const STORE_KEY_ACTIVE_PROMPT = "activePromptProfileId";

  const DEFAULT_SYSTEM_PROMPT =
    "你是一个专业的文本解释助手。当用户选中一段文本时，请用简洁易懂的语言解释其含义、背景和用途。";

  // ---- 提示词方案内部状态 ----
  let promptProfiles = [];
  let activePromptId = null;
  let isNewPromptProfile = false;

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** 迁移旧版扁平配置 → profiles 数组 */
  async function migrateIfNeeded() {
    const existing = await browserApi.storage.local.get([STORE_KEY_PROFILES, "apiKey", "apiBaseUrl", "modelName"]);
    if (existing[STORE_KEY_PROFILES] && existing[STORE_KEY_PROFILES].length > 0) return; // 已有 profiles

    const oldKey = (existing.apiKey || "").trim();
    const oldUrl = ((existing.apiBaseUrl || DEFAULTS.apiBaseUrl).trim()).replace(/\/+$/, "");
    const oldModel = (existing.modelName || DEFAULTS.modelName).trim();

    if (!oldKey && !existing[STORE_KEY_PROFILES]) return; // 完全空，无需迁移

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

    // 保证 activeId 指向一个实际存在的 profile
    if (activeId && !profiles.some(p => p.id === activeId)) {
      activeId = profiles.length > 0 ? profiles[0].id : null;
    }

    log.debug("已加载配置方案", { count: profiles.length, activeId });
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

  // ---- 提示词方案管理 ----
  async function migratePromptIfNeeded() {
    const existing = await browserApi.storage.local.get([STORE_KEY_PROMPT_PROFILES, STORE_KEY_ACTIVE_PROMPT]);
    if (existing[STORE_KEY_PROMPT_PROFILES] && existing[STORE_KEY_PROMPT_PROFILES].length > 0) return;

    const defaultPrompt = {
      id: genId(),
      name: "默认",
      content: DEFAULT_SYSTEM_PROMPT,
      isDefault: true,
    };

    await browserApi.storage.local.set({
      [STORE_KEY_PROMPT_PROFILES]: [defaultPrompt],
      [STORE_KEY_ACTIVE_PROMPT]: defaultPrompt.id,
    });
  }

  async function loadPromptFromStorage() {
    await migratePromptIfNeeded();

    const obj = await browserApi.storage.local.get([STORE_KEY_PROMPT_PROFILES, STORE_KEY_ACTIVE_PROMPT]);
    promptProfiles = obj[STORE_KEY_PROMPT_PROFILES] || [];
    activePromptId = obj[STORE_KEY_ACTIVE_PROMPT] || null;

    if (activePromptId && !promptProfiles.some(p => p.id === activePromptId)) {
      activePromptId = promptProfiles.length > 0 ? promptProfiles[0].id : null;
    }

    log.debug("已加载提示词方案", { count: promptProfiles.length, activePromptId });
  }

  async function persistPrompt() {
    await browserApi.storage.local.set({
      [STORE_KEY_PROMPT_PROFILES]: promptProfiles,
      [STORE_KEY_ACTIVE_PROMPT]: activePromptId,
    });
  }

  function findActivePrompt() {
    return promptProfiles.find(p => p.id === activePromptId) || null;
  }

  function renderPromptProfileSelect() {
    const sel = $("promptProfileSelect");
    sel.textContent = "";

    if (promptProfiles.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "（暂无方案）";
      opt.selected = true;
      sel.appendChild(opt);
    } else {
      promptProfiles.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === activePromptId) opt.selected = true;
        sel.appendChild(opt);
      });
    }

    $("deletePromptProfileBtn").disabled = !findActivePrompt() || findActivePrompt().isDefault === true;
  }

  function loadPromptFormFromProfile() {
    const p = findActivePrompt();
    if (!p) {
      $("systemPrompt").value = "";
      $("promptProfileName").value = "";
      $("promptProfileNameField").style.display = isNewPromptProfile ? "" : "none";
      return;
    }

    $("systemPrompt").value = p.content || "";
    $("promptProfileName").value = p.name || "";
    $("promptProfileNameField").style.display = isNewPromptProfile ? "" : "none";
  }

  async function selectPromptProfile(id) {
    if (id === activePromptId && !isNewPromptProfile) return;
    isNewPromptProfile = false;
    activePromptId = id;
    $("promptProfileNameField").style.display = "none";
    loadPromptFormFromProfile();
    $("deletePromptProfileBtn").disabled = !findActivePrompt() || findActivePrompt().isDefault === true;
    await persistPrompt();
    log.debug("切换到提示词方案", id);
  }

  async function newPromptProfile() {
    // 立即创建空白提示词方案并落盘
    const defaultContent = DEFAULT_SYSTEM_PROMPT;
    const seq = promptProfiles.filter(p => p.name.startsWith("新提示词")).length + 1;
    const p = { id: genId(), name: `新提示词${seq}`, content: defaultContent };
    promptProfiles.push(p);
    activePromptId = p.id;
    isNewPromptProfile = true;
    await persistPrompt();

    renderPromptProfileSelect();
    loadPromptFormFromProfile();
    $("promptProfileNameField").style.display = "";
    $("promptProfileName").value = p.name;
    $("promptProfileName").focus();
    $("deletePromptProfileBtn").disabled = false;
    log.debug("新建空白提示词方案", { id: p.id });
  }

  async function savePromptProfile() {
    const name = $("promptProfileName").value.trim();
    const content = $("systemPrompt").value.trim();

    if (!name) {
      showMsg("请填写提示词方案名称", true);
      $("promptProfileName").focus();
      return;
    }

    if (isNewPromptProfile) {
      // 更新空白方案（由 newPromptProfile 预先创建，用户补充名称和内容）
      const p = findActivePrompt();
      if (p) {
        p.name = name;
        p.content = content;
      }
      isNewPromptProfile = false;
    } else if (activePromptId) {
      const p = findActivePrompt();
      if (p) {
        p.name = name;
        p.content = content;
      }
    } else {
      return;
    }

    await persistPrompt();

    const sel = $("promptProfileSelect");
    const placeholder = sel.querySelector('option[value=""]');
    if (placeholder) placeholder.remove();

    renderPromptProfileSelect();
    $("promptProfileNameField").style.display = "none";
    log.info("保存提示词方案", { name });
  }

  async function deletePromptProfile() {
    const p = findActivePrompt();
    if (!p) return;
    if (p.isDefault) {
      showMsg("默认提示词方案不可删除", true);
      return;
    }

    const confirmed = confirm(`确定要删除提示词方案"${p.name}"吗？`);
    if (!confirmed) return;

    const idx = promptProfiles.findIndex(x => x.id === activePromptId);
    if (idx === -1) return;

    promptProfiles.splice(idx, 1);
    if (promptProfiles.length === 0) {
      activePromptId = null;
    } else {
      activePromptId = promptProfiles[Math.min(idx, promptProfiles.length - 1)].id;
    }

    await persistPrompt();
    renderPromptProfileSelect();
    loadPromptFormFromProfile();
    log.info("已删除提示词方案", { name: p.name });
    showMsg("已删除", false);
  }

  async function resetPromptProfile() {
    const p = findActivePrompt();
    if (!p) return;
    const confirmed = confirm(`确定要清空提示词方案"${p.name}"的内容吗？`);
    if (!confirmed) return;

    p.content = "";
    await persistPrompt();

    loadPromptFormFromProfile();
    log.info("已清空提示词方案", { name: p.name });
    showMsg("✓ 已清空", false);
  }

  // ---- UI 渲染 ----
  function renderProfileSelect() {
    const sel = $("profileSelect");
    sel.textContent = "";

    if (profiles.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "（暂无配置）";
      opt.selected = true;
      sel.appendChild(opt);
    } else {
      profiles.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === activeId) opt.selected = true;
        sel.appendChild(opt);
      });
    }

    $("deleteProfileBtn").disabled = !findActive() || findActive().isDefault === true;
  }

  function loadFormFromProfile() {
    const p = findActive();
    if (!p) {
      clearForm();
      $("profileName").value = "";
      $("profileNameField").style.display = isNewProfile ? "" : "none";
      return;
    }

    $("apiKey").value = p.apiKey || "";
    $("apiBaseUrl").value = p.apiBaseUrl || DEFAULTS.apiBaseUrl;
    $("modelName").value = p.modelName || DEFAULTS.modelName;
    $("profileName").value = p.name || "";
    $("profileNameField").style.display = isNewProfile ? "" : "none";

    updateStatusDot(!!p.apiKey);
    updateModelHint(p.modelName);
  }

  function clearForm() {
    $("apiKey").value = "";
    $("apiBaseUrl").value = DEFAULTS.apiBaseUrl;
    $("modelName").value = DEFAULTS.modelName;
    $("profileName").value = "";
    $("modelHint").textContent = "";
    updateStatusDot(false);
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

  // ---- 操作 ----
  async function selectProfile(id) {
    if (id === activeId && !isNewProfile) return;
    isNewProfile = false;
    activeId = id;
    $("profileNameField").style.display = "none";
    loadFormFromProfile();
    $("deleteProfileBtn").disabled = !findActive() || findActive().isDefault === true;
    await persist();
    log.debug("切换到配置方案", id);
  }

  async function newProfile() {
    // 立即创建空白方案并落盘
    const seq = profiles.filter(p => p.name.startsWith("新方案")).length + 1;
    const p = { id: genId(), name: `新方案${seq}`, apiKey: "", apiBaseUrl: "", modelName: "" };
    profiles.push(p);
    activeId = p.id;
    isNewProfile = true;
    await persist();

    renderProfileSelect();
    loadFormFromProfile();
    $("profileNameField").style.display = "";
    $("profileName").value = p.name;
    $("profileName").focus();
    $("deleteProfileBtn").disabled = false;
    log.debug("新建空白配置方案", { id: p.id });
  }

  async function saveProfile() {
    const name = $("profileName").value.trim();
    const apiKey = $("apiKey").value.trim();
    const apiBaseUrl = $("apiBaseUrl").value.trim().replace(/\/+$/, "");
    const modelName = $("modelName").value.trim();

    if (!name) {
      showMsg("请填写方案名称", true);
      $("profileName").focus();
      return;
    }
    if (!apiKey) {
      showMsg("请填写 API Key", true);
      return;
    }

    if (isNewProfile) {
      // 更新空白方案（由 newProfile 预先创建，用户补充名称和凭证）
      const p = findActive();
      if (p) {
        p.name = name;
        p.apiKey = apiKey;
        p.apiBaseUrl = apiBaseUrl || DEFAULTS.apiBaseUrl;
        p.modelName = modelName;
      }
      isNewProfile = false;
    } else if (activeId) {
      // 更新已有 profile
      const p = findActive();
      if (p) {
        p.name = name;
        p.apiKey = apiKey;
        p.apiBaseUrl = apiBaseUrl || DEFAULTS.apiBaseUrl;
        p.modelName = modelName;
      }
    } else {
      showMsg("请先选择或新建配置方案", true);
      return;
    }

    await persist();

    // 同时保存当前提示词方案内容
    if (activePromptId) {
      const promptContent = $("systemPrompt").value.trim();
      const promptP = findActivePrompt();
      if (promptP) {
        promptP.content = promptContent;
        await persistPrompt();
      }
    }

    // 去掉"新建中"占位项
    const sel = $("profileSelect");
    const placeholder = sel.querySelector('option[value=""]');
    if (placeholder) placeholder.remove();

    renderProfileSelect();
    $("profileNameField").style.display = "none";
    updateStatusDot(true);
    updateModelHint(modelName);
    log.info("保存配置方案", { name, modelName, isNew: !activeId || isNewProfile === false });
    showMsg("✓ 已保存", false);
  }

  async function resetProfile() {
    const p = findActive();
    if (!p) return;
    const confirmed = confirm(`确定要清空方案"${p.name}"的所有配置吗？`);
    if (!confirmed) return;

    p.apiKey = "";
    p.apiBaseUrl = "";
    p.modelName = "";
    await persist();

    loadFormFromProfile();
    log.info("已清空配置方案", { name: p.name });
    showMsg("✓ 已清空", false);
  }

  async function deleteProfile() {
    const p = findActive();
    if (!p) return;
    if (p.isDefault) {
      showMsg("默认配置方案不可删除", true);
      return;
    }

    const confirmed = confirm(`确定要删除配置方案"${p.name}"吗？`);
    if (!confirmed) return;

    const idx = profiles.findIndex(x => x.id === activeId);
    if (idx === -1) return;

    profiles.splice(idx, 1);

    // 切换到相邻 profile
    if (profiles.length === 0) {
      activeId = null;
    } else {
      activeId = profiles[Math.min(idx, profiles.length - 1)].id;
    }

    await persist();
    renderProfileSelect();
    loadFormFromProfile();
    log.info("已删除配置方案", { name: p.name });
    showMsg("已删除", false);
  }

  // ---- 测试连接 ----
  async function test() {
    const apiKey = $("apiKey").value.trim();
    const apiBaseUrl = $("apiBaseUrl").value.trim().replace(/\/+$/, "");
    const modelName = $("modelName").value.trim();

    if (!apiKey || !apiBaseUrl || !modelName) {
      showMsg("✗ 请先填写完整配置后再测试", true);
      return;
    }

    const btn = $("testBtn");
    btn.disabled = true;
    btn.textContent = "测试中…";
    $("statusDot").className = "status-dot loading";

    log.debug("测试连接", { apiBaseUrl, modelName });

    try {
      const res = await fetch(`${apiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: "user", content: "回复ok" }],
          stream: false,
          max_tokens: 20,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        log.warn("测试连接失败", { status: res.status, detail: text.slice(0, 120) });
        showMsg(`✗ 请求失败（${res.status}）：${text.slice(0, 120)}`, true);
        $("statusDot").className = "status-dot fail";
        return;
      }

      // 解析 JSON 响应体，检查 API 层错误（很多服务对无效 Key 返回 200 + JSON error）
      let data;
      try {
        data = await res.json();
      } catch {
        showMsg("✗ API 返回了非 JSON 响应", true);
        $("statusDot").className = "status-dot fail";
        return;
      }
      if (data.error) {
        const msg = data.error.message || JSON.stringify(data.error);
        showMsg(`✗ API 错误：${msg.slice(0, 120)}`, true);
        $("statusDot").className = "status-dot fail";
        return;
      }
      if (!data.choices || !data.choices[0]?.message?.content) {
        showMsg("✗ API 响应中缺少 choices 字段", true);
        $("statusDot").className = "status-dot fail";
        return;
      }

      log.info("测试连接成功", { apiBaseUrl, modelName, reply: data.choices[0].message.content });
      const reply = data.choices[0].message.content;
      showMsg(`✓ 连接成功 — ${reply.slice(0, 60)}`, false);
      $("statusDot").className = "status-dot ok";
    } catch (err) {
      log.error("测试连接异常", err.message);
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
      window.open(browserApi.runtime.getURL("options.html"));
    }
    window.close();
  }

  // ---- 打开日志页 ----
  function openLogPage() {
    const url = browserApi.runtime.getURL("log.html");
    window.open(url);
    window.close();
  }

  function showMsg(text, isError) {
    const el = $("statusMsg");
    el.textContent = text;
    el.className = "status-msg visible" + (isError ? " error" : "");
    if (!isError) {
      setTimeout(() => el.classList.remove("visible"), 2500);
    }
  }

  // ---- 初始化 ----
  document.addEventListener("DOMContentLoaded", async () => {
    await loadFromStorage();
    renderProfileSelect();
    loadFormFromProfile();

    await loadPromptFromStorage();
    renderPromptProfileSelect();
    loadPromptFormFromProfile();

    $("profileSelect").addEventListener("change", () => {
      const id = $("profileSelect").value;
      if (id) selectProfile(id);
    });

    $("newProfileBtn").addEventListener("click", newProfile);
    $("deleteProfileBtn").addEventListener("click", deleteProfile);
    $("resetProfileBtn").addEventListener("click", resetProfile);
    $("saveBtn").addEventListener("click", saveProfile);
    $("testBtn").addEventListener("click", test);

    $("promptProfileSelect").addEventListener("change", () => {
      const id = $("promptProfileSelect").value;
      if (id) selectPromptProfile(id);
    });

    $("newPromptProfileBtn").addEventListener("click", newPromptProfile);
    $("deletePromptProfileBtn").addEventListener("click", deletePromptProfile);
    $("resetPromptProfileBtn").addEventListener("click", resetPromptProfile);
    $("savePromptProfileBtn").addEventListener("click", savePromptProfile);

    // ---- 自动保存：输入即落盘 ----//
    ["apiKey", "apiBaseUrl", "modelName"].forEach((id) => {
      $(id).addEventListener("input", async () => {
        const p = findActive();
        if (!p) return;
        p.apiKey = $("apiKey").value.trim();
        p.apiBaseUrl = $("apiBaseUrl").value.trim().replace(/\/+$/, "");
        p.modelName = $("modelName").value.trim();
        await persist();
      });
    });
    $("systemPrompt").addEventListener("input", async () => {
      const p = findActivePrompt();
      if (!p) return;
      p.content = $("systemPrompt").value.trim();
      await persistPrompt();
    });

    $("openOptions").addEventListener("click", (e) => {
      e.preventDefault();
      openOptions();
    });

    $("openLog").addEventListener("click", (e) => {
      e.preventDefault();
      openLogPage();
    });
  });
})();