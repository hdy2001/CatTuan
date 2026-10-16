"""发布网页：执行 agent 把做好的单页网站发布出来，用户在喵团 App 里点网站卡片，就能在内置浏览器里看。

网站存在 $HERMES_HOME/sites/<site_id>/index.html，旁边的 meta.json 记标题和版本。
App 在单独的端口（默认 :3211，和 App 不同源，带 CSP）上提供这些网页，见 app/server.mjs。
- publish_site：发布新网站；带 site_id 就是更新已有网站（旧版留一份 index.prev.html）
- read_site：读已有网站的 HTML，用户要改网站时先读再改
- check_site：在沙箱浏览器里真的打开网站（只能开 :3211 上的网站 id），收集 JS 报错、加载失败的请求，截首屏图，可按顺序点几下再看
"""

from __future__ import annotations

import json
import os
import re
import secrets
from datetime import datetime, timezone
from html import escape
from pathlib import Path

MAX_HTML = 1_500_000
SITE_ID = re.compile(r"^s_[0-9a-f]{8}$")
SITES_URL = os.environ.get("CATTUAN_SITES_URL", "http://localhost:3211")
SANDBOX = os.environ.get("CATTUAN_SANDBOX_URL", "http://127.0.0.1:8660")

PUBLISH_SCHEMA = {
    "name": "publish_site",
    "description": (
        "把做好的网页发布出来：用户在 App 聊天里点网站卡片，就能在 App 的内置浏览器里直接看。"
        "用户要「网站 / 网页 / 可视化页面 / 导游图 / 攻略页 / 清单页 / H5」时用它，做之前先 skill_view web-page。"
        "html 是完整的单文件网页（CSS、JS 都写在里面）；外部资源只能用 https（例如 cdnjs 上的 Leaflet、地图瓦片、https 图片），访问不了 localhost 和内网。"
        "要修改已有网站时带上 site_id（先 read_site 读出原来的 HTML 再改），会发布成新版本。"
        "发布后不要把 HTML 代码贴在回复里，也不要说「附件」「下载」「用浏览器打开」。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "网站标题，不超过 30 字，例如「首尔医美诊所地图」"},
            "html": {"type": "string", "description": "完整的 HTML 文档（<!DOCTYPE html> 开头，CSS/JS 内联）"},
            "description": {"type": "string", "description": "一句话说明网站里有什么（可选）"},
            "site_id": {"type": "string", "description": "要更新的网站 id（s_ 开头）；新网站不填"},
        },
        "required": ["title", "html"],
    },
}

READ_SCHEMA = {
    "name": "read_site",
    "description": "读一个已发布网站的 HTML 源码和标题。用户要改某个网站时，先用它读出原来的内容，改好后用 publish_site 带同一个 site_id 发布。",
    "parameters": {
        "type": "object",
        "properties": {"site_id": {"type": "string", "description": "网站 id（s_ 开头）"}},
        "required": ["site_id"],
    },
}


CHECK_SCHEMA = {
    "name": "check_site",
    "description": (
        "在沙箱浏览器里真的打开一个已发布的网站（手机宽度），看它能不能用：返回 JS 报错（带 index.html 行号和那一行代码）、"
        "加载失败的资源、弹窗、页面标题和可见文字、页面上能点的按钮，以及首屏截图的本地路径（可以用 vision_analyze 看图）。"
        "可以按顺序点几下（例如「开始」→ 第一个选项）再看点完后的报错和画面，用来检查游戏、测验、筛选这类交互。"
        "发布或更新网站后、用户说网页打不开 / 点不动 / 有 bug 时，先用它看真实报错再改，不要只读源码猜。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "site_id": {"type": "string", "description": "网站 id（s_ 开头）"},
            "click": {
                "type": "array", "items": {"type": "string"},
                "description": "按顺序要点的东西，最多 5 个：按钮上的文字（例如「开始挑战」）或 CSS 选择器（例如 #start、.option-btn）。不填就只看打开后的首屏",
            },
            "viewport": {"type": "string", "enum": ["mobile", "desktop"], "description": "mobile（默认，390px 宽）或 desktop（1280px）"},
        },
        "required": ["site_id"],
    },
}


def _dir() -> Path:
    try:
        from hermes_constants import get_hermes_home
        home = Path(get_hermes_home())
    except Exception:
        home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    path = home / "sites"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


def _clean(s: str) -> str:
    """去掉半个 emoji（孤立代理项），否则写文件会报错。"""
    return str(s or "").encode("utf-8", "ignore").decode("utf-8")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _write(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _normalize_html(html: str, title: str) -> str:
    html = _clean(html).strip()
    # 模型有时把整页包在 ```html 代码块里
    fenced = re.match(r"^```(?:html)?\s*\n(.*?)\n?```$", html, re.S | re.I)
    if fenced:
        html = fenced.group(1).strip()
    if not re.search(r"<!doctype|<html", html[:500], re.I):
        html = (
            '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f"<title>{escape(title)}</title>\n</head>\n<body>\n{html}\n</body>\n</html>"
        )
    return html


def publish_site(args: dict, **kwargs) -> str:
    title = _clean(args.get("title")).strip()[:40] or "未命名网站"
    raw = args.get("html") or ""
    if not str(raw).strip():
        return _dump({"error": "html 不能为空"})
    html = _normalize_html(raw, title)
    if len(html) > MAX_HTML:
        return _dump({"error": f"网页太大了（{len(html)} 字符，上限 {MAX_HTML}），把大段数据精简一下再发"})
    site_id = (args.get("site_id") or "").strip()
    root = _dir()
    if site_id:
        if not SITE_ID.match(site_id) or not (root / site_id / "meta.json").exists():
            return _dump({"error": f"没有网站 {site_id}；新网站不要填 site_id"})
    else:
        site_id = f"s_{secrets.token_hex(4)}"
    folder = root / site_id
    folder.mkdir(parents=True, exist_ok=True)
    meta_file = folder / "meta.json"
    try:
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
    except Exception:
        meta = {"id": site_id, "createdAt": _now(), "version": 0}
    index = folder / "index.html"
    if index.exists():
        os.replace(index, folder / "index.prev.html")
    _write(index, html)
    meta.update({
        "title": title,
        "description": _clean(args.get("description")).strip()[:120],
        "version": int(meta.get("version") or 0) + 1,
        "updatedAt": _now(),
    })
    _write(meta_file, json.dumps(meta, ensure_ascii=False, indent=2))
    return _dump({
        "ok": True,
        "site": {"id": site_id, "title": title, "version": meta["version"], "url": f"{SITES_URL}/{site_id}/"},
        "note": "已发布。App 会在聊天消息下面放这个网站的卡片，用户点开就能在 App 里看。回复里用两三句说说网站里有什么，不要贴代码，不要说附件或下载。",
    })


def read_site(args: dict, **kwargs) -> str:
    site_id = (args.get("site_id") or "").strip()
    folder = _dir() / site_id
    if not SITE_ID.match(site_id) or not (folder / "index.html").exists():
        return _dump({"error": f"没有网站 {site_id}"})
    try:
        meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    except Exception:
        meta = {}
    return _dump({
        "site_id": site_id,
        "title": meta.get("title", ""),
        "version": meta.get("version", 1),
        "html": (folder / "index.html").read_text(encoding="utf-8"),
    })


def _task_of(kwargs: dict) -> str | None:
    """App 在任务提示里写了「任务编号：t_xxx」；转给沙箱，截图就会出现在这个任务卡片的「浏览过程」里。"""
    m = re.search(r"任务编号：(t_[a-z0-9]+)", str(kwargs.get("user_task") or ""))
    return m.group(1) if m else None


def check_site(args: dict, **kwargs) -> str:
    import httpx

    site_id = (args.get("site_id") or "").strip()
    folder = _dir() / site_id
    if not SITE_ID.match(site_id) or not (folder / "index.html").exists():
        return _dump({"error": f"没有网站 {site_id}"})
    clicks = args.get("click") or []
    if isinstance(clicks, str):
        clicks = [clicks]
    clicks = [_clean(c).strip()[:100] for c in clicks if str(c or "").strip()][:5]
    params = {"id": site_id, "click": clicks}
    if args.get("viewport") in ("mobile", "desktop"):
        params["viewport"] = args["viewport"]
    task = _task_of(kwargs)
    try:
        resp = httpx.get(f"{SANDBOX}/site/check", params=params, timeout=130, headers={"x-cattuan-task": task} if task else None)
        data = resp.json()
    except Exception as exc:
        return _dump({"error": f"沙箱不可用：{exc}"})
    if data.get("error"):
        return _dump({"site_id": site_id, "error": data.get("message") or data["error"]})
    try:
        meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    except Exception:
        meta = {}
    issues = [{k: v for k, v in i.items() if not (k == "count" and v == 1)} for i in data.get("issues") or []]
    snapshots = []
    for s in data.get("snapshots") or []:
        snapshots.append({k: v for k, v in {
            "phase": s.get("phase"), "click": s.get("click"), "url": s.get("url"), "title": s.get("title"),
            "text": (s.get("text") or "")[:800], "textLength": s.get("textLength"), "canvases": s.get("canvases") or None,
            "clickables": s.get("clickables"), "screenshot": s.get("screenshot"), "error": s.get("error"),
        }.items() if v not in (None, "", [])})
    hint = (
        "按 issues 里的 where（index.html 的行号）和 code 找到出错的代码改掉；SyntaxError 会让整段 <script> 都不执行（按钮全点不动），"
        "常见原因是字符串里有没转义的引号。改完用 publish_site 带同一个 site_id 发布，再 check_site 一次确认没有报错。"
        if issues else "没发现报错。要确认画面对不对，可以用 vision_analyze 看 screenshot。"
    )
    # 沙箱出口已经清掉了半个 emoji
    return _dump({
        "site_id": site_id, "title": meta.get("title", ""), "version": meta.get("version", 1),
        "ok": data.get("ok"), "summary": data.get("summary"), "load": data.get("load"),
        "issues": issues, "snapshots": snapshots, "hint": hint,
    })


def register(ctx) -> None:
    ctx.register_tool(name="publish_site", toolset="sites", schema=PUBLISH_SCHEMA, handler=publish_site)
    ctx.register_tool(name="read_site", toolset="sites", schema=READ_SCHEMA, handler=read_site)
    ctx.register_tool(name="check_site", toolset="sites", schema=CHECK_SCHEMA, handler=check_site)
