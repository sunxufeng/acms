/**
 * 🔴 「声明了继承源」就必须**真能继承出来**（2026-10-03 立的硬判据）。
 *
 * 起因是一次真实事故（v15「笔记归档」独立成点）：
 *   - 资源登记里写了 `legacyRead: 'module:getnote:update'`，**以为**存量角色会继承到；
 *   - 但引擎 `inheritModulePermissions` 里，`read`/`refresh` 取 `legacyRead`、
 *     **写动作（create/update/delete/transition）取 `legacyWrite`**；
 *   - 于是 `update` 判据的继承源是 `null` ⇒ **一个角色都没拿到**这个点；
 *   - 而迁移**跑成功了**（启动日志有「已完成角色权限 v15 一次性迁移」），
 *     矩阵里那一列全是空的，接口 403 —— **全程没有任何报错**。
 *   - 顺带还踩了「迁移是一次性的」：那轮把角色版本推到 15，只改资源定义不会再补
 *     ⇒ 必须再抬版本重放（v16）。
 *
 * 三段判据（都是**真跑一遍继承**，不是读源码猜）：
 *   ① 通用不变量：资源声明的继承源，必须真能产出对应动作；
 *   ② 🔴 **源码断言的权限点必须可继承**（或资源显式 `legacyRead/Write` 全 null = 不发放）——
 *      这一条才是能抓住本次事故的判据（①抓不到，因为 v15 时 legacyWrite 是 null、压根没声明）；
 *   ③ 针对性回归：`module:getnote:update` ⇒ `module:getnoteArchive:update`。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULE_RESOURCES, modulePermission, type ModuleResource } from '@acms/contracts';
import { inheritModulePermissions } from '@acms/domain';

/** 引擎按 `legacyWrite` 发放的动作（见 packages/domain/src/permission.ts） */
const WRITE_ACTIONS = ['create', 'update', 'delete', 'transition'] as const;
/** 引擎按 `legacyRead` 发放的动作 */
const READ_ACTIONS = ['read', 'refresh'] as const;

/** 该资源声明的全部继承源（legacyRead / legacyWrite / legacyActions 里的每一条） */
function sourcesOf(r: ModuleResource): string[] {
  const out = new Set<string>();
  if (r.legacyRead) out.add(r.legacyRead);
  if (r.legacyWrite) out.add(r.legacyWrite);
  for (const v of Object.values(r.legacyActions ?? {})) for (const p of v ?? []) out.add(p);
  if (r.menuPermission) out.add(r.menuPermission);
  return [...out];
}

/** 造一个「持有该资源全部声明继承源」的角色，跑真正的继承函数 */
function inheritAllSources(r: ModuleResource): Set<string> {
  return new Set(
    inheritModulePermissions(
      { key: '合成测试角色', permissions: sourcesOf(r) },
      { onlyKeys: [r.key] },
    ),
  );
}

describe('① 资源声明了继承源 ⇒ 对应动作必须真能继承出来', () => {
  it('声明 `legacyRead` 的资源，读动作能继承出来', () => {
    const bad: string[] = [];
    for (const r of MODULE_RESOURCES) {
      const declared = r.actions.filter((a) => (READ_ACTIONS as readonly string[]).includes(a));
      if (!r.legacyRead || declared.length === 0) continue;
      const got = inheritAllSources(r);
      if (!declared.some((a) => got.has(modulePermission(r.key, a)))) {
        bad.push(`${r.key}（legacyRead=${r.legacyRead}）`);
      }
    }
    expect(bad, `声明了 legacyRead 但读动作发不出来：${bad.join('、')}`).toEqual([]);
  });

  it('声明 `legacyWrite` 的资源，写动作能继承出来', () => {
    const bad: string[] = [];
    for (const r of MODULE_RESOURCES) {
      const declared = r.actions.filter((a) => (WRITE_ACTIONS as readonly string[]).includes(a));
      if (!r.legacyWrite || declared.length === 0) continue;
      const got = inheritAllSources(r);
      if (!declared.some((a) => got.has(modulePermission(r.key, a)))) {
        bad.push(`${r.key}（legacyWrite=${r.legacyWrite}）`);
      }
    }
    expect(bad, `声明了 legacyWrite 但写动作发不出来：${bad.join('、')}`).toEqual([]);
  });
});

/**
 * 🔴 显式豁免：这 4 个权限点**故意**继承不到，逐条写清原因（不许无声无息地加进来）。
 *
 * 判据是「被断言的点必须能继承」，而下面这些要么根本不是断言（是兜底哨兵）、
 * 要么是刻意的管理员专属。豁免名单有**数量上限断言**，膨胀就会被测试拦下。
 */
const EXEMPT: Record<string, string> = {
  'module:scheduledTasks:write':
    '不是断言，是 lifecycle.meta 的 `writePerm` 兜底哨兵。`modPerm(action)` 只要按 path 命中模块就直接返回 `module:<key>:<action>`，' +
    '永远走不到这个字段 ⇒ 该字符串**是死代码**（定时任务真正的判据是 module:scheduledTasks:create/update/delete）',
  'module:aiUsage:update':
    '同上是 `writePerm` 哨兵；这张表是只读的（actions 只有 read/refresh），写动作**本来就不该发给任何人**',
  'module:aiOpLogs:update': '同上：只读表（AI 路由操作日志）',
  'module:meetingRooms:update':
    '故意的：资源注释写明「同步飞书会议室是写动作，legacyWrite: null ⇒ 不继承给任何角色，只有系统管理员持有」，' +
    '前端按它隐藏「同步」按钮',
};

// ── 扫描源码里断言 / 引用的权限点 ──────────────────────────────────────────
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** 从源码里抽出所有被断言 / 引用的 `module:<key>:<action>` */
function collectAssertedPermissions(files: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (perm: string, where: string) => {
    const list = found.get(perm) ?? [];
    if (!list.includes(where)) list.push(where);
    found.set(perm, list);
  };
  for (const f of files) {
    const src = stripComments(readFileSync(f, 'utf8'));
    const rel = f.slice(f.indexOf('apps'));
    for (const m of src.matchAll(/'(module:[A-Za-z0-9_]+:[a-z]+)'/g)) add(m[1], rel);
  }
  return found;
}

describe('② 🔴 源码断言/引用的权限点必须可继承（或资源显式不发放）', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, '..', '..', '..');
  const files = [
    ...walk(path.join(root, 'apps', 'api', 'src')),
    ...walk(path.join(root, 'apps', 'web', 'app')),
    ...walk(path.join(root, 'apps', 'web', 'lib')),
    ...walk(path.join(root, 'apps', 'web', 'components')),
  ];
  const asserted = collectAssertedPermissions(files);

  it('扫到了足够多的权限点（守卫本身有效）', () => {
    expect(asserted.size).toBeGreaterThan(50);
  });

  it('豁免名单不膨胀（≤ 6 条），且没有过期条目', () => {
    expect(Object.keys(EXEMPT).length, '豁免名单变长了 ⇒ 先确认是新加的"故意的"还是又一个事故').toBeLessThanOrEqual(6);
    const stale = Object.keys(EXEMPT).filter((k) => !asserted.has(k));
    expect(stale, `这些豁免条目在源码里已经找不到了，请删掉：${stale.join('、')}`).toEqual([]);
  });

  it('每个权限点都对应真实资源与真实动作（防拼错 key/action）', () => {
    const bad: string[] = [];
    for (const [perm, where] of asserted) {
      if (EXEMPT[perm]) continue;
      const [, key, action] = perm.split(':') as [string, string, string];
      const res = MODULE_RESOURCES.find((r) => r.key === key);
      if (!res) bad.push(`${perm}（没有 key=${key} 的资源）← ${where[0]}`);
      else if (!res.actions.includes(action as never)) {
        bad.push(`${perm}（${key} 未声明动作 ${action}）← ${where[0]}`);
      }
    }
    expect(bad, `源码里出现了登记表里不存在的权限点：\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('🔴 被断言的非 enter 权限点，必须能被该资源的继承源产出（否则升级后静默失能）', () => {
    const bad: string[] = [];
    for (const [perm, where] of asserted) {
      if (EXEMPT[perm]) continue;
      const [, key, action] = perm.split(':') as [string, string, string];
      if (action === 'enter') continue; // enter 另有菜单白名单/adminOnly 两道闸，不在此判据内
      const res = MODULE_RESOURCES.find((r) => r.key === key);
      if (!res) continue; // 上一段已经报了
      const src = sourcesOf(res);
      if (src.length === 0) continue; // 显式不随迁移发放（由管理员在矩阵里手勾）—— 见资源定义注释
      const got = inheritAllSources(res);
      if (!got.has(perm)) {
        const hint = res.legacyWrite
          ? `已声明 legacyWrite=${res.legacyWrite} 也发不出来`
          : `写动作的继承源 legacyWrite 是 null（填在 legacyRead 上没用）`;
        bad.push(`${perm} ← ${where[0]}\n      ${hint}`);
      }
    }
    expect(
      bad,
      '这些权限点在代码里被断言，但存量角色**继承不到** ⇒ 升级后"按钮没了 / 接口 403"且无报错。\n' +
        '  修法二选一：① 给资源补 `legacyWrite`（写动作）或 `legacyRead`（读动作）；' +
        '② 明确 `legacyRead: null` + `legacyWrite: null` 并抬 `ROLE_PERMISSION_VERSION` 登记为"不发放"。\n  ' +
        bad.join('\n  '),
    ).toEqual([]);
  });
});

describe('③ 回归：笔记归档点必须真的继承到（v15 事故 / v16 修复）', () => {
  it('原本持有「编辑」的角色 ⇒ 继承后拿到 `module:getnoteArchive:update`', () => {
    const got = new Set(
      inheritModulePermissions(
        { key: '合成测试角色', permissions: ['module:getnote:update'] },
        { onlyKeys: ['getnoteArchive'] },
      ),
    );
    expect(got.has('module:getnoteArchive:update')).toBe(true);
  });

  it('两个字段都对上（update 走 legacyWrite、read 走 legacyRead）', () => {
    const res = MODULE_RESOURCES.find((r) => r.key === 'getnoteArchive');
    expect(res, '未登记 getnoteArchive').toBeTruthy();
    expect(res!.legacyWrite).toBe('module:getnote:update');
    expect(res!.legacyRead).toBe('module:getnote:update');
    expect(res!.actions).toContain('update');
  });

  it('反证：不持有「编辑」的角色拿不到（不能凭空发放）', () => {
    const got = new Set(
      inheritModulePermissions(
        { key: '合成测试角色', permissions: ['module:getnote:read'] },
        { onlyKeys: ['getnoteArchive'] },
      ),
    );
    expect(got.has('module:getnoteArchive:update')).toBe(false);
  });
});
