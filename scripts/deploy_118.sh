#!/usr/bin/env bash
# 统一部署脚本：本地必须先 build（api/web + packages），再跑本脚本。
# 用法：bash scripts/deploy_118.sh
# 作用：原子地停止→解压→启动 acms-api 与 acms-web 两个服务，避免只 restart 一个导致 502。
set -euo pipefail

SSH_HOST="118.145.116.216"
SSH_USER="root"
SSHPASS_ENV="${SEASON_PASS:-season69130!}"
export SSHPASS="$SSHPASS_ENV"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/tmp/acms_kh -o ConnectTimeout=10"

LOCAL_API_TAR=/tmp/api_dist.tar.gz
LOCAL_PKGS_TAR=/tmp/pkgs_dist.tar.gz
LOCAL_WEB_TAR=/tmp/web_next.tar.gz

for f in "$LOCAL_API_TAR" "$LOCAL_PKGS_TAR" "$LOCAL_WEB_TAR"; do
  if [ ! -f "$f" ]; then
    echo "缺少构建产物: $f —— 请先在本地 build (tsc + next build)"
    exit 1
  fi
done

echo "=== 上传产物 ==="
sshpass $SSH_OPTS scp "$LOCAL_API_TAR" "$LOCAL_PKGS_TAR" "$LOCAL_WEB_TAR" "${SSH_USER}@${SSH_HOST}:/tmp/"

echo "=== 原子停止双服务 → 解压 → 启动双服务 ==="
sshpass $SSH_OPTS ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" '
set -e
systemctl stop acms-api acms-web
sleep 1
# api dist
tar xzf /tmp/api_dist.tar.gz -C /opt/acms/api/ 2>/dev/null
# pkgs
rm -rf /tmp/pkgs_extract && mkdir -p /tmp/pkgs_extract
tar xzf /tmp/pkgs_dist.tar.gz -C /tmp/pkgs_extract/ 2>/dev/null
for p in base-adapter contracts domain; do
  rm -rf /opt/acms/api/node_modules/@acms/$p/dist
  cp -r /tmp/pkgs_extract/packages/$p/dist /opt/acms/api/node_modules/@acms/$p/dist
done
# web
rm -rf /opt/acms/repo/apps/web/.next
mkdir -p /opt/acms/repo/apps/web
tar xzf /tmp/web_next.tar.gz -C /opt/acms/repo/apps/web/ 2>/dev/null
# 启动双服务
systemctl start acms-api acms-web
sleep 5
echo "api: $(systemctl is-active acms-api)  web: $(systemctl is-active acms-web)"
curl -sk -o /dev/null -w "https_index: %{http_code}\n" https://127.0.0.1/ || true
echo DONE
'
echo "=== 部署完成 ==="
