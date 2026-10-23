#!/usr/bin/env bash
# 启动单个账号的 Pi 执行服务，数据和配置在该账号的 agent-home。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CATTUAN_HOME="${1:-$ROOT/agent-home}"
export PI_HOME="$CATTUAN_HOME"
export NODE_USE_ENV_PROXY=1
export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}"
node --input-type=module - "$ROOT" "$CATTUAN_HOME" <<'JS'
const { pathToFileURL } = await import('node:url');
const { ensureAgentEnv } = await import(pathToFileURL(`${process.argv[2]}/app/homes.mjs`));
ensureAgentEnv(process.argv[3], Number(process.env.API_SERVER_PORT || 8650));
JS
exec node "$ROOT/app/pi-gateway.mjs"
