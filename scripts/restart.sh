#!/usr/bin/env bash
# 本机用：等喵团空闲（所有人都没有进行中、排队中的后台任务）再重启指定服务，避免打断正在跑的任务。线上用 systemctl restart。
# 用法：scripts/restart.sh app|sandbox|all   [最长等待秒数，默认 600]
#   app 包括主 agent 和子 agent：重启时没跑完的任务会在重启后接着做
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${CATTUAN_DATA_DIR:-$ROOT/app/data}"
PORT="${PORT:-3210}"
WHAT="${1:-all}"
MAX_WAIT="${2:-600}"

busy() {
  local tasks
  tasks=$(node --input-type=module - "$PORT" <<'JS'
const url = `http://127.0.0.1:${process.argv[2]}/api/health`;
try {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const d = await r.json();
  if (!r.ok || !Number.isInteger(d.running) || !Number.isInteger(d.queued)) throw new Error('invalid health');
  console.log(d.running + d.queued);
} catch (error) {
  if (error.cause?.code === 'ECONNREFUSED') console.log(0);
  else { console.error('无法确认任务状态，未重启'); process.exit(1); }
}
JS
) || return 2
  echo "tasks=$tasks"
  [ "$tasks" != "0" ]
}

waited=0
while status=$(busy); do
  [ "$waited" -ge "$MAX_WAIT" ] && { echo "等了 ${MAX_WAIT}s 还在忙（${status}），这次不重启"; exit 1; }
  [ $((waited % 30)) -eq 0 ] && echo "忙（${status}），等空闲再重启…"
  sleep 5; waited=$((waited + 5))
done
if [ "${status:-}" = "" ]; then echo "无法确认任务状态，未重启" >&2; exit 1; fi

up() { for _ in $(seq 1 60); do lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
launch() { node "$ROOT/scripts/launch-service.mjs" "$ROOT" "$@"; }

if [ "$WHAT" = sandbox ] || [ "$WHAT" = all ]; then
  pkill -f "node .*sandbox/server.mjs" || true; sleep 1
  launch "$ROOT/sandbox/server.out" "$ROOT/scripts/start-sandbox.sh"
  up 8660 && echo "sandbox 已重启"
fi
if [ "$WHAT" = app ] || [ "$WHAT" = all ]; then
  pkill -f "node .*app/server.mjs" || true
  for _ in $(seq 1 30); do pgrep -f "node .*app/server.mjs" >/dev/null || break; sleep 1; done # 等它把状态写完
  launch "$DATA/server.out" "$ROOT/scripts/start-app.sh"
  up "$PORT" && echo "app 已重启"
fi
