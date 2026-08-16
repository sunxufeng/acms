# ACMS

Arete College Management System。数据层为飞书多维表格（Base），后端 NestJS，前端 Next.js 15，pnpm monorepo。

## 结构

```
apps/api            NestJS 11 API（/api/v1）
apps/web            Next.js 15 前端
packages/contracts  共享类型与表注册（契约先行）
packages/domain     领域纯函数（权限引擎、状态机）
packages/base-adapter  飞书 Base 数据适配层
```

## 快速开始

```bash
pnpm install
cp .env.example .env   # 填入 FEISHU_APP_SECRET
docker compose up -d redis
pnpm dev:api   # :3000
pnpm dev:web   # :3100
```

## 真实 Base 契约

`docs/base-schema-snapshot.json` 为 2026-08-16 拉取的真实表结构快照（8 表 187 字段）。
表结构变更后重新导出并跑契约测试：`pnpm --filter @acms/base-adapter test`。

## 测试与门禁

- `pnpm typecheck` / `pnpm test` 必须全绿才可合主干
- 回归红线：登录流程、授权解析、权限矩阵、Base 契约
