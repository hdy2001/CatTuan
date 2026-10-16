#!/usr/bin/env bash
# 一键启动：沙箱浏览器（:8660）+ Hermes agent（:8650）+ 喵团 App（:3210）。Ctrl+C 一起停。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

"$ROOT/scripts/start-sandbox.sh" > "$ROOT/sandbox/server.out" 2>&1 &
SANDBOX_PID=$!
"$ROOT/scripts/start-agent.sh" > "$ROOT/hermes-home/gateway.out" 2>&1 &
AGENT_PID=$!
trap 'kill $AGENT_PID $SANDBOX_PID 2>/dev/null' EXIT

for _ in $(seq 1 60); do
  lsof -nP -iTCP:8650 -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 1
done
lsof -nP -iTCP:8650 -sTCP:LISTEN >/dev/null 2>&1 || { echo "agent 没起来，看 hermes-home/gateway.out"; exit 1; }

"$ROOT/scripts/start-app.sh"
