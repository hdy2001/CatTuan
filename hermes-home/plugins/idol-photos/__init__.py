"""idol_photo_search（名字沿用旧版）：用必应图片搜索按关键词找最近 N 天的公开图片。

每张图带一个由原图 URL 算出的稳定 id；agent 回复里用 `GALLERY: id1,id2,...` 选图，
App 从同一轮的工具输出里把 id 还原成图片，不需要模型抄写长 URL。
"""

from __future__ import annotations

import hashlib
import html
import json
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode, urlparse

SCHEMA = {
    "name": "idol_photo_search",
    "description": (
        "按关键词搜网上的公开图片（人物、地点、商品、作品、活动现场等），可以按时间过滤只要最近的图。"
        "一次调用传多个关键词会并行搜索并合并去重，所以把同一样东西的几种叫法（中文名、外文名）放进同一次调用的 queries 里。"
        "关键词用名称本身效果最好；需要特定内容时再加一个具体词（地点、活动名、型号），不要加「高清」「图片」这类泛词。"
        "返回每张图的 id、标题、来源站点。选好后在回复末尾单独一行写 `GALLERY: id1,id2,...`（按展示顺序），App 会渲染成图墙。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "queries": {
                "type": "array", "items": {"type": "string"}, "maxItems": 4,
                "description": "1–4 个关键词，例如 [\"故宫 雪景\", \"Forbidden City snow\"]",
            },
            "days": {"type": "integer", "description": "只要最近多少天的图：1、7、30（默认 7；结果太少会自动放宽到 30）"},
            "offset": {"type": "integer", "description": "翻页偏移，用户说「再来一些」时传 10、20…"},
        },
        "required": ["queries"],
    },
}

_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
_ITEM_RE = re.compile(r'class="iusc"[^>]*?\sm="([^"]+)"')
# 电商 / 二手 / 周边商店基本都是商品图，不是美图；booru 类图库常混有不适宜内容，一并排除。
_SHOP_HOSTS = ("taobao.", "tmall.", "jd.com", "pinduoduo.", "yangkeduo.", "goofish.", "xianyu", "bunjang.",
               "mercari", "amazon.", "ebay.", "aliexpress.", "rakuten.", "coupang.", "shopee.", "temu.", "1688.com",
               "suruga-ya", "auctions.yahoo", "joom.", "etsy.", "nin-nin-game.", "play-asia.", "amiami.", "hlj.com",
               "solarisjapan.", "mandarake.", "goodsmile.", "tokyootakumode.", "booth.pm",
               "danbooru.", "gelbooru.", "safebooru.", "yande.re", "konachan.", "rule34", "e621.", "sankakucomplex.")
_PER_QUERY = 10
_MAX_TOTAL = 30


def photo_id(url: str) -> str:
    return hashlib.sha1(url.encode()).hexdigest()[:8]


def _is_shop(url: str) -> bool:
    return any(h in url for h in _SHOP_HOSTS)


def search(query: str, days: int, offset: int = 0) -> list[dict]:
    import httpx

    params = {"q": query, "first": max(0, offset) + 1, "count": 35, "mmasync": 1, "adlt": "strict",
              "qft": f"+filterui:age-lt{max(1, days) * 1440}"}
    resp = httpx.get(f"https://www.bing.com/images/async?{urlencode(params)}", timeout=20, follow_redirects=True,
                     headers={"User-Agent": _UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6"})
    resp.raise_for_status()
    out = []
    for raw in _ITEM_RE.findall(resp.text):
        try:
            m = json.loads(html.unescape(raw))
        except ValueError:
            continue
        image, thumb, page = m.get("murl"), m.get("turl"), m.get("purl") or ""
        if not image or not thumb or "explicit" in thumb or _is_shop(page) or _is_shop(image):
            continue
        out.append({
            "id": photo_id(image), "q": query,
            "title": html.unescape(m.get("t") or "").strip()[:80],
            "site": urlparse(page or image).hostname or "",
            "image": image, "thumb": thumb, "page": page,
        })
        if len(out) >= _PER_QUERY:
            break
    return out


def _search_all(queries: list[str], days: int, offset: int) -> list[dict]:
    with ThreadPoolExecutor(max_workers=len(queries)) as pool:
        batches = list(pool.map(lambda q: search(q, days, offset), queries))
    merged, seen = [], set()
    # 各关键词轮流取，避免一个关键词占满。
    for i in range(_PER_QUERY):
        for batch in batches:
            if i < len(batch) and batch[i]["id"] not in seen:
                seen.add(batch[i]["id"])
                merged.append(batch[i])
    return merged[:_MAX_TOTAL]


def idol_photo_search(args: dict, **kwargs) -> str:
    queries = args.get("queries") or ([args["query"]] if args.get("query") else [])
    queries = [q.strip() for q in queries if isinstance(q, str) and q.strip()][:4]
    if not queries:
        return json.dumps({"error": "queries is required"}, ensure_ascii=False)
    days, offset = int(args.get("days") or 7), int(args.get("offset") or 0)
    try:
        photos = _search_all(queries, days, offset)
        if len(photos) < 6 * len(queries) and days < 30:  # 新图太少就自动放宽到 30 天
            days = 30
            photos = _search_all(queries, days, offset)
    except Exception as exc:
        return json.dumps({"error": f"搜索失败：{exc}"}, ensure_ascii=False)
    if not photos:
        return json.dumps({"queries": queries, "photos": [], "hint": "没有结果，换个更短的关键词（比如只用名字）"},
                          ensure_ascii=False)
    return json.dumps({"queries": queries, "days": days, "photos": photos}, ensure_ascii=False)


def register(ctx) -> None:
    ctx.register_tool(name="idol_photo_search", toolset="idol", schema=SCHEMA, handler=idol_photo_search)
