#!/usr/bin/env node
/**
 * 计算「存量角色应当补齐的菜单/模块权限点」（只读，不写任何数据）。
 *
 * 场景：新增模块/菜单后，菜单 perm 从空改成 `module:<key>:read`，而**存量角色的权限矩阵
 * 是持久化的快照、不会自动包含新权限点** —— 不迁移的话，除系统管理员外所有角色都会
 * 突然看不到这些菜单（系统管理员靠代码里的 healLockedRoles 全量覆盖，不受影响）。
 *
 * 用法：
 *   1) 先把生产矩阵拉下来（从生产 114 的系统配置表取 role_permission_config 的「配置值」）：
 *        psql "$DB" -t -A -c "SELECT data->>'配置值' FROM <系统配置表> WHERE data->>'配置键'='role_permission_config';" > /tmp/rpc.json
 *   2) node scripts/calc_menu_perm_patch.mjs
 *      → 打印每个角色将新增多少条、能看到几个新菜单，并写出 /tmp/perm_patch.json
 *   3) 把 /tmp/perm_patch.json 传到服务器，用 scripts/apply_menu_perm_patch.py --apply 落库
 *
 * ⚠️ 必须复用 packages/domain 的 `inheritModulePermissions`，不要自己另写一套规则：
 *    内置角色基线（ROLE_PERMISSIONS）用的就是它，两套规则必然漂移
 *    （出现「新角色能看到、存量角色看不到」这种最难查的不一致）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const domain = require(path.join(root, 'packages/domain/dist/index.js'));
const contracts = require(path.join(root, 'packages/contracts/dist/index.js'));
const { inheritModulePermissions } = domain;
const { MENU_PERM_INHERIT, modulePermission } = contracts;

const CFG = process.env.RPC_FILE || '/tmp/rpc.json';
const OUT = process.env.PATCH_FILE || '/tmp/perm_patch.json';

/** 本次要处理的模块 key（按需改这里）。只补这些模块的权限点，避免把历史差异一次性灌进去。 */
const NEW_KEYS = (process.env.NEW_KEYS || [
  'markbook', 'learningOutcomes', 'curriculum', 'lessonPlan', 'behaviour', 'attendanceCodes',
  'aiRouteGroups', 'aiUpstreams', 'aiProxies', 'aiModelRoutes', 'aiApiKeys', 'aiUsage', 'aiOpLogs',
  'departmentManagement',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

/** 外部用户角色（小程序 / 家长 H5）：后台管理菜单不该给它们 */
const EXCLUDE = new Set(['student', 'parent']);
/** 锁定角色：权限由代码 healLockedRoles 全量覆盖（不回写），写进矩阵反而误导 */
const LOCKED = new Set(['系统管理员']);
/** 前置为空数组 = 无条件获得（与 packages/domain 里的实现同一语义） */
const UNCONDITIONAL = Object.entries(MENU_PERM_INHERIT)
  .filter(([, prereqs]) => prereqs.length === 0)
  .map(([perm]) => perm);

const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const patch = {};
const rows = [['角色', '现状', '新增', '可见新菜单'].join('\t')];

for (const r of cfg.roles) {
  const key = r.key;
  const cur = new Set(r.permissions || []);
  if (EXCLUDE.has(key) || LOCKED.has(key)) {
    patch[key] = [];
    rows.push([key, cur.size, '跳过', EXCLUDE.has(key) ? '外部用户角色' : '锁定角色（代码保证全量）'].join('\t'));
    continue;
  }
  const derived = inheritModulePermissions({ key, permissions: [...cur] });
  // 排除 `:enter`（派生逻辑里 enter 是无条件放行的，会把 14 个模块的 enter 撒给所有人，
  // 连财务都能拿到 AI 路由的 enter —— 它由 role.menus 机制管，不属于「菜单可见性」范围）
  const added = derived.filter(
    (p) => !cur.has(p) && !p.endsWith(':enter') && NEW_KEYS.some((k) => p.startsWith('module:' + k + ':')),
  );
  for (const p of UNCONDITIONAL) if (!cur.has(p) && !added.includes(p)) added.push(p);
  patch[key] = added;
  const visible = NEW_KEYS.filter((k) => added.includes(modulePermission(k, 'read')));
  rows.push([key, cur.size, added.length + ' 条', visible.length + '/' + NEW_KEYS.length + '：' + (visible.join(',') || '无')].join('\t'));
}

fs.writeFileSync(OUT, JSON.stringify(patch, null, 1));
console.log(rows.join('\n'));
const all = Object.values(patch).flat();
console.log('\n合计新增 ' + all.length + ' 条（去重 ' + new Set(all).size + '）');
const weird = [...new Set(all.filter((p) => !p.startsWith('module:')))];
console.log('非 module: 前缀的新增（应为空）: ' + JSON.stringify(weird));
console.log('已写出 ' + OUT);
