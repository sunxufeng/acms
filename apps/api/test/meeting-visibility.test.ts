import { describe, expect, it } from 'vitest';
import { TABLES, USER_TABLE } from '@acms/contracts';
import {
  MEETING_SCOPE_BYPASS_ROLES,
  meetingDefaults,
  meetingRowScope,
  myDeptNamesOf,
  subtreeOf,
} from '../src/meeting-minutes/meeting-visibility.js';

/**
 * 会议纪要「可见范围」判据的契约测试。
 *
 * 数据全部取自**生产实况**（2026-09-17 从 `114.215.186.106` 的 PG 导出），
 * 这样断言才有意义 —— 造一套理想化的假数据测不出真实组织里的坑
 * （比如「有人直属挂在公司根部门下」这种情况）。
 *
 * 本文件**不连数据库、不改任何数据**（纯函数 + 假 ctx），可随时重跑。
 */

// ── 生产实况数据 ────────────────────────────────────────────────

const DING = 'ou_353332a4a2fd28318f97fab46970fbd0'; // 丁懿｜Kevin
const SUN = 'ou_d76a678e745598605144be152b041084'; // 孙旭峰｜Richard
const SONG = 'ou_aadb103c8368069478e64583ab9ebf46'; // 宋琼｜Sally（院长办公室负责人 / 系统管理员）
const YVONNE = 'ou_f6a5de4202cbad4459b0de402b1888bf'; // 刘玉蓉｜Yvonne（**直属挂在公司根部门**）
const ALICE = 'ou_af6531688cf07e3f7cb3942318b22a0b'; // 钟慧婷｜Alice（教学管理中心，无任何负责人身份）

const OD = {
  root: '0',
  aiLab: 'od-5fb6b67cc43e724c8ccb2d73e62ede57',
  academic: 'od-8a061acf8f256378f547271432eb9a8b',
  admission: 'od-2a46c9d8610f9c8c6e5d65991d01e466',
  studentDev: 'od-e219cbe836072b302c88c12c60d86020',
  teaching: 'od-7d788fddba25e91dd74ca751c48d6fac',
  brand: 'od-da5e2eb47cc586567504313a7bb12b0e',
  recruit: 'od-31861f34ddc9d1f94d0c63ecb33676ff',
  dean: 'od-1e9666ca892c13f8062351a129a67ba9',
} as const;

/** 部门表（生产 9 条；注意「公司」的 id 就是字符串 '0'，parent 为空串） */
const DEPTS = [
  { open_department_id: OD.root, name: '公司', parent_department_id: '', status: 'active', leader_user_id: '' },
  { open_department_id: OD.aiLab, name: 'Arete AI Lab', parent_department_id: OD.root, status: 'active', leader_user_id: SUN },
  { open_department_id: OD.academic, name: '学术轨', parent_department_id: OD.root, status: 'active', leader_user_id: DING },
  { open_department_id: OD.admission, name: '升学指导中心', parent_department_id: OD.academic, status: 'active', leader_user_id: DING },
  { open_department_id: OD.studentDev, name: '学生发展中心', parent_department_id: OD.academic, status: 'active', leader_user_id: DING },
  { open_department_id: OD.teaching, name: '教学管理中心', parent_department_id: OD.academic, status: 'active', leader_user_id: DING },
  { open_department_id: OD.brand, name: '品牌营销中心', parent_department_id: OD.root, status: 'active', leader_user_id: 'ou_fa63ed00aebaf340b4393fda077cdbce' },
  { open_department_id: OD.recruit, name: '招生家校中心', parent_department_id: OD.root, status: 'active', leader_user_id: 'ou_4c092460519501b82aa0789f75e4e7fb' },
  { open_department_id: OD.dean, name: '院长办公室', parent_department_id: OD.root, status: 'active', leader_user_id: SONG },
  // 已删除部门：必须被排除（否则会把已解散部门的人算进范围）
  { open_department_id: 'od-deleted', name: '已解散部门', parent_department_id: OD.root, status: 'invalid', leader_user_id: DING },
];

/** 部门成员快照（抽样，覆盖「普通成员 / 负责人 / 根部门直属」三种情形） */
const MEMBERS = [
  { user_open_id: DING, open_department_id: OD.academic },
  { user_open_id: ALICE, open_department_id: OD.teaching },
  { user_open_id: SUN, open_department_id: OD.aiLab },
  { user_open_id: SONG, open_department_id: OD.dean },
  { user_open_id: YVONNE, open_department_id: OD.root },
];

/** 用户表（「可见用户」存的是 record id，所以判据要先把自己反查成 record id） */
const USERS = [
  { id: 'rec_ding', '飞书 Open ID': DING, 姓名: '丁懿｜Kevin' },
  { id: 'rec_alice', '飞书 Open ID': ALICE, 姓名: '钟慧婷｜Alice' },
  { id: 'rec_sun', '飞书 Open ID': SUN, 姓名: '孙旭峰｜Richard' },
];

/** 假 ctx：按 tableId 返回上面的实况数据 */
function makeCtx() {
  return {
    search: async (tableId: string): Promise<Record<string, unknown>[]> => {
      if (tableId === TABLES.departments.tableId) return DEPTS;
      if (tableId === TABLES.departmentMembers.tableId) return MEMBERS;
      if (tableId === USER_TABLE.tableId) return USERS;
      return [];
    },
  };
}

const user = (openId: string, roles: string[] = ['教师本人']) => ({
  openId,
  name: openId,
  roles,
  campuses: ['申昆路校区'],
  maxDataLevel: 'L3',
});

// ───────────────────────── subtreeOf ─────────────────────────

describe('subtreeOf（部门子树展开）', () => {
  const nodes = DEPTS.map((d) => ({
    id: d.open_department_id,
    name: d.name,
    parent: d.parent_department_id,
    status: d.status,
    leader: d.leader_user_id,
  })).filter((n) => n.status !== 'invalid');

  it('学术轨的子树 = 自己 + 三个子中心', () => {
    expect(subtreeOf(nodes, OD.academic).sort()).toEqual(
      [OD.academic, OD.admission, OD.studentDev, OD.teaching].sort(),
    );
  });

  it('公司（根）的子树 = 全部部门（含自身）', () => {
    expect(subtreeOf(nodes, OD.root).length).toBe(9);
  });

  it('叶子部门只有自己', () => {
    expect(subtreeOf(nodes, OD.teaching)).toEqual([OD.teaching]);
  });

  it('不存在的部门 id 返回空（不是全量）', () => {
    expect(subtreeOf(nodes, 'od-not-exist')).toEqual([]);
  });

  it('有环也不会死循环', () => {
    const cyc = [
      { id: 'a', name: 'A', parent: 'b', status: 'active', leader: '' },
      { id: 'b', name: 'B', parent: 'a', status: 'active', leader: '' },
    ];
    expect(subtreeOf(cyc, 'a').sort()).toEqual(['a', 'b']);
  });
});

// ───────────────────────── myDeptNamesOf ─────────────────────────

describe('myDeptNamesOf（我的部门范围 → 部门名集合）', () => {
  it('丁懿：所属学术轨（含下级）+ 负责 4 个部门 → 恰好这 4 个', async () => {
    const names = await myDeptNamesOf(user(DING), makeCtx());
    expect(names.sort()).toEqual(['升学指导中心', '学生发展中心', '学术轨', '教学管理中心'].sort());
  });

  it('钟慧婷：只是教学管理中心的普通成员 → 只有本部门', async () => {
    expect(await myDeptNamesOf(user(ALICE), makeCtx())).toEqual(['教学管理中心']);
  });

  it('孙旭峰：Arete AI Lab 成员 + 该部门负责人 → 只有该部门', async () => {
    expect(await myDeptNamesOf(user(SUN), makeCtx())).toEqual(['Arete AI Lab']);
  });

  it('🔴 刘玉蓉：直属挂在「公司」根部门 → 因根包含全部，等于看到所有部门', async () => {
    // 这是「公司是根、子树含全部」的必然结果，需业务侧知情：
    // 直属公司的成员（如行政/助理）会看到所有部门的「部门内可见」纪要。
    const names = await myDeptNamesOf(user(YVONNE), makeCtx());
    expect(names.length).toBe(9);
  });

  it('不在任何部门的人 → 空集合（不是全量）', async () => {
    expect(await myDeptNamesOf(user('ou_nobody'), makeCtx())).toEqual([]);
  });

  it('openId 为空 → 空集合', async () => {
    expect(await myDeptNamesOf({ ...user(''), openId: '' }, makeCtx())).toEqual([]);
  });

  it('已删除部门不参与（不会把人算进已解散部门）', async () => {
    const names = await myDeptNamesOf(user(DING), makeCtx());
    expect(names).not.toContain('已解散部门');
  });
});

// ───────────────────────── meetingRowScope ─────────────────────────

describe('meetingRowScope（可见范围判据）', () => {
  /** 收集返回结构里的所有叶子条件 */
  function leaves(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
    const n = node as { conjunction?: string; conditions?: unknown[]; field?: string };
    if (!n) return out;
    if (Array.isArray(n.conditions)) for (const c of n.conditions) leaves(c, out);
    else if (n.field) out.push(n as Record<string, unknown>);
    return out;
  }

  it('判据结构：三个「可见范围」分支 + 一条「创建人」分支（丁懿）', async () => {
    const scope = await meetingRowScope(user(DING), makeCtx());
    const scopes = leaves(scope)
      .filter((c) => c.field === '可见范围')
      .flatMap((c) => c.value as string[]);
    // 「仅自己可见」不再单独成支 —— 它由下面那条「创建人 = 我」覆盖
    expect(scopes.sort()).toEqual(['公开', '指定用户可见', '部门内可见'].sort());
    // 「创建人 = 我」是**独立**分支（用 openId）
    expect(leaves(scope).find((c) => c.field === '创建人ID')?.value).toEqual([DING]);
    // 「指定用户可见」用用户 record id + contains；「部门」用部门名等值
    expect(leaves(scope).find((c) => c.field === '可见用户')?.value).toEqual(['rec_ding']);
    expect(leaves(scope).find((c) => c.field === '可见用户')?.op).toBe('contains');
    expect(leaves(scope).find((c) => c.field === '部门')?.value?.length).toBe(4);
  });

  it('🔴 回归：创建人总能看自己创建的（「指定用户可见」且名单不含自己时也必须能看）', async () => {
    // 线上实测过的缺陷：姜龙女建了一条「指定用户可见」（名单里只有钟慧婷），
    // 结果她自己看不到这条，连 POST 都因回读 detail 被挡而返回 404。
    const scope = await meetingRowScope(user(ALICE), makeCtx());
    const creator = leaves(scope).find((c) => c.field === '创建人ID');
    expect(creator?.value).toEqual([ALICE]); // 不依赖「可见范围」，独立成支
    // 且不再有专门的「仅自己可见」分支
    expect(
      leaves(scope).some(
        (c) => c.field === '可见范围' && (c.value as string[]).includes('仅自己可见'),
      ),
    ).toBe(false);
  });

  it('🔴 空集合时**整条分支不生成**（否则空 value 数组 = 不过滤 = 全员可见）', async () => {
    // 这个人有 openId，但不在任何部门、也不在用户表里
    const scope = await meetingRowScope(user('ou_ghost'), makeCtx());
    const fields = leaves(scope).map((c) => c.field as string);

    expect(fields).not.toContain('部门'); // 部门集合为空 ⇒ 不产生该分支
    expect(fields).not.toContain('可见用户'); // 用户 record id 为空 ⇒ 不产生该分支
    // 只剩「公开」+「创建人 = 我」两支（他有 openId，所以仍能看自己创建的）
    expect(fields).toEqual(['可见范围', '创建人ID']);
  });

  it('🔴 连 openId 都没有时（异常会话）只剩「公开」一支', async () => {
    const scope = await meetingRowScope({ ...user(''), openId: '' }, makeCtx());
    const all = leaves(scope);
    expect(all.map((c) => c.field)).toEqual(['可见范围']);
    expect(all[0].value).toEqual(['公开']);
  });

  it('🔴 安全断言：任何一个条件的 value 都不为空数组', async () => {
    for (const openId of [DING, ALICE, SUN, YVONNE, 'ou_ghost', '']) {
      const scope = await meetingRowScope(user(openId), makeCtx());
      for (const c of leaves(scope)) {
        expect(Array.isArray(c.value)).toBe(true);
        expect((c.value as string[]).length).toBeGreaterThan(0);
      }
    }
  });

  it('无部门的人：看不到「部门内可见」的，但仍能看「公开」和自己的', async () => {
    const scope = await meetingRowScope(user('ou_ghost'), makeCtx());
    const scopes = leaves(scope)
      .filter((c) => c.field === '可见范围')
      .flatMap((c) => c.value as string[]);
    // 可见范围只剩「公开」——「仅自己可见」的记录是靠「创建人 = 我」那条独立分支命中的
    expect(scopes.sort()).toEqual(['公开']);
    expect(leaves(scope).some((c) => c.field === '创建人ID')).toBe(true);
    expect(leaves(scope).some((c) => c.field === '部门')).toBe(false);
    expect(leaves(scope).some((c) => c.field === '可见用户')).toBe(false);
  });

  it('豁免角色名单含系统管理员与院级管理（引擎按此跳过整个判据）', () => {
    expect(MEETING_SCOPE_BYPASS_ROLES).toContain('系统管理员');
    expect(MEETING_SCOPE_BYPASS_ROLES).toContain('院级管理');
  });
});

// ───────────────────────── meetingDefaults ─────────────────────────

describe('meetingDefaults（新建时自动写创建人 + 兜底可见范围）', () => {
  it('写入创建人 openId', () => {
    expect(meetingDefaults({}, user(DING))['创建人ID']).toBe(DING);
  });

  it('可见范围为空时补默认值', () => {
    expect(meetingDefaults({}, user(DING))['可见范围']).toBe('部门内可见');
    expect(meetingDefaults({ 可见范围: '' }, user(DING))['可见范围']).toBe('部门内可见');
  });

  it('用户已选时不覆盖', () => {
    expect(meetingDefaults({ 可见范围: '仅自己可见' }, user(DING))['可见范围']).toBeUndefined();
  });
});
