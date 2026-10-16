"""记账：账本在 $HERMES_HOME/ledger/entries.json，记账记忆在 $HERMES_HOME/ledger/LEDGER.md。

App 的记账面板直接读写同一份文件，所以必须守约定：
- entries.json 是 JSON 数组，条目字段见 _normalize；amount 恒为正数，靠 type 区分收支
- 每次写入都先重新读最新内容，写临时文件再 os.replace；替换前再核对一次文件没被 App 改过，改过就重来
- LEDGER.md 固定包含 预算 / 固定收支 / 消费习惯 / 备注 四节，App 只读展示
"""

from __future__ import annotations

import fcntl
import json
import math
import os
import re
import secrets
import threading
import time
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

MEMORY_SECTIONS = ["## 预算", "## 固定收支", "## 消费习惯", "## 备注"]
MEMORY_TEMPLATE = "# 记账记忆\n\n" + "\n\n".join(MEMORY_SECTIONS) + "\n"
_TYPES = ("expense", "income")
_MAX_RESULTS = 100
_LOCK = threading.Lock()

ADD_SCHEMA = {
    "name": "ledger_add",
    "description": (
        "把一笔或多笔收支记进用户的账本（和 App 记账面板是同一份）。用户说「午饭 35」「打车 22」「买书 59」"
        "「今天发工资 8000」这类话时调用；一句话里有几笔就在 entries 里放几条，一次写入。"
        "amount 填正数，用 type 区分支出 expense / 收入 income。"
        "支出分类：餐饮、交通、购物、娱乐、旅行、居住、医疗、学习、人情、其他；收入分类：工资、副业、红包、其他。"
        "date 只在用户说了「昨天」「上周五」这类日期时才填（YYYY-MM-DD），默认今天。"
        "同一笔不要重复记；用户说记错了，先 ledger_delete 再重新记。返回写入的条目（含 id）和今天/本月支出合计。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "entries": {
                "type": "array",
                "description": "要记的收支，每笔一条",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": list(_TYPES), "description": "expense 支出（默认）/ income 收入"},
                        "amount": {"type": "number", "description": "金额，正数，单位元，例如 35.5"},
                        "category": {"type": "string", "description": "分类，例如「餐饮」「交通」「旅行」「工资」"},
                        "note": {"type": "string", "description": "备注，用用户的原话，例如「午饭」「打车回家」"},
                        "date": {"type": "string", "description": "YYYY-MM-DD，不填为今天"},
                    },
                    "required": ["amount", "category"],
                },
            },
        },
        "required": ["entries"],
    },
}

QUERY_SCHEMA = {
    "name": "ledger_query",
    "description": (
        "查账本：按日期范围（默认本月 1 号到今天）和可选的分类、收支类型筛选，返回最多 100 条明细（新的在前）和汇总"
        "（summary：总支出 totalExpense、总收入 totalIncome、按分类合计 byCategory、按天合计 byDay，汇总覆盖全部匹配记录）。"
        "用户问「这个月花了多少」「上周吃饭花了多少」「最近打车花了多少」「今天记了什么」时调用；"
        "回答金额以 summary 为准，不要自己累加明细。要删除或更正某笔记录时，也先用它找到 id。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "from": {"type": "string", "description": "开始日期 YYYY-MM-DD（含），默认本月 1 号"},
            "to": {"type": "string", "description": "结束日期 YYYY-MM-DD（含），默认今天"},
            "category": {"type": "string", "description": "只看这个分类，例如「餐饮」；不填看全部"},
            "type": {"type": "string", "enum": list(_TYPES), "description": "只看支出 expense 或收入 income；不填两种都看"},
        },
    },
}

DELETE_SCHEMA = {
    "name": "ledger_delete",
    "description": (
        "按 id 删除账本里的记录。用户说「刚才那笔记错了」「把打车那笔删掉」时调用：id 来自 ledger_add 的返回或先用 ledger_query 查到。"
        "改金额或分类 = 删掉旧的再 ledger_add 一条新的。只删用户明确要删的那几笔。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "ids": {"type": "array", "items": {"type": "string"}, "description": "要删除的记录 id，例如 [\"l_mgr3k2xa1b2c3d\"]"},
        },
        "required": ["ids"],
    },
}

MEMORY_SCHEMA = {
    "name": "ledger_memory",
    "description": (
        "读写记账记忆 LEDGER.md（用户的预算、固定收支、消费习惯、备注；App 会展示给用户看）。"
        "action=read 读取全文；action=update 传完整的新 Markdown 整份替换，必须保留「## 预算」「## 固定收支」「## 消费习惯」「## 备注」四个标题。"
        "用户设定或调整预算、提到固定支出或收入（房租、工资日、会员订阅）、你从账本里看出稳定的消费习惯时，先 read 再 update；"
        "做月度总结、提醒预算或分析消费前，先 read。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["read", "update"]},
            "content": {"type": "string", "description": "update：完整的新 LEDGER.md 内容（Markdown）"},
        },
        "required": ["action"],
    },
}


def _dir() -> Path:
    try:
        from hermes_constants import get_hermes_home
        home = Path(get_hermes_home())
    except Exception:
        home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    path = home / "ledger"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


@contextmanager
def _locked():
    """进程内线程锁 + 跨进程文件锁。App 不拿这把锁，靠写前核对兜底。"""
    with _LOCK, open(_dir() / ".lock", "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _read_raw(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def _load(path: Path) -> tuple[bytes | None, list]:
    """读账本。解析失败时稍等重试几次；一直坏就报错，绝不拿空数组覆盖。"""
    for attempt in range(5):
        raw = _read_raw(path)
        try:
            data = json.loads(raw.decode("utf-8")) if raw and raw.strip() else []
            if not isinstance(data, list):
                raise ValueError("entries.json 顶层不是数组")
            return raw, data
        except ValueError:
            if attempt == 4:
                raise ValueError(f"账本文件 {path} 不是合法的 JSON 数组，没有改动它")
            time.sleep(0.05)


def _update_entries(mutate):
    """读最新账本 → mutate(entries) 原地修改 → 原子写回；写回前发现文件被别人改过就重新读、重新 mutate。"""
    path = _dir() / "entries.json"
    with _locked():
        for _ in range(20):
            raw, entries = _load(path)
            before = json.dumps(entries, ensure_ascii=False)
            result = mutate(entries)
            if json.dumps(entries, ensure_ascii=False) == before:
                return result
            text = json.dumps(entries, ensure_ascii=False, indent=2) + "\n"
            if _read_raw(path) != raw:
                continue
            _write_atomic(path, text)
            return result
    raise RuntimeError("账本正在被频繁改写，稍后再试")


def _today() -> str:
    return date.today().isoformat()


def _now_iso() -> str:
    # 与 JS 的 new Date().toISOString() 同格式
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _base36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out or "0"


def _new_id() -> str:
    return f"l_{_base36(int(time.time() * 1000))}{secrets.token_hex(3)}"


def _round(x: float):
    x = round(x + 0.0, 2)
    return int(x) if x == int(x) else x


def _num(value) -> float:
    try:
        x = float(value)
    except (TypeError, ValueError):
        return 0.0
    return x if math.isfinite(x) else 0.0


def _amount(value):
    if isinstance(value, bool):
        raise ValueError("amount 必须是数字")
    if isinstance(value, str):
        value = re.sub(r"[¥￥元块,，\s]", "", value)
    try:
        x = abs(float(value))
    except (TypeError, ValueError):
        raise ValueError(f"amount 不是数字：{value!r}") from None
    if not math.isfinite(x) or round(x, 2) <= 0:
        raise ValueError(f"amount 必须大于 0：{value!r}")
    return _round(x)


def _date(value, default: str) -> str:
    text = str(value or "").strip()
    if not text:
        return default
    relative = {"今天": 0, "today": 0, "昨天": 1, "yesterday": 1, "前天": 2}
    if text.lower() in relative:
        return (date.today() - timedelta(days=relative[text.lower()])).isoformat()
    m = re.fullmatch(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", text)
    try:
        if not m:
            raise ValueError
        return date(int(m[1]), int(m[2]), int(m[3])).isoformat()
    except ValueError:
        raise ValueError(f"date 要用 YYYY-MM-DD 格式：{text!r}") from None


def _normalize(item, today: str, now: str) -> dict:
    if not isinstance(item, dict):
        raise ValueError("每笔记录必须是对象")
    typ = str(item.get("type") or "expense").strip().lower()
    if typ not in _TYPES:
        raise ValueError(f"type 只能是 expense 或 income：{typ!r}")
    return {
        "id": _new_id(),
        "type": typ,
        "amount": _amount(item.get("amount")),
        "category": str(item.get("category") or "").strip() or "其他",
        "note": str(item.get("note") or "").strip(),
        "date": _date(item.get("date"), today),
        "createdAt": now,
        "source": "agent",
    }


def _summarize(entries: list[dict]) -> dict:
    totals = {"expense": 0.0, "income": 0.0}
    by_cat: dict[str, dict[str, float]] = {"expense": {}, "income": {}}
    by_day: dict[str, dict[str, float]] = {}
    for e in entries:
        typ, amt = e.get("type"), _num(e.get("amount"))
        if typ not in totals:
            continue
        totals[typ] += amt
        cat = e.get("category") or "其他"
        by_cat[typ][cat] = by_cat[typ].get(cat, 0.0) + amt
        day = by_day.setdefault(str(e.get("date")), {"expense": 0.0, "income": 0.0})
        day[typ] += amt
    return {
        "totalExpense": _round(totals["expense"]),
        "totalIncome": _round(totals["income"]),
        "net": _round(totals["income"] - totals["expense"]),
        "byCategory": {t: {k: _round(v) for k, v in sorted(d.items(), key=lambda kv: -kv[1])}
                       for t, d in by_cat.items()},
        "byDay": {d: {k: _round(v) for k, v in sums.items()} for d, sums in sorted(by_day.items())},
    }


def _expense_between(entries: list, start: str, end: str) -> float:
    return _round(sum(_num(e.get("amount")) for e in entries
                      if isinstance(e, dict) and e.get("type") == "expense" and start <= str(e.get("date", "")) <= end))


def ledger_add(args: dict, **kwargs) -> str:
    try:
        items = args.get("entries")
        if isinstance(items, dict):
            items = [items]
        if not isinstance(items, list) or not items:
            return _dump({"error": "entries 需要是非空数组，例如 [{\"amount\": 35, \"category\": \"餐饮\", \"note\": \"午饭\"}]"})
        today, now = _today(), _now_iso()
        added, errors = [], []
        for i, item in enumerate(items, 1):
            try:
                added.append(_normalize(item, today, now))
            except ValueError as exc:
                errors.append(f"第 {i} 笔：{exc}")
        if errors:
            return _dump({"error": "有记录不合法，这一批都没有写入，改好后整批重新调用", "details": errors})

        def mutate(entries):
            entries.extend(added)
            return {"todayExpense": _expense_between(entries, today, today),
                    "monthExpense": _expense_between(entries, today[:8] + "01", today)}

        totals = _update_entries(mutate)
        return _dump({"ok": True, "added": added, "today": today, **totals})
    except Exception as exc:
        return _dump({"error": f"记账失败：{exc}"})


def ledger_query(args: dict, **kwargs) -> str:
    try:
        today = _today()
        start = _date(args.get("from"), today[:8] + "01")
        end = _date(args.get("to"), today)
        if start > end:
            start, end = end, start
        category = str(args.get("category") or "").strip()
        typ = str(args.get("type") or "").strip().lower()
        if typ and typ not in _TYPES:
            return _dump({"error": f"type 只能是 expense 或 income：{typ!r}"})
        _, entries = _load(_dir() / "entries.json")
        matched = [e for e in entries if isinstance(e, dict)
                   and start <= str(e.get("date", "")) <= end
                   and (not category or e.get("category") == category)
                   and (not typ or e.get("type") == typ)]
        matched.sort(key=lambda e: (str(e.get("date", "")), str(e.get("createdAt", ""))), reverse=True)
        return _dump({
            "from": start, "to": end, "today": today,
            "filters": {k: v for k, v in (("category", category), ("type", typ)) if v},
            "count": len(matched),
            "entries": matched[:_MAX_RESULTS],
            "truncated": len(matched) > _MAX_RESULTS,
            "summary": _summarize(matched),
        })
    except Exception as exc:
        return _dump({"error": f"查账失败：{exc}"})


def ledger_delete(args: dict, **kwargs) -> str:
    try:
        ids = args.get("ids") or args.get("id") or []
        if isinstance(ids, str):
            ids = [ids]
        wanted = {str(i).strip() for i in ids if str(i).strip()}
        if not wanted:
            return _dump({"error": "需要 ids：要删除的记录 id 数组"})

        def mutate(entries):
            removed = [e for e in entries if isinstance(e, dict) and e.get("id") in wanted]
            entries[:] = [e for e in entries if not (isinstance(e, dict) and e.get("id") in wanted)]
            return removed

        removed = _update_entries(mutate)
        found = {e["id"] for e in removed}
        result = {"ok": True, "deleted": removed}
        if wanted - found:
            result["notFound"] = sorted(wanted - found)
        return _dump(result)
    except Exception as exc:
        return _dump({"error": f"删除失败：{exc}"})


def ledger_memory(args: dict, **kwargs) -> str:
    try:
        action = str(args.get("action") or "read").strip()
        path = _dir() / "LEDGER.md"
        with _locked():
            if action == "read":
                if not path.exists():
                    _write_atomic(path, MEMORY_TEMPLATE)
                return _dump({"content": path.read_text("utf-8")})
            if action == "update":
                content = args.get("content")
                if not isinstance(content, str) or not content.strip():
                    return _dump({"error": "update 需要 content：完整的新 LEDGER.md 内容"})
                content = content.strip() + "\n"
                missing = [s for s in MEMORY_SECTIONS if not re.search(rf"^{re.escape(s)}[ \t]*$", content, re.M)]
                content += "".join(f"\n{s}\n" for s in missing)
                _write_atomic(path, content)
                result = {"ok": True, "content": content}
                if missing:
                    result["addedSections"] = missing
                return _dump(result)
        return _dump({"error": f"未知 action：{action}（只支持 read / update）"})
    except Exception as exc:
        return _dump({"error": f"记账记忆读写失败：{exc}"})


def register(ctx) -> None:
    ctx.register_tool(name="ledger_add", toolset="ledger", schema=ADD_SCHEMA, handler=ledger_add)
    ctx.register_tool(name="ledger_query", toolset="ledger", schema=QUERY_SCHEMA, handler=ledger_query)
    ctx.register_tool(name="ledger_delete", toolset="ledger", schema=DELETE_SCHEMA, handler=ledger_delete)
    ctx.register_tool(name="ledger_memory", toolset="ledger", schema=MEMORY_SCHEMA, handler=ledger_memory)
