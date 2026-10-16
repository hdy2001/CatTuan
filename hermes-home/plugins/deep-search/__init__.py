"""深度搜索：在沙箱的真实浏览器里搜必应、读网页（和普通用户看到的一样，App 里能看到实时画面）。

- deep_web_search：必应搜索，返回标题、网址、摘要
- read_webpage：打开网页读正文（最多约 1.2 万字）；不下载文件、不访问内网
"""

from __future__ import annotations

import json
import os

SANDBOX = os.environ.get("CATTUAN_SANDBOX_URL", "http://127.0.0.1:8660")

SEARCH_SCHEMA = {
    "name": "deep_web_search",
    "description": (
        "用必应搜网页（在真实浏览器里搜，中文结果好）。深度搜索时多换几个角度的关键词：官方说法、对比、评测、时间范围、反方观点。"
        "返回标题、网址和摘要；摘要不够就用 read_webpage 读原文。"
    ),
    "parameters": {
        "type": "object",
        "properties": {"query": {"type": "string", "description": "搜索词，例如「看天下 杂志 图书馆 数字资源」"}},
        "required": ["query"],
    },
}

READ_SCHEMA = {
    "name": "read_webpage",
    "description": (
        "打开一个网页读正文（在真实浏览器里打开，能读靠脚本渲染的页面）。不会下载文件（PDF、压缩包等会被拒），不能登录、不能访问内网。"
        "返回标题和正文；读不到正文时 note 会说明原因，换个来源。"
    ),
    "parameters": {
        "type": "object",
        "properties": {"url": {"type": "string", "description": "网页地址（通常来自 deep_web_search 的结果）"}},
        "required": ["url"],
    },
}


def _dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


def _clean(obj):
    """去掉半个 emoji（孤立代理项），否则 Hermes 存库会报错。"""
    if isinstance(obj, str):
        return obj.encode("utf-8", "ignore").decode("utf-8")
    if isinstance(obj, list):
        return [_clean(v) for v in obj]
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    return obj


def _sandbox(path: str, **params) -> dict:
    import httpx

    resp = httpx.get(f"{SANDBOX}{path}", params=params, timeout=120)
    try:
        return _clean(resp.json())
    except ValueError:
        return {"error": f"沙箱返回了 {resp.status_code}"}


def deep_web_search(args: dict, **kwargs) -> str:
    query = (args.get("query") or "").strip()
    if not query:
        return _dump({"error": "query 不能为空"})
    try:
        data = _sandbox("/web/search", q=query)
    except Exception as exc:
        return _dump({"error": f"沙箱不可用：{exc}"})
    if data.get("error"):
        return _dump({"error": data.get("message") or data["error"]})
    results = [{"n": i + 1, **r} for i, r in enumerate(data.get("results") or [])]
    return _dump({"query": query, "results": results} if results else {"query": query, "results": [], "hint": "没搜到，换个说法再试"})


def read_webpage(args: dict, **kwargs) -> str:
    url = (args.get("url") or "").strip()
    if not url:
        return _dump({"error": "url 不能为空"})
    try:
        data = _sandbox("/web/read", url=url)
    except Exception as exc:
        return _dump({"error": f"沙箱不可用：{exc}"})
    if data.get("error"):
        return _dump({"url": url, "error": data.get("message") or data["error"]})
    text = data.get("text") or ""
    return _dump({"url": data.get("finalUrl") or url, "title": data.get("title") or "", "text": text[:12000],
                  **({"note": data["note"]} if data.get("note") else {}), **({"truncated": True} if len(text) > 12000 else {})})


def register(ctx) -> None:
    ctx.register_tool(name="deep_web_search", toolset="deepsearch", schema=SEARCH_SCHEMA, handler=deep_web_search)
    ctx.register_tool(name="read_webpage", toolset="deepsearch", schema=READ_SCHEMA, handler=read_webpage)
