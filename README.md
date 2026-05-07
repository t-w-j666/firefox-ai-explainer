# AI Text Explainer

在 Firefox 中**划选网页文字**，通过本机 **FastAPI** 调用大模型（默认 **DeepSeek**，OpenAI 兼容接口），以 **SSE 流式**返回解释；扩展侧用 **Shadow DOM** 渲染 UI，并用 **后台脚本**转发请求，避免 GitHub 等站点 **CSP** 拦截 `localhost`。

---

## 目录

- [功能概览](#功能概览)
- [架构说明](#架构说明)
- [仓库文件说明](#仓库文件说明)
- [环境要求](#环境要求)
- [安装与运行](#安装与运行)
- [配置](#配置)
- [扩展加载与调试](#扩展加载与调试)
- [HTTP API 约定](#http-api-约定)
- [常见问题](#常见问题)

---

## 功能概览

- 划词后出现 **「AI 解释」** 浮动按钮；点击后在 **Shadow DOM** 卡片中流式展示正文（打字机效果）。
- 提示词采用 **Lexical Approach（语料块学习法）**：含义、常见搭配、例句。
- **标题栏可拖动**卡片；点击遮罩或关闭按钮收起。
- 后端未启动、超时、模型错误时，前端有可读提示；关闭卡片会 **中止** 进行中的请求。

---

## 架构说明

```text
网页 (任意站点)
  └── Content Script (content.js)
        ├── 监听划选、计算按钮/卡片位置
        ├── Shadow DOM + popup.css（样式与页面隔离）
        └── runtime.connect ──────────────────┐
                                             ▼
                                   Background (background.js)
                                             │  fetch(SSE)
                                             ▼
                                   本机 FastAPI (main.py)
                                             │  LangChain ChatOpenAI
                                             ▼
                                   DeepSeek API（默认）
```

要点：

| 层级 | 职责 |
|------|------|
| **content.js** | 仅负责 DOM/UI 与用户交互；**不直接 `fetch` 后端**（在 github.com 等页面会被 CSP 拦截）。 |
| **background.js** | 在扩展上下文中发起 `POST /explain/stream`，解析 SSE，通过 Port 把 `chunk` / `error` / `done` 推回 content script。 |
| **main.py** | CORS、校验请求体、组装 Prompt、流式调用模型，输出标准 SSE `data:` JSON。 |

---

## 仓库文件说明

仓库根目录中与项目直接相关的文件如下（不含 `.git/`、本地 `.venv/`）。

| 文件 | 作用 |
|------|------|
| [**`manifest.json`**](manifest.json) | Firefox **Manifest V3**：扩展元数据、`permissions`、`host_permissions`、`content_scripts`、`background`、`web_accessible_resources`（供 Shadow 内加载 `popup.css`）。 |
| [**`content.js`**](content.js) | **内容脚本**：`mouseup` / `keyup` 去抖后读取选区与矩形；注入 Shadow DOM（按钮、遮罩、卡片）；通过 **`runtime.connect('ai-explainer-sse')`** 驱动流式展示；标题栏拖动逻辑。 |
| [**`background.js`**](background.js) | **后台脚本**：接收 content 的 `start` 消息，对 `http://127.0.0.1:8765/explain/stream`（或可配置的 `apiBaseUrl`）发起带 SSE 的 `fetch`，解析 `data:` 行并把结果 **postMessage** 回 content。 |
| [**`popup.css`**](popup.css) | **仅用于 Shadow DOM**：浮动按钮、遮罩、卡片、暗色主题、`grab/grabbing` 等；由 content script **fetch `runtime.getURL('popup.css')`** 注入，避免污染宿主页面样式。 |
| [**`main.py`**](main.py) | **后端**：FastAPI 应用；`POST /explain/stream` 返回 `text/event-stream`；默认 **DeepSeek**（`base_url` + `deepseek-chat`）；支持上下文长度上限与环境变量。 |
| [**`requirements.txt`**](requirements.txt) | Python 依赖版本范围（FastAPI、Uvicorn、LangChain OpenAI、Pydantic 等）。 |
| [**`setup_venv.ps1`**](setup_venv.ps1) | Windows：**创建 `.venv` 并 `pip install -r requirements.txt`**。 |
| [**`setup_venv.sh`**](setup_venv.sh) | macOS / Linux：同上。 |
| [**`.gitignore`**](.gitignore) | 忽略 `.venv/`、`__pycache__`、`.env` 等本地文件。 |
| [**`README.md`**](README.md) | 本说明文档。 |

---

## 环境要求

- **Python** 3.10+
- **Firefox** 109+（MV3）
- **DeepSeek**（或其他 OpenAI 兼容服务）的有效 API Key（默认对接 DeepSeek 官方兼容端点）

---

## 安装与运行

### 1. Python 虚拟环境与依赖

在**克隆后的仓库根目录**执行：

**Windows (PowerShell)**

```powershell
.\setup_venv.ps1
.\.venv\Scripts\Activate.ps1
```

若脚本策略受限：

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

**macOS / Linux**

```bash
chmod +x setup_venv.sh
./setup_venv.sh
source .venv/bin/activate
```

### 2. 启动后端

```powershell
# 示例：PowerShell 写入会话环境变量（推荐在系统/用户环境变量中永久配置）
$env:DEEPSEEK_API_KEY = "<your-api-key>"
python main.py
```

默认监听：`http://127.0.0.1:8765`

- 健康检查：`GET /health`
- 流式解释：`POST /explain/stream`

---

## 配置

### 后端环境变量

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（**优先读取**）。 |
| `OPENAI_API_KEY` | 未设置上一项时作为密钥回退（兼容其他 OpenAI 兼容服务商）。 |
| `DEEPSEEK_API_BASE` | 兼容 API 根路径，默认 `https://api.deepseek.com/v1`。 |
| `DEEPSEEK_MODEL` | 模型名，默认 `deepseek-chat`。 |
| `OPENAI_MODEL` | 未设置 `DEEPSEEK_MODEL` 时可用此变量指定模型。 |
| `PORT` | HTTP 端口，默认 `8765`。 |
| `MAX_CONTEXT_CHARS` | 提交给模型的上下文最大字符数，默认 `6000`（与前端截断策略一致）。 |

### 扩展侧：自定义本机 API 根 URL

默认请求 `http://127.0.0.1:8765`。若后端端口变更，可在扩展存储中写入 `apiBaseUrl`（无需尾部 `/`），例如在扩展调试控制台执行：

```js
browser.storage.local.set({ apiBaseUrl: "http://127.0.0.1:9000" });
```

---

## 扩展加载与调试

1. Firefox 地址栏打开 **`about:debugging#/runtime/this-firefox`**。
2. **临时加载附加组件** → 选择本仓库中的 **`manifest.json`**。
3. 修改 `manifest.json`、`background.js` 或 `content.js` 后，应在调试页对该扩展点击 **「重新加载」**，再刷新目标网页。

> **说明**：临时扩展在关闭 Firefox 后会失效，需重新加载。

---

## HTTP API 约定

### `POST /explain/stream`

- **Request**：`Content-Type: application/json`

```json
{
  "text": "用户划选的词句",
  "context": "页面邻近文本（可选，前端会截断）"
}
```

- **Response**：`Content-Type: text/event-stream`

每条 SSE 事件为单行：`data: <JSON>`，例如：

| JSON 字段 | 含义 |
|-----------|------|
| `{"chunk":"..."}` | 增量文本片段 |
| `{"error":"..."}` | 错误信息 |
| `{"done":true}` | 流结束 |

---

## 常见问题

| 现象 | 可能原因与处理 |
|------|----------------|
| 普通站点可用，**GitHub 上提示无法连接** | 页面 CSP 限制 content `fetch`。**本项目已通过 `background.js` 转发**；请确认扩展已 **重新加载** 且使用当前仓库版本。 |
| **503** | 未配置 `DEEPSEEK_API_KEY`（或未配置兼容的 `OPENAI_API_KEY`）。 |
| **样式未更新** | `popup.css` 在会话中可能被缓存；重新加载扩展或新开标签页后再试。 |
| **长时间无响应** | 前端约 **120s** 超时；确认本机后端已启动且防火墙未拦截端口。 |
