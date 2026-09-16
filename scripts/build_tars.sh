#!/usr/bin/env bash
# 打包构建产物，供 deploy_prod.sh 上传部署。
# 用法：先在 acms 目录执行 pnpm build，再执行 bash scripts/build_tars.sh
# 产物：/tmp/api_dist.tar.gz  /tmp/pkgs_dist.tar.gz  /tmp/web_next.tar.gz
set -euo pipefail
# 禁用 macOS tar 写入 ._* AppleDouble 元数据文件（避免在 Linux 解压产生垃圾文件）
export COPYFILE_DISABLE=1
cd "$(git rev-parse --show-toplevel)"

for d in apps/api/dist apps/web/.next packages/base-adapter/dist packages/contracts/dist packages/domain/dist; do
  if [ ! -d "$d" ]; then
    echo "缺少构建产物: $d —— 请先执行: pnpm build" >&2
    exit 1
  fi
done

# 排除 AI 运行时数据目录（ai/data：configs.json / agents.json 等），
# 这些是部署后运行时落盘的持久状态，绝不能打进 tar 覆盖生产（部署脚本 rm -rf dist 会清掉 dist 内文件）。
#
# ⚠️ 非 TS 资源必须在这里补拷：apps/api 用**裸 tsc** 构建，tsc 只产 JS、**不拷任何非 TS 文件**。
#    目前唯一一份是成绩单 PDF 用的中文字体（2.2 MB 子集化 Noto Sans SC）——
#    漏了这一步线上会报「找不到成绩单字体」，PDF 导出直接 500。
if [ -d apps/api/src/exam-grade/assets ]; then
  mkdir -p apps/api/dist/exam-grade/assets
  cp -R apps/api/src/exam-grade/assets/. apps/api/dist/exam-grade/assets/
fi

# pdfkit 依赖闭包（成绩单 PDF）。解压到 dist/node_modules/ —— 见 apps/api/vendor/README.md：
#   · 落在 <slot>/node_modules/，Node 从 dist-<slot>/exam-grade/*.js 向上解析时优先命中
#   · 只在 slot 内生效，不覆盖 apps/api/node_modules 或仓库根，对其他代码零影响
#   · 这样做是为了避免在生产上跑 pnpm install（它会要求重建整个 node_modules，
#     两个 slot 共用一份，失败即全站不可用）
if [ -f apps/api/vendor/pdfkit-deps.tgz ]; then
  VSTAGE=/tmp/pdfkit_vendor_stage
  rm -rf "$VSTAGE"; mkdir -p "$VSTAGE"
  tar xzf apps/api/vendor/pdfkit-deps.tgz -C "$VSTAGE"
  rm -rf apps/api/dist/node_modules
  mkdir -p apps/api/dist/node_modules
  cp -R "$VSTAGE/node_modules/." apps/api/dist/node_modules/
  echo "[build] 已内联 pdfkit 依赖闭包 -> apps/api/dist/node_modules（$(ls apps/api/dist/node_modules | wc -l | tr -d ' ') 个包）"
fi

tar czf /tmp/api_dist.tar.gz --exclude='ai/data' -C apps/api/dist .

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
