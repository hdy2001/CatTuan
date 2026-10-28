#!/usr/bin/env bash
# 启动本机搜索服务 DDGS（127.0.0.1:4479，web_search 的默认后端；没起来时 web_search 自动改用沙箱浏览器搜）。
# 同一台机器跑两套（比如 DEV）时设 SEARCH_PORT 换端口，App 那边的 DDGS_URL 跟着改。
# 第一次先装：python3 -m venv search/.venv && search/.venv/bin/pip install -r search/requirements.txt
# 搜索引擎要走代理时设 SEARCH_PROXY；没设时沿用 agent-home/.env 的 HTTPS_PROXY。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DDGS="$ROOT/search/.venv/bin/ddgs"
[ -x "$DDGS" ] || { echo "没装 DDGS：python3 -m venv search/.venv && search/.venv/bin/pip install -r search/requirements.txt" >&2; exit 1; }

if [ -z "${SEARCH_PROXY:-}${HTTPS_PROXY:-}" ] && [ -f "$ROOT/agent-home/.env" ]; then
  while IFS='=' read -r k v; do
    v="${v%\"}"; v="${v#\"}"
    export "$k=$v"
  done < <(grep -E '^(HTTP_PROXY|HTTPS_PROXY)=' "$ROOT/agent-home/.env")
fi
PROXY="${SEARCH_PROXY:-${HTTPS_PROXY:-}}"

exec "$DDGS" api --host 127.0.0.1 --port "${SEARCH_PORT:-4479}" ${PROXY:+--proxy "$PROXY"}
