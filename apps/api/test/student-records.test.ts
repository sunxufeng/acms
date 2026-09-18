/**
 * 「学生记录」三合一（2026-09-18）的类型域判定测试。
 *
 * 这里测的是**权限**，所以用例要覆盖「多了」和「少了」两个方向：
 *   - 少了：有权限的人看不到内容 / 进不了页面（功能消失，且不报错、只是空掉）
 *   - 多了：没权限的人看到了别人的类型（越权）
 * 以及一个特别容易写反的算子：`isempty` 的 value 是空数组，若排在
 * 「want 为空 ⇒ 不限制」之后，语义会反转成「谁都能看」。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { loadRolePermissionConfig } from '@acms/domain';
import { modulePermission, type SessionUser } from '@acms/contracts';
import {
  buildTypeScopeFilter,
  matchFilter,
  typeAllowedValues,
  type RecordMeta,
} from '../src/shared/generic-crud.module.js';

const FIELD = '记录类型';

const TYPE_SCOPE: NonNullable<RecordMeta['typeScope']> = {
  field: FIELD,
  typeModules: {
    日常跟进: 'dailyFollowups',
    家校沟通: 'homeSchoolComms',
    学生观察: 'studentObservations',
  },
  defaultType: '日常跟进',
};

const META = { typeScope: TYPE_SCOPE } as Pick<RecordMeta, 'typeScope'>;
const META_NO_TYPE = {} as Pick<RecordMeta, 'typeScope'>;

function seedRoles(spec: Record<string, string[]>) {
  loadRolePermissionConfig(
    Object.entries(spec).map(([key, permissions]) => ({
      key,
      permissions: permissions as never,
      maxDataLevel: 'L4' as const,
    })),
  );
}

function user(roles: string[]): SessionUser {
  return { openId: 'ou_test', name: '测试', roles, campuses: [], maxDataLevel: 'L4' } as SessionUser;
}

const READ = (key: string) => modulePermission(key, 'read');

describe('typeAllowedValues：类型域权限的三态', () => {
  beforeEach(() => {
    seedRoles({
      系统管理员: [READ('dailyFollowups'), READ('homeSchoolComms'), READ('studentObservations')],
      全员观察: [READ('studentObservations')],
      有日常: [READ('dailyFollowups')],
      无类型: ['student:read'],
    });
  });

  it('没有 typeScope 的模块 ⇒ null（不限制）', () => {
    expect(typeAllowedValues(META_NO_TYPE, user(['无类型']), 'read')).toBeNull();
  });

  it('豁免角色（系统管理员）⇒ null（不限制，不做逐类型过滤）', () => {
    expect(typeAllowedValues(META, user(['系统管理员']), 'read')).toBeNull();
  });

  it('只持有学生观察权限 ⇒ 只返回「学生观察」', () => {
    expect(typeAllowedValues(META, user(['全员观察']), 'read')).toEqual(['学生观察']);
  });

  it('一个类型权限都没有 ⇒ 空数组（不等于「不限制」）', () => {
    expect(typeAllowedValues(META, user(['无类型']), 'read')).toEqual([]);
  });
});

describe('buildTypeScopeFilter：可见条件', () => {
  beforeEach(() => {
    seedRoles({
      系统管理员: [READ('dailyFollowups'), READ('homeSchoolComms'), READ('studentObservations')],
      全员观察: [READ('studentObservations')],
      有日常: [READ('dailyFollowups')],
      无类型: ['student:read'],
    });
  });

  it('无 typeScope ⇒ null', () => {
    expect(buildTypeScopeFilter(META_NO_TYPE, user(['无类型']))).toBeNull();
  });

  it('豁免角色 ⇒ null', () => {
    expect(buildTypeScopeFilter(META, user(['系统管理员']))).toBeNull();
  });

  it('无任何类型权限 ⇒ "none"（一条都不可见）', () => {
    expect(buildTypeScopeFilter(META, user(['无类型']))).toBe('none');
  });

  it('只有「学生观察」且默认类型不在其中 ⇒ 单条件，不加 isempty 兜底', () => {
    // defaultType 是「日常跟进」，该用户看不到它，所以「未打类型」的记录也不该放行 ——
    // 这正是「兜底不能无条件加」的原因，否则等于把日常跟进的记录漏给了他。
    expect(buildTypeScopeFilter(META, user(['全员观察']))).toEqual({
      field: FIELD,
      op: 'is',
      value: ['学生观察'],
    });
  });

  it('持有「日常跟进」（= 默认类型）⇒ 追加 isempty 兜底，且是 OR', () => {
    const cond = buildTypeScopeFilter(META, user(['有日常']));
    expect(cond).toEqual({
      conjunction: 'or',
      conditions: [
        { field: FIELD, op: 'is', value: ['日常跟进'] },
        { field: FIELD, op: 'isempty', value: [] },
      ],
    });
  });
});

describe('matchFilter 对类型条件的行级判断', () => {
  beforeEach(() => {
    seedRoles({
      系统管理员: [READ('dailyFollowups'), READ('homeSchoolComms'), READ('studentObservations')],
      全员观察: [READ('studentObservations')],
      有日常: [READ('dailyFollowups')],
    });
  });

  const rowOf = (type?: string) => (type === undefined ? { 沟通主题: 'x' } : { [FIELD]: type, 沟通主题: 'x' });

  it('只看学生观察的人：看不到家校沟通、看得到学生观察', () => {
    const cond = buildTypeScopeFilter(META, user(['全员观察']));
    expect(matchFilter(rowOf('学生观察'), cond)).toBe(true);
    expect(matchFilter(rowOf('家校沟通'), cond)).toBe(false);
  });

  it('只看学生观察的人：未打类型的记录也不放行（默认类型是日常跟进）', () => {
    const cond = buildTypeScopeFilter(META, user(['全员观察']));
    expect(matchFilter(rowOf(undefined), cond)).toBe(false);
    expect(matchFilter(rowOf(''), cond)).toBe(false);
  });

  it('有日常跟进权限的人：未打类型的记录按默认类型放行（历史数据不会消失）', () => {
    const cond = buildTypeScopeFilter(META, user(['有日常']));
    expect(matchFilter(rowOf(undefined), cond)).toBe(true);
    expect(matchFilter(rowOf(''), cond)).toBe(true);
    expect(matchFilter(rowOf('日常跟进'), cond)).toBe(true);
    expect(matchFilter(rowOf('家校沟通'), cond)).toBe(false);
  });

  it('"none" ⇒ 全部剔除（而不是全部放行）', () => {
    const cond = buildTypeScopeFilter(META, user(['无类型']));
    expect(cond).toBe('none');
    expect(matchFilter(rowOf('日常跟进'), cond)).toBe(false);
  });

  it('豁免角色（不限制）⇒ 三类都能看到', () => {
    const cond = buildTypeScopeFilter(META, user(['系统管理员']));
    expect(matchFilter(rowOf('日常跟进'), cond)).toBe(true);
    expect(matchFilter(rowOf('家校沟通'), cond)).toBe(true);
    expect(matchFilter(rowOf(undefined), cond)).toBe(true);
  });
});

describe('isempty / isnotempty 算子（顺序写反会变成「谁都能看」）', () => {
  const empty: Parameters<typeof matchFilter>[1] = { field: FIELD, op: 'isempty', value: [] };
  const notEmpty: Parameters<typeof matchFilter>[1] = { field: FIELD, op: 'isnotempty', value: [] };

  it('isempty：字段缺失 / 空串 ⇒ true，有值 ⇒ false', () => {
    expect(matchFilter({}, empty)).toBe(true);
    expect(matchFilter({ [FIELD]: '' }, empty)).toBe(true);
    expect(matchFilter({ [FIELD]: '日常跟进' }, empty)).toBe(false);
  });

  it('isnotempty：与 isempty 互补', () => {
    expect(matchFilter({}, notEmpty)).toBe(false);
    expect(matchFilter({ [FIELD]: '日常跟进' }, notEmpty)).toBe(true);
  });

  it('普通等值算子仍然照常工作（回归）', () => {
    expect(matchFilter({ [FIELD]: '日常跟进' }, { field: FIELD, op: 'is', value: ['日常跟进'] })).toBe(true);
    expect(matchFilter({ [FIELD]: '家校沟通' }, { field: FIELD, op: 'is', value: ['日常跟进'] })).toBe(false);
    expect(matchFilter({ [FIELD]: '家校沟通' }, { field: FIELD, op: 'contains', value: ['家校'] })).toBe(true);
  });
});
