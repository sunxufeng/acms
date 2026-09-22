/**
 * 「定时任务」模块的**授权口径**单测（2026-09-22 晚新增）。
 *
 * 这条链路会把**未脱敏的笔记原文**写进飞书云盘，可见范围由云盘权限决定 ——
 * 所以它只该对系统管理员开放。判据藏在 `MODULE_RESOURCES` 的 legacyRead/legacyWrite 里
 * （模块权限是**派生**出来的，见 `packages/domain/src/permission.ts` 的
 * `inheritModulePermissions`），这正是最容易踩的地方：
 *
 * 🔴 **两个 legacy 字段都写 null ⇒ 连系统管理员都拿不到**
 *    派生不出来 = 菜单看不见、按钮全隐藏、接口 403，而 `healLockedRoles()` 只覆盖
 *    「代码里的全量权限」，派生不出来的点不在里面，救不回来。
 *    （2026-09-19 学生记录、会议室助手都踩过同类问题。）
 *
 * 反向也要钉住：**别的角色一个都不该有** —— 要么是 legacy 依据被别人共享，
 * 要么是有人顺手把 `adminOnly` 去掉并抬了版本。
 */
import { describe, expect, it } from 'vitest';
import { MODULE_RESOURCES, modulePermission } from '@acms/contracts';
import { ROLE_PERMISSIONS } from '@acms/domain';

const ACTIONS = ['enter', 'read', 'create', 'update', 'delete', 'transition'] as const;
const OTHER_ROLES = [
  '院级管理',
  '教务',
  '财务',
  '教师本人',
  '学生事务',
  '招生',
  'HR行政',
  '审计',
  'student',
  'parent',
] as const;

describe('🔴 定时任务模块：只有系统管理员有权限', () => {
  it('资源已登记，且标注 adminOnly', () => {
    const res = MODULE_RESOURCES.find((r) => r.key === 'scheduledTasks');
    expect(res).toBeTruthy();
    expect(res?.path).toBe('/scheduled-tasks');
    expect(res?.adminOnly).toBe(true);
    expect(res?.genericCrud).toBe(true);
  });

  it('legacy 依据指向「仅系统管理员持有」的 admin:user（写成 null ⇒ 管理员自己也没有）', () => {
    const res = MODULE_RESOURCES.find((r) => r.key === 'scheduledTasks');
    expect(res?.legacyRead).toBe('admin:user');
    expect(res?.legacyWrite).toBe('admin:user');
  });

  it('系统管理员拿到了全部动作（含运行 → transition）', () => {
    const perms = new Set(ROLE_PERMISSIONS['系统管理员'] as readonly string[]);
    for (const a of ACTIONS) {
      expect(perms.has(modulePermission('scheduledTasks', a))).toBe(true);
    }
  });

  it('其它角色一个权限点都没有（这条链路写未脱敏原文到云盘）', () => {
    for (const role of OTHER_ROLES) {
      const mine = (ROLE_PERMISSIONS[role] as readonly string[]).filter((p) =>
        p.startsWith('module:scheduledTasks:'),
      );
      expect(mine, `角色「${role}」不该有定时任务权限`).toEqual([]);
    }
  });
});
