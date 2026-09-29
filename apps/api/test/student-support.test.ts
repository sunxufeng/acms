/**
 * 学生支持看板（2026-09-29）的守卫测试。
 *
 * 两类断言，各有明确目的：
 *
 * **A. 纯函数行为** —— 信号判据被「后端聚合 / 前端展示 / 单测」三处共用，
 *    写错一处就是"卡片看着有理由、其实是错的"。尤其这几条：
 *    · `supportSignalsOf` 的**证据文案**必须带真实数字（"已 67 天未联系"），
 *      只写"很久没联系"老师无法判断轻重；
 *    · `supportInScope` 里 **"没有任何归属 ⇒ 任何人都能看见"** 那一条 ——
 *      去掉它，"没人管的学生"会被范围过滤掉（而他们正是这页最该被看见的人，
 *      且**不报错、只是看板上没人**，2026-09-29 设计时专门留的分支）。
 *
 * **B. 源码接线守卫** —— 本项目最贵的一类 bug 是"声明与判据错开一半、静默失效"：
 *    · 若 `studentSupport` 的继承源写成 `module:dailyFollowups:read`
 *      ⇒ **student / parent 也持有那个点**，老师端看板会发给学生和家长；
 *    · 若 `studentSupportAll` 忘了 `legacyRead: null`
 *      ⇒ 一次版本迁移就**人人能看全部学生**；
 *    · 若 `@Get('board')` 排到 `@Get(':studentId')` 之后
 *      ⇒ `/student-support/board` 被当成学生 id，接口**静默 404/空**；
 *    · 若聚合里用 `关联学生`（姓名字符串）而不是 `关联学生编号`（id 数组）
 *      ⇒ 生产 75 个姓名此刻全能匹配上、看不出问题，**改名/重名那天才开始错**。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SUPPORT_MENU_KEY,
  SUPPORT_PROBLEM_TYPES,
  SUPPORT_SEVERITIES,
  SUPPORT_STATUSES,
  modulePermission,
  parseDayToMs,
  fmtDay,
  supportAutoOwner,
  supportCompareRows,
  supportDefaultDueMs,
  supportInScope,
  supportMenuVisible,
  supportOverdueDays,
  supportPriorityOf,
  supportProblemHits,
  supportSeeAll,
  supportSignalsOf,
  type SupportCommLike,
  type SupportSignal,
} from '@acms/contracts';

// 测试文件在 apps/api/test/ ⇒ 回三层才是仓库根（两层会落在 apps/）
const root = new URL('../../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');

const DAY = 86400000;
/** 固定"今天"：2026-09-29 12:00 UTC（= 北京时间 20:00，同一天） */
const NOW = Date.UTC(2026, 8, 29, 12);
const comm = (daysAgo: number, extra: Partial<SupportCommLike> = {}): SupportCommLike => ({
  ms: NOW - daysAgo * DAY,
  ...extra,
});

describe('A. 信号判据（supportSignalsOf）', () => {
  it('从未沟通：0 条记录 ⇒ P0，且不再叠加其它信号（避免一张卡全是空证据）', () => {
    const s = supportSignalsOf({ comms: [] }, NOW);
    expect(s).toHaveLength(1);
    expect(s[0].key).toBe('neverContacted');
    expect(s[0].level).toBe('P0');
    expect(s[0].evidence).toContain('0 条');
  });

  it('长期失联：>14 天 ⇒ P0，证据里带**具体日期与天数**（老师要能判断轻重）', () => {
    const s = supportSignalsOf({ comms: [comm(67)] }, NOW);
    const x = s.find((v) => v.key === 'longSilence');
    expect(x?.level).toBe('P0');
    expect(x?.evidence).toContain('67 天');
    expect(x?.evidence).toMatch(/\d{2}-\d{2}/);
  });

  it('14 天整**不算**长期失联（阈值是 >14）；8~14 天算近期沉默 P1', () => {
    expect(supportSignalsOf({ comms: [comm(14)] }, NOW).some((v) => v.key === 'longSilence')).toBe(false);
    expect(supportSignalsOf({ comms: [comm(14)] }, NOW).some((v) => v.key === 'recentSilence')).toBe(true);
    expect(supportSignalsOf({ comms: [comm(8)] }, NOW).some((v) => v.key === 'recentSilence')).toBe(false);
    expect(supportSignalsOf({ comms: [comm(9)] }, NOW).some((v) => v.key === 'recentSilence')).toBe(true);
  });

  it('问题线索：只看**最近一条**记录（三年前的焦虑不该永远挂在看板上）', () => {
    const old = supportSignalsOf(
      { comms: [comm(30, { subject: '考试焦虑' }), comm(1, { subject: '课程咨询' })] },
      NOW,
    );
    expect(old.some((v) => v.key === 'problemClue')).toBe(false);
    const fresh = supportSignalsOf({ comms: [comm(1, { subject: '考试焦虑' })] }, NOW);
    expect(fresh.some((v) => v.key === 'problemClue')).toBe(true);
  });

  it('问题线索的证据里必须带**命中的原词**（不是只给个"有问题"的标签）', () => {
    const s = supportSignalsOf({ comms: [comm(1, { subject: '雷卿禾考试应激' })] }, NOW);
    const x = s.find((v) => v.key === 'problemClue');
    expect(x).toBeTruthy();
    expect(x!.evidence).toContain('「应激」');
  });

  it('反复沟通未缓解：近 30 天 ≥2 条且**都**命中同一类问题词', () => {
    const hit = supportSignalsOf(
      {
        comms: [
          comm(3, { subject: '缺数学课未交作业' }),
          comm(9, { subject: '作业未交情况说明' }),
        ],
      },
      NOW,
    );
    expect(hit.some((v) => v.key === 'unresolved')).toBe(true);
    // 只命中一次 ⇒ 不算"反复"
    const once = supportSignalsOf(
      { comms: [comm(3, { subject: '缺数学课未交作业' }), comm(9, { subject: '聊社团' })] },
      NOW,
    );
    expect(once.some((v) => v.key === 'unresolved')).toBe(false);
  });

  it('关系待建立（仅 1 条）与记录缺责任人（P2）', () => {
    const s = supportSignalsOf({ comms: [comm(2, { owner: '' })] }, NOW);
    expect(s.some((v) => v.key === 'thinRelation')).toBe(true);
    expect(s.some((v) => v.key === 'noOwner')).toBe(true);
    const withOwner = supportSignalsOf({ comms: [comm(2, { owner: '赵光宇｜Michael' })] }, NOW);
    expect(withOwner.some((v) => v.key === 'noOwner')).toBe(false);
  });

  it('正常学生（近期有沟通、有责任人、无问题词）⇒ **一条信号都没有**（不上板）', () => {
    const s = supportSignalsOf(
      { comms: [comm(1, { owner: '钟慧婷｜Alice', subject: '日常沟通' }), comm(3, { owner: '钟慧婷｜Alice' })] },
      NOW,
    );
    expect(s).toHaveLength(0);
    expect(supportPriorityOf(s)).toBe('');
  });

  it('问题词词典：按问题类型分组，且能推回问题类型（用于预选类型）', () => {
    const h = supportProblemHits('遇到考试会出现肚子疼、发高烧，情绪也很差');
    expect(h.words).toContain('情绪');
    expect(h.types).toContain('情绪与心理');
    // 中性词不该命中（否则等于没筛）
    const neutral = supportProblemHits('今天聊了考试安排与作业要求');
    expect(neutral.words).toHaveLength(0);
  });
});

describe('B. 分组与排序', () => {
  const mk = (key: string, level: 'P0' | 'P1' | 'P2'): SupportSignal => ({
    key: key as never,
    label: key,
    level,
    icon: '',
    evidence: '',
  });

  it('最高优先级决定分组：P0 > P1 > P2', () => {
    expect(supportPriorityOf([mk('a', 'P2'), mk('b', 'P0')])).toBe('P0');
    expect(supportPriorityOf([mk('a', 'P2'), mk('b', 'P1')])).toBe('P1');
  });

  it('同级别内：**最久没被想起的排最前**；从未沟通（null）排最前', () => {
    const list = [
      { level: 'P0' as const, lastDays: 14 },
      { level: 'P0' as const, lastDays: 67 },
      { level: 'P0' as const, lastDays: null },
      { level: 'P1' as const, lastDays: 999 },
    ];
    const sorted = [...list].sort(supportCompareRows);
    expect(sorted[0].lastDays).toBe(null);
    expect(sorted[1].lastDays).toBe(67);
    expect(sorted[2].lastDays).toBe(14);
    // P1 永远排在 P0 之后，哪怕它天数更大
    expect(sorted[3].lastDays).toBe(999);
  });
});

describe('C. 负责人自动推导（不让人手选）', () => {
  it('优先级：最近沟通人 > 班主任 > IDP 老师 > 空', () => {
    expect(supportAutoOwner({ commOwner: 'A', headTeacher: 'B', idpTeacher: 'C' })).toEqual({
      name: 'A',
      source: '最近沟通人',
    });
    expect(supportAutoOwner({ commOwner: '', headTeacher: 'B', idpTeacher: 'C' })).toEqual({
      name: 'B',
      source: '班主任',
    });
    expect(supportAutoOwner({ commOwner: '  ', headTeacher: '', idpTeacher: 'C' })).toEqual({
      name: 'C',
      source: 'IDP 老师',
    });
    expect(supportAutoOwner({})).toEqual({ name: '', source: '' });
  });
});

describe('D. 行级可见性（这一页最容易做废的地方）', () => {
  it('🔴 没有任何归属的学生 ⇒ **任何人都能看见**（否则"没人管的学生"恰好被筛掉）', () => {
    expect(supportInScope({ seeAll: false, owner: '', headTeacher: '', idpTeacher: '', me: '张老师' })).toBe(true);
    expect(supportInScope({ seeAll: false, me: '张老师' })).toBe(true);
  });

  it('看全部（studentSupportAll）⇒ 一律可见', () => {
    expect(supportInScope({ seeAll: true, owner: '别人', headTeacher: '别人', idpTeacher: '别人', me: '张老师' })).toBe(
      true,
    );
  });

  it('我的学生可见；别人的学生不可见', () => {
    expect(supportInScope({ seeAll: false, owner: '张老师', me: '张老师' })).toBe(true);
    expect(supportInScope({ seeAll: false, owner: '李老师', me: '张老师' })).toBe(false);
  });

  it('⚠️ 身份要同时认**姓名**与 **openId**（班主任存 openId、负责人存姓名，只传一个会漏判一半）', () => {
    // 班主任字段是 openId
    expect(
      supportInScope({ seeAll: false, headTeacher: 'ou_abc123', me: ['张老师', 'ou_abc123'] }),
    ).toBe(true);
    // 负责人字段是姓名
    expect(
      supportInScope({ seeAll: false, owner: '张老师｜Zhang', me: ['张老师', 'ou_abc123'] }),
    ).toBe(true);
  });

  it('数据范围开关：只有 studentSupportAll:read 才是"看全部"', () => {
    expect(supportSeeAll([modulePermission('studentSupportAll', 'read')])).toBe(true);
    // 光有页面权限 ≠ 能看全部
    expect(supportSeeAll([modulePermission('studentSupport', 'read')])).toBe(false);
    expect(supportSeeAll([])).toBe(false);
    expect(supportSeeAll(null)).toBe(false);
  });
});

describe('E. 超期与日期口径', () => {
  it('过期未更新 ⇒ 返回超期天数；已关闭的状态不再判超期', () => {
    const due = NOW - 2 * DAY;
    expect(supportOverdueDays({ status: '跟进中', dueMs: due }, NOW)).toBe(2);
    expect(supportOverdueDays({ status: '待认领', dueMs: due }, NOW)).toBe(2);
    expect(supportOverdueDays({ status: '已缓解', dueMs: due }, NOW)).toBe(null);
    expect(supportOverdueDays({ status: '已关闭', dueMs: due }, NOW)).toBe(null);
    // 没到期的返回 null（不是 0）
    expect(supportOverdueDays({ status: '跟进中', dueMs: NOW + DAY }, NOW)).toBe(null);
    expect(supportOverdueDays({ status: '跟进中', dueMs: 0 }, NOW)).toBe(null);
  });

  it('默认期望回应日期 = 今天 +3 天的当天 0 点（北京时间）', () => {
    const due = supportDefaultDueMs(NOW);
    expect(fmtDay(due)).toBe('2026-10-02');
    // 往返一致
    expect(parseDayToMs(fmtDay(due))).toBe(due);
  });

  it('状态机值域固定在代码里（字典可改文案，但状态不能由运营改）', () => {
    expect(SUPPORT_STATUSES).toEqual(['待认领', '跟进中', '已缓解', '已关闭', '已升级']);
  });
});

describe('F. 菜单可见性', () => {
  it('硬闸门：没有 studentSupport:read 一律看不到（含菜单与接口）', () => {
    expect(supportMenuVisible({ perms: [], menus: [] })).toBe(false);
    expect(supportMenuVisible({ perms: [modulePermission('studentSupport', 'read')] })).toBe(true);
  });

  it('菜单白名单：空白名单不额外限制；有白名单时**必须兼容学生记录的旧 key**', () => {
    const perms = [modulePermission('studentSupport', 'read')];
    expect(supportMenuVisible({ perms, menus: [] })).toBe(true);
    expect(supportMenuVisible({ perms, menus: [SUPPORT_MENU_KEY] })).toBe(true);
    // 生产实测：只有 Phase1 有 13 项白名单，且**不含任何新菜单 key**、含
    // studentObservations（合并前的旧 key）⇒ 严格只认新 key 会把招生老师整体挡在门外
    expect(supportMenuVisible({ perms, menus: ['studentObservations'] })).toBe(true);
    expect(supportMenuVisible({ perms, menus: ['studentRecords'] })).toBe(true);
    // 真正不在名单里的菜单仍然挡住
    expect(supportMenuVisible({ perms, menus: ['grades'] })).toBe(false);
  });
});

describe('G. 源码接线守卫（防"声明与判据错开一半"）', () => {
  const MP = read('packages/contracts/src/module-permissions.ts');
  const DICT = read('apps/api/src/dictionary/dict.data.ts');
  const SVC = read('apps/api/src/student-support/student-support.service.ts');
  const MOD = read('apps/api/src/student-support/student-support.module.ts');
  const PAGE = read('apps/web/app/student-support/page.tsx');
  const SHELL = read('apps/web/components/AppShell.tsx');

  it('权限版本抬到 9，且两个新资源的引入版本都是 9', () => {
    expect(MP).toContain('export const ROLE_PERMISSION_VERSION = 9;');
    const i = MP.indexOf('MODULE_RESOURCE_INTRODUCED_VERSION');
    const seg = MP.slice(i, i + 1400);
    expect(seg).toContain('studentSupport: 9');
    expect(seg).toContain('studentSupportAll: 9');
  });

  it('🔴 每个资源的引入版本必须 ≤ 当前版本（否则 `v <= toVersion` 永远过滤掉 ⇒ 永不迁移）', () => {
    const cur = Number(/ROLE_PERMISSION_VERSION = (\d+)/.exec(MP)?.[1] ?? 0);
    expect(cur).toBeGreaterThan(0);
    const i = MP.indexOf('MODULE_RESOURCE_INTRODUCED_VERSION');
    const seg = MP.slice(i, MP.indexOf('};', i));
    for (const m of seg.matchAll(/(\w+):\s*(\d+)/g)) {
      expect(Number(m[2]), `${m[1]} 的引入版本 ${m[2]} 不能大于当前版本 ${cur}`).toBeLessThanOrEqual(cur);
    }
  });

  it('🔴 studentSupport 的继承源必须是 meetingMinutes:read —— **不能**是 dailyFollowups:read', () => {
    // dailyFollowups:read 被 student / parent 持有 ⇒ 继承它等于把老师端看板发给学生和家长
    const i = MP.indexOf("key: 'studentSupport'");
    const seg = MP.slice(i, MP.indexOf('},', i));
    expect(seg).toContain("legacyRead: 'module:meetingMinutes:read'");
    expect(seg).not.toContain('dailyFollowups');
  });

  it('🔴 studentSupportAll 三件套：legacyRead null（不自动发放）+ 只给 read + subOf（矩阵里能勾到）', () => {
    const i = MP.indexOf("key: 'studentSupportAll'");
    const seg = MP.slice(i, MP.indexOf('},', i));
    expect(seg).toContain('legacyRead: null');
    expect(seg).toContain("actions: ['read']");
    expect(seg).toContain("subOf: 'studentSupport'");
    // 假路径，避免抢 /student-support 的 moduleByPath 匹配
    expect(seg).toContain("path: '/student-support/all'");
  });

  it('🔴 问题类型 / 严重程度字典**直接引用 contracts 常量**（手抄会在增删类型后静默错位）', () => {
    expect(DICT).toContain('SUPPORT_PROBLEM_TYPES');
    expect(DICT).toContain('SUPPORT_SEVERITIES');
    expect(DICT).toContain('支持问题类型: [...SUPPORT_PROBLEM_TYPES]');
    expect(DICT).toContain('支持严重程度: [...SUPPORT_SEVERITIES]');
    // 峰哥给的口径，逐项相等
    expect([...SUPPORT_PROBLEM_TYPES]).toEqual([
      '学业困难',
      '情绪与心理',
      '出勤与作息',
      '家庭情况',
      '人际社交',
      '升学规划',
      '行为与纪律',
      '其他',
    ]);
    expect([...SUPPORT_SEVERITIES]).toEqual(['关注', '需介入', '紧急']);
  });

  it('🔴 静态路由 `board` 必须排在 `@Get(\':studentId\')` 之前（否则被当成学生 id，静默失效）', () => {
    // ⚠️ 用 lastIndexOf：文件头**注释里**也写了这两个装饰器名（讲这条规矩），
    //    用 indexOf 会命中注释、断言就变成看注释位置了（第一次就踩了）。
    const iBoard = MOD.lastIndexOf("@Get('board')");
    const iOpt = MOD.lastIndexOf("@Get('owner-options')");
    const iParam = MOD.lastIndexOf("@Get(':studentId')");
    expect(iBoard).toBeGreaterThan(0);
    expect(iOpt).toBeGreaterThan(0);
    expect(iParam).toBeGreaterThan(0);
    expect(iBoard).toBeLessThan(iParam);
    expect(iOpt).toBeLessThan(iParam);
  });

  it('🔴 关联学生必须用 `关联学生编号`（id 数组），**不能**用 `关联学生`（姓名字符串）', () => {
    expect(SVC).toContain("idpLinkIds(f['关联学生编号'])");
    // 姓名只允许作兜底（byName），不能当唯一来源
    expect(SVC).toContain('byName');
  });

  it('聚合里必须过滤「在校生」（学生档案里混着潜在学生/退学等状态）', () => {
    expect(SVC).toContain('idpIsEnrolled');
  });

  it('写动作与读动作走同一个权限判据（老师没有任何"都持有"的写权限点）', () => {
    expect(SVC).toContain("requireModule(user, 'studentSupport', 'read')");
    // 不允许出现 studentSupport:update 这种不存在的点
    expect(SVC).not.toContain("'studentSupport', 'update'");
    expect(MOD).not.toContain("'studentSupport', 'update'");
  });

  it('菜单可见性接在 AppShell 的 canSeeItem 上（只藏按钮不算，前端必须真判）', () => {
    expect(SHELL).toContain('supportMenuVisible');
    expect(SHELL).toContain('SUPPORT_MENU_KEY');
  });

  it('前端的问题类型 / 严重程度候选读字典（峰哥要求），只在读不到时兜底', () => {
    expect(PAGE).toContain("dict['支持问题类型']");
    expect(PAGE).toContain("dict['支持严重程度']");
    expect(PAGE).toContain('supportProblemTypeOptions');
    expect(PAGE).toContain('supportSeverityOptions');
  });

  it('前端不自己算超期 / 分组（判据只在后端一份，两处各算必然出现"卡片与详情矛盾"）', () => {
    // ⚠️ 只看 **import 块**：文件头注释里会提到这些函数名（说明"判据在后端"），
    //    直接 includes 会命中注释（第一次就踩了）。
    const imp = /import\s*\{[\s\S]*?\}\s*from\s*'@acms\/contracts'/.exec(PAGE)?.[0] ?? '';
    expect(imp).not.toContain('supportOverdueDays');
    expect(imp).not.toContain('supportSignalsOf');
    expect(imp).not.toContain('supportPriorityOf');
    expect(imp).not.toContain('supportAutoOwner');
    // 但格式化与"默认日期"这类**纯展示**工具是要用的
    expect(imp).toContain('fmtDay');
    expect(imp).toContain('supportDefaultDueMs');
  });

  it('建表在模块 onModuleInit 里（通用 CRUD 只生成路由、不建表）', () => {
    expect(MOD).toContain('ensureTable');
    expect(MOD).toContain('TABLES.studentSupport.tableId');
  });
});
