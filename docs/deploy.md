# ACMS v2 部署拓扑（2026-08-16 更新）

## 主链路（DNS → 118，118 反代入口）

```
浏览器 / 飞书
  → https://acms.areteailab.com  (DNS A → 118.145.116.216)
    → 118 系统 nginx (TLS 终结, 80→443, /api/ 反向到 127.0.0.1:3000)
      → 127.0.0.1:3000  (acms-api.service，Node 22 + Redis，宿主机)
```

- 火山引擎安全组 **80/443 已放行**（用户 2026-08-16 操作），DNS 已指向 118，公网即刻生效。
- **实际入口 = 118 本机 standalone nginx**（`/etc/nginx/sites-enabled/acms`），持真实证书
  `/etc/nginx/ssl/{fullchain,privkey}.pem`，反向 `/api/` → `127.0.0.1:3000`。
- 本机验证：`curl --resolve acms.areteailab.com:443:127.0.0.1 https://acms.areteailab.com/api/v1/health` → 200。

## 关于 NPM（重要）

118 上已导入 NPM 镜像 `jc21/nginx-proxy-manager:2.9.19`（由 116 运行容器 `docker export`→`docker import`
绕过 docker 25→29 的 layer 不兼容），容器脚本 `/opt/acms/npm/run.sh`、证书导入脚本
`/opt/acms/npm/import_npm.sh`、配置脚本 `/opt/acms/npm/setup_npm.sh` 均在。

但 116 的 NPM 是**定制镜像**（user 表无 `current_password` 列、`/api/certificates` 路由 404，
仅 `/api/nginx/proxy-hosts` 可用），**无法通过 API 管理证书/配置 SSL**。因此现网 TLS 由
standalone nginx 承担，NPM 容器当前 **停止**（避免占用 80/443）。

> 若坚持用 NPM 作入口，需另装标准版 jc21 NPM（docker 25/29 不兼容需降级 docker 或换源），
> 属后续可选任务。当前推荐保持 standalone nginx（已验证可用）。

## 118.145.116.216（唯一服务器，应用 + 入口 + 库）

- **入口/反代**：系统 nginx（`systemctl status nginx`，配置 `/etc/nginx/sites-enabled/acms`）
- **库**：宿主机 MariaDB（`npm` 库供 NPM 备用；Redis 供 API 用），`bind-address=0.0.0.0`
- **应用**：`/opt/acms/api`（`pnpm --legacy deploy` 产物 + dist）；旧版留 `/opt/acms/api.old`
- **环境**：`/opt/acms/.env`（chmod 600），Node 22
- **服务**：`systemctl status acms-api`、`systemctl status nginx`、`docker images`（看 NPM 镜像）
- **日志**：`journalctl -u acms-api -f`；nginx `journalctl -u nginx -f`

## 116.62.188.165（已退役，不再承载 acms）

- 原 NPM 隧道 `acms-tunnel.service` 已停止并禁用
- 原 NPM 代理配置 `acms_new_proxy.conf` 已删除并 reload
- 116 上其他业务（harbor / portainer / arete 等）不受影响，仅 acms 相关配置清除

## 发版流程（当前手动）

1. 本地：各包 `npx tsc -p tsconfig.json`（contracts → domain → base-adapter → api 顺序）
2. `pnpm --filter @acms/api --prod --legacy deploy /tmp/acms-api-deploy`
3. 修 workspace 软链：`cd /tmp/acms-api-deploy/node_modules/@acms && for p in base-adapter contracts domain; do rm -rf $p ._*; cp -R -L <repo>/packages/$p ./$p; rm -rf ./$p/{node_modules,src,test,tsconfig.json}; done`，再 `cp -R <repo>/apps/api/dist /tmp/acms-api-deploy/`
4. 打包上传：`COPYFILE_DISABLE=1 tar --exclude='._*' -czf /tmp/acms-api.tgz -C /tmp acms-api-deploy` → scp 118 → `/opt/acms/api`（保留旧版为 api.old）
5. `systemctl restart acms-api`
6. 冒烟：`curl https://acms.areteailab.com/api/v1/health`

## 待办

- [ ] 飞书 Base 给应用「可编辑」权限（当前只读，91403）：建「系统用户表」+ 首登自动建档管理员
- [ ] 证书：2026-10-25 到期前更新（standalone nginx 直接换 `/etc/nginx/ssl` 并重载）
- [ ] Web（Next.js）部署 118:3100 + nginx location 分流（/api → api，其余 → web）
- [ ] （可选）若坚持 NPM 入口：装标准版 NPM / 降级 docker 解决证书 API 不可用问题
