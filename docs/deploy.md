# ACMS v2 部署拓扑（2026-08-16）

## 主链路（DNS 已指向 118，待安全组放行 80/443）

```
浏览器/飞书
  → https://acms.areteailab.com (DNS A → 118.145.116.216)
    → nginx (118, TLS 终结, /etc/nginx/sites-available/acms)
      → 127.0.0.1:3000 acms-api.service (Node 22 + Redis)
```

⚠️ 2026-08-16：火山引擎安全组仅放行 22，80/443 待峰哥在控制台放行后主链路即刻生效。

## 备用链路（已验证可用，DNS 指回 116 时启用）

```
浏览器/飞书
  → https://acms.areteailab.com (DNS A → 116.62.188.165)
    → NPM 容器 nginx-app: acms_new_proxy.conf (证书 npm-8)
      → 172.17.0.1:13000 (autossh 隧道 acms-tunnel.service)
        → 118.145.116.216:3000
```

## 116.62.188.165（入口/NPM 服务器）

- 反代配置：`/clouddream/nginx-proxy-manage/data/nginx/proxy_host/acms_new_proxy.conf`
- 证书：`npm-8`（acms.areteailab.com，有效期至 2026-10-25；npm-7 备用）
- 隧道：`systemctl status acms-tunnel`（autossh，root 密钥登录 118）
- 修改后：`docker exec nginx-app nginx -t && docker exec nginx-app nginx -s reload`

## 118.145.116.216（应用服务器）

- 代码：`/opt/acms/api`（pnpm --legacy deploy 产物 + dist，无构建链；上一版留 /opt/acms/api.old）
- 环境：`/opt/acms/.env`（chmod 600），Node 22（/usr/local/node），redis-server（apt）
- 服务：`systemctl status acms-api`；nginx（/etc/nginx/sites-available/acms，证书 /etc/nginx/ssl/）
- 日志：`journalctl -u acms-api -f`
- 本机验证（绕过安全组）：`curl --resolve acms.areteailab.com:443:127.0.0.1 https://acms.areteailab.com/api/v1/health`

## 发版流程（当前手动）

1. 本地：各包 `npx tsc -p tsconfig.json`（contracts → domain → base-adapter → api 顺序）
2. `pnpm --filter @acms/api --prod --legacy deploy /tmp/acms-api-deploy`
3. 修 workspace 软链：`cd /tmp/acms-api-deploy/node_modules/@acms && for p in base-adapter contracts domain; do rm -rf $p ._*$; cp -R -L <repo>/packages/$p ./$p; rm -rf ./$p/{node_modules,src,test,tsconfig.json}; done`，再 `cp -R <repo>/apps/api/dist /tmp/acms-api-deploy/`
4. 打包上传：`COPYFILE_DISABLE=1 tar --exclude='._*' -czf /tmp/acms-api.tgz -C /tmp acms-api-deploy` → scp 118 → /opt/acms/api（保留旧版为 api.old）
5. `systemctl restart acms-api`
6. 冒烟：`curl https://acms.areteailab.com/api/v1/health`（CI smoke job 公网探针）

## 待办

- [ ] ⚠️ 峰哥：火山引擎安全组放行 80/443（主链路生效的最后一步）
- [ ] 飞书 Base 给应用「可编辑」权限（当前只读，91403）：建「系统用户表」+ 首登自动建档管理员
- [ ] 证书自动续期（当前手动，2026-10-25 到期；118 上可装 acme.sh 或从 116 同步）
- [ ] Web（Next.js）部署 118:3100 + nginx location 分流（/api → api，其余 → web）
