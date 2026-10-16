#!/usr/bin/env bash
# 启动沙箱浏览器服务（:8660）。X / Instagram / Weverse 在国内要走代理：没设 SANDBOX_PROXY 时沿用 ~/.hermes/.env 的 HTTPS_PROXY；
# 微博、B 站始终直连。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${SANDBOX_PROXY:-}${HTTPS_PROXY:-}" ] && [ -f "$HOME/.hermes/.env" ]; then
  while IFS='=' read -r k v; do
    v="${v%\"}"; v="${v#\"}"
    export "$k=$v"
  done < <(grep -E '^(HTTP_PROXY|HTTPS_PROXY)=' "$HOME/.hermes/.env")
fi

exec node "$ROOT/sandbox/server.mjs"
