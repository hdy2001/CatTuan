#!/usr/bin/env bash
# 启动沙箱浏览器服务（:8660）。国外网站在国内要走代理：没设 SANDBOX_PROXY 时沿用 agent-home/.env 的 HTTPS_PROXY；
# 国内站点始终直连。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${SANDBOX_PROXY:-}${HTTPS_PROXY:-}" ] && [ -f "$ROOT/agent-home/.env" ]; then
  while IFS='=' read -r k v; do
    v="${v%\"}"; v="${v#\"}"
    export "$k=$v"
  done < <(grep -E '^(HTTP_PROXY|HTTPS_PROXY)=' "$ROOT/agent-home/.env")
fi

exec node "$ROOT/sandbox/server.mjs"
