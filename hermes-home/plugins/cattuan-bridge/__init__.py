"""把执行 agent 每次工具调用的完整参数和结果推给喵团 App。

App 用 Hermes 的 /v1/runs 跑后台任务（为了能中途插话、停止），但 runs 的事件流里只有工具名和 tool_call_id，
没有参数和结果；搜图结果、网站卡片、深度搜索过程、浏览器画面归属都要这些。这里在 pre/post_tool_call
钩子里把它们 POST 到 App 的 /api/agent/tool，App 按 tool_call_id 和事件流对上。
- 只转发 App 后台任务的会话（session_id 以 task- 开头），别的会话不管。
- 在后台线程里推送，不拖慢工具；App 没开、推送失败就丢掉。
"""

from __future__ import annotations

import json
import os
import queue
import threading
import urllib.request
from pathlib import Path

APP_URL = os.environ.get("CATTUAN_APP_URL", "http://127.0.0.1:3210") + "/api/agent/tool"
MAX_RESULT = 300_000
_queue: "queue.Queue[dict]" = queue.Queue(maxsize=1000)
_key_cache: list[str] = []


def _key() -> str:
    """App 用 agent 的 API_SERVER_KEY 认这是 agent 推来的。"""
    if not _key_cache:
        home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
        key = os.environ.get("API_SERVER_KEY", "")
        try:
            for line in (home / ".env").read_text(encoding="utf-8").splitlines():
                if line.startswith("API_SERVER_KEY="):
                    key = line.split("=", 1)[1].strip().strip('"')
        except OSError:
            pass
        _key_cache.append(key)
    return _key_cache[0]


def _worker() -> None:
    while True:
        payload = _queue.get()
        try:
            body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8", "ignore")
            req = urllib.request.Request(APP_URL, data=body, method="POST", headers={
                "Content-Type": "application/json", "Authorization": f"Bearer {_key()}"})
            urllib.request.urlopen(req, timeout=3).read()
        except Exception:
            pass


def _push(phase: str, kwargs: dict) -> None:
    session_id = str(kwargs.get("session_id") or "")
    if not session_id.startswith("task-"):
        return
    payload = {
        "phase": phase,
        "session_id": session_id,
        "tool_call_id": kwargs.get("tool_call_id") or "",
        "tool": kwargs.get("tool_name") or "",
        "args": kwargs.get("args") if isinstance(kwargs.get("args"), dict) else {},
    }
    if phase == "end":
        result = kwargs.get("result")
        result = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
        payload["result"] = result[:MAX_RESULT]
    try:
        _queue.put_nowait(payload)
    except queue.Full:
        pass


def _pre_tool_call(**kwargs):
    _push("start", kwargs)
    return None  # 不拦截、不改参数


def _post_tool_call(**kwargs):
    _push("end", kwargs)


def register(ctx) -> None:
    if not any(t.name == "cattuan-bridge" for t in threading.enumerate()):
        threading.Thread(target=_worker, name="cattuan-bridge", daemon=True).start()
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("post_tool_call", _post_tool_call)
