#!/usr/bin/env bash
# 每天备份一次：账号库（app.db）、每个人的数据（聊天、任务、目标、上传的图、agent 的记忆 / 会话库），
# 以及仓库里 agent-home 的运行时数据（管理员沿用本机数据时在这里）。
# SQLite 库用 .backup 在线导出一份一致的快照，不直接拷正在写的库文件；缓存、日志不备份。
# 用法：deploy/backup.sh（cattuan-backup.timer 每天 04:00 跑）。备份放在 $BACKUP_DIR，保留 $BACKUP_KEEP_DAYS 天。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${CATTUAN_DATA_DIR:-$ROOT/app/data}"
OUT="${BACKUP_DIR:-/var/backups/cattuan}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT"

EXCLUDES=(--exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='*.lock' --exclude='*.sock' --exclude='*.pid'
  --exclude='cache/' --exclude='installs/' --exclude='logs/' --exclude='audio_cache/' --exclude='image_cache/' --exclude='*.out')

copy_tree() { # $1 源目录  $2 备份里的名字
  [ -d "$1" ] || return 0
  mkdir -p "$STAGE/$2"
  rsync -a "${EXCLUDES[@]}" "$1/" "$STAGE/$2/"
  # 库文件单独在线导出
  (cd "$1" && find . -name '*.db' -not -path './installs/*' -not -path './cache/*' -type f) | while read -r db; do
    mkdir -p "$STAGE/$2/$(dirname "$db")"
    sqlite3 "$1/$db" ".backup '$STAGE/$2/$db'"
  done
}

copy_tree "$DATA" data
copy_tree "$ROOT/agent-home" agent-home

tar -czf "$OUT/cattuan-$STAMP.tar.gz" -C "$STAGE" .
chmod 600 "$OUT/cattuan-$STAMP.tar.gz"
find "$OUT" -name 'cattuan-*.tar.gz' -mtime +"$KEEP" -delete
echo "备份好了：$OUT/cattuan-$STAMP.tar.gz（$(du -h "$OUT/cattuan-$STAMP.tar.gz" | cut -f1)）"
