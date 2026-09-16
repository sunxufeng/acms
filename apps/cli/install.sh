#!/bin/sh
# ACMS CLI 安装脚本（2026-09-16）
#
#   curl -fsSL https://acms.areteailab.com/cli/install.sh | sh
#
# 做三件事：下载 3 个 .mjs 到 ~/.local/share/acms、在 ~/.local/bin 建软链、打印下一步。
# 刻意用 POSIX sh 而不是 bash —— CI 容器里 bash 不一定在。

set -eu

BASE="${ACMS_BASE_URL:-https://acms.areteailab.com}"
LIB_DIR="${ACMS_LIB_DIR:-$HOME/.local/share/acms}"
BIN_DIR="${ACMS_BIN_DIR:-$HOME/.local/bin}"

FILES="acms.mjs acms-mcp.mjs acms-client.mjs"

info() { printf '  %s\n' "$1"; }
die() { printf '✗ %s\n' "$1" >&2; exit 1; }

# Node 22 是硬要求（CLI 用了全局 fetch 与 AbortSignal.timeout）
command -v node >/dev/null 2>&1 || die "未找到 node，请先安装 Node 22 或更高版本"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || die "需要 Node 22+，当前是 $(node -v)"

printf '安装 ACMS CLI 到 %s\n' "$LIB_DIR"
mkdir -p "$LIB_DIR" "$BIN_DIR"

for f in $FILES; do
  printf '  下载 %s ... ' "$f"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$BASE/cli/$f" -o "$LIB_DIR/$f" || die "下载失败：$BASE/cli/$f"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$BASE/cli/$f" -O "$LIB_DIR/$f" || die "下载失败：$BASE/cli/$f"
  else
    die "既没有 curl 也没有 wget"
  fi
  chmod +x "$LIB_DIR/$f"
  printf '完成\n'
done

# 用软链而不是拷到 PATH：升级时只需重跑本脚本，PATH 上那份不用管
ln -sf "$LIB_DIR/acms.mjs" "$BIN_DIR/acms"
ln -sf "$LIB_DIR/acms-mcp.mjs" "$BIN_DIR/acms-mcp"

printf '\n✓ 已安装：%s/acms 与 %s/acms-mcp\n' "$BIN_DIR" "$BIN_DIR"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf '\n⚠ %s 不在 PATH 里，请把下面这行加到 shell 配置（~/.zshrc 或 ~/.bashrc）：\n' "$BIN_DIR"
    printf '    export PATH="%s:$PATH"\n' "$BIN_DIR"
    ;;
esac

printf '\n下一步：\n'
info "acms login --token <令牌>     # 令牌在 ACMS「后台管理 → 令牌管理」里签发"
info "acms doctor                   # 逐项自检"
info "acms schema                   # 看有哪些模块（agent 也靠它）"
printf '\n想让 WorkBuddy 用上，在 ~/.workbuddy/mcp.json 里加：\n'
printf '  { "mcpServers": { "acms": { "command": "acms-mcp",\n'
printf '      "env": { "ACMS_TOKEN": "acms-sk-…" } } } }\n'
