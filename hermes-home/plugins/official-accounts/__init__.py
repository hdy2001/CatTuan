"""社媒账号源：通过 CatTuan 沙箱（独立 profile 的浏览器）只读获取各平台公开账号（品牌、机构、博主、个人公开主页……）的最新帖子。

平台：weibo（微博，访客免登录）、x、instagram、weverse（需要用户在 App 里自己登录沙箱）、
bilibili（B 站，免登录可读，被风控时再登录）。

- official_account：找 / 关注 / 取消关注 / 列出社媒账号、查看各平台登录状态；
  关注列表存在 $HERMES_HOME/official_accounts.json，每条记录 platform
- official_photos：拉已关注账号最近 N 天带图的帖子，图片 id 规则与 idol_photo_search 相同，
  回复里同样用 `GALLERY: id1,id2,...` 选图
- 没登录的平台返回 login_needed 和给用户的引导（「请在 App 里点登录 X」），不会替用户登录
"""

from __future__ import annotations

import hashlib
import json
import re
import os
import threading
from pathlib import Path

SANDBOX = os.environ.get("CATTUAN_SANDBOX_URL", "http://127.0.0.1:8660")
_LOCK = threading.Lock()
_MAX_PHOTOS = 40

PLATFORMS = {"weibo": "微博", "x": "X", "instagram": "Instagram", "weverse": "Weverse", "bilibili": "B 站", "xiaohongshu": "小红书"}
_ALIASES = {
    "微博": "weibo", "twitter": "x", "推特": "x", "ig": "instagram", "ins": "instagram",
    "b站": "bilibili", "b 站": "bilibili", "bili": "bilibili", "哔哩哔哩": "bilibili", "小红书": "xiaohongshu", "xhs": "xiaohongshu", "红书": "xiaohongshu", "rednote": "xiaohongshu",
}
_UID_HINT = "uid：微博 / B 站用数字 id，X / Instagram 用用户名（不带 @），Weverse 用社区路径（weverse.io/ 后面那段，如 seventeen）。"

ACCOUNT_SCHEMA = {
    "name": "official_account",
    "description": (
        "管理用户关注的社媒账号（品牌、机构、媒体、博主、个人公开主页等任何公开账号都可以），支持微博(weibo)、X(x)、Instagram(instagram)、Weverse(weverse)、B 站(bilibili)、小红书(xiaohongshu，需登录)。"
        "action=find 在 platform 上按名字搜账号（返回认证信息和粉丝数）；action=follow 把账号加入关注列表（之后 official_photos 会读它）；"
        "action=unfollow 取消；action=list 列出已关注；action=status 查看各平台是否已在沙箱里登录。"
        "X / Instagram / Weverse 需要用户先在 App「+」→「社媒账号」点登录、在弹出的窗口里自己登录；没登录时返回 login_needed，"
        "把其中的 hint 原样转告用户，不要换别的平台冒充。"
        "同名账号多时，优先选认证信息是本人、品牌或机构官方的账号；用户点名某个具体账号就直接关注那个。" + _UID_HINT
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["find", "follow", "unfollow", "list", "status"]},
            "platform": {"type": "string", "enum": list(PLATFORMS),
                         "description": "find/follow/unfollow：哪个平台（默认 weibo）。用户说推特就是 x，ins 就是 instagram"},
            "name": {"type": "string", "description": "find：搜索的名字，例如「LongCat」「北京地铁」"},
            "idol": {"type": "string", "description": "follow：这个账号属于谁或什么主题（人名、品牌、话题），例如「LongCat」「北京地铁」"},
            "uid": {"type": "string", "description": "follow/unfollow：find 结果里的 uid"},
            "account_name": {"type": "string", "description": "follow：账号昵称"},
        },
        "required": ["action"],
    },
}

PHOTOS_SCHEMA = {
    "name": "official_photos",
    "description": (
        "读取社媒账号最近 N 天发布的帖子（文字和原图），想知道某个账号最近发了什么、有没有新动态时用它，比搜索引擎更准更新。"
        "默认读已关注的账号；用户临时想看某个没关注的公开账号时，先 official_account find 拿到 uid，再把它放进 accounts 直接读，不用先关注。"
        "用户点名某个平台（X/推特、Instagram、Weverse、B 站、微博）时填 platform，只读那个平台。"
        "账号内容很杂时，用 keywords 过滤出相关的帖子（中文名、英文名等不同叫法都放进去）。"
        "返回 posts（帖子文本+图片 id）和 photos；选好后回复末尾写 `GALLERY: id1,id2,...`。"
        "返回 login_needed 时，把其中的 hint 告诉用户（去 App「+」→「社媒账号」点登录）。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "accounts": {
                "type": "array", "description": "直接读这些账号（不用先关注），uid 来自 official_account find 的结果；填了就不读关注列表",
                "items": {"type": "object", "properties": {
                    "platform": {"type": "string", "enum": list(PLATFORMS)}, "uid": {"type": "string"}, "name": {"type": "string"}},
                    "required": ["platform", "uid"]},
            },
            "platform": {"type": "string", "enum": list(PLATFORMS), "description": "只读这个平台的账号；不填读全部已关注账号"},
            "idol": {"type": "string", "description": "只读 follow 时 idol 填了这个值的账号；不填则读全部"},
            "days": {"type": "integer", "description": "最近多少天（默认 7，最多 30）"},
            "keywords": {"type": "array", "items": {"type": "string"},
                         "description": "帖子文本需包含其中任一词，例如 [\"发布会\", \"launch\"]；不填不过滤"},
        },
    },
}


def _store() -> Path:
    try:
        from hermes_constants import get_hermes_home
        home = Path(get_hermes_home())
    except Exception:
        home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    return home / "official_accounts.json"


def _load() -> list[dict]:
    try:
        accounts = json.loads(_store().read_text("utf-8"))
    except (OSError, ValueError):
        return []
    for a in accounts:
        a.setdefault("platform", "weibo")  # 旧记录只有微博
    return accounts


def _save(accounts: list[dict]) -> None:
    _store().write_text(json.dumps(accounts, ensure_ascii=False, indent=2), "utf-8")


def _platform(value) -> str:
    p = str(value or "weibo").strip().lower()
    p = _ALIASES.get(p, p)
    if p not in PLATFORMS:
        raise ValueError(f"不支持的平台：{value}（可选 {', '.join(PLATFORMS)}）")
    return p


def _task_of(kwargs: dict) -> str | None:
    """这次调用属于 App 的哪个任务：Hermes 把会话 id（App 起的 task-<任务编号>）作为 task_id / session_id 传进来
    （user_task 在这条调用链上一直是空的）。转给沙箱，App 的「浏览器」视图就知道画面属于哪个任务。"""
    for key in ("task_id", "session_id"):
        m = re.match(r"task-(t_[a-z0-9]+)$", str(kwargs.get(key) or ""))
        if m:
            return m.group(1)
    m = re.search(r"任务编号：(t_[a-z0-9]+)", str(kwargs.get("user_task") or ""))
    return m.group(1) if m else None


def _sandbox(path: str, _task: str | None = None, **params) -> dict:
    """沙箱出错时也返回 JSON：{error: login_required | login_in_progress | ..., message}。"""
    import httpx

    resp = httpx.get(f"{SANDBOX}{path}", params=params, timeout=90, headers={"x-cattuan-task": _task} if _task else None)
    try:
        data = resp.json()
    except ValueError:
        resp.raise_for_status()
        raise
    if resp.status_code >= 400 and not isinstance(data, dict):
        resp.raise_for_status()
    return _clean(data)


def _clean(obj):
    """去掉半个 emoji（孤立代理项）。沙箱用 JS 截字符串时可能切出半个字符，Hermes 存库时会 UnicodeEncodeError。"""
    if isinstance(obj, str):
        return obj.encode("utf-8", "ignore").decode("utf-8")
    if isinstance(obj, list):
        return [_clean(v) for v in obj]
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    return obj


def _login_hint(label: str) -> str:
    return f"{label} 还没登录：请在喵团 App「+」→「社媒账号」点「登录 {label}」，在弹出的窗口里自己登录（建议用小号），登好后关掉窗口再叫我。"


def _failure(platform: str, data: dict) -> dict:
    code = data.get("error")
    msg = data.get("message") or str(code)
    if code == "login_required":
        return {"error": "login_required", "login_needed": [{"platform": platform, "hint": msg}],
                "hint": f"把这句话转告用户：{msg}"}
    if code == "login_in_progress":
        return {"error": code, "hint": f"{msg}（告诉用户登录完关掉窗口后再试）"}
    return {"error": f"沙箱请求失败：{msg}"}


def _dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


def official_account(args: dict, **kwargs) -> str:
    action = args.get("action")
    try:
        if action == "status":
            data = _sandbox("/sessions")
            return _dump({"mode": data.get("mode"), "platforms": [
                {"platform": p["id"], "label": p["label"], "logged_in": p["loggedIn"], "needs_login": p["needsLogin"],
                 **({"hint": _login_hint(p["label"])} if p["needsLogin"] and not p["loggedIn"] else {})}
                for p in data.get("platforms", [])]})
        platform = _platform(args.get("platform"))
        if action == "find":
            name = (args.get("name") or "").strip()
            if not name:
                return _dump({"error": "find 需要 name"})
            data = _sandbox(f"/{platform}/search_users", q=name, _task=_task_of(kwargs))
            if data.get("error"):
                return _dump(_failure(platform, data))
            return _dump({"platform": platform, "candidates": data.get("users", [])})
        with _LOCK:
            accounts = _load()
            if action == "list":
                return _dump({"accounts": accounts})
            uid = str(args.get("uid") or "").strip().lstrip("@")
            if not uid:
                return _dump({"error": f"{action} 需要 uid"})
            if action == "follow":
                accounts = [a for a in accounts if not (a["platform"] == platform and a["uid"].lower() == uid.lower())]
                accounts.append({"platform": platform, "uid": uid, "name": args.get("account_name") or uid,
                                 "idol": (args.get("idol") or "").strip()})
                _save(accounts)
                return _dump({"ok": True, "accounts": accounts})
            if action == "unfollow":
                # 没指定平台时按 uid 在所有平台里删
                same_platform = lambda a: not args.get("platform") or a["platform"] == platform  # noqa: E731
                _save([a for a in accounts if not (same_platform(a) and a["uid"].lower() == uid.lower())])
                return _dump({"ok": True})
        return _dump({"error": f"未知 action：{action}"})
    except ValueError as exc:
        return _dump({"error": str(exc)})
    except Exception as exc:
        return _dump({"error": f"沙箱不可用或请求失败：{exc}"})


def official_photos(args: dict, **kwargs) -> str:
    idol = (args.get("idol") or "").strip()
    days = min(30, max(1, int(args.get("days") or 7)))
    keywords = [k.lower() for k in args.get("keywords") or [] if isinstance(k, str) and k.strip()]
    try:
        platform = _platform(args["platform"]) if args.get("platform") else None
    except ValueError as exc:
        return _dump({"error": str(exc)})
    direct = args.get("accounts") or []
    if direct:
        # 临时读：不经过关注列表。
        try:
            accounts = [{"platform": _platform(a.get("platform") or ""), "uid": str(a.get("uid") or "").strip(),
                         "name": a.get("name") or str(a.get("uid") or "")} for a in direct if isinstance(a, dict)]
        except ValueError as exc:
            return _dump({"error": str(exc)})
        accounts = [a for a in accounts if a["uid"]][:6]
        if not accounts:
            return _dump({"error": "accounts 里要有 platform 和 uid（先用 official_account find 拿 uid）"})
    else:
        accounts = [a for a in _load() if not platform or a["platform"] == platform]
        if not accounts:
            where = f" {PLATFORMS[platform]} 上的" if platform else "任何"
            return _dump({"error": f"还没有关注{where}账号：先 official_account find（platform={platform or 'weibo'}）拿到 uid，再 follow，或者把它放进 accounts 直接读"})
        accounts = [a for a in accounts if not idol or a.get("idol") == idol] or accounts

    found, errors, notes, login_needed = [], [], [], {}
    for acc in accounts:
        plat = acc["platform"]
        if plat in login_needed:
            continue
        try:
            data = _sandbox(f"/{plat}/timeline", uid=acc["uid"], days=days, name=acc.get("name") or "", _task=_task_of(kwargs))
        except Exception as exc:
            errors.append(f"{PLATFORMS[plat]} {acc['name']}: {exc}")
            continue
        if data.get("error") == "login_required":
            login_needed[plat] = data.get("message") or _login_hint(PLATFORMS[plat])
            continue
        if data.get("error"):
            errors.append(f"{PLATFORMS[plat]} {acc['name']}: {data.get('message') or data['error']}")
            continue
        if data.get("note"):
            notes.append(data["note"])
        for p in data.get("posts", []):
            if keywords and not any(k in p["text"].lower() for k in keywords):
                continue
            found.append((plat, p))

    # 多个账号 / 平台的帖子按时间合并，最新的优先占满图片名额。
    found.sort(key=lambda x: x[1]["ts"], reverse=True)
    posts, photos, seen = [], [], set()
    for plat, p in found:
        if len(photos) >= _MAX_PHOTOS:
            break
        ids = []
        for img in p["images"]:
            pid = hashlib.sha1(img["large"].encode()).hexdigest()[:8]
            ids.append(pid)
            if pid in seen:
                continue
            seen.add(pid)
            site = f"{PLATFORMS[plat]} · {p['author']}" if plat == "weverse" else f"{PLATFORMS[plat]} @{p['author']}"
            photos.append({"id": pid, "title": p["text"][:50], "site": site,
                           "image": img["large"], "thumb": img["thumb"], "page": p["url"], "at": p["at"]})
        posts.append({"post": p["post_id"], "platform": plat, "account": p["author"], "at": p["at"][:16],
                      "text": p["text"], "photos": ids})

    result = {"days": days, "posts": posts, "photos": photos[:_MAX_PHOTOS]}
    if login_needed:
        result["login_needed"] = [{"platform": k, "hint": v} for k, v in login_needed.items()]
    if errors:
        result["errors"] = errors
    if notes:
        result["notes"] = notes
    if not posts:
        result["hint"] = ("这些平台需要先登录，把 login_needed 里的 hint 转告用户" if login_needed and len(login_needed) == len({a["platform"] for a in accounts})
                          else "这些账号这段时间没有符合条件的帖子，可以放宽 days、去掉 keywords，或改用搜索")
    return _dump(result)


XHS_SEARCH_SCHEMA = {
    "name": "xiaohongshu_search",
    "description": (
        "按关键词搜小红书笔记（需要用户在 App「+」→「社媒账号」登录小红书）。适合：附近美食/店铺/景点/攻略、某个活动或地点的实拍、"
        "经验分享、攻略测评等任何「去小红书搜一下」的事。"
        "问「附近」时，用【用户当前位置】里的街道或区名拼关键词，例如「望京 美食」「朝阳区 咖啡」；只写城市太宽。"
        "返回笔记标题、作者、点赞数、发布时间、链接和封面图 id；挑好后回复末尾写 `GALLERY: id1,id2,...`。"
        "笔记是网友分享，不是官方信息，转述时说清楚。返回 login_needed 时把 hint 原样告诉用户。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "搜索词，例如「望京 美食」「音乐节 上海 返图」"},
            "sort": {"type": "string", "enum": ["general", "latest", "popular"],
                     "description": "general 综合（默认）、latest 最新、popular 最热"},
            "count": {"type": "integer", "description": "返回多少条（默认 12，最多 20）"},
        },
        "required": ["query"],
    },
}


def xiaohongshu_search(args: dict, **kwargs) -> str:
    query = (args.get("query") or "").strip()
    if not query:
        return _dump({"error": "query 不能为空"})
    sort = args.get("sort") if args.get("sort") in ("general", "latest", "popular") else "general"
    count = min(20, max(1, int(args.get("count") or 12)))
    try:
        data = _sandbox("/xiaohongshu/search_notes", q=query, sort=sort, _task=_task_of(kwargs))
    except Exception as exc:
        return _dump({"error": f"沙箱不可用：{exc}"})
    if data.get("error") == "login_required":
        return _dump({"login_needed": {"xiaohongshu": data.get("message") or _login_hint("小红书")}})
    if data.get("error"):
        return _dump({"error": data.get("message") or data["error"]})
    notes, photos = [], []
    for n in (data.get("notes") or [])[:count]:
        ids = []
        for img in n.get("images", [])[:1]:  # 只取封面
            pid = hashlib.sha1(img["large"].encode()).hexdigest()[:8]
            ids.append(pid)
            photos.append({"id": pid, "title": n["text"][:50], "site": f"小红书 @{n['author']}",
                           "image": img["large"], "thumb": img.get("thumb") or img["large"], "page": n["url"], "at": n.get("at")})
        notes.append({"note": n["post_id"], "title": n["text"], "author": n["author"], "likes": n.get("likes"),
                      "at": (n.get("at") or "")[:10], "url": n["url"], "photos": ids})
    result = {"query": query, "sort": sort, "notes": notes, "photos": photos}
    if not notes:
        result["hint"] = "没搜到，换个说法试试（比如换成区名，或去掉太具体的词）"
    return _dump(result)


def register(ctx) -> None:
    ctx.register_tool(name="official_account", toolset="idol", schema=ACCOUNT_SCHEMA, handler=official_account)
    ctx.register_tool(name="official_photos", toolset="idol", schema=PHOTOS_SCHEMA, handler=official_photos)
    ctx.register_tool(name="xiaohongshu_search", toolset="idol", schema=XHS_SEARCH_SCHEMA, handler=xiaohongshu_search)
