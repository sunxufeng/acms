# ACMS 部署拓扑（2026-08-26 更新）

> 注意：118 服务器已是 **DEV 环境**，对外域名 `acms-dev.areteailab.com`；生产域名 `acms.areteailab.com` 指向独立 PROD 服务器。本文随 DEV/PROD 拆分修订。

## 环境对照

| 环境 | 域名 | 服务器 | 飞书 Base | 表映射 |
|------|------|--------|-----------|--------|
| DEV | `acms-dev.areteailab.com` | 118.145.116.216 | DEV app `cli_aa03bcd61eb8dce3` / base `RIAgbQsrfa7EJdslDnkcdAuanyd` | 不传 `TABLE_ID_MAP`（直连） |
| PROD | `acms.areteailab.com` | 114.215.186.106 | 生产 app / base | 传 `TABLE_ID_MAP` 指向生产 |

## DEV 主链路（118）

```
浏览器 / 飞书
  → https://acms-dev.areteailab.com  (DNS A → 118.145.116.216)
    → 118 系统 nginx (TLS /etc/nginx/ssl-acms-dev/, /api/ → 127.0.0.1:3000, 其余 → 127.0.0.1:3100)
      → 127.0.0.1:3000  (acms-api.service，Node 22 + Redis)
      → 127.0.0.1:3100  (acms-web.service，Next.js)
```

- DEV 入口 = 118 本机 standalone nginx（`/etc/nginx/sites-enabled/acms-dev`），反代 `/api/` → 3000、其余 → 3100。
- 环境文件 `/opt/acms/.env`（`chmod 600`），含 `FEISHU_APP_ID/SECRET/BASE_TOKEN`（DEV）、`WEB_ORIGIN=https://acms-dev.areteailab.com`、`FEISHU_REDIRECT_URI=https://acms-dev.areteailab.com/api/v1/auth/callback`、`ALLOW_SELF_REGISTER=dev`。

## 关于 NPM（历史）

118 上曾导入 NPM 镜像 `jc21/nginx-proxy-manager:2.9.19`（由 116 运行容器导出导入绕过 docker 25→29 layer 不兼容），
容器脚本在 `/opt/acms/npm/`。但 116 的 NPM 是**定制镜像**（user 表无 `current_password` 列、`/api/certificates` 404，
仅 `/api/nginx/proxy-hosts` 可用），**无法通过 API 管理证书/配置 SSL**。因此现网 TLS 由 **standalone nginx** 承担，
NPM 容器当前 **停止**（避免占用 80/443）。当前推荐保持 standalone nginx（已验证可用）。

## 118.145.116.216（DEV：应用 + 入口）

- **入口/反代**：系统 nginx（`systemctl status nginx`，配置 `/etc/nginx/sites-enabled/acms-dev`）
- **库**：宿主机 Redis（供 API 会话/限流/微信绑定）
- **应用**：`/opt/acms/api`（api/dist + `node_modules/@acms/*` 扁平拷贝）、`/opt/acms/repo/apps/web/.next`（前端构建产物）
- **环境**：`/opt/acms/.env`（chmod 600），Node 22
- **服务**：`systemctl status acms-api`、`systemctl status acms-web`
- **日志**：`journalctl -u acms-api -f`；`journalctl -u acms-web -f`；nginx `journalctl -u nginx -f`

## 114.215.186.106（PROD）

- 域名 `acms.areteailab.com`，保留完整 monorepo（`/opt/acms/repo`），部署走 `scripts/deploy_prod.sh`（需显式传 `SSHPASS`，用户 `ecs-user`）。
- 表映射靠 `TABLE_ID_MAP` 指向生产 Base；同一套代码经运行时重映射服务生产数据。

## 发版流程（当前脚本化）

### DEV → 118（`acms-dev.areteailab.com`）
1. 本地：`env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR pnpm build`（各包 tsc + web next build）
2. 打包：`bash scripts/build_tars.sh` → `/tmp/{api_dist,pkgs_dist,web_next}.tar.gz`
   - ⚠️ `build_tars.sh` 产出的 pkgs **无** `packages/` 前缀（供 `deploy_prod.sh`）。给 118 部署须重打为带 `packages/` 前缀：
     ```
     STAGE=/tmp/pkgs_stage && rm -rf "$STAGE" && mkdir -p "$STAGE/packages"
     for p in base-adapter contracts domain; do mkdir -p "$STAGE/packages/$p"; cp -R "packages/$p/dist" "$STAGE/packages/$p/"; done
     tar czf /tmp/pkgs_dist.tar.gz -C "$STAGE" .
     ```
3. 部署：`bash scripts/deploy_118.sh`（scp + 原子 stop→解压→start，`password=SEASON_PASS` 缺省 `season69130!`）
4. 冒烟：`curl https://acms-dev.areteailab.com/api/v1/health`、首页 200、`/api/v1/auth/me` 401

### PROD → 114.215.186.106（`acms.areteailab.com`）
1. 同上 `pnpm build` + `bash scripts/build_tars.sh`（pkgs 用无前缀布局，正好匹配 `deploy_prod.sh`）
2. 部署：`SSHPASS=<prod_pass> bash scripts/deploy_prod.sh`
3. 冒烟：`curl -H "Host: acms.areteailab.com" http://localhost:80/`

## 待办

- [ ] 飞书 Base 给应用「可编辑」权限（当前只读，91403）：建「系统用户表」+ 首登自动建档管理员
- [ ] DEV 证书到期前更新（standalone nginx 直接换 `/etc/nginx/ssl-acms-dev` 并重载）
- [ ] （可选）若坚持 NPM 入口：装标准版 NPM / 降级 docker 解决证书 API 不可用问题
