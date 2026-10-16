#!/usr/bin/env bash
# 启动喵团 App（:3210）。如果 ~/.hermes/.env 里配了 HTTP(S)_PROXY，图片代理会走它（取 twimg 等被墙图床）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$HOME/.hermes/.env" ] && [ -z "${HTTPS_PROXY:-}" ]; then
  while IFS='=' read -r k v; do
    v="${v%\"}"; v="${v#\"}"
    export "$k=$v"
  done < <(grep -E '^(HTTP_PROXY|HTTPS_PROXY)=' "$HOME/.hermes/.env")
fi
if [ -n "${HTTPS_PROXY:-}${HTTP_PROXY:-}" ]; then
  export NODE_USE_ENV_PROXY=1
  export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}"
fi

exec node "$ROOT/app/server.mjs"
