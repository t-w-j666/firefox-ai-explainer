# AI Text Explainer

在 **Firefox** 中划选网页文字，直接调用大模型 API（DeepSeek / OpenAI 等兼容服务），以 **SSE 流式**返回解释。纯浏览器扩展，**无需启动任何后端服务**。

---

## 特性

- **划选即解释** — 选中任意网页文字，点击浮动按钮即可获取 AI 解释
- **SSE 流式输出** — 逐字输出，打字机效果，无需等待完整响应
- **Shadow DOM 隔离** — UI 与页面样式完全隔离，不影响原网页
- **绕过 CSP 限制** — 后台脚本转发请求，GitHub 等严格 CSP 站点也能正常使用
- **多配置方案管理** — 支持多组 API Key / Base URL / 模型配置，快速切换
- **多提示词方案** — 可自定义系统提示词，切换不同解释风格
- **自动保存** — 输入即落盘，关闭页面不会丢失编辑内容
- **调用日志** — 内置日志页面，记录每次 API 调用的输入/输出/耗时/错误，支持重放
- **API 调用统计** — 总调用数、成功/失败/超时统计
- **拖动卡片** — 按住标题栏可拖动解释卡片到任意位置
- **超时中止** — 关闭卡片自动中止请求，不浪费 token

---

## 项目结构

```
firefox-ai-explainer/
├── manifest.json          # Firefox Manifest V3 扩展声明
├── background.js          # 后台脚本：转发 API 请求，解析 SSE 流，维护调用记录
├── content.js             # 内容脚本：划选检测、浮动按钮、解释卡片 UI
├── popup.css              # Shadow DOM 样式（浮动按钮 + 解释卡片）
├── popup.html / popup.js  # 弹出面板：配置方案 & 提示词方案管理、测试连接
├── options.html / options.js # 设置页：API 配置、测试连接、重置
├── log.html / log.js      # 日志页：API 调用记录查看、统计、筛选、重放
└── README.md
```

### 文件职责

| 文件 | 职责 |
|------|------|
| `manifest.json` | 扩展元数据、权限声明（`storage`+`<all_urls>`）、脚本注册 |
| `background.js` | 唯一持久运行的后台脚本。接收 content script 的 SSE 连接请求 → 读取配置 → 直调 OpenAI 兼容 API → 解析流式响应 → 逐 chunk 回传。维护调用记录与 API 调用统计。 |
| `content.js` | 注入所有页面。监听 `mouseup` 检测划选 → 在 Shadow DOM 中渲染浮动按钮 → 点击后建立 SSE 连接 → 渲染解释卡片并逐字输出。 |
| `popup.css` | 仅 Shadow DOM 内生效的样式。按钮、卡片、暗色主题、打字机光标动画。 |
| `popup.html/js` | 点击工具栏图标弹出的配置面板。管理 API 配置方案（新建/切换/删除/清空）和系统提示词方案。支持测试连接。 |
| `options.html/js` | 独立的完整设置页面（右键扩展 → 管理扩展 → 选项）。API 三个字段的编辑、保存、测试、清空。 |
| `log.html/js` | API 调用记录查看器。统计卡片、配置概览、筛选（全部/成功/失败/超时）、折叠详情、重放请求。 |

---

## 技术选型与架构

### 技术栈

| 层级 | 技术 |
|------|------|
| 扩展框架 | Firefox Manifest V3 |
| 脚本 | 原生 JavaScript（ES2020+，无框架无依赖） |
| 样式 | 纯 CSS（Shadow DOM 隔离） |
| 存储 | `browser.storage.local`（配置方案、提示词方案、调用统计） |
| API 协议 | OpenAI Chat Completions API（兼容 DeepSeek / OpenAI / 任何兼容服务） |
| 流式传输 | Server-Sent Events (SSE)，后台脚本逐 chunk 解析并转发 |

### 架构流程

```
用户划选文字
    │
    ▼
content.js 检测 mouseup
    │ 获取选区文本 + 上下文（最多 6000 字符）
    ▼
渲染 Shadow DOM 浮动按钮
    │ 用户点击「AI 解释」
    ▼
runtime.connect("ai-explainer-sse")
    │
    ▼
background.js 收到连接
    │ 1. 从 storage 读取 active 配置方案
    │ 2. 从 storage 读取 active 提示词方案
    │ 3. 构造请求体（system + user messages）
    ▼
fetch(apiBaseUrl + "/chat/completions")
    │ POST, stream: true, SSE 响应
    ▼
逐 chunk 解析 SSE → port.postMessage({ type: "chunk", text })
    │
    ▼
content.js 收到 chunk → 追加到解释卡片
    │ 打字机效果逐字输出
    ▼
SSE 完成 → port.postMessage({ type: "done" })
```

### 为什么这样设计

- **无后端**：直接浏览器内调 API，不依赖任何 Python/Node 服务，零部署成本
- **后台转发**：绕过目标网页的 CSP 策略（如 GitHub），请求从 background script 发起
- **Shadow DOM**：UI 样式与页面完全隔离，不会受页面 CSS 影响也不会污染页面
- **配置方案 + 提示词方案分离**：用户可以自由组合不同的 API 配置与不同的提示词，切换灵活

---

## 使用指南

### 环境要求

- **Firefox** 109+（Manifest V3）
- 一个兼容 OpenAI 的 API Key（DeepSeek / OpenAI / 等）

### 安装扩展

1. 在 Firefox 地址栏打开 `about:debugging#/runtime/this-firefox`
2. 点击 **「临时加载附加组件」**
3. 选择项目根目录下的 **`manifest.json`**
4. 加载成功后，地址栏右侧会出现扩展图标

### 配置 API

**方式一：弹出面板（快速配置）**

点击工具栏图标打开弹出面板：

1. 点击 **「+」** 新建配置方案（名称自动编号：新方案1、新方案2…）
2. 填写 API Key、API Base URL、模型名称
3. 点击 **保存**（字段也支持自动保存，无需手动点保存）
4. 点击 **测试** 验证连接

**方式二：设置页（完整配置）**

右键扩展图标 → 管理扩展 → 选项，或在弹出面板中点击「打开完整设置 →」：

- 填写 API Key、Base URL、模型名称
- 点击 **保存**，或 **测试连接** 验证
- 支持单个方案下的字段自动保存

### 日常使用

1. 在任意网页上 **选中一段文字**
2. 选区附近会弹出 **「AI 解释」** 按钮
3. 点击按钮，弹出解释卡片，**逐字输出** 解释内容
4. 按住卡片 **标题栏** 可拖动到任意位置
5. 点击卡片右上角 **×** 或点击遮罩层关闭

> 支持鼠标划选和键盘 Shift+方向键 划选后松键触发。

### 配置方案管理

弹出面板支持完整的方案管理：

| 操作 | 说明 |
|------|------|
| **+** | 新建方案（名称自动编号，立即落盘） |
| **下拉选择** | 切换当前活跃方案，自动加载配置 |
| **🗑** | 删除当前方案（默认方案不可删除） |
| **↺** | 清空当前方案的字段内容 |
| **保存** | 保存当前编辑（如为新方案则创建） |

**提示词方案** 同理，支持新建/切换/删除/清空/保存。可在弹出面板直接编辑系统提示词。

### 查看日志

点击弹出面板底部的 **「日志」** 可打开调用记录页面：

- 统计卡片：总调用、成功、失败、超时次数
- 当前活跃配置与模型
- 每次调用的详细输入/输出/耗时
- 错误诊断与解决建议
- 支持筛选（全部/成功/失败/超时）
- 支持 **重放** 失败请求

---

## 常见问题

| 问题 | 原因与解决 |
|------|------------|
| **浮动按钮不出现** | 确认选中了有效文本；检查扩展是否已成功加载（`about:debugging` 查看） |
| **提示"未配置 API Key"** | 未在弹出面板或设置页配置 API Key |
| **测试连接失败** | 检查 API Key 是否正确、Base URL 是否可达、模型名称是否有效 |
| **GitHub 上提示无法连接** | 这是 GitHub 的 CSP 限制，扩展通过后台转发已绕开，刷新页面重试 |
| **长时间无响应** | 默认超时 120 秒。检查网络连接或模型服务状态 |
| **样式错乱** | 确认已重新加载扩展（`about:debugging` 中点「重新加载」）并刷新页面 |
| **配置编辑后丢失** | 确认使用的是有 API 配置方案的版本（v1.0.1+），字段已支持自动保存 |

---

## 开发与调试

### 修改后重新加载

1. 在 `about:debugging#/runtime/this-firefox` 找到本扩展
2. 点击 **「重新加载」**
3. 刷新目标网页即可看到改动生效

### 存储结构

```
apiProfiles: [
  { id, name, apiKey, apiBaseUrl, modelName, isDefault? }
]
activeProfileId: string

promptProfiles: [
  { id, name, content, isDefault? }
]
activePromptProfileId: string

apiStats: { totalCalls, successfulCalls, failedCalls, timeoutCalls, totalDurationMs, lastCallAt }
```

### 提示词说明

默认系统提示词为 Lexical Approach 风格：

> "你是一个专业的文本解释助手。当用户选中一段文本时，请用简洁易懂的语言解释其含义、背景和用途。"

可以在弹出面板中自由修改或新增提示词方案。

---

## 许可

MIT