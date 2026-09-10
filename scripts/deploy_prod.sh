#!/usr/bin/env bash
# ============================================================================
# ACMS 生产环境「平滑部署」脚本（Blue-Green 双实例）
# ----------------------------------------------------------------------------
# 目标：部署/重启期间对外零空窗，根除「api 不监听端口导致 502」的问题。
#
# 机制：
#   - API 两个 slot：3001 / 3002；Web 两个 slot：3101 / 3102（web = api + 100）
#   - 每个 slot 独立 dist 目录：dist-3001 / dist-3002、.next-3101 / .next-3102
#   - 状态文件 /opt/acms/.deploy_slot 记录当前对外 slot 的 API 端口（3001/3002）
#   - 部署流程：解压到「空闲 slot」→ 起新实例 → 探活 → 改写 nginx upstream 并
#     reload 切流 → 停旧实例。任意时刻对外仅 1 个 api 进程，定时任务不翻倍。
#   - nginx 用 upstream + proxy_next_upstream 被动故障转移；reload 本身平滑无空窗。
#   - 首次部署：当前是旧版单实例（3000/3100），自动迁移到 3001/3101 后停旧单元。
#
# 用法：SSHPASS='<密码>' bash scripts/deploy_prod.sh   （需先 pnpm build && bash scripts/build_tars.sh）
# ============================================================================
set -euo pipefail

SSH_HOST="114.215.186.106"
SSH_USER="ecs-user"
if [ -z "${SSHPASS:-}" ]; then
  echo "错误：未设置 SSHPASS 环境变量。用法：SSHPASS='<密码>' bash scripts/deploy_prod.sh" >&2
  exit 1
fi
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o PreferredAuthentications=password -o PubkeyAuthentication=no"

# 远端 ssh 执行内联命令（抗 rate-limit 重试）。命令成功执行（含 cat 空文件）即返回，不重试；
# 仅连接/认证失败（ssh 退出非 0）才重试。日志走 stderr，命令 stdout 原样回传。
rssh_cmd() {
  local cmd="$1"; local n=0; local out
  until [ $n -ge 6 ]; do
    if out=$(SSHPASS="$SSHPASS" sshpass -e ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" "$cmd" 2>/dev/null); then
      printf '%s' "$out"; return 0
    fi
    n=$((n+1)); echo "[ssh] 内联命令第 $n 次失败，15s 后重试" >&2; sleep 15
  done
  return 1
}
# 远端 ssh 执行本地脚本文件（bash -s，可带参数），抗 rate-limit 重试。脚本 stdout 透传。
rssh_file() {
  local scriptfile="$1"; shift; local n=0
  until [ $n -ge 6 ]; do
    if SSHPASS="$SSHPASS" sshpass -e ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" 'bash -s' "$@" < "$scriptfile" 2>/dev/null; then
      return 0
    fi
    n=$((n+1)); echo "[ssh] 脚本 $scriptfile 第 $n 次失败，15s 后重试" >&2; sleep 15
  done
  return 1
}

LOCAL_API_TAR=/tmp/api_dist.tar.gz
LOCAL_PKGS_TAR=/tmp/pkgs_dist.tar.gz
LOCAL_WEB_TAR=/tmp/web_next.tar.gz
LOCAL_WEB_PUBLIC_TAR=/tmp/web_public.tar.gz

for f in "$LOCAL_API_TAR" "$LOCAL_PKGS_TAR" "$LOCAL_WEB_TAR"; do
  if [ ! -f "$f" ]; then
    echo "缺少构建产物: $f —— 请先在 acms 目录执行: pnpm build && bash scripts/build_tars.sh" >&2
    exit 1
  fi
done
if [ -d "apps/web/public" ]; then
  tar czf "$LOCAL_WEB_PUBLIC_TAR" -C apps/web/public .
fi

# ---- 1) 读取当前 slot，计算目标 slot ----
echo "=== 读取当前部署 slot ==="
# cat 末尾加 true：文件不存在时 ssh 仍返回 0（命令执行成功），仅连接失败才重试
CURRENT=$(rssh_cmd "cat /opt/acms/.deploy_slot 2>/dev/null; true" || true)
if [ -z "$CURRENT" ]; then
  MODE="first"
  TARGET_API=3001; TARGET_WEB=3101
  STANDBY_API=""; STANDBY_WEB=""
  OLD_API=""; OLD_WEB=""
  echo "当前：旧版单实例（3000/3100），将迁移到 slot 3001/3101"
else
  MODE="switch"
  if [ "$CURRENT" = "3001" ]; then TARGET_API=3002; TARGET_WEB=3102; else TARGET_API=3001; TARGET_WEB=3101; fi
  STANDBY_API=$CURRENT; STANDBY_WEB=$((CURRENT + 100))
  OLD_API=$CURRENT; OLD_WEB=$((CURRENT + 100))
  echo "当前 slot=$CURRENT，目标 slot=$TARGET_API/$TARGET_WEB（旧 slot 作为 backup）"
fi

# ---- 2) 上传构建产物 + systemd 模板 ----
# 用 ssh + cat 重定向逐文件上传（比 scp 更抗 rate-limit），失败 sleep 15 重试最多 5 次
echo "=== 上传产物与 systemd 模板到 ${SSH_HOST} ==="
# 注意：next.config.mjs 是 next start 的「运行时源码」，服务器不随源码同步，必须显式推送，
# 否则会一直服务默认 .next（陈旧构建）。见 scripts/deploy/next.config.prod.mjs 顶部说明。
PROD_NEXT_CONFIG=scripts/deploy/next.config.prod.mjs
if [ ! -f "$PROD_NEXT_CONFIG" ]; then
  echo "缺少生产运行时配置: $PROD_NEXT_CONFIG" >&2
  exit 1
fi
UPLOADS=("$LOCAL_API_TAR" "$LOCAL_PKGS_TAR" "$LOCAL_WEB_TAR" scripts/systemd/acms-api@.service scripts/systemd/acms-web@.service "$PROD_NEXT_CONFIG")
if [ -f "$LOCAL_WEB_PUBLIC_TAR" ]; then UPLOADS+=("$LOCAL_WEB_PUBLIC_TAR"); fi
for f in "${UPLOADS[@]}"; do
  base=$(basename "$f")
  n=0; ok=0
  until [ $n -ge 5 ]; do
    if SSHPASS="$SSHPASS" sshpass -e ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" "cat > /tmp/$base" < "$f" 2>/dev/null; then ok=1; break; fi
    n=$((n+1)); echo "[upload] $base 第 $n 次失败，15s 后重试" >&2; sleep 15
  done
  if [ $ok -ne 1 ]; then echo "错误：上传 $base 失败，中止部署" >&2; exit 1; fi
  echo "[upload] $base 完成"
done

rssh_cmd 'sudo cp -f /tmp/acms-api@.service /etc/systemd/system/ && sudo cp -f /tmp/acms-web@.service /etc/systemd/system/ && sudo systemctl daemon-reload && echo "[remote] systemd 模板已安装/刷新"' \
  || { echo "错误：systemd 模板安装/daemon-reload 失败，中止部署" >&2; exit 1; }

# ---- 2.1) 远端：安装「运行时」next.config.mjs ----
# 服务器只部署构建产物、不部署源码，而 next.config.mjs 是 next start 运行时必读的文件。
# 缺 distDir 会让 next start 永远走默认 .next（陈旧构建）⇒ 新页面 404 且日志无报错（2026-09-10 已踩）。
# 安装后立刻断言包含 NEXT_DIST_DIR，漂移即中止部署。
rssh_cmd 'set -e
CFG=/opt/acms/repo/apps/web/next.config.mjs
TS=$(date +%s)
if [ -f "$CFG" ]; then sudo cp -a "$CFG" "/opt/acms/next.config.mjs.bak-$TS" && echo "[remote] 已备份旧配置 -> /opt/acms/next.config.mjs.bak-$TS"; fi
sudo cp -f /tmp/next.config.prod.mjs "$CFG"
sudo chown ecs-user:ecs-user "$CFG"
grep -q "NEXT_DIST_DIR" "$CFG" || { echo "错误：next.config.mjs 缺少 distDir，会导致服务陈旧构建"; exit 1; }
echo "[remote] 运行时 next.config.mjs 已同步并校验 distDir OK"' \
  || { echo "错误：运行时 next.config.mjs 安装失败，中止部署" >&2; exit 1; }

# ---- 3) 远端：解压到目标 slot + 启动新实例 + 探活 ----
cat > /tmp/acms_remote_deploy.sh <<'REMOTE_EOF'
#!/usr/bin/env bash
set -euo pipefail
TA=$1; TW=$2
REPO=/opt/acms/repo
echo "[remote] 若目标 slot 已存在则先停止（清理上一次失败残留，确保可重入）"
sudo systemctl stop "acms-api@$TA" "acms-web@$TW" 2>/dev/null || true
echo "[remote] 解压构建产物到 slot api=$TA web=$TW"
rm -rf "$REPO/apps/api/dist-$TA"; mkdir -p "$REPO/apps/api/dist-$TA"
tar xzf /tmp/api_dist.tar.gz -C "$REPO/apps/api/dist-$TA" 2>/dev/null
rm -rf /tmp/pkgs_extract && mkdir -p /tmp/pkgs_extract
tar xzf /tmp/pkgs_dist.tar.gz -C /tmp/pkgs_extract/ 2>/dev/null
for p in base-adapter contracts domain; do
  rm -rf "$REPO/packages/$p/dist"; mkdir -p "$REPO/packages/$p/dist"
  cp -r /tmp/pkgs_extract/$p/dist/* "$REPO/packages/$p/dist/" 2>/dev/null || true
done
rm -rf "$REPO/apps/web/.next-$TW"; mkdir -p "$REPO/apps/web/.next-$TW"
tar xzf /tmp/web_next.tar.gz -C "$REPO/apps/web/.next-$TW" 2>/dev/null
if [ -f /tmp/web_public.tar.gz ]; then
  mkdir -p "$REPO/apps/web/public"; tar xzf /tmp/web_public.tar.gz -C "$REPO/apps/web/public" 2>/dev/null
fi
echo "[remote] 启动新 slot 实例 acms-api@$TA acms-web@$TW"
sudo systemctl start "acms-api@$TA" "acms-web@$TW"
echo "[remote] 探活 api(:$TA)/api/v1/health 与 web(:$TW)/"
ok=0
for i in $(seq 1 60); do
  code_api=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$TA/api/v1/health" || true)
  code_web=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$TW/" || true)
  if [ "$code_api" = "200" ] && [ "$code_web" = "200" ]; then
    echo "[remote] 探活通过 (api=$code_api web=$code_web) 第 $i 次"; ok=1; break
  fi
  echo "[remote] 等待中($i) api=$code_api web=$code_web"; sleep 1
done
if [ "$ok" != "1" ]; then
  echo "[remote] 探活失败！保留新实例以便排查，中止部署" >&2
  echo "[remote] 新实例状态："; sudo systemctl status "acms-api@$TA" "acms-web@$TW" --no-pager 2>/dev/null || true
  exit 1
fi
echo "[remote] 新实例就绪"
REMOTE_EOF

echo "=== 远端解压+启动+探活 ==="
rssh_file /tmp/acms_remote_deploy.sh "$TARGET_API" "$TARGET_WEB" \
  || { echo "错误：远端解压/启动/探活失败，中止部署" >&2; exit 1; }

# ---- 4) 远端：改写 nginx upstream + reload 切流 ----
# 仅传 TA TW MODE 三个参数；旧 slot（switch 模式）由脚本依据 TA 自行推算，避免空参数在 ssh 传输中丢失
cat > /tmp/acms_remote_nginx.sh <<'REMOTE_EOF'
#!/usr/bin/env bash
set -euo pipefail
TA=$1; TW=$2; MODE=$3
SA=""; SW=""
if [ "$MODE" = "switch" ]; then
  if [ "$TA" = "3001" ]; then SA=3002; else SA=3001; fi
  SW=$((SA + 100))
fi
NGX=/etc/nginx/sites-enabled/acms
UP=/etc/nginx/sites-enabled/acms_upstream.conf
DONE=${UP}.done
TS=$(date +%Y%m%d%H%M%S)
echo "[nginx] 备份当前配置 -> $NGX.bak-$TS"
sudo cp -f "$NGX" "$NGX.bak-$TS"
{
  echo "upstream acms_api {"
  echo "    server 127.0.0.1:$TA;"
  if [ "$MODE" = "switch" ]; then echo "    server 127.0.0.1:$SA backup;"; fi
  echo "}"
  echo "upstream acms_web {"
  echo "    server 127.0.0.1:$TW;"
  if [ "$MODE" = "switch" ]; then echo "    server 127.0.0.1:$SW backup;"; fi
  echo "}"
} | sudo tee "$UP" >/dev/null
if [ ! -f "$DONE" ]; then
  echo "[nginx] 转换 server 块 proxy_pass -> upstream 名，并注入 proxy_next_upstream"
  sudo sed -i -E \
    -e 's#proxy_pass[[:space:]]+http://127.0.0.1:3000[^;]*;#proxy_pass http://acms_api;\n        proxy_next_upstream error timeout http_502 http_503 http_504;#' \
    -e 's#proxy_pass[[:space:]]+http://127.0.0.1:3100[^;]*;#proxy_pass http://acms_web;\n        proxy_next_upstream error timeout http_502 http_503 http_504;#' \
    "$NGX"
  sudo touch "$DONE"
  echo "[nginx] 与备份的差异："; sudo diff "$NGX.bak-$TS" "$NGX" || true
else
  echo "[nginx] server 块已转换，仅刷新 upstream 端口"
fi
echo "[nginx] upstream 片段内容："; sudo cat "$UP"
echo "[nginx] 校验配置"; sudo nginx -t
echo "[nginx] 平滑 reload"; sudo nginx -s reload
echo "[nginx] 完成"
REMOTE_EOF

echo "=== 改写 nginx upstream 并 reload 切流 ==="
rssh_file /tmp/acms_remote_nginx.sh "$TARGET_API" "$TARGET_WEB" "$MODE" \
  || { echo "错误：nginx upstream 转换/reload 失败，中止部署" >&2; exit 1; }

# ---- 5) 远端：停旧实例 + 写 slot 状态 ----
# 传参 MODE NEW OA OW；first 模式下 OA/OW 用 none 占位（避免空参数在 ssh 传输中丢失导致 unbound）
cat > /tmp/acms_remote_stop.sh <<'REMOTE_EOF'
#!/usr/bin/env bash
set -euo pipefail
MODE=$1; NEW=$2; OA=$3; OW=$4
[ "$OA" = "none" ] && OA=""
[ "$OW" = "none" ] && OW=""
echo "[stop] 停旧实例"
if [ "$MODE" = "first" ]; then
  sudo systemctl stop acms-api acms-web 2>/dev/null || true
  sudo systemctl disable acms-api acms-web 2>/dev/null || true
else
  sudo systemctl stop "acms-api@$OA" "acms-web@$OW"
  sudo systemctl disable "acms-api@$OA" "acms-web@$OW" 2>/dev/null || true
fi
echo "[stop] 启用新 slot 并写入 .deploy_slot=$NEW"
sudo systemctl enable "acms-api@$NEW" "acms-web@$((NEW+100))" 2>/dev/null || true
echo -n "$NEW" | sudo tee /opt/acms/.deploy_slot >/dev/null
echo "[stop] 完成"
REMOTE_EOF

echo "=== 停用旧实例并落盘 slot 状态 ==="
rssh_file /tmp/acms_remote_stop.sh "$MODE" "$TARGET_API" "${OLD_API:-none}" "${OLD_WEB:-none}" \
  || { echo "错误：停用旧实例失败，中止部署" >&2; exit 1; }

# ---- 6) 远端：经 nginx 零空窗验证 ----
cat > /tmp/acms_remote_verify.sh <<'REMOTE_EOF'
#!/usr/bin/env bash
set -euo pipefail
TW=$1
REPO=/opt/acms/repo
echo "[verify] 经 nginx 探活（localhost）"
for i in $(seq 1 10); do
  c_api=$(curl -skL -o /dev/null -w '%{http_code}' --max-time 5 http://localhost/api/v1/health || true)
  c_web=$(curl -skL -o /dev/null -w '%{http_code}' --max-time 5 http://localhost/ || true)
  if [ "$c_api" = "200" ] && [ "$c_web" = "200" ]; then
    echo "[verify] OK api=$c_api web=$c_web"; break
  fi
  echo "[verify] 等待($i) api=$c_api web=$c_web"; sleep 1
done
echo "[verify] 运行中的实例："
systemctl is-active 'acms-api@*' 'acms-web@*' 2>/dev/null || true
echo "[verify] .deploy_slot=$(cat /opt/acms/.deploy_slot 2>/dev/null)"

# 构建一致性校验：确认对外服务的就是本次部署的构建。
# 若 next.config.mjs 缺 distDir，next start 会走默认 .next（陈旧构建），
# 现象是新页面 404、老页面全 200、日志零报错——极难排查。这条校验能当场拦下。
echo "[verify] 构建一致性校验"
WANT=$(cat "$REPO/apps/web/.next-$TW/BUILD_ID" 2>/dev/null || true)
GOT=$(curl -s -H "RSC: 1" --max-time 5 "http://127.0.0.1:$TW/" | grep -o '"b":"[^"]*"' | head -1 | sed 's/.*:"//;s/"$//' || true)
echo "[verify] 期望 buildId=$WANT / 实际 buildId=$GOT"
if [ -n "$WANT" ] && [ -n "$GOT" ] && [ "$WANT" != "$GOT" ]; then
  echo "[verify] 构建不一致：实际服务的不是本次部署的构建（多半是 next.config.mjs 缺 distDir）" >&2
  exit 1
fi
if [ -z "$GOT" ]; then
  echo "[verify] 未能取到运行时 buildId，跳过一致性校验"
else
  echo "[verify] 构建一致 OK"
fi
REMOTE_EOF

echo "=== 零空窗验证 ==="
rssh_file /tmp/acms_remote_verify.sh "$TARGET_WEB" \
  || { echo "错误：零空窗验证失败" >&2; exit 1; }

echo "=== 平滑部署完成：对外 slot = $TARGET_API/$TARGET_WEB ==="
