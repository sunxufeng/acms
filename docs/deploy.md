# ACMS v2 部署拓扑（2026-08-16）

## 链路

```
浏览器/飞书
  → https://acms.areteailab.com (DNS → 116.62.188.165, 阿里云 ECS)
    → NPM 容器 nginx-app: acms_new_proxy.conf
      → 172.17.0.1:13000 (autossh 隧道 acms-tunnel.service)
        → 118.145.116.216:3000 (acms-api.service, Node 22 + Redis)
```

## 116.62.188.165（入口/NPM 服务器）

- 反代配置：`/clouddream/nginx-proxy-manage/data/nginx/proxy_host/acms_new_proxy.conf`
- 证书：`npm-8`（acms.areteailab.com，有效期至 2026-10-25；npm-7 为备用同域名证书）
- 隧道：`systemctl status acms-tunnel`（autossh，root 密钥登录 118）
- 修改后：`docker exec nginx-app nginx -t && docker exec nginx-app nginx -s reload`

## 118.145.116.216（应用服务器）

- 代码：`/opt/acms/api`（pnpm --legacy deploy 产物 + dist，无构建链）
- 环境：`/opt/acms/.env`（chmod 600），Node 22（/usr/local/node），redis-server（apt）
- 服务：`systemctl status acms-api`
- 日志：`journalctl -u acms-api -f`

## 发版流程（当前手动）

1. 本地：`pnpm -r build && rm -rf /tmp/acms-api-deploy && pnpm --filter @acms/api --prod --legacy deploy /tmp/acms-api-deploy`
2. 修 workspace 软链：`cd /tmp/acms-api-deploy/node_modules/@acms && for p in base-adapter contracts domain; do rm -f $p; cp -R -L <repo>/packages/$p ./$p; rm -rf ./$p/node_modules ./$p/src ./$p/test ./$p/tsconfig.json; done`
3. 打包上传：`COPYFILE_DISABLE=1 tar --exclude='._*' -czf /tmp/acms-api.tgz -C /tmp acms-api-deploy && scp` → 118 解压到 `/opt/acms/api`
4. `systemctl restart acms-api`
5. 冒烟：`curl https://acms.areteailab.com/api/v1/health`（CI smoke job 也做）

## 待办

- [ ] 118 安全组：建议放行 3000 端口（仅限 116.62.188.165），替代 SSH 隧道
- [ ] Web（Next.js）部署到 118:3100 + NPM location 分流（/ → web，/api → api）
- [ ] 证书自动续期 hook 确认（acms.areteailab.com 当前手动放置）
