"""
AI Text Explainer — FastAPI 后端
POST /explain/stream：JSON {"text","context"} → SSE（每行 data: JSON）

依赖：requirements.txt | 虚拟环境：setup_venv.ps1 / setup_venv.sh
默认使用 DeepSeek（OpenAI 兼容接口）。环境变量：
- DEEPSEEK_API_KEY（推荐）；若未设置则回退 OPENAI_API_KEY
- DEEPSEEK_API_BASE（默认 https://api.deepseek.com/v1）
- DEEPSEEK_MODEL（默认 deepseek-chat）；亦可用 OPENAI_MODEL 覆盖
- PORT（默认 8765）
"""

from __future__ import annotations

import json
import os
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

MAX_CONTEXT_CHARS = int(os.getenv("MAX_CONTEXT_CHARS", "6000"))

app = FastAPI(title="AI Text Explainer API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ExplainBody(BaseModel):
    """与 content script 对齐：划选文本 + 页面上下文。"""

    text: str = Field(..., min_length=1, max_length=8000)
    context: str = Field(default="", max_length=MAX_CONTEXT_CHARS)


LEXICAL_SYSTEM = """##对陌生概念或者术语进行讲解，不仅要讲清楚‘是什么’，还要讲清楚‘有什么’，‘怎么用’
##输出格式为纯文本输出，不要使用markdown格式"""


def _build_user_prompt(text: str, context: str) -> str:
    ctx = context.strip() if context else "（无额外上下文）"
    if len(ctx) > MAX_CONTEXT_CHARS:
        ctx = ctx[:MAX_CONTEXT_CHARS] + "\n…（上下文已截断）"
    return f"划选词句：\n{text}\n\n上下文：\n{ctx}"


def _get_llm() -> ChatOpenAI:
    """
    DeepSeek 与 OpenAI SDK 兼容：指定 base_url + 模型名即可。
    文档：https://api-docs.deepseek.com/zh-cn/
    """
    key = os.getenv("DEEPSEEK_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not key:
        raise HTTPException(
            status_code=503,
            detail="未配置 DEEPSEEK_API_KEY（或兼容项 OPENAI_API_KEY），无法调用模型。",
        )
    base_url = (
        os.getenv("DEEPSEEK_API_BASE", "").strip()
        or "https://api.deepseek.com/v1"
    )
    model = (
        os.getenv("DEEPSEEK_MODEL", "").strip()
        or os.getenv("OPENAI_MODEL", "").strip()
        or "deepseek-chat"
    )
    return ChatOpenAI(
        model=model,
        api_key=key,
        base_url=base_url,
        streaming=True,
        temperature=0.3,
    )


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "service": "ai-text-explainer"}


async def _sse_lexical_stream(text: str, context: str) -> AsyncIterator[str]:
    """
    SSE：每条事件为 data: <JSON>
    - {"chunk": "..."} 增量文本
    - {"error": "..."} 模型或运行时错误（仍可收到 done）
    - {"done": true} 结束
    """
    try:
        llm = _get_llm()
    except HTTPException as e:
        yield f"data: {json.dumps({'error': e.detail}, ensure_ascii=False)}\n\n"
        yield f"data: {json.dumps({'done': True}, ensure_ascii=False)}\n\n"
        return

    messages = [
        SystemMessage(content=LEXICAL_SYSTEM),
        HumanMessage(content=_build_user_prompt(text, context)),
    ]
    try:
        async for chunk in llm.astream(messages):
            piece = getattr(chunk, "content", None) or ""
            if piece:
                yield f"data: {json.dumps({'chunk': piece}, ensure_ascii=False)}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
    yield f"data: {json.dumps({'done': True}, ensure_ascii=False)}\n\n"


@app.post("/explain/stream")
async def explain_stream(body: ExplainBody):
    return StreamingResponse(
        _sse_lexical_stream(body.text, body.context),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8765"))
    uvicorn.run("main:app", host="127.0.0.1", port=port, reload=True)
