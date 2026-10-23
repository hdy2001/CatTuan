#!/usr/bin/env bash
# 备份账号库和所有人的数据（聊天、任务、目标、上传的图、agent 的记忆和会话），保留 14 天。
# deploy/setup.sh 装的 cron 每天 04:00 用运行用户跑；手动：sudo -u cattuan bash deploy/backup.sh
set -euo pipefail
umask 077 # 备份里有各人的 key，只给运行用户看
cd "$(dirname "$0")/.."
OUT="${BACKUP_DIR:-/var/backups/cattuan}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

rsync -a --exclude='app.db*' --exclude='*.lock' --exclude='*.out' --exclude='cache/' app/data agent-home "$TMP/"
sqlite3 app/data/app.db ".backup '$TMP/data/app.db'" # 正在写的库不能直接拷，在线导出一份一致的快照
tar -czf "$OUT/cattuan-$(date +%Y%m%d-%H%M).tar.gz" -C "$TMP" data agent-home
find "$OUT" -name 'cattuan-*.tar.gz' -mtime +14 -delete
echo "备份好了：$(ls -t "$OUT"/cattuan-*.tar.gz | head -1)"
