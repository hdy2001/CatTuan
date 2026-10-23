#!/usr/bin/env bash
# 在一台全新的 Ubuntu 24.04 服务器上一次性装好喵团。用 root 跑；可以重复跑，装过的步骤会跳过。
# 用法：
#   APP_DOMAIN=app.example.com REPO_URL=https://github.com/<you>/CatTuan.git bash setup.sh
# 代码已经在 /srv/cattuan 了（比如从本机 rsync 过去）就不用 REPO_URL。跑完按最后的提示做（详见 deploy/README.md）。
set -euo pipefail

APP_USER=cattuan
APP_DIR=/srv/cattuan
NODE_MAJOR="${NODE_MAJOR:-26}" # 和本机一致；24 也行（App 用到的 node:sqlite 22.13 起就不用开实验开关）
: "${APP_DOMAIN:?要设 APP_DOMAIN（App 的域名，比如 app.example.com）}"

[ "$(id -u)" = 0 ] || { echo "请用 root 跑"; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
as_app() { sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && $*"; }

step "时区、基础软件包（含中文字体：不然沙箱截图和实时画面里是方块字）"
timedatectl set-timezone Asia/Shanghai
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates rsync sqlite3 ufw caddy \
  build-essential \
  fonts-noto-cjk fonts-noto-color-emoji

step "swap：每个用户一个 agent 进程，内存吃紧时有个兜底"
if ! swapon --show | grep -q .; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "Node.js $NODE_MAJOR"
if ! node -v 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

step "运行用户 $APP_USER 和代码 $APP_DIR"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
if [ ! -d "$APP_DIR/.git" ] && [ ! -f "$APP_DIR/app/server.mjs" ]; then
  : "${REPO_URL:?代码还没放到 $APP_DIR：设 REPO_URL 让脚本 git clone，或者先从本机 rsync 过去}"
  git clone "$REPO_URL" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

step "Pi SDK 执行 runtime（App 的锁定依赖）"
as_app "cd app && npm ci --omit=dev"

step "沙箱浏览器：playwright-core 和它对应版本的 Chromium（含系统依赖）"
as_app "cd sandbox && npm ci --omit=dev"
(cd "$APP_DIR/sandbox" && npx playwright-core install-deps chromium)
as_app "cd sandbox && npx playwright-core install chromium"

step "配置文件"
mkdir -p /etc/cattuan
[ -f /etc/cattuan/cattuan.env ] \
  || sed -e "s|APP_DOMAIN|$APP_DOMAIN|g" "$APP_DIR/deploy/cattuan.env.example" > /etc/cattuan/cattuan.env
chown root:"$APP_USER" /etc/cattuan/cattuan.env && chmod 640 /etc/cattuan/cattuan.env
[ -f "$APP_DIR/agent-home/.env" ] || as_app "cp agent-home/.env.example agent-home/.env && chmod 600 agent-home/.env"
sed -e "s|APP_DOMAIN|$APP_DOMAIN|g" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
mkdir -p /var/backups/cattuan && chown "$APP_USER:$APP_USER" /var/backups/cattuan && chmod 700 /var/backups/cattuan

step "systemd 服务"
cp "$APP_DIR"/deploy/systemd/*.service "$APP_DIR"/deploy/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable cattuan-sandbox cattuan-agents cattuan-app cattuan-backup.timer caddy

step "防火墙：只开 SSH、80、443"
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

cat <<EOF

装好了。接下来（详见 $APP_DIR/deploy/README.md）：
  1. 填 LongCat key：  sudo -u $APP_USER nano $APP_DIR/agent-home/.env
  2. 建管理员账号：    cd $APP_DIR && sudo -u $APP_USER node scripts/user.mjs invite <你的名字> --admin
  3. 启动：            systemctl restart caddy && systemctl start cattuan-sandbox cattuan-agents cattuan-app
  4. 打开第 2 步打印的邀请链接，设好密码就能登录。
EOF
