#!/usr/bin/env bash
# 打包构建产物，供 deploy_prod.sh 上传部署。
# 用法：先在 acms 目录执行 pnpm build，再执行 bash scripts/build_tars.sh
# 产物：/tmp/api_dist.tar.gz  /tmp/pkgs_dist.tar.gz  /tmp/web_next.tar.gz
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

for d in apps/api/dist apps/web/.next packages/base-adapter/dist packages/contracts/dist packages/domain/dist; do
  if [ ! -d "$d" ]; then
    echo "缺少构建产物: $d —— 请先执行: pnpm build" >&2
    exit 1
  fi
done

tar czf /tmp/api_dist.tar.gz -C apps/api/dist .

STAGE=/tmp/pkgs_stage
rm -rf "$STAGE" && mkdir -p "$STAGE"
for p in base-adapter contracts domain; do
  mkdir -p "$STAGE/$p"
  cp -R "packages/$p/dist" "$STAGE/$p/"
done
tar czf /tmp/pkgs_dist.tar.gz -C "$STAGE" .

tar czf /tmp/web_next.tar.gz -C apps/web/.next .

echo "=== tars ready ==="
ls -lh /tmp/api_dist.tar.gz /tmp/pkgs_dist.tar.gz /tmp/web_next.tar.gz
