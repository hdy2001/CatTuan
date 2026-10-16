#!/usr/bin/env bash
# 等喵团空闲（没有进行中的后台任务、agent 没有进行中的请求）再重启指定服务，避免打断用户正在跑的任务。
# 用法：scripts/restart.sh app|agent|sandbox|all   [最长等待秒数，默认 600]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WHAT="${1:-all}"
MAX_WAIT="${2:-600}"

busy() {
  local tasks inflight
  tasks=$(curl -s -m 5 http://127.0.0.1:3210/api/state | python3 -c "import json,sys
try: print(sum(t['status'] in ('running','queued') for t in json.load(sys.stdin)['tasks']))
except Exception: print(0)")
  inflight=$(lsof -nP -iTCP:8650 -sTCP:ESTABLISHED 2>/dev/null | grep -c node || true)
  echo "tasks=$tasks agent_inflight=$inflight"
  [ "$tasks" != "0" ] || [ "$inflight" != "0" ]
}

waited=0
while status=$(busy); do
  [ "$waited" -ge "$MAX_WAIT" ] && { echo "等了 ${MAX_WAIT}s 还在忙（$status），这次不重启"; exit 1; }
  [ $((waited % 30)) -eq 0 ] && echo "忙（$status），等空闲再重启…"
  sleep 5; waited=$((waited + 5))
done

up() { for _ in $(seq 1 60); do lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }

if [ "$WHAT" = sandbox ] || [ "$WHAT" = all ]; then
  pkill -f "node .*sandbox/server.mjs" || true; sleep 1
  (nohup "$ROOT/scripts/start-sandbox.sh" > "$ROOT/sandbox/server.out" 2>&1 &); up 8660 && echo "sandbox 已重启"
fi
if [ "$WHAT" = agent ] || [ "$WHAT" = all ]; then
  pkill -f "CatTuan/hermes-agent/.venv/bin/hermes gateway run" || true; sleep 2
  (nohup "$ROOT/scripts/start-agent.sh" > "$ROOT/hermes-home/gateway.out" 2>&1 &); up 8650 && echo "agent 已重启"
  # 端口先开、agent 还没就绪时会返回 503，等它能正常应答
  KEY=$(grep '^API_SERVER_KEY=' "$ROOT/hermes-home/.env" | cut -d= -f2)
  for _ in $(seq 1 30); do curl -s -o /dev/null -w "%{http_code}" -m 3 -H "Authorization: Bearer $KEY" http://127.0.0.1:8650/v1/models | grep -q 200 && break; sleep 1; done
fi
if [ "$WHAT" = app ] || [ "$WHAT" = all ]; then
  pkill -f "node .*app/server.mjs" || true; sleep 1
  (nohup "$ROOT/scripts/start-app.sh" > "$ROOT/app/data/server.out" 2>&1 &); up 3210 && echo "app 已重启"
fi
