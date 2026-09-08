#!/usr/bin/env bash
# ACMS PostgreSQL 每日备份（压缩 + 定期清理）
# 数据库：acms-prd @ 127.0.0.1:5432
# 用法：pg_backup.sh            （手动执行）
# 定时：0 3 * * * /opt/acms/scripts/pg_backup.sh >> /opt/acms/data/pg_backup.log 2>&1
set -euo pipefail

# ---- 配置 ----
BACKUP_DIR="/opt/acms/data/pg_backup"
DB_NAME="acms-prd"
DB_HOST="127.0.0.1"
DB_PORT="5432"
DB_USER="acms"
# 密码从生产 .env 的 DATABASE_URL 解析（避免明文写死）
ENV_FILE="/opt/acms/.env"
KEEP_DAYS=14

# ---- 解析密码 ----
if [[ -f "$ENV_FILE" ]]; then
  DATABASE_URL="$(grep '^DATABASE_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
  # postgresql://acms:PASSWORD@host:port/db
  PGPASSWORD="$(echo "$DATABASE_URL" | sed -E 's#postgresql://[^:]+:([^@]+)@.*#\1#')"
fi
export PGPASSWORD

mkdir -p "$BACKUP_DIR"

TS="$(date +%Y-%m-%d_%H%M)"
OUT="$BACKUP_DIR/${DB_NAME}_${TS}.sql.gz"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始备份 $DB_NAME -> $OUT"

# plain 格式导出并 gzip -9 压缩（用 -Fc 可改用 pg_restore 恢复）
if ! pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
     | gzip -9 > "$OUT"; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: pg_dump 失败" >&2
  rm -f "$OUT"
  exit 1
fi

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 备份完成 大小=$SIZE"

# ---- 定期清理：删除超过 KEEP_DAYS 天的旧备份 ----
DELETED="$(find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -mtime +"$KEEP_DAYS" -print -delete | wc -l)"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 清理 ${KEEP_DAYS} 天前的旧备份 ${DELETED} 个"

# ---- 清理日志自身（保留最近 2000 行）----
LOG="$(dirname "$0")/pg_backup.log"
if [[ -f "$LOG" ]]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 完成"
