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
import {
  MODULE_RESOURCES,
  STUDENT_RECORD_ENTRY_KEY,
  STUDENT_RECORD_TYPES,
  STUDENT_RECORD_TYPE_TO_MODULE,
  STUDENT_RECORD_TYPE_VALUES,
  moduleKeyOfRecordType,
  modulePermission,
  studentRecordMenuVisible,
  type SessionUser,
} from '@acms/contracts';
import { DICTIONARIES_RAW } from '../src/dictionary/dict.data.js';
import { LIFECYCLE_METAS } from '../src/shared/lifecycle.meta.js';
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

/** 与生命周期元数据同构（含 2026-09-21 新增的合并入口 key） */
const TYPE_SCOPE_WITH_ENTRY: NonNullable<RecordMeta['typeScope']> = {
  ...TYPE_SCOPE,
  allTypesModuleKey: STUDENT_RECORD_ENTRY_KEY,
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

/**
 * 2026-09-21（峰哥报障）：矩阵里「学生记录」这一行是可勾的，勾了写入
 * `module:studentRecords:<action>`，而运行时原先**完全忽略**它 ——
 * 被这样授权的角色（生产实测 Phase3~Phase8 六个班主任角色）列表/新建全 403。
 */
describe('typeAllowedValues：合并入口的「全类型」授权', () => {
  beforeEach(() => {
    seedRoles({
      系统管理员: [],
      只有合并入口: [READ(STUDENT_RECORD_ENTRY_KEY)],
      只有类型行: [READ('studentObservations')],
      都没有: ['student:read'],
    });
  });

  it('只勾了「学生记录」这一行 ⇒ 全部类型放行（就是本次修的 bug）', () => {
    expect(typeAllowedValues({ typeScope: TYPE_SCOPE_WITH_ENTRY }, user(['只有合并入口']), 'read')).toEqual(
      Object.keys(TYPE_SCOPE.typeModules),
    );
  });

  it('只勾了类型行 ⇒ 仍然只放行该类型（不得被合并入口的判定放大）', () => {
    expect(typeAllowedValues({ typeScope: TYPE_SCOPE_WITH_ENTRY }, user(['只有类型行']), 'read')).toEqual(['学生观察']);
  });

  it('两者都没有 ⇒ 空数组（不是「不限制」）', () => {
    expect(typeAllowedValues({ typeScope: TYPE_SCOPE_WITH_ENTRY }, user(['都没有']), 'read')).toEqual([]);
  });

  it('meta 没配 allTypesModuleKey ⇒ 合并入口的点不生效（老 meta 行为不变）', () => {
    expect(typeAllowedValues(META, user(['只有合并入口']), 'read')).toEqual([]);
  });

  it('动作是逐动作判的：只勾了 read ⇒ create 仍然空', () => {
    expect(typeAllowedValues({ typeScope: TYPE_SCOPE_WITH_ENTRY }, user(['只有合并入口']), 'create')).toEqual([]);
  });
});

/**
 * 菜单可见性：三层判据（权限 → 白名单 → 白名单兼容合并前的旧 key）。
 * 少了任何一层都有一类人看不到入口，而且**不报错**，只是「功能没了」。
 */
describe('studentRecordMenuVisible', () => {
  it('持有任一类型 read 且无白名单 ⇒ 可见', () => {
    expect(studentRecordMenuVisible({ perms: [READ('studentObservations')], menus: null })).toBe(true);
  });

  it('只勾了「学生记录」这一行 ⇒ 也可见（Phase3~Phase8 的班主任角色）', () => {
    expect(studentRecordMenuVisible({ perms: [READ(STUDENT_RECORD_ENTRY_KEY)], menus: null })).toBe(true);
  });

  it('白名单里是合并前的旧 key（studentObservations）⇒ 仍可见（Phase1 14 人实测）', () => {
    expect(
      studentRecordMenuVisible({
        perms: [READ('studentObservations')],
        menus: ['dashboard', 'studentObservations', 'reports'],
      }),
    ).toBe(true);
  });

  it('白名单里没它、也没旧 key ⇒ 不可见（白名单仍然只收敛、不放大）', () => {
    expect(
      studentRecordMenuVisible({ perms: [READ('dailyFollowups')], menus: ['dashboard', 'reports'] }),
    ).toBe(false);
  });

  it('没有任何记录权限 ⇒ 不可见（白名单再全也不放行）', () => {
    expect(studentRecordMenuVisible({ perms: ['student:read'], menus: null })).toBe(false);
    expect(studentRecordMenuVisible({ perms: ['student:read'], menus: ['studentRecords'] })).toBe(false);
  });

  it('白名单里明确有 studentRecords ⇒ 可见', () => {
    expect(
      studentRecordMenuVisible({ perms: [READ(STUDENT_RECORD_ENTRY_KEY)], menus: ['studentRecords'] }),
    ).toBe(true);
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

/**
 * 真实类型定义 ↔ 字典取值 ↔ 权限点（2026-09-21 新增「IDP沟通」时补上）。
 *
 * 上面几组测的是**机制**（自建了一份 TYPE_SCOPE），这一组测**真实数据**：
 * 类型定义（contracts）与字典取值是**两份手抄同步**的东西，谁漏改一边都不会报错，
 * 只会表现为「Tab 里有、下拉里没有」这种静默不一致。这里把它变成会变红的断言。
 */
describe('真实类型定义（contracts）与字典 / 权限点的三方一致', () => {
  it('字典「记录类型」与类型定义**逐项且同序**一致', () => {
    // 顺序也要一致：顶部 Tab 与下拉的展示顺序都取自这两份
    expect(DICTIONARIES_RAW['记录类型'] ?? []).toEqual([...STUDENT_RECORD_TYPE_VALUES]);
  });

  it('类型取值不重复（重复会让下拉出现两个同样的选项、权限映射互相覆盖）', () => {
    expect(new Set(STUDENT_RECORD_TYPE_VALUES).size).toBe(STUDENT_RECORD_TYPE_VALUES.length);
  });

  it('🔴 每个类型的 moduleKey 都是**真实存在的模块**（否则该类型谁都看不见）', () => {
    for (const t of STUDENT_RECORD_TYPES) {
      const found = MODULE_RESOURCES.some((m) => m.key === t.moduleKey);
      // 失败信息里带上类型与 key，便于直接定位是哪一条
      expect(found, `类型「${t.value}」的 moduleKey「${t.moduleKey}」不在 MODULE_RESOURCES 里`).toBe(true);
    }
  });

  it('🔴 类型 → 权限点映射按定义逐条接线（漏接线 ⇒ 该类型谁都看不见）', () => {
    // 期望值**按类型定义动态推导**，而不是写死清单：否则每加一个同类类型都要回来改这条 ——
    // 上一版写死了 ['IDP沟通','学生沟通']，加类型时它既不会变红（守不住新值）、又留着旧名单。
    for (const t of STUDENT_RECORD_TYPES) {
      expect(moduleKeyOfRecordType(t.value), `「${t.value}」的权限点应等于定义里的 ${t.moduleKey}`)
        .toBe(t.moduleKey);
    }
  });

  it('🔴 复用「日常跟进」权限点的类型：绝不新造权限点（新权限点上线即无人持有）', () => {
    // 「与新类型内容/敏感度一致就复用权限点」是明确判据（见 contracts 的类型定义注释）：
    // 新造一个权限点的代价是**上线后除管理员外没有任何角色持有它** ⇒ 所有人 Tab 与下拉里
    // 都看不到这个类型（功能等于没上线），且不报错。
    // 这里对**本次新增的具体值**写死：它是这一版的决定，值得被钉住；
    // 而"全体类型都要接线"那件事由上面那条动态推导守。
    expect(moduleKeyOfRecordType('学生实践'), '学生实践 必须复用 dailyFollowups').toBe('dailyFollowups');
    expect(moduleKeyOfRecordType('学生沟通')).toBe('dailyFollowups');
    expect(moduleKeyOfRecordType('IDP沟通')).toBe('dailyFollowups');
  });

  it('未知类型返回 undefined（写入校验据此报「未知的记录类型」，不会造出谁都看不见的脏记录）', () => {
    expect(moduleKeyOfRecordType('并不存在的类型')).toBeUndefined();
    expect(moduleKeyOfRecordType('')).toBeUndefined();
  });

  it('🔴 持有「日常跟进」读权限 ⇒ 该权限点下的**全部**类型一起放行', () => {
    // 这条是「复用 moduleKey」的技术依据：typeAllowedValues 遍历「类型 → moduleKey」再判权限，
    // 所以多个类型指向同一个模块时会被一起放行。
    // ⚠️ 期望值**按类型定义动态推导**（而不是写死清单）：否则每加一个同类类型都要改这条测试 ——
    //    上一版就写死了两个类型，加「学生沟通」时它变红了（红是对的，但改起来是纯噪音）。
    const scope: NonNullable<RecordMeta['typeScope']> = {
      field: FIELD,
      typeModules: STUDENT_RECORD_TYPE_TO_MODULE,
      defaultType: '日常跟进',
    };
    loadRolePermissionConfig([
      { key: '有日常', permissions: [READ('dailyFollowups')] as never, maxDataLevel: 'L4' as const },
      { key: '只观察', permissions: [READ('studentObservations')] as never, maxDataLevel: 'L4' as const },
    ]);

    const dailyTypes = STUDENT_RECORD_TYPES.filter((t) => t.moduleKey === 'dailyFollowups').map((t) => t.value);
    const dailyUser = typeAllowedValues({ typeScope: scope }, user(['有日常']), 'read');
    expect(dailyUser).toEqual(dailyTypes);                     // 全放行，且顺序同定义
    expect(dailyUser ?? []).not.toContain('家校沟通');           // 别的权限点的类型不许混进来
    expect(dailyUser ?? []).not.toContain('学生观察');
    expect(dailyUser?.length, '至少应包含日常跟进本身').toBeGreaterThan(0);

    // 反向：只持学生观察权限的人，拿不到日常跟进族里的任何一个（新类型没有把权限放大）
    const obsUser = typeAllowedValues({ typeScope: scope }, user(['只观察']), 'read');
    expect(obsUser).toEqual(['学生观察']);
    for (const v of dailyTypes) expect(obsUser ?? []).not.toContain(v);
  });
});

/**
 * 接线断言：判据再对，**元数据没接上**也等于没改。
 *
 * 2026-09-21 的两个线上 bug 都属于这一类（判据写好了但少配一处）：
 *   ① `typeScope.allTypesModuleKey` 不配 ⇒ 矩阵里勾「学生记录」的角色依旧 403；
 *   ② 四个记录入口的 `defaults` 不返回「责任人」⇒ 新建（含笔记转换）责任人永远是空。
 * 这里直接读**真实的元数据**，防止以后重构时静默丢掉。
 */
describe('生命周期元数据接线（学生记录）', () => {
  const paths = ['student-records', 'daily-followups', 'home-school-comms', 'student-observations'];
  const metas = LIFECYCLE_METAS.filter((m) => paths.includes(m.path));

  it('四个入口都登记了（少一个就有入口失效）', () => {
    expect(metas.map((m) => m.path).sort()).toEqual([...paths].sort());
  });

  it('typeScope 配了合并入口 key（否则矩阵里那一行勾了没用）', () => {
    for (const m of metas) {
      expect(m.typeScope?.allTypesModuleKey).toBe(STUDENT_RECORD_ENTRY_KEY);
    }
  });

  it('新建默认值给出「记录类型 + 责任人 = 当前登录用户」', async () => {
    for (const m of metas) {
      const d = m.defaults;
      expect(typeof d).toBe('function');
      const fields = await (d as Exclude<typeof d, Record<string, unknown>>)?.({}, user([]));
      expect(fields?.责任人).toBe('测试');                       // 取登录用户，不是空
      expect(String(fields?.[FIELD] ?? '')).not.toBe('');        // 记录类型也要给（否则落到 defaultType）
    }
  });

  it('「责任人」不在 readonly 里（readonly 是写入侧硬过滤，会把值静默丢掉）', () => {
    for (const m of metas) expect(m.readonly ?? []).not.toContain('责任人');
  });
});
