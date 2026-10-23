#!/usr/bin/env bash
# 启动本机自托管的 Langfuse（轨迹分析，http://localhost:3000）。容器设了 restart: always，起一次以后跟着 docker 自动起。
# 第一次运行：随机生成 langfuse/.env（数据库密码、项目 key、登录账号），把项目 key 写进 agent-home/.env，
# App/BFF（app/server.mjs）从这里读 key；使用项目自身的轨迹配置。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/langfuse"
ENV_FILE="$DIR/.env"
AGENT_ENV="$ROOT/agent-home/.env"
CHANGED=""

command -v docker >/dev/null || { echo "需要 docker：brew install colima docker docker-compose && colima start"; exit 1; }
if ! docker info >/dev/null 2>&1; then
  command -v colima >/dev/null && colima start --cpu 4 --memory 8 --disk 60 || { echo "docker 没在运行"; exit 1; }
fi
if docker compose version >/dev/null 2>&1; then DC=(docker compose); else DC=(docker-compose); fi

if [ ! -f "$ENV_FILE" ]; then
  hex() { openssl rand -hex "$1"; }
  cat > "$ENV_FILE" <<EOF
LANGFUSE_PORT=3000
POSTGRES_PASSWORD=$(hex 16)
CLICKHOUSE_PASSWORD=$(hex 16)
REDIS_PASSWORD=$(hex 16)
MINIO_PASSWORD=$(hex 16)
SALT=$(hex 16)
NEXTAUTH_SECRET=$(hex 32)
ENCRYPTION_KEY=$(hex 32)
LANGFUSE_PUBLIC_KEY=pk-lf-$(hex 16)
LANGFUSE_SECRET_KEY=sk-lf-$(hex 16)
LANGFUSE_USER_EMAIL=dev@cattuan.local
LANGFUSE_USER_PASSWORD=$(hex 12)
EOF
  chmod 600 "$ENV_FILE"
  echo "已生成 langfuse/.env"
fi
get() { grep "^$1=" "$ENV_FILE" | cut -d= -f2-; }
PORT=$(get LANGFUSE_PORT)

"${DC[@]}" -p cattuan-langfuse -f "$DIR/docker-compose.yml" --env-file "$ENV_FILE" up -d

# 项目 key 写进 agent-home/.env（已经有就不动）
if ! grep -q '^CATTUAN_LANGFUSE_PUBLIC_KEY=.' "$AGENT_ENV" 2>/dev/null; then
  cat >> "$AGENT_ENV" <<EOF
CATTUAN_LANGFUSE_PUBLIC_KEY=$(get LANGFUSE_PUBLIC_KEY)
CATTUAN_LANGFUSE_SECRET_KEY=$(get LANGFUSE_SECRET_KEY)
CATTUAN_LANGFUSE_BASE_URL=http://127.0.0.1:$PORT
EOF
  chmod 600 "$AGENT_ENV"
  echo "已把 Langfuse 项目 key 写进 agent-home/.env"
  CHANGED=1
fi

[ -n "$CHANGED" ] && echo "重启 App 后生效：scripts/restart.sh app"
echo "当前采集 App/BFF 的调度模型与任务生命周期轨迹；Pi 内部模型调用尚未接入采集。"

echo "等 Langfuse 起来（第一次要拉镜像、跑数据库迁移，可能几分钟）…"
for _ in $(seq 1 180); do
  curl -sf -m 3 "http://127.0.0.1:$PORT/api/public/health" >/dev/null && break
  sleep 2
done
curl -sf -m 3 "http://127.0.0.1:$PORT/api/public/health" >/dev/null || { echo "Langfuse 没起来，看日志：${DC[*]} -p cattuan-langfuse logs langfuse-web"; exit 1; }
echo "Langfuse 已就绪：http://localhost:$PORT  登录：$(get LANGFUSE_USER_EMAIL)，密码见 langfuse/.env 的 LANGFUSE_USER_PASSWORD"
