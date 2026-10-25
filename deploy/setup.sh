#!/usr/bin/env bash
# 在 Ubuntu 服务器上装好并启动喵团。用 root 跑；可以重复跑：第一次是安装，之后 git pull 完再跑一次就是更新。
#   APP_DOMAIN=app.example.com bash deploy/setup.sh   有域名：Caddy 自动申请 HTTPS 证书（域名记在 /etc/cattuan.env，之后不用再给）
#   bash deploy/setup.sh                              没域名：http://<服务器 IP>（明文，只适合临时用）
# 第一次会问 LongCat API Key（也可以用 LONGCAT_API_KEY=… 传进来）。
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER=cattuan
ENV_FILE=/etc/cattuan.env
[ "$(id -u)" = 0 ] || { echo '请用 root 跑'; exit 1; }
as_app() { sudo -u "$APP_USER" -H bash -c "cd '$DIR' && $*"; }
[ -f "$ENV_FILE" ] && APP_DOMAIN="${APP_DOMAIN:-$(sed -n 's|^PUBLIC_ORIGIN=https://||p' "$ENV_FILE")}"

echo '==> 系统软件：Caddy、sqlite3（备份用）、中文字体（不然沙箱截图是方块字）、Node.js'
timedatectl set-timezone Asia/Shanghai 2>/dev/null || ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
if ! command -v caddy >/dev/null || ! command -v sqlite3 >/dev/null; then
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y git curl sudo cron rsync sqlite3 caddy fonts-noto-cjk fonts-noto-color-emoji
fi
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' 2>/dev/null || {
  curl -fsSL https://deb.nodesource.com/setup_26.x | bash -
  apt-get install -y nodejs
}

echo "==> 运行用户 $APP_USER、依赖、沙箱的 Chromium"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
chown -R "$APP_USER:$APP_USER" "$DIR"
as_app 'npm ci --omit=dev --prefix app && npm ci --omit=dev --prefix sandbox'
(cd "$DIR/sandbox" && npx playwright-core install-deps chromium)
as_app 'cd sandbox && npx playwright-core install --no-shell chromium' # 沙箱直接用完整 Chrome，不要 headless shell

echo "==> 配置：$ENV_FILE、LongCat key、Caddy"
[ -f "$ENV_FILE" ] || cat > "$ENV_FILE" <<'EOF'
# 喵团线上配置（systemd 读）。改完 systemctl restart cattuan-app。PUBLIC_ORIGIN 由 deploy/setup.sh 按 APP_DOMAIN 填。
PUBLIC_ORIGIN=
# 调试用的注册接口 POST /api/auth/register：要用时改成 1
ALLOW_REGISTER=0
# 成员的每日额度（管理员不限）。下面是默认值，要改就去掉 #
# QUOTA_MESSAGES_PER_DAY=300
# QUOTA_TASKS_PER_DAY=40
# QUOTA_GOAL_CHECKS_PER_DAY=48
# QUOTA_GOALS=5
# QUOTA_GOAL_MIN_EVERY=60
EOF
sed -i "s|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=${APP_DOMAIN:+https://$APP_DOMAIN}|" "$ENV_FILE"
chown "root:$APP_USER" "$ENV_FILE" && chmod 640 "$ENV_FILE"

KEY_FILE="$DIR/agent-home/.env"
[ -f "$KEY_FILE" ] || as_app 'cp agent-home/.env.example agent-home/.env && chmod 600 agent-home/.env'
if ! grep -q '^LONGCAT_API_KEY=.' "$KEY_FILE"; then
  KEY="${LONGCAT_API_KEY:-}"
  [ -n "$KEY" ] || { read -rsp 'LongCat API Key：' KEY; echo; }
  [ -n "$KEY" ] || { echo '没填 key，先不启动'; exit 1; }
  sed -i "s|^LONGCAT_API_KEY=.*|LONGCAT_API_KEY=$KEY|" "$KEY_FILE"
fi

cat > /etc/caddy/Caddyfile <<EOF
# deploy/setup.sh 生成，重跑会覆盖。App、沙箱、agent 都只听 127.0.0.1，对外只有这里。
${APP_DOMAIN:-:80} {
	encode gzip
	# 聊天和任务进度靠 SSE 实时推，别缓冲
	reverse_proxy 127.0.0.1:3210 {
		flush_interval -1
	}
}
EOF

echo '==> systemd 服务、每日备份'
unit() { # $1 名字  $2 说明  $3 启动命令
  cat > "/etc/systemd/system/cattuan-$1.service" <<EOF
[Unit]
Description=$2
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$DIR
EnvironmentFile=$ENV_FILE
ExecStart=$3
Restart=always
RestartSec=3
# 先只给主进程发 SIGTERM（agents 守护进程会挨个停掉各人的 gateway），超时再全部杀掉
KillMode=mixed
TimeoutStopSec=40

[Install]
WantedBy=multi-user.target
EOF
}
unit sandbox '喵团沙箱浏览器 :8660' "$DIR/scripts/start-sandbox.sh"
unit agents '喵团执行 agent（每个账号一个 Pi gateway）' "$(command -v node) $DIR/scripts/agents.mjs"
unit app '喵团 App :3210' "$DIR/scripts/start-app.sh"
mkdir -p /var/backups/cattuan && chown "$APP_USER:$APP_USER" /var/backups/cattuan && chmod 700 /var/backups/cattuan
echo "0 4 * * * $APP_USER bash $DIR/deploy/backup.sh 2>&1 | logger -t cattuan-backup" > /etc/cron.d/cattuan

echo '==> 启动（有后台任务在跑就先等，最多 10 分钟；没跑完的任务重启后会自动续跑）'
idle() {
  local n
  n=$(curl -fsS --max-time 5 http://127.0.0.1:3210/api/health | node -pe 'const d = JSON.parse(require("fs").readFileSync(0)); d.running + d.queued') || return 0
  [ "$n" = 0 ]
}
for _ in $(seq 120); do idle && break; sleep 5; done
systemctl daemon-reload
systemctl enable --now cron
systemctl enable caddy cattuan-sandbox cattuan-agents cattuan-app
systemctl restart caddy cattuan-sandbox cattuan-agents cattuan-app
for _ in $(seq 30); do curl -fsS http://127.0.0.1:3210/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:3210/api/health >/dev/null 2>&1 || { echo 'App 没起来，看日志：journalctl -u cattuan-app -n 50'; exit 1; }

URL="https://${APP_DOMAIN:-}"; [ -n "${APP_DOMAIN:-}" ] || URL='http://<服务器 IP>'
echo; echo "好了：$URL"
if as_app 'node scripts/user.mjs list' | grep -q '还没有账号'; then
  echo "先建管理员：cd $DIR && sudo -u $APP_USER node scripts/user.mjs add <你的名字> --admin"
fi
