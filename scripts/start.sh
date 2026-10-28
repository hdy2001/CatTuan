#!/usr/bin/env bash
# 一键启动：沙箱浏览器（:8660）+ 搜索服务 DDGS（:4479）+ 喵团 App（:3210，主 agent 和子 agent 都在 App 进程里跑）。Ctrl+C 一起停。
# 第一次用先建账号：node scripts/user.mjs add <名字> --admin（从单用户版升级：node scripts/user.mjs adopt <名字>）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${CATTUAN_DATA_DIR:-$ROOT/app/data}"
mkdir -p "$DATA"

"$ROOT/scripts/start-sandbox.sh" > "$ROOT/sandbox/server.out" 2>&1 &
SANDBOX_PID=$!
"$ROOT/scripts/start-search.sh" > "$ROOT/search/server.out" 2>&1 & # 没装 DDGS 也能用：搜索改走沙箱浏览器
SEARCH_PID=$!
trap 'kill $SANDBOX_PID $SEARCH_PID 2>/dev/null' EXIT

"$ROOT/scripts/start-app.sh"
