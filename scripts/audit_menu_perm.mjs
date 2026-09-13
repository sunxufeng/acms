#!/usr/bin/env node
/**
 * 菜单 ↔ 权限分配清单 全量核对（只读，不写任何数据）
 * 用法：node scripts/audit_menu_perm.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parsePerms(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const m = src.match(/export const PERMISSIONS = \[([\s\S]*?)\] as const;/);
  if (!m) throw new Error('PERMISSIONS not found in ' + file);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function parseMenu(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const start = src.indexOf('DEFAULT_NAV_MENU_CONFIG');
  const seg = src.slice(start, src.indexOf('items: [', start));
  const body = src.slice(src.indexOf('items: [', start));
  // 逐行解析每个 item
  const items = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{ key:')) continue;
    const get = (k) => {
      const mm = t.match(new RegExp(`${k}:\\s*'([^']*)'`));
      return mm ? mm[1] : undefined;
    };
    items.push({
      key: get('key'),
      label: get('label'),
      href: get('href'),
      section: get('section'),
      perm: get('perm'),
      adminOnly: /adminOnly:\s*true/.test(t),
      order: Number((t.match(/order:\s*(\d+)/) || [])[1] ?? 0),
    });
    if (t.endsWith('],')) break;
  }
  void seg;
  return items;
}

// ⚠️ 优先用**编译产物里的运行时值**：下面的 parsePerms/parseMenu 是正则解析源码字面量，
//    认不出 `...MODULE_PERMISSIONS` 这类展开 —— 会把全部 `module:*` 权限点误报成
//    「菜单 perm 不在权限清单」（A 段假阳性）。2026-09-13 给教学域/AI 路由菜单挂上
//    module:* 权限点后就踩了一次：运行时清单里明明有，脚本却报 14 条 ✗。
const DIST = path.join(root, 'packages/contracts/dist/index.js');
async function loadRuntime() {
  if (!fs.existsSync(DIST)) return null;
  try {
    const m = await import(pathToFileURL(DIST).href);
    return { perms: [...m.PERMISSIONS], menu: m.DEFAULT_NAV_MENU_CONFIG?.items ?? [] };
  } catch {
    return null;
  }
}
const RT = await loadRuntime();

const PERMS = RT && RT.perms.length ? RT.perms : parsePerms('packages/contracts/src/role.ts');
const MENU =
  RT && RT.menu.length
    ? RT.menu.map((i) => ({
        key: i.key,
        label: i.label,
        href: i.href,
        section: i.section,
        perm: i.perm ?? '',
        adminOnly: !!i.adminOnly,
      }))
    : parseMenu('packages/contracts/src/homepage.ts');
const permSet = new Set(PERMS);

console.log(`权限清单共 ${PERMS.length} 个权限点；菜单共 ${MENU.length} 项\n`);

// A. 菜单引用了清单里没有的 perm
const badPerm = MENU.filter((i) => i.perm && !permSet.has(i.perm));
console.log('=== A. 菜单 perm 不在权限清单（勾选了也无效/界面找不到）===');
if (!badPerm.length) console.log('  （无）');
else badPerm.forEach((i) => console.log(`  ✗ ${i.label}(${i.key}) → ${i.perm}`));

// B. 无 perm 且非 adminOnly → 完全不受控
const noPerm = MENU.filter((i) => !i.perm && !i.adminOnly);
console.log('\n=== B. 无 perm 且非管理员专属（所有人可见，权限分配里管不到）===');
noPerm.forEach((i) => console.log(`  ! ${i.label}(${i.key}) ${i.href} [${i.section}]`));
if (!noPerm.length) console.log('  （无）');

// C. 孤儿权限点：在清单但没有任何菜单用（含 write 类，属正常但需知情）
const usedByMenu = new Set(MENU.filter((i) => i.perm).map((i) => i.perm));
const orphan = PERMS.filter((p) => !usedByMenu.has(p));
console.log('\n=== C. 权限清单中有、但无菜单直接引用（写类正常；读类可疑）===');
orphan.forEach((p) => console.log(`  - ${p}${p.endsWith(':read') ? '   <== 读权限却无菜单，角色授予后看不到任何入口' : ''}`));

// D. 一个 perm 被多个菜单共用 → 无法单独控制某个菜单
console.log('\n=== D. 多个菜单共用同一 perm（无法单独授权某一个菜单）===');
const byPerm = new Map();
for (const i of MENU) if (i.perm) {
  if (!byPerm.has(i.perm)) byPerm.set(i.perm, []);
  byPerm.get(i.perm).push(i.label);
}
[...byPerm.entries()]
  .filter(([, v]) => v.length > 1)
  .forEach(([p, v]) => console.log(`  * ${p}  ←  ${v.join(' / ')}`));

// E. 后端代码里用到但清单没有的权限点
console.log('\n=== E. 后端 @Permissions / 权限字符串 中出现但清单未登记 ===');
const apiDir = path.join(root, 'apps/api/src');
const found = new Map();
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts')) {
      const s = fs.readFileSync(p, 'utf8');
      for (const m of s.matchAll(/'([a-zA-Z][a-zA-Z0-9]*:(?:read|write|archive|approve|confirm|settle|send|run|admin|chat|config|automation))'/g)) {
        const v = m[1];
        if (!permSet.has(v)) found.set(v, (found.get(v) || new Set()).add(path.relative(root, p)));
      }
    }
  }
}
walk(apiDir);
if (!found.size) console.log('  （无）');
else [...found.entries()].forEach(([v, files]) => console.log(`  ? ${v}  (${[...files].join(', ')})`));
