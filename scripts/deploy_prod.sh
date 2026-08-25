#!/usr/bin/env bash
# 生产环境部署脚本：本地必须先 build（api/web + packages），再跑本脚本。
# 用法：SSHPASS='<密码>' bash scripts/deploy_prod.sh   （或已 export SSHPASS）
# 目标服务器：114.215.186.106 (ecs-user)
# 域名：acms.areteailab.com
# 作用：上传构建产物 → 原子停止→解压→启动 acms-api 与 acms-web 两个服务
set -euo pipefail

SSH_HOST="114.215.186.106"
SSH_USER="ecs-user"
if [ -z "${SSHPASS:-}" ]; then
  echo "错误：未设置 SSHPASS 环境变量（服务器密码）。用法：SSHPASS='<密码>' bash scripts/deploy_prod.sh" >&2
  exit 1
fi
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10"

LOCAL_API_TAR=/tmp/api_dist.tar.gz
LOCAL_PKGS_TAR=/tmp/pkgs_dist.tar.gz
LOCAL_WEB_TAR=/tmp/web_next.tar.gz
LOCAL_WEB_PUBLIC_TAR=/tmp/web_public.tar.gz

for f in "$LOCAL_API_TAR" "$LOCAL_PKGS_TAR" "$LOCAL_WEB_TAR"; do
  if [ ! -f "$f" ]; then
    echo "缺少构建产物: $f —— 请先在 acms 目录执行: pnpm build && bash scripts/build_tars.sh"
    exit 1
  fi
done

# web/public 可选
if [ -d "apps/web/public" ]; then
  tar czf "$LOCAL_WEB_PUBLIC_TAR" -C apps/web/public .
fi

echo "=== 上传产物到 ${SSH_HOST} ==="
UPLOADS=("$LOCAL_API_TAR" "$LOCAL_PKGS_TAR" "$LOCAL_WEB_TAR")
if [ -f "$LOCAL_WEB_PUBLIC_TAR" ]; then
  UPLOADS+=("$LOCAL_WEB_PUBLIC_TAR")
fi
sshpass -e scp $SSH_OPTS "${UPLOADS[@]}" "${SSH_USER}@${SSH_HOST}:/tmp/"

echo "=== 原子停止双服务 → 解压 → 启动双服务 ==="
sshpass -e ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" '
set -e
sudo systemctl stop acms-api acms-web
sleep 1
# api dist
rm -rf /opt/acms/repo/apps/api/dist
mkdir -p /opt/acms/repo/apps/api/dist
tar xzf /tmp/api_dist.tar.gz -C /opt/acms/repo/apps/api/dist 2>/dev/null
# pkgs dist（@acms/* 通过 pnpm workspace symlink，直接放到 packages/*/dist）
rm -rf /tmp/pkgs_extract && mkdir -p /tmp/pkgs_extract
tar xzf /tmp/pkgs_dist.tar.gz -C /tmp/pkgs_extract/ 2>/dev/null
for p in base-adapter contracts domain; do
  rm -rf /opt/acms/repo/packages/$p/dist
  mkdir -p /opt/acms/repo/packages/$p/dist
  cp -r /tmp/pkgs_extract/$p/dist/* /opt/acms/repo/packages/$p/dist/ 2>/dev/null || true
done
# web .next
rm -rf /opt/acms/repo/apps/web/.next
mkdir -p /opt/acms/repo/apps/web/.next
tar xzf /tmp/web_next.tar.gz -C /opt/acms/repo/apps/web/.next 2>/dev/null
# web/public（可选）
if [ -f /tmp/web_public.tar.gz ]; then
  mkdir -p /opt/acms/repo/apps/web/public
  tar xzf /tmp/web_public.tar.gz -C /opt/acms/repo/apps/web/public 2>/dev/null
fi
# 启动双服务
sudo systemctl start acms-api acms-web
sleep 5
echo "api: $(sudo systemctl is-active acms-api)  web: $(sudo systemctl is-active acms-web)"
curl -s -o /dev/null -w "http_index: %{http_code}\n" -H "Host: acms.areteailab.com" http://localhost:80/ || true
echo DONE
'
echo "=== 部署完成 ==="
