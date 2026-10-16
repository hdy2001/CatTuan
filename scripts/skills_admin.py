"""喵团「技能」面板的后端助手：用 Hermes 自己的函数读写技能启停，避免从 Node 手改 config.yaml。

用法（app/server.mjs 调用，HERMES_HOME 指向 hermes-home/，用 hermes-agent/.venv 的 python 跑）：
  skills_admin.py list                 → 所有技能（来源 / 启停 / 最近使用）
  skills_admin.py show <name>          → SKILL.md 全文
  skills_admin.py set <name> on|off    → 启用 / 停用（写 config.yaml 的 skills.disabled，Hermes 每次调用都会重读）
  skills_admin.py delete <name>        → 删除（只允许删非内置技能）
输出都是一行 JSON。
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

# 复用 hermes-agent 里的模块（agent.* / hermes_cli.*）。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hermes-agent"))
from agent.skill_utils import parse_frontmatter  # noqa: E402

HOME = Path(os.environ["HERMES_HOME"])
SKILLS = HOME / "skills"


def _bundled() -> set[str]:
    try:
        return {ln.split(":", 1)[0].strip() for ln in (SKILLS / ".bundled_manifest").read_text().splitlines() if ln.strip()}
    except OSError:
        return set()


def _usage() -> dict:
    try:
        return json.loads((SKILLS / ".usage.json").read_text())
    except (OSError, ValueError):
        return {}


def _frontmatter(text: str) -> dict:
    try:
        return parse_frontmatter(text)[0] or {}
    except Exception:
        return {}


def _installs() -> dict:
    try:
        return {e["name"]: e for e in json.loads((SKILLS / ".cattuan_installs.json").read_text())}
    except (OSError, ValueError, KeyError):
        return {}


def _scan() -> dict[str, dict]:
    from agent.skill_utils import ESSENTIAL_SKILLS
    from hermes_cli.config import load_config
    from hermes_cli.skills_config import get_disabled_skills

    disabled = get_disabled_skills(load_config())
    bundled, usage, installs = _bundled(), _usage(), _installs()
    out = {}
    for md in sorted(SKILLS.rglob("SKILL.md")):
        rel = md.relative_to(SKILLS)
        if any(p.startswith(".") for p in rel.parts):
            continue
        fm = _frontmatter(md.read_text(errors="ignore"))
        name = str(fm.get("name") or md.parent.name)
        category = rel.parts[0] if len(rel.parts) > 2 else ""
        u = usage.get(name) or {}
        if name in installs:
            origin = "store"  # 执行 agent 按需装的（本地内置或在线技能库）
        elif name in bundled:
            origin = "bundled"
        elif category == "cattuan":
            origin = "cattuan"
        elif u.get("created_by") == "agent" or u.get("agent_created") is True:
            origin = "agent"  # 执行 agent 用 skill_manage 自己写的（Hermes 在 .usage.json 里标 created_by: agent）
        else:
            origin = "user"
        out[name] = {
            "name": name, "description": str(fm.get("description") or "")[:160], "category": category,
            "origin": origin, "enabled": name not in disabled, "essential": name in ESSENTIAL_SKILLS,
            "lastUsedAt": u.get("last_used_at"), "createdAt": u.get("created_at"), "dir": str(md.parent),
            "installReason": (installs.get(name) or {}).get("reason"), "installedAt": (installs.get(name) or {}).get("at"),
            "installSource": (installs.get(name) or {}).get("source"),
        }
    return out


def main() -> None:
    cmd, *args = sys.argv[1:] or ["list"]
    skills = _scan()
    if cmd == "list":
        print(json.dumps({"skills": [{k: v for k, v in s.items() if k != "dir"} for s in skills.values()]}, ensure_ascii=False))
        return
    name = args[0] if args else ""
    skill = skills.get(name)
    if not skill:
        print(json.dumps({"error": f"没有这个技能：{name}"}, ensure_ascii=False))
        return
    if cmd == "show":
        print(json.dumps({**skill, "content": (Path(skill["dir"]) / "SKILL.md").read_text(errors="ignore")[:20000]}, ensure_ascii=False))
    elif cmd == "set":
        from hermes_cli.config import load_config
        from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills
        if skill["essential"]:
            print(json.dumps({"error": "这是 Hermes 必需的技能，不能停用"}, ensure_ascii=False))
            return
        config = load_config()
        disabled = get_disabled_skills(config)
        disabled.discard(name) if args[1:] == ["on"] else disabled.add(name)
        save_disabled_skills(config, disabled)
        print(json.dumps({"ok": True, "name": name, "enabled": args[1:] == ["on"]}, ensure_ascii=False))
    elif cmd == "delete":
        if skill["origin"] == "bundled" or skill["essential"]:
            print(json.dumps({"error": "内置技能不能删，可以停用"}, ensure_ascii=False))
            return
        shutil.rmtree(skill["dir"])
        print(json.dumps({"ok": True, "name": name}, ensure_ascii=False))
    else:
        print(json.dumps({"error": f"未知命令：{cmd}"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
