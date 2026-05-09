# AI Text Explainer

在 Firefox 中**划选网页文字**，直接调用大模型 API（默认 DeepSeek），以 **SSE 流式**返回解释。纯浏览器扩展，**无需启动 Python 后端**。

扩展用 **Shadow DOM** 隔离 UI，通过后台脚本转发请求，避免 GitHub 等站点的 CSP 拦截。

---

## 使用教程

### 基本操作

1. **划选文字** — 在任意网页上用鼠标选中一个词或句子。
2. **点击「AI 解释」按钮** — 选中文字后，选区附近会出现一个浮动按钮。
3. **查看流式解释** — 弹出卡片后会逐字输出解释（打字机效果），无需等待完整响应。
4. **拖动卡片** — 按住卡片**标题栏**可拖动到任意位置。
5. **关闭卡片** — 点击右上角 **×** 或点击卡片外的遮罩层即可关闭；关闭时会自动中止正在进行的请求，不浪费 token。

> 支持的交互方式：鼠标划选、键盘 Shift+方向键 划选后松键均可触发。

### 典型使用场景

| 场景 | 操作 | 预期结果 |
|------|------|----------|
| 阅读英文文章遇到生词 | 双击选中单词 → 点击「AI 解释」 | 获得含义、常见搭配、例句 |
| 遇到复杂技术概念 | 选中相关段落 → 点击「AI 解释」 | 获得概念讲解、用法说明 |
| 在 GitHub 上阅读代码文档 | 选中文字 → 点击「AI 解释」 | 正常返回解释（请求通过后台转发，绕过 CSP） |

### 注意事项

- 请求超时时间为 120 秒，超时会提示。
- 关闭卡片会立即中止请求，保证 token 不浪费。
- 浮动按钮仅在划选有效文本且选区有可见大小时出现。

---

## 环境要求

- **Firefox** 109+（需支持 Manifest V3）
- **DeepSeek**（或其他 OpenAI 兼容服务）的 API Key

---

## 快速开始

### 1. 加载 Firefox 扩展

1. 地址栏打开 `about:debugging#/runtime/this-firefox`
2. 点击 **「临时加载附加组件」**
3. 选择本仓库根目录下的 **`manifest.json`**
4. 扩展加载成功后，右键扩展图标 → **管理扩展** → **选项**

### 2. 在设置页面配置 API Key

在打开的选项页面中填写：

- **API Key** — 你的 DeepSeek / OpenAI API 密钥
- **API Base URL** — API 地址（默认 `https://api.deepseek.com`）
- **模型名称** — 模型标识符（默认 `deepseek-chat`）

点击 **保存**，然后点击 **测试连接** 验证配置是否可用。

### 3. 验证是否正常工作

- 访问任意网页（如 `https://example.com`）
- 选中一段文字
- 点击弹出的 **「AI 解释」** 按钮
- 看到卡片中逐字输出解释即为成功

---

## 配置

### 切换模型 / API 服务

支持任何 OpenAI 兼容接口。在选项页面修改以下字段：

| 字段 | 说明 | 默认值 |
|------|------|--------|
| API Key | API 密钥 | — |
| API Base URL | 兼容 API 根路径 | `https://api.deepseek.com` |
| 模型名称 | 模型标识符 | `deepseek-chat` |

> 示例：切换到 **OpenAI** — 将 API Base URL 改为 `https://api.openai.com`，模型改为 `gpt-4o-mini`，填入你的 OpenAI API Key 即可。

---

## 调试与修改

修改 `content.js`、`background.js`、`options.html` 或 `manifest.json` 后：

1. 在 `about:debugging#/runtime/this-firefox` 找到本扩展
2. 点击 **「重新加载」**
3. 刷新目标网页即可看到改动生效

---

## 项目文件结构

| 文件 | 作用 |
|------|------|
| `options.html` / `options.js` | 选项设置页面：配置 API Key、模型等 |
| `content.js` | 内容脚本：管理划选检测、浮动按钮、解释卡片 UI |
| `background.js` | 后台脚本：直调大模型 API（OpenAI 兼容格式），解析 SSE 流 |
| `popup.css` | Shadow DOM 样式：浮动按钮、卡片、暗色主题 |
| `manifest.json` | Firefox MV3 扩展配置 |
| `main.py` | （可选/遗留）FastAPI 后端，不再需要 |

---

## 常见问题

| 现象 | 原因与解决 |
|------|------------|
| 普通站点正常，**GitHub 上提示无法连接** | CSP 限制。请确认扩展已重新加载，请求通过 background.js 转发不受 CSP 影响。 |
| **提示"未配置 API Key"** | 未在选项页面填写 API Key。右键扩展图标 → 管理扩展 → 选项。 |
| **测试连接失败** | 检查 API Key 是否正确、API Base URL 是否有效、网络是否正常。 |
| **样式没有更新** | `popup.css` 可能被缓存。重新加载扩展或在新标签页中测试。 |
| **长时间无响应（超时）** | 检查网络连接。默认超时 120 秒。 |
| **浮动按钮不出现** | 确认选中了有效文本且选区可见；检查扩展已成功加载。 |
| **解释内容不对** | 提示词采用 Lexical Approach，如对输出格式有特殊要求可修改 `background.js` 中的 `SYSTEM_PROMPT`。 |