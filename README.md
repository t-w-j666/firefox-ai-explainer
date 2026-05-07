# AI Text Explainer（Firefox 扩展 + FastAPI）

划选网页文本 → 出现 **「AI 解释」** 按钮 → 调用本机 **FastAPI + LangChain** 流式（SSE）返回解释，前端在 **Shadow DOM** 内渲染浮动卡片，避免页面 CSS 污染。

## 架构与数据流（透明约定）

1. **前端** `content.js`：`mouseup` / `keyup`（键盘选区）去抖后读取 `window.getSelection()`，计算 `Range.getBoundingClientRect()`（视口坐标），在 Shadow DOM 内放置 `position:fixed` 按钮。
2. **请求**：由 **`background.js`** 发起 `POST {apiBase}/explain/stream`（`content.js` 仅通过 `runtime.connect` 接收流式片段）。这样 **GitHub 等站点页面的 CSP** 不会拦截对 `127.0.0.1` 的请求；内容脚本里直接 `fetch` 会被 `connect-src` 挡住。
   - Header：`Content-Type: application/json`，body：`{"text":"划选","context":"邻近文本截断"}`，`Accept: text/event-stream`。
3. **SSE**：每行 `data: ` 后为 JSON：
   - `{"chunk":"..."}` 增量正文（打字机效果）；
   - `{"error":"..."}` 错误说明；
   - `{"done":true}` 结束。
4. **样式**：`popup.css` 由脚本 `fetch(browser.runtime.getURL("popup.css"))` 注入 **Shadow Root**，不再通过 `content_scripts.css` 注入页面（避免泄漏）。

## 环境

- Python **3.10+**
- Firefox **109+**
- **DeepSeek API**（[OpenAI 兼容](https://api-docs.deepseek.com/zh-cn/)）：设置 `DEEPSEEK_API_KEY`；默认请求 `https://api.deepseek.com/v1`，模型 `deepseek-chat`

## Python 虚拟环境与依赖

在项目根目录（本 README 同级）执行。

### Windows（PowerShell）

```powershell
cd "D:\Cursor项目统一管理\firefox-ai-explainer"
.\setup_venv.ps1
.\.venv\Scripts\Activate.ps1
```

若禁止脚本：

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### macOS / Linux

```bash
chmod +x setup_venv.sh
./setup_venv.sh
source .venv/bin/activate
```

## 启动后端

```powershell
.\.venv\Scripts\Activate.ps1
$env:DEEPSEEK_API_KEY = "你的_DeepSeek_API_Key"
python main.py
```

默认：`http://127.0.0.1:8765`

- 健康检查：`GET /health`
- 流式解释：`POST /explain/stream`

可选环境变量：

| 变量 | 含义 |
|------|------|
| `PORT` | 端口（默认 8765） |
| `DEEPSEEK_API_KEY` | DeepSeek 密钥（**优先**） |
| `OPENAI_API_KEY` | 若未设置上一项，可用此项作为密钥（兼容旧说明） |
| `DEEPSEEK_API_BASE` | API 根路径（默认 `https://api.deepseek.com/v1`） |
| `DEEPSEEK_MODEL` | 模型（默认 `deepseek-chat`；推理模型如 `deepseek-reasoner`） |
| `OPENAI_MODEL` | 若未设置 `DEEPSEEK_MODEL`，可用此项指定模型名 |
| `MAX_CONTEXT_CHARS` | 上下文最大字符（默认 6000，与前端一致） |

## 加载 Firefox 扩展

1. 打开 `about:debugging#/runtime/this-firefox`
2. **临时加载附加组件** → 选择本目录下的 `manifest.json`

修改 `manifest.json` 或新增 `background.js` 后，须在 **`about:debugging`** 对该扩展点 **「重新加载」**，否则后台脚本仍是旧版。

## 自定义后端地址

默认 `http://127.0.0.1:8765`。可在 **扩展调试 → 检查 → 控制台** 或通过 `storage.local` 写入键 **`apiBaseUrl`**（字符串，无尾部 `/` 亦可），例如：

```js
browser.storage.local.set({ apiBaseUrl: "http://127.0.0.1:9000" });
```

（在扩展所属上下文执行，例如后续若增加 `options.html` 可在其中设置。）

## 故障排查

- **无法连接后端**：确认 `python main.py` 已运行；`manifest.json` 中 `host_permissions` 需包含你的 API 主机。
- **503**：未设置 `DEEPSEEK_API_KEY`（或未设置兼容项 `OPENAI_API_KEY`）。
- **长时间无响应**：前端约 **120s** 超时；关闭浮层会 **中止** 当前 fetch，不再追加正文。

## 仓库文件

| 文件 | 说明 |
|------|------|
| `main.py` | FastAPI、CORS、SSE、Lexical Approach 提示词 |
| `manifest.json` | Firefox MV3（含 `background`） |
| `background.js` | 在扩展后台发起 `fetch`/SSE，绕过页面 CSP |
| `content.js` | 划选、坐标、Shadow DOM；经 connect 接收流式正文 |
| `popup.css` | 浮动按钮与卡片样式（Shadow 内） |
| `requirements.txt` / `setup_venv.*` | 依赖与一键建虚拟环境 |
