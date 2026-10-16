"""按需装技能：执行 agent 遇到现有工具和技能做不好的事时，自己找技能、自己装，用户不用设置。

- skill_store：search 在两处找技能——本地还没打开的 Hermes 内置技能、在线技能库（skills.sh 等，经 `hermes skills search`）；
  install 打开本地技能，或用 `hermes skills install --yes` 装在线技能（Hermes 自带安全扫描，扫描不过的装不上，不用 --force）。
  每次安装记到 $HERMES_HOME/skills/.cattuan_installs.json，App 的「技能」面板据此显示「什么时候、为什么装的」。
- fetch_url：只读地 GET 公开网页 / JSON 接口（很多技能要靠它，比如天气、汇率）。拦截内网地址，限大小。
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
SKILLS = HOME / "skills"
LOG = SKILLS / ".cattuan_installs.json"
HERMES_BIN = str(Path(sys.executable).with_name("hermes"))
# 需要这些的技能在这里用不了（执行 agent 没有终端 / 文件 / 浏览器工具）。
NEEDS_TERMINAL = re.compile(r"```(?:bash|sh|shell|zsh|console)|\b(?:brew|pip|npm|apt|curl|wget|python3?)\s+[\w-]", re.I)

STORE_SCHEMA = {
    "name": "skill_store",
    "description": (
        "按需找技能、装技能（用户不用自己设置）。遇到现有工具和已开技能做不好的事（查天气、汇率、做旅行/打卡攻略、某种写作格式……）时："
        "action=search 用中文或英文关键词找（本地内置技能 + 在线技能库，返回名字、说明、来源、安装量、是否需要终端）；"
        "action=install 安装一个（identifier 用 search 结果里的），返回技能全文，装完直接照着做；action=list 看已经按需装过的。"
        "只装和当前任务直接相关的；你没有终端和文件工具，needs_terminal=true 的技能装了也用不了，别装。"
        "能读公开网页 / JSON 接口的技能可以装，读网页用 fetch_url。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["search", "install", "list"]},
            "query": {"type": "string", "description": "search：关键词，例如「天气」「weather」「旅行攻略」"},
            "identifier": {"type": "string", "description": "install：search 结果里的 identifier"},
            "reason": {"type": "string", "description": "install：一句话说明为什么装（会显示给用户看）"},
        },
        "required": ["action"],
    },
}

FETCH_SCHEMA = {
    "name": "fetch_url",
    "description": (
        "只读地打开一个公开网址（GET），返回正文文本或 JSON（最多约 1.2 万字）。给技能用：查天气（wttr.in?format=j2）、汇率、公开 API、文章正文。"
        "不能访问内网地址，不能提交表单或登录。社媒平台请用 official_photos / xiaohongshu_search，不要用它抓。"
    ),
    "parameters": {
        "type": "object",
        "properties": {"url": {"type": "string", "description": "http(s) 网址"}},
        "required": ["url"],
    },
}


def _dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


def _load_log() -> list[dict]:
    try:
        return json.loads(LOG.read_text("utf-8"))
    except (OSError, ValueError):
        return []


def _save_log(entries: list[dict]) -> None:
    tmp = LOG.with_suffix(".tmp")
    tmp.write_text(json.dumps(entries, ensure_ascii=False, indent=2), "utf-8")
    os.replace(tmp, LOG)


def _skill_files() -> dict[str, Path]:
    """name → SKILL.md（跳过点开头的目录）。"""
    from agent.skill_utils import parse_frontmatter
    out = {}
    for md in SKILLS.rglob("SKILL.md"):
        if any(p.startswith(".") for p in md.relative_to(SKILLS).parts):
            continue
        try:
            fm = parse_frontmatter(md.read_text(errors="ignore"))[0] or {}
        except Exception:
            fm = {}
        out[str(fm.get("name") or md.parent.name)] = md
    return out


def _disabled() -> set[str]:
    from hermes_cli.config import load_config
    from hermes_cli.skills_config import get_disabled_skills
    return get_disabled_skills(load_config())


def _hub_env() -> dict:
    env = dict(os.environ, HERMES_HOME=str(HOME))
    # 在线技能多半在 GitHub 上，国内直连常超时：沿用 ~/.hermes/.env 里的代理（有的话）。
    try:
        for line in (Path.home() / ".hermes/.env").read_text().splitlines():
            k, _, v = line.partition("=")
            if k in ("HTTPS_PROXY", "HTTP_PROXY") and v and k not in env:
                env[k] = v.strip().strip('"')
    except OSError:
        pass
    return env


def _search(query: str) -> list[dict]:
    from agent.skill_utils import parse_frontmatter
    words = [w for w in re.split(r"[\s,，、]+", query.lower()) if w]
    results = []
    # 本地：还没打开的内置技能
    disabled = _disabled()
    for name, md in _skill_files().items():
        if name not in disabled:
            continue
        text = md.read_text(errors="ignore")
        desc = str((parse_frontmatter(text)[0] or {}).get("description") or "")
        hay = f"{name} {desc}".lower()
        score = sum(hay.count(w) for w in words)
        if score:
            results.append({"identifier": f"local/{name}", "name": name, "description": desc[:160], "source": "本地内置",
                            "needs_terminal": bool(NEEDS_TERMINAL.search(text)), "_score": score + 100})
    # 在线技能库
    try:
        out = subprocess.run([HERMES_BIN, "skills", "search", query, "--limit", "8", "--json"], capture_output=True,
                             text=True, timeout=45, env=_hub_env())
        raw = out.stdout[out.stdout.find("["):] if "[" in out.stdout else "[]"
        for it in json.loads(raw)[:8]:
            m = re.search(r"([\d,]+) installs", it.get("description") or "")
            results.append({"identifier": it.get("identifier"), "name": it.get("name"), "description": (it.get("description") or "")[:160],
                            "source": it.get("source") or "在线", "installs": int(m.group(1).replace(",", "")) if m else None,
                            "needs_terminal": None, "_score": int(m.group(1).replace(",", "")) / 1000 if m else 0})
    except Exception as exc:
        results.append({"note": f"在线技能库暂时搜不了：{exc}"})
    results.sort(key=lambda r: -(r.get("_score") or 0))
    for r in results:
        r.pop("_score", None)
    return results[:10]


def _log_install(names: list[str], identifier: str, source: str, reason: str) -> None:
    log = [e for e in _load_log() if e.get("name") not in names]
    for n in names:
        log.append({"name": n, "identifier": identifier, "source": source, "reason": reason[:120],
                    "at": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
    _save_log(log)


def _install(identifier: str, reason: str) -> dict:
    if identifier.startswith("local/"):
        from hermes_cli.config import load_config
        from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills
        name = identifier[len("local/"):]
        md = _skill_files().get(name)
        if not md:
            return {"error": f"本地没有这个技能：{name}"}
        config = load_config()
        save_disabled_skills(config, get_disabled_skills(config) - {name})
        _log_install([name], identifier, "本地内置", reason)
        return {"ok": True, "installed": [name], "content": md.read_text(errors="ignore")[:12000]}
    before = set(_skill_files())
    out = subprocess.run([HERMES_BIN, "skills", "install", identifier, "--yes"], capture_output=True, text=True,
                         timeout=180, env=_hub_env())
    added = sorted(set(_skill_files()) - before)
    if out.returncode != 0 or not added:
        tail = (out.stdout + out.stderr).strip().splitlines()[-6:]
        return {"error": "没装上（可能没通过安全扫描或下载失败）", "detail": "\n".join(tail)[:600]}
    _log_install(added, identifier, "在线技能库", reason)
    files = _skill_files()
    content = files[added[0]].read_text(errors="ignore")
    return {"ok": True, "installed": added, "needs_terminal": bool(NEEDS_TERMINAL.search(content)), "content": content[:12000]}


def skill_store(args: dict, **kwargs) -> str:
    action = args.get("action")
    try:
        if action == "search":
            q = (args.get("query") or "").strip()
            return _dump({"results": _search(q)}) if q else _dump({"error": "search 需要 query"})
        if action == "install":
            ident = (args.get("identifier") or "").strip()
            if not ident:
                return _dump({"error": "install 需要 identifier（来自 search 结果）"})
            return _dump(_install(ident, (args.get("reason") or "").strip() or "完成任务需要"))
        if action == "list":
            return _dump({"installed": _load_log()})
        return _dump({"error": f"未知 action：{action}"})
    except subprocess.TimeoutExpired:
        return _dump({"error": "技能库超时了，稍后再试"})
    except Exception as exc:
        return _dump({"error": f"技能商店出错：{exc}"})


def _public_host(host: str) -> bool:
    try:
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return False
        return True
    except (socket.gaierror, ValueError):
        return False


def fetch_url(args: dict, **kwargs) -> str:
    import httpx

    url = (args.get("url") or "").strip()
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        return _dump({"error": "只支持 http(s) 网址"})
    if not _public_host(p.hostname):
        return _dump({"error": "不能访问内网或本机地址"})
    try:
        with httpx.Client(timeout=15, follow_redirects=False, headers={"User-Agent": "CatTuan/0.1 (personal assistant)"}) as c:
            r = c.get(url)
            hops = 0
            while r.is_redirect and hops < 3:  # 跟跳转时每一跳都重新检查地址
                nxt = urlparse(str(r.next_request.url))
                if nxt.scheme not in ("http", "https") or not _public_host(nxt.hostname or ""):
                    return _dump({"error": "跳转到了不允许的地址"})
                r = c.send(r.next_request)
                hops += 1
        ctype = r.headers.get("content-type", "")
        if not re.search(r"json|text|xml|javascript", ctype):
            return _dump({"error": f"不是文本内容（{ctype or '未知类型'}）"})
        text = r.text[:200_000]
        if "html" in ctype:
            text = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", text, flags=re.I)
            text = re.sub(r"<[^>]+>", " ", text)
            text = re.sub(r"\s+", " ", text)
        return _dump({"status": r.status_code, "content_type": ctype, "text": text[:12000]})
    except Exception as exc:
        return _dump({"error": f"打不开：{exc}"})


def register(ctx) -> None:
    ctx.register_tool(name="skill_store", toolset="skillstore", schema=STORE_SCHEMA, handler=skill_store)
    ctx.register_tool(name="fetch_url", toolset="skillstore", schema=FETCH_SCHEMA, handler=fetch_url)
