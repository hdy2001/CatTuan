#!/usr/bin/env bash
# 一键启动：沙箱浏览器（:8660）+ 每个账号一个 Hermes agent（scripts/agents.mjs 守护）+ 喵团 App（:3210）。Ctrl+C 一起停。
# 第一次用先建账号：node scripts/user.mjs invite <名字> --admin（从单用户版升级：node scripts/user.mjs adopt <名字>）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${CATTUAN_DATA_DIR:-$ROOT/app/data}"
mkdir -p "$DATA"

"$ROOT/scripts/start-sandbox.sh" > "$ROOT/sandbox/server.out" 2>&1 &
SANDBOX_PID=$!
node "$ROOT/scripts/agents.mjs" > "$DATA/agents.out" 2>&1 &
AGENTS_PID=$!
trap 'kill $AGENTS_PID $SANDBOX_PID 2>/dev/null' EXIT

sleep 2 # 各人的 agent 在后台陆续起来；App 先起，没起好的那几秒派的任务会自动重排队
"$ROOT/scripts/start-app.sh"
