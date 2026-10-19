#!/usr/bin/env bash
# 启动一个 CatTuan 专用的 Hermes gateway（OpenAI 兼容 API server）。
#   scripts/start-agent.sh                 仓库的 hermes-home（沿用单用户版数据的管理员，默认 127.0.0.1:8650）
#   scripts/start-agent.sh <HERMES_HOME>   某个账号的主目录（scripts/agents.mjs 给每个账号这样起一个，端口和 key 在它的 .env 里）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export HERMES_HOME="${1:-$ROOT/hermes-home}"

# 模型 key：优先用这个主目录的 .env，再用仓库 hermes-home/.env（大家共用的那一份），缺的再从 ~/.hermes/.env 补。
for envfile in "$HERMES_HOME/.env" "$ROOT/hermes-home/.env" "$HOME/.hermes/.env"; do
  [ -f "$envfile" ] || continue
  # macOS 自带 bash 3.2 不能 source 进程替换，逐行 export。
  while IFS='=' read -r k v; do
    v="${v%\"}"; v="${v#\"}"
    [ -z "${!k:-}" ] && export "$k=$v"
  done < <(grep -E '^(LONGCAT_API_KEY|OPENROUTER_API_KEY|FAL_KEY)=' "$envfile")
done
: "${LONGCAT_API_KEY:?需要 LONGCAT_API_KEY（放在 hermes-home/.env、~/.hermes/.env 或当前环境里）}"

# 首次运行补上本地 API server 配置（本地开发用的随机 key）。
# .env 可能是从 .env.example 复制来的、只填了 LONGCAT_API_KEY，所以按缺不缺 API_SERVER_KEY 判断，而不是看文件在不在。
if ! grep -q '^API_SERVER_KEY=.' "$HERMES_HOME/.env" 2>/dev/null; then
  sed -i.bak '/^#* *API_SERVER_/d' "$HERMES_HOME/.env" 2>/dev/null && rm -f "$HERMES_HOME/.env.bak"
  cat >> "$HERMES_HOME/.env" <<EOF
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8650
API_SERVER_KEY=$(openssl rand -hex 16)
EOF
  chmod 600 "$HERMES_HOME/.env"
fi

exec "$ROOT/hermes-agent/.venv/bin/hermes" gateway run
