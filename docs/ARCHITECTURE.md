# ACMS 技术架构文档

> Arete College Management System（学院管理系统）
> 数据层为飞书多维表格（Base），后端 NestJS，前端 Next.js 15，pnpm monorepo。
> 最后整理：2026-08-26（代码版本 `e183edf`）

本文为 ACMS 的总纲，串联各层设计与既有专题文档。配套文档：

- `docs/deploy.md` — 部署拓扑与发版流程（DEV/PROD 双环境）
- `docs/attendance-sign-api.md` — 学生打卡（签到）接口契约
- `docs/student-portal-plan.md` — 学生门户 / 小程序方案
- `docs/base-schema-snapshot.json` / `docs/m2_schema.json` — 飞书 Base 真实表结构快照

---

## 1. 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 数据层 | 飞书 Base（bitable v1） | 唯一事实源（system of record），经 `tenant_access_token` 访问 |
| 后端 | NestJS 11 + TypeScript 5.7 | 全局前缀 `api/v1`，运行于 Node 22 |
| 前端 | Next.js 15（App Router） | SSR + 边缘反代后端，端口 3100 |
| 缓存/会话 | Redis 7 | 会话、OAuth state、限流、微信绑定 |
| 包管理 | pnpm 11.21 workspace | `node >= 22` |
| 接入 | 独立 nginx（TLS 终止） | `/api/` 反代 3000，其余反代 3100 |

设计基调：**契约先行**（`packages/contracts` 登记表/角色/权限点/错误码）→ **领域纯函数**（`packages/domain` 权限引擎/冲突预检）→ **数据适配**（`packages/base-adapter` 屏蔽飞书 API 细节）→ **应用**（`apps/api`、`apps/web`）。

---

## 2. Monorepo 结构

```
acms/
├─ apps/
│  ├─ api/        NestJS 后端（pnpm --filter @acms/api）
│  └─ web/        Next.js 前端（pnpm --filter @acms/web）
├─ packages/
│  ├─ contracts/  共享契约：tables.ts / role.ts / api.ts / homepage.ts
│  ├─ domain/     领域逻辑：permission.ts / conflict.ts
│  └─ base-adapter/ 飞书 Base 客户端：client.ts / convert.ts / token.ts
├─ docs/          技术文档与表结构快照
├─ scripts/       build_tars.sh / deploy_118.sh(DEV) / deploy_prod.sh(PROD)
└─ docker-compose.yml 仅声明 redis:7-alpine
```

构建顺序（依赖方向）：`contracts → domain → base-adapter → api`；`web` 独立构建。

---

## 3. 数据层（飞书 Base）

### 3.1 客户端三件套（`packages/base-adapter/src`）

- **`token.ts` — `TokenManager`**：`POST /open-apis/auth/v3/tenant_access_token/internal` 换取应用令牌，带缓存与约 60s 提前刷新窗口。
- **`client.ts` — `BaseClient`**：封装 `bitable/v1` 的 search/get/create/update/delete 与字段/表结构迁移接口。
  - `search(tableId, opts)`：主读取路径，支持 `FilterGroup` 嵌套（经 `flattenFilter()` 递归展平）。
  - `update()` **必须用 `PUT`**（POST/PATCH 均为 404）。
  - 日期字段：`toWriteFields()` 把 `"YYYY-MM-DD"` 转毫秒时间戳；`fromReadFields()` 读回转本地日期串。
  - `reqRaw()`：对 `429` / `99991400` 做 3 次指数退避重试。
  - 两个已固化的坑：`search()` 按系统字段排序会触发 `InvalidSort(1254016)` → 降级为不排序重试；`listFields()` **必须分页**（每页 100），否则 >100 字段表会漏字段导致 Schema Drift 误判。
- **`convert.ts`**：飞书存储形态 ↔ 业务形态互转（`toText` / `toStringArray` / `toUserIds` / `toUserWrite` 等），是解析用户记录的基础。

### 3.2 表注册（`packages/contracts/src/tables.ts`）

- 导出 `TABLES`（`as const`，`TableKey = keyof typeof TABLES`），共 **35 张表**，覆盖：学生生命周期（学生档案/生源跟进/考勤/学业成绩/实践/家校/日常跟进/阶段评价/校友跟进）、教学域（教师/课程计划/教学班/场地/课次/招生）、计财（教师考勤/合作方/计费明细/月结/调整）、通知（模板/日志）、系统表（系统配置/考勤围栏/审计日志/微信绑定）、IDP（计划/沟通）、关联 Link 表（学年/班级/课程/授权/监护人）。
- `USER_TABLE = { tableId: 'tblnFCIRBOZr2oVF', name: '系统用户表' }` — 飞书系统用户表登记处。
- `tables.ts` 硬编码的是 **DEV** 表 ID；PROD 通过运行时映射切换（见 3.3）。

### 3.3 DEV / PROD 表 ID 映射

`apps/api/src/base.provider.ts`：
- `withTableMap(client)`：读环境变量 `TABLE_ID_MAP`（JSON：`{ 代码表ID: 实际表ID }`），用 **`Proxy`** 包裹 `BaseClient`，拦截所有表级方法的第一个参数 `tableId` 做替换；未配置/空对象则原样透传。
- 结论：**一套代码，DEV 不传 `TABLE_ID_MAP` 直连 DEV Base；PROD 传入 `TABLE_ID_MAP` 指向生产 Base**（或同 Base 不同表）。DEV 零影响。

### 3.4 跨层契约（`packages/contracts/src`）

- **`api.ts`**：`ApiErrorBody` / `ERROR_CODES`（`UNAUTHENTICATED` `FORBIDDEN` `NOT_FOUND` `VALIDATION` `CONFLICT` `RATE_LIMITED` `UPSTREAM` `INTERNAL`）/ `Page<T>` / `SessionUser`（`{ openId, name, roles, campuses, maxDataLevel, studentId?, sessionId, expiresAt }`）。
- **`role.ts`**：`ROLES`（11 个）、`DATA_LEVELS`（L1–L4）、`PERMISSIONS`（44 个功能权限点）、`ROLE_PERMISSIONS` 矩阵、`DATA_LEVEL_RANK`（兼容 `一般/内部/敏感/高度敏感` 中英词汇）、`USER_LEVEL_TO_ENGINE`（用户表中文密级 → 引擎等级）。`student` / `parent` 为外部用户角色（小程序/家长 H5），不出现在飞书系统用户表。
- **`homepage.ts`**：`LoginFeature` / `DashboardTheme` / `NavMenuItem` / `DEFAULT_NAV_MENU_CONFIG`（带 `adminOnly` / `perm` 标志，前端按会话裁剪菜单）/ `DEFAULT_HOMEPAGE_CONFIG` / `imageUrl()`（后端转发飞书图片，避免直链鉴权）。

---

## 4. 领域层（`packages/domain`）

### 4.1 权限模型（`permission.ts`）— ABAC + RBAC

`authorize(principal, permission, resource?): AuthzDecision`，判定顺序：

1. **missing-permission**：主体无该权限点 → `allowed:false, reason:'missing-permission'`。
2. **campus-mismatch**：`系统管理员`/`院级管理` 为组织级视角（`isOrgWide`）跳过校区限制；否则要求 `principal.campuses` 与 `resource.campus`（**支持数组多选，按集合交集**）有交集，否则 `reason:'campus-mismatch'`。
3. **data-level-exceeded**：资源所需密级（数组取最高）超过 `maxDataLevelOf(principal)` → `reason:'data-level-exceeded'`。

设计特征：**fail-closed 偏保守**——缺配置 / 未知密级一律按最高（L4）处理。`ROLE_MAX_LEVEL`：系统管理员/院级管理/审计 = L4；教务/财务/学生事务/HR行政 = L3；教师本人/招生 = L2；student/parent = L1。`admin:user` 仅授予系统管理员，避免普通管理员互删。

> 2026-08-26 修复（`e183edf`）：原 `principal.campuses.includes(resource.campus)` 在学生「校区」为多选字段（数组）时恒为 false，导致带校区的列表被全部过滤成空白；改为集合交集，并让组织级角色绕过单校区限制。

### 4.2 排课冲突预检（`conflict.ts`）

纯函数 `preflightSessionConflicts(draft, existing): ConflictResult`：比较同一日期下 授课教师 / 场地 / 教学班 的时间重叠，`ConflictType` 含 `教师冲突`/`场地冲突`/`班级冲突`，返回 `{ hard, soft }`。fail-closed：既有课次时间不可解析时保守判为硬冲突。`soft` 预留软冲突扩展位（当前恒空）。

---

## 5. API 层（NestJS，`apps/api`）

### 5.1 启动（`main.ts`）

`NestFactory.create` → `setGlobalPrefix('api/v1')` → `enableCors({ origin: WEB_ORIGIN.split(','), credentials: true })` → `app.use(securityMiddleware)`（注入 CSP / X-Frame-Options / 写接口跨域来源校验）→ 监听 `API_PORT ?? 3000`。

### 5.2 鉴权流程（`auth` 模块）

飞书 OAuth 2.0 + **PKCE(S256)**：
- `GET /auth/login`：生成 `state` + `code_verifier`，`code_challenge=S256(verifier)`，`verifier` 存 Redis（`oauth:state:${state}`，EX 600/NX）。
- `GET /auth/callback`：校验 state → 换 `access_token` → 取 `open_id` → `resolvePrincipal` → 建会话、写 cookie。
- `GET /auth/me`（`SessionGuard`）、`POST /auth/logout`、`GET /auth/permissions`（返回权限矩阵 + 我的角色/权限）。

**`resolvePrincipal`（用户解析 + 注册判定）**：
1. 按飞书 `open_id` 查 `USER_TABLE`；用户表为空 → 首登者自动成为 `系统管理员` 并建档（bootstrap）。
2. 否则按优先级：`BOOTSTRAP_ADMIN_OPEN_IDS` 引导管理员 → `ALLOW_SELF_REGISTER`（`'1'|'true'|'dev'`）→ 否则抛 `NOT_REGISTERED`(401)，前端引导联系管理员开通。
3. 自注册角色 `SELF_REGISTER_ROLE`（默认 `教师本人`），密级 `SELF_REGISTER_LEVEL`（默认 `内部`）。
4. 命中用户表：`账号状态==='停用'` → `USER_DISABLED`；解析 `系统角色`/`默认校区`/`数据密级上限` → 映射为 `SessionUser`。
5. fail-closed：用户表不可读时仅放行引导管理员，其余 `USER_TABLE_UNAVAILABLE`。

**会话**：`SessionGuard` 从 `acms_sid` Cookie 或 `x-acms-sid` 头（小程序回退）读会话 → Redis 校验 → 写 `req.user`；`SessionService` 管理 TTL（`SESSION_TTL_SECONDS ?? 3600`）。`LoginRateLimitGuard` 对 login/callback 做双固定窗口限流（IP 10/60s、全局 120/60s），超限 429。

### 5.3 业务模块（`app.module.ts` 导入）

全局模块：Health / Auth(Global) / Student / Dict / Teacher / Teaching / Venue / Schedule / Enrollment / Portal / Attendance / MiniProgram / Parent / Partnership / Billing / Settlement / Adjustment / Notification / Dashboard / Export / Audit / Monitor / 通用 CRUD / Student360 / Idp / Users / Ai / AiSummarize / WechatBinding / HomepageConfig / StudentAuth。

- **通用 CRUD 模式**（`shared/generic-crud.module.ts`）：`registerAll(metas)` 按元数据动态生成 `BaseRecordService` + `Controller`（`list/detail/create/update(PUT)/archive(DELETE)/transition`）。元数据：`LIFECYCLE_METAS`（7 条学生生命周期路径，含 `studentMatch` 本人隔离）、`CONFIG_METAS`（settings/attendance-zones/wechat-bindings）、`AUDIT_METAS`（audit-logs，`admin:audit`）。`transition` 对目标状态做 `authorize` 守卫。
- **学生档案**（`students`）：CSV 导出、`FileInterceptor` 照片/附件上传、增改查、归档/恢复。
- **IDP**（`idp`）：计划继承 `BaseRecordService`，加「同一学生同一学期唯一」约束；沟通走通用 CRUD。
- **学生自助 / 小程序登录**（与飞书解耦的独立身份）：
  - `student-auth`：本地 JSON 账号库（`ACMS_DATA_DIR/student-accounts.json`），`scrypt` 密码哈希，角色 `['student']` 带 `studentId`。
  - `mini-program`：微信 `code2Session`；`wxbind:${openid}` Redis（180d）为权威绑定；`bindByCredentials`（学号+姓名网页登录）；`listZones`（按校区考勤围栏）。

### 5.4 定时任务

- **AI 自动化调度**（`ai/lib/automation/scheduler.ts`，依赖 `croner`）：`scheduleAll()` 启动时全量 reschedule 所有 `enabled` 自动化；`idleOnly` 任务不在 `00:00–06:00` 空闲窗口时落盘 `pendingIdle.json` 由 `sweepPendingIdle`（60s）补跑，保证重启不丢。store：`ACAILY_AUTOMATION_STORE ?? /opt/acaily/data/automations.json`。启动入口 `ai.service.ts onModuleInit() → scheduleAll()`。
- **监控**（`monitor`）：`OnModuleInit` 起 5min 轮询，检查堆内存（`MONITOR_MEM_P1_MB=1500`）与飞书可达性，超限经飞书 `im/v1/messages` 告警（30min 冷却）；`/monitor/status` 暴露状态。

---

## 6. Web 层（Next.js 15，`apps/web`）

- **路由**：App Router，约 63 个页面分组（students / teachers / courses / teaching-classes / venues / schedule / enrollments / idp-plans / home-school-comms / daily-followups / source-followups / alumni-followups / student-360 / student-attendances / grades / practice-activities / stage-evaluations / settlements / adjustments / partnerships / billing / notifications / audit-logs / permissions / settings / wechat-bindings / portal / student-login / homepage-* / ai / menu-groups-settings 等）。
- **外壳**：`layout.tsx` 用 `AppShellGate` 包裹；`STANDALONE = ['/login','/parent','/portal','/student-login']` 不套 AppShell（独立外壳）。其余受保护页面套统一 `AppShell`，菜单由 `DEFAULT_NAV_MENU_CONFIG` 按会话权限裁剪。
- **API 调用**（`lib/api.ts` + `next.config.mjs`）：
  - 统一 `request<T>(path, options)` 封装 `fetch`：`credentials:'include'`、`FormData` 不手动设 `Content-Type`、401 按路径分流（portal/student-login → 跳 student-login；其余 → 跳 login）、错误体优先 `body.error.message`。
  - SSR 反代：`next.config.mjs` 的 `rewrites()` 将 `/api/:path*` → `API_ORIGIN ?? http://localhost:3000`，前端以同源 `/api/v1/...` 调用，规避跨域与 cookie 限制；全站 `Cache-Control: no-store`。

---

## 7. 权限点清单（`role.ts` PERMISSIONS，44 个）

学生域 `student:read/write/archive`；生源 `followup:read/write`；考勤 `attendance:read/write/approve`；计财 `billing:read/write/confirm/settle` `partnership:read/write` `finance:read/approve`；通知 `notification:read/write/send`；学业 `grade:read/write`；实践 `activity:read/write`；家校 `communication:read/write`；评价 `evaluation:read/write`；校友 `alumni:read/write`；师资 `teacher:read/write/archive`；课程 `course:read/write`；场地 `venue:read/write`；排课 `schedule:read/write`；导出 `export:run`；管理 `admin:user/studentUser/audit`；配置 `config:read/write`；AI `ai:chat/config/automation/admin`。

---

## 8. 部署（见 `docs/deploy.md` 详版）

- **构建**：`pnpm build`（各包 tsc + web next build）。
- **打包**：`scripts/build_tars.sh` 产 `/tmp/{api_dist,pkgs_dist,web_next}.tar.gz`。
- **DEV（118，`acms-dev.areteailab.com`）**：`scripts/deploy_118.sh` — 把 `packages/*` 扁平拷贝进 `api/node_modules/@acms/*`，nginx TLS 在 `/etc/nginx/ssl-acms-dev/`，服务 `acms-api`/`acms-web`，环境 `/opt/acms/.env`。
- **PROD（`acms.areteailab.com`）**：`scripts/deploy_prod.sh` — 保留完整 monorepo（`/opt/acms/repo`），表映射靠 `TABLE_ID_MAP`，部署需显式传 `SSHPASS`。
- **关键差异**：118 把包扁平化进 `node_modules/@acms/*`，PROD 保留完整 monorepo 靠 pnpm symlink —— **两者产物不可混用**。

---

## 9. 已知坑位（WARNING）

1. `BaseClient.update()` 必须 `PUT`（POST/PATCH → 404）— `client.ts`。
2. `search()` 按系统字段排序触发 `InvalidSort 1254016` → 已降级无排序重试。
3. `listFields()` 必须分页（每页 100），否则 >100 字段表漏字段导致 Schema Drift 误判。
4. 权限比较兼容中英密级词汇，缺失/未知一律按最高 L4（fail-closed）— `role.ts`。
5. 排课冲突预检：既有课次时间不可解析 → 保守判硬冲突 — `conflict.ts`。
6. 用户表不可读时仅放行引导管理员，其余 `USER_TABLE_UNAVAILABLE` — `auth.service.ts`。
7. 118 扁平拷贝 vs PROD 完整 monorepo，**产物不可混用** — `deploy_118.sh` vs `deploy_prod.sh`。
8. `build_tars.sh` 产物 pkgs **无** `packages/` 前缀（供 `deploy_prod.sh`）；`deploy_118.sh` 要求 **有** `packages/` 前缀 —— 给 118 部署须按前缀重打。

---

## 10. 测试与门禁

- `pnpm typecheck` / `pnpm test` 必须全绿才可合主干。
- 回归红线：登录流程、授权解析、权限矩阵、Base 契约（`pnpm --filter @acms/base-adapter test`）。

---

## 11. 技术选型权衡（Why this stack）

### 11.1 为什么采用

1. **团队 / 客户本就在飞书生态内** —— 用飞书 Base 作事实源可零运维，非技术同事能直接在表格里查看、修改数据（如「系统角色」多选、「校区」字段），所见即所得，交付门槛低。
2. **鉴权复用飞书 OAuth** —— `auth.service.ts` 的 `resolvePrincipal` 直接走飞书登录拿 `open_id`，无需自建账号体系、找回密码、短信验证。
3. **全栈单一语言（TS）** —— 表 schema（`contracts`）、业务规则 / 权限（`domain`）、API、Web 均为 TypeScript，类型可跨前后端与领域层共享，改表结构有编译期保护。
4. **Next.js 适合内部管理后台** —— App Router 既能 SSR 出页面也能做客户端交互，路由分组天然对应业务模块。
5. **部署极简** —— 118 单台机器，无 MySQL / Redis 强依赖，只有 nginx + 两个 systemd 服务。

### 11.2 优点

- **零数据库运维**：飞书托管存储、备份、扩容，不用管慢查询、主从、迁移脚本。
- **业务透明度高**：运营 / 教务可直接打开飞书表格核对数据，减少数据对不上的扯皮。
- **类型共享带来安全性**：`contracts` 定义表与 DTO、`domain` 定义权限与冲突检测，跨越前后端的字段改名能在 `pnpm build` 阶段报错。
- **迭代快、人员成本低**：一套 TS 技能覆盖全栈，小团队可维护。
- **部署轻**：`pnpm build` → 打 tar → `deploy_118.sh` 原子替换，无 DB 迁移步骤。

### 11.3 缺点 / 代价

- **性能与规模天花板**：飞书 Base 有单表行数上限、API 速率配额（`tenant_access_token` 调用频限）、无索引 / 无联表。复杂查询只能拉全量到内存再过滤——`permission.ts` 的 ABAC 校区比较 bug（`isOrgWide`，提交 `e183edf`）正是「遍历全量再比数组」的典型代价，数据量大时明显变慢。
- **强依赖飞书可用性**：飞书抖动 = 系统抖动；飞书 Base API 改字段类型 / 限流会直接打挂业务。
- **弱一致性**：Base 是表格不是事务型 DB，无事务、无外键、并发写易覆盖；约束全靠代码约定（如 `user.service.ts` 用 `ROLES.includes(r)` 过滤非法角色，飞书字段选项没同步会被静默丢弃）。
- **跨应用身份隔离坑**：飞书 `open_id` 与应用绑定，换 App / 多环境会触发 `NOT_REGISTERED`、`99992361` 等错误（118 切 DEV 时踩过），迁移与多环境麻烦。
- **权限 / IAM 要自己造**：ABAC + RBAC 全手写（`permission.ts`），不如直接用成熟 IdP / IAM，边界 case 多。
- **报表 / 聚合难做**：没有真正 SQL，统计类需求得拉全量再算，扩展性差，大数据量下不成立。
- **本地开发与测试依赖飞书**：要么连真实 Base，要么大量 mock，自动化测试门槛高。

### 11.4 适用边界

这是一套为「小团队 + 飞书生态 + 内部工具 + 快速迭代」高度优化的选型，用「放弃强一致 / 高性能 / 可移植性」换来了「零运维 + 业务可见 + 交付快」。当系统规模、并发或分析需求涨上去时，飞书 Base 这一层会最先成为瓶颈——届时要么在 Base 前加缓存 / 物化层，要么将高频表迁到真正的数据库。
