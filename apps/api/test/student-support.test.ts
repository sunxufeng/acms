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
  SUPPORT_LEVELS,
  SUPPORT_MENU_KEY,
  SUPPORT_PROBLEM_MIN_WORDS,
  SUPPORT_PROBLEM_TYPES,
  SUPPORT_PROBLEM_WORD_LIST,
  SUPPORT_SEVERITIES,
  SUPPORT_STRONG_WORDS,
  SUPPORT_UNRESOLVED_MIN_COUNT,
  SUPPORT_STATUSES,
  modulePermission,
  parseDayToMs,
  fmtDay,
  supportAutoOwner,
  supportCompareRows,
  supportDefaultDueMs,
  supportInScope,
  supportLevelRank,
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
      { comms: [comm(30, { subject: '考试应激' }), comm(1, { subject: '课程咨询' })] },
      NOW,
    );
    expect(old.some((v) => v.key === 'problemClue')).toBe(false);
    const fresh = supportSignalsOf({ comms: [comm(1, { subject: '考试应激' })] }, NOW);
    expect(fresh.some((v) => v.key === 'problemClue')).toBe(true);
  });

  it('问题线索的证据里必须带**命中的原词**（不是只给个"有问题"的标签）', () => {
    const s = supportSignalsOf({ comms: [comm(1, { subject: '雷卿禾考试应激' })] }, NOW);
    const x = s.find((v) => v.key === 'problemClue');
    expect(x).toBeTruthy();
    expect(x!.evidence).toContain('「应激」');
  });

  it('反复沟通未缓解：近 30 天 ≥3 条且**都**命中同一类问题词（阈值 2 会命中 49%）', () => {
    const hit = supportSignalsOf(
      {
        comms: [
          comm(3, { subject: '又缺数学课了' }),
          comm(9, { subject: '缺数学课情况' }),
          comm(16, { subject: '缺数学课未到' }),
        ],
      },
      NOW,
    );
    expect(hit.some((v) => v.key === 'unresolved')).toBe(true);
    // ⚠️ 三条记录必须命中**同一类**问题词；混着两类（如两条"缺课"+两条"未交作业"）
    //    各只到 2 条，不算"反复谈同一件事"（这正是本判据的语义，不是 bug）。
    // 只有 2 条 ⇒ 不算"反复"（那是一个月正常谈过两次）
    const twice = supportSignalsOf(
      { comms: [comm(3, { subject: '缺数学课未交作业' }), comm(9, { subject: '作业未交情况说明' })] },
      NOW,
    );
    expect(twice.some((v) => v.key === 'unresolved')).toBe(false);
    // 只有一条命中 ⇒ 也不算
    const once = supportSignalsOf(
      {
        comms: [
          comm(3, { subject: '缺数学课未交作业' }),
          comm(9, { subject: '聊社团' }),
          comm(16, { subject: '聊社团' }),
        ],
      },
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
    // ⚠️ 不能再用「情绪」—— 它是本轮被移除的宽词（见 A2 段的说明）
    const h = supportProblemHits('遇到考试会出现肚子疼、发高烧，失眠严重');
    expect(h.words).toContain('失眠');
    expect(h.types).toContain('情绪与心理');
    // 中性词不该命中（否则等于没筛）
    const neutral = supportProblemHits('今天聊了考试安排与作业要求');
    expect(neutral.words).toHaveLength(0);
  });
});

describe('A2. 词表与门槛（2026-09-30 上线后调优：命中率 56% → 21%）', () => {
  it('🔴 词表**不含**这些"宽词"—— 它们在 AI 长文总结里天天出现、且多在否定或中性语境', () => {
    // 「没有违纪」「时间冲突」「情绪高涨」「美国心理学方向」「请假流程」「作息规律」
    // 实测：第一版收了它们 ⇒ problemClue 命中 42/75 人（56%），看板失去优先级意义。
    const flat = SUPPORT_PROBLEM_WORD_LIST.map((x) => x.word);
    for (const w of ['情绪', '压力', '心理', '紧张', '冲突', '矛盾', '请假', '家庭', '家访',
                     '人际', '纪律', '作息', '同学关系', '选校', '选科', '文书', '标化', '申请季']) {
      expect(flat, `「${w}」是宽词，不该出现在词表里（见 SUPPORT_PROBLEM_WORDS 的注释）`).not.toContain(w);
    }
  });

  it('🔴 单独一个泛词**不算**问题线索；命中强词、或 ≥2 个词才算', () => {
    // 只命中「学习问题」（泛词，1 个）⇒ 不算：这类记录多半是老师已在处理的日常评价
    const one = supportSignalsOf({ comms: [comm(1, { subject: '英语学习问题突出' })] }, NOW);
    expect(one.some((v) => v.key === 'problemClue')).toBe(false);
    // 命中两个词 ⇒ 算
    const two = supportSignalsOf({ comms: [comm(1, { subject: '学习问题突出，跟不上' })] }, NOW);
    expect(two.some((v) => v.key === 'problemClue')).toBe(true);
    // 命中强词（单独就够）⇒ 算
    const strong = supportSignalsOf({ comms: [comm(1, { subject: '近期失眠严重' })] }, NOW);
    expect(strong.some((v) => v.key === 'problemClue')).toBe(true);
  });

  it('强词表与词表必须同源（强词也得在词表里，否则永远匹配不上）', () => {
    const flat = new Set(SUPPORT_PROBLEM_WORD_LIST.map((x) => x.word));
    for (const w of SUPPORT_STRONG_WORDS) {
      expect(flat.has(w), `强词「${w}」不在 SUPPORT_PROBLEM_WORDS 里`).toBe(true);
    }
    expect(SUPPORT_PROBLEM_MIN_WORDS).toBe(2);
  });

  it('🔴 unresolved 阈值 = 3（近 30 天 2 条记录是常态，不是"反复"）', () => {
    expect(SUPPORT_UNRESOLVED_MIN_COUNT).toBe(3);
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

  it('权限版本 ≥ 9，学生支持两个资源引入版本恒为 9（引入版本必须等于当次抬的版本）', () => {
    // ⚠️ 别再写死 `= N`：每加一批资源都会抬版本，写死就得每次回来改（已撞三次，见 idp.test.ts 的同款注释）
    const cur = Number(/ROLE_PERMISSION_VERSION = (\d+)/.exec(MP)?.[1] ?? 0);
    expect(cur).toBeGreaterThanOrEqual(9);
    const i = MP.indexOf('MODULE_RESOURCE_INTRODUCED_VERSION');
    const seg = MP.slice(i, i + 1700);
    expect(seg, 'studentSupport 的引入版本必须恒为 9（它是在 v9 引入的）').toContain('studentSupport: 9');
    expect(seg).toContain('studentSupportAll: 9');
    // v10（2026-09-30）：「移除卡片」是独立权限点，引入版本 10
    expect(seg).toContain('studentSupportRemove: 10');
    expect(cur).toBeGreaterThanOrEqual(10);
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

describe('H. 登记入口（2026-09-30 峰哥：「登记支持按钮在哪里」）', () => {
  const MP = read('packages/contracts/src/module-permissions.ts');
  const SVC = read('apps/api/src/student-support/student-support.service.ts');
  const MOD = read('apps/api/src/student-support/student-support.module.ts');
  const PAGE = read('apps/web/app/student-support/page.tsx');
  const API = read('apps/web/lib/api.ts');
  const CONTRACTS = read('packages/contracts/src/student-support.ts');
  const ZH = read('apps/web/messages/zh.json');

  it('🔴 `student-options` 是静态路由，必须排在 `@Get(\':studentId\')` 之前', () => {
    // ⚠️ 与 G 段同因：**必须用 lastIndexOf** —— 文件头注释里也写了这几个装饰器名，
    //    `indexOf` 会命中注释（第 16 行），断言就变成"看注释位置"了（第一次写就踩了）。
    const iOpt = MOD.lastIndexOf("@Get('student-options')");
    const iParam = MOD.lastIndexOf("@Get(':studentId')");
    expect(iOpt).toBeGreaterThan(0);
    expect(iParam).toBeGreaterThan(0);
    expect(iOpt, 'student-options 排在 :studentId 之后 ⇒ 会被当成学生 id，静默失效').toBeLessThan(iParam);
    // 三个静态路由都要在参数路由之前（board / owner-options / student-options）
    expect(MOD.lastIndexOf("@Get('board')")).toBeLessThan(iParam);
    expect(MOD.lastIndexOf("@Get('owner-options')")).toBeLessThan(iParam);
  });

  it('🔴 学生候选**必须包含没上板的学生**（否则这个入口就没意义了）', () => {
    // board 里靠 `if (!signals.length) continue` 把无信号的学生挡在板外 ——
    // studentOptions 里**不能**有这一句，否则"看板上没有的人"在选择器里也找不到，
    // 峰哥要的「主动给一个没信号的学生登记」还是做不到（而且不报错）。
    const i = SVC.indexOf('async studentOptions(');
    const j = SVC.indexOf('// ─────────────────────────', i);
    const body = SVC.slice(i, j > i ? j : i + 4000);
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toContain('if (!signals.length) continue');
    // 但必须标记他有没有上板（前端要给出「当前无信号」的提示）
    expect(body).toContain('onBoard:');
  });

  it('🔴 学生候选的范围判据与看板**同一份**（不能因为搜得到就绕过行级限制）', () => {
    const i = SVC.indexOf('async studentOptions(');
    const body = SVC.slice(i, i + 3000);
    // 判据全抽到 helper 里共用（各写一份必然漂移）
    expect(body).toContain('this.loadContext(');
    expect(body).toContain('this.ctxOf(');
    expect(body).toContain('this.inScopeOf(');
    // helper 里落的必须是 contracts 那一份判据 + 本模块共用的负责人推导
    expect(SVC).toContain('supportInScope({');
    expect(SVC).toContain('private ctxOf(');
    expect(SVC).toContain('private inScopeOf(');
    expect(SVC).toContain('this.resolveOwner(');
    // 反向：不许在学生候选里自己重新推导负责人
    expect(body).not.toContain('supportAutoOwner(');
  });

  it('🔴🔴 写动作的范围校验**不得**走 `detail()`（detail 依赖 board ⇒ 给"看板上没有的学生"登记必然 404）', () => {
    // 2026-09-30 上线实测踩到：save 里原为 `const { row } = await this.detail(...)` ⇒
    // 「＋ 登记支持」里选一个**无信号**的学生 → POST claim **404**、库里 0 行。
    // 而这个入口的全部意义就是给"看板上没有的人"登记 —— 属于"功能上线即残废且不报错"。
    const i = SVC.indexOf('async save(');
    // 🔴 断言前**必须先剥掉注释行** —— 本条的每一版都被注释骗过：
    //    · 第一版：注释里为了讲规矩写了「这里不能用 `this.detail()`」⇒ `not.toContain` 永远失败
    //    · 第二版：窗口取太长，把后面 `detail()` 方法体里真正的那句 `this.board(` 框进来了
    //    ⇒ 源码守卫的通用做法：**窗口贴紧 + 剥注释**，否则断言测的是注释不是代码。
    const strip = (s: string) =>
      s
        .split('\n')
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');
    const upto = (from: string, next: string, fallback: number) => {
      const a = SVC.indexOf(from);
      const b = SVC.indexOf(next, a + from.length);
      return strip(SVC.slice(a, b > a ? b : a + fallback));
    };

    const seg = upto('async save(', '\n  async ', 2200);
    expect(seg).not.toContain('this.detail(');
    expect(seg).toContain('this.studentCtx(');
    // studentCtx 自己也不许依赖 board（board 只收"有信号"的学生）
    const sc = upto('private async studentCtx(', '\n  async ', 1400);
    expect(sc).not.toContain('this.board(');
    expect(sc).toContain('this.loadContext(');
    expect(sc).toContain('this.inScopeOf(');
    // detail 那边也留了反向提示，防止有人"顺手"把两者合并回去
    expect(SVC).toContain('写动作不要复用本方法');
  });

  it('负责人推导与 IDP 老师索引都抽成了共用方法（board 与 studentOptions 各一份必然漂移）', () => {
    expect(SVC).toContain('private resolveOwner(');
    expect(SVC).toContain('private async idpTeacherIndex(');
    // board 里不能再有内联的 idpTeacherOf 构建
    const iBoard = SVC.indexOf('async board(');
    const board = SVC.slice(iBoard, iBoard + 3000);
    expect(board).toContain('this.idpTeacherIndex()');
    expect(board).toContain('this.resolveOwner(');
    expect(board).not.toContain("idpTeacherOf.set(");
  });

  it('契约层有 SupportStudentOption，且前端接口层挂的是本模块端点', () => {
    expect(CONTRACTS).toContain('export interface SupportStudentOption');
    expect(CONTRACTS).toContain('onBoard: boolean');
    expect(API).toContain("'/student-support/student-options'");
  });

  it('🔴 登记表单字段**只有一份定义**（RegisterFields），抽屉与弹窗共用', () => {
    expect(PAGE).toContain('function RegisterFields(');
    // 抽屉里已改为渲染共用组件
    expect(PAGE).toContain('<RegisterFields');
    // 字段标签在整页里只应出现一次（都在 RegisterFields 内部）
    // ⚠️ 模式不带右括号：`dueHint` 是带参数的 `t('dueHint', { n })`，
    //    写死 `t('dueHint')` 会永远匹配 0 次 —— 断言反而变成"永远通过"的反向假象。
    for (const key of ['problemType', 'severity', 'problemText', 'dueHint']) {
      const n = (PAGE.match(new RegExp(`t\\('${key}'`, 'g')) ?? []).length;
      expect(n, `t('${key}' 出现了 ${n} 次 —— 字段定义被复制了一份，两处必然漂移`).toBe(1);
    }
    // 表单 state 只有一组（六个字段）
    expect(PAGE).toContain('const regValues = useMemo(');
    expect(PAGE).toContain('const patchReg = useCallback(');
  });

  it('🔴 卡片的快捷登记按钮必须 stopPropagation（否则点按钮会同时打开抽屉）', () => {
    const i = PAGE.indexOf('function SupportCard(');
    const card = PAGE.slice(i, i + 4000);
    expect(card).toContain('onClaim');
    expect(card).toContain('e.stopPropagation()');
    // 卡片上要能看出"已认领的人显示更新登记"（同一个按钮，语义随状态变）
    expect(card).toContain("t('claimAndRegister')");
    expect(card).toContain("t('updateRegister')");
  });

  it('页头有「＋ 登记支持」与「导出」（设计稿里有、首版漏做的两个）', () => {
    expect(PAGE).toContain("t('addSupport')");
    expect(PAGE).toContain("t('exportCsv')");
    expect(PAGE).toContain('onClick={exportCsv}');
    expect(PAGE).toContain('openRegister(null)');
  });

  it('导出 CSV 带 BOM（不带的话 Excel 打开是乱码）且口径是后端算好的 rows', () => {
    const i = PAGE.indexOf('const exportCsv = useCallback(');
    const seg = PAGE.slice(i, i + 1800);
    expect(seg).toContain('\\ufeff');
    expect(seg).toContain('text/csv;charset=utf-8');
    // 不重算判据：只用行里已有的字段
    expect(seg).not.toContain('supportSignalsOf');
    expect(seg).not.toContain('supportOverdueDays');
  });

  it('学生选择器里「没上板的排在前面」的意图写在注释里（下次别改成过滤掉）', () => {
    expect(PAGE).toContain('const stuHits = useMemo(');
    expect(PAGE).toContain('Number(a.onBoard) - Number(b.onBoard)');
  });

  it('弹窗的提交走与抽屉同一个 doSubmit（两处各写一份 ⇒ 会出现只有一条路径报错）', () => {
    expect(PAGE).toContain('const doSubmit = useCallback(');
    expect(PAGE).toContain('const submitRegister = useCallback(');
    // submit（抽屉）与 submitRegister（弹窗）都调用 doSubmit，且不再各自直连 api
    const iDrawer = PAGE.indexOf('const submit = useCallback(');
    const drawer = PAGE.slice(iDrawer, iDrawer + 700);
    expect(drawer).toContain('doSubmit(');
    expect(drawer).not.toContain('api.studentSupportSave(');
    const iReg = PAGE.indexOf('const submitRegister = useCallback(');
    const reg = PAGE.slice(iReg, iReg + 700);
    expect(reg).toContain('doSubmit(');
    expect(reg).not.toContain('api.studentSupportSave(');
  });

  it('新文案齐（中英都要有，否则英文界面下弹出空按钮）', () => {
    for (const k of ['addSupport', 'exportCsv', 'pickHint', 'searchStudent', 'onBoard', 'offBoard',
                     'changeStudent', 'cancel', 'claimAndRegister', 'updateRegister',
                     'colProblemType', 'colSeverity', 'colDue', 'colCommCount', 'colOverdue']) {
      expect(ZH, `zh.json 缺 ${k}`).toContain(`"${k}"`);
    }
    const EN = read('apps/web/messages/en.json');
    for (const k of ['addSupport', 'claimAndRegister', 'cancel', 'searchStudent']) {
      expect(EN, `en.json 缺 ${k}`).toContain(`"${k}"`);
    }
  });

  it('权限没变：登记入口不需要新的权限点（能看看板 = 能登记，见 module-permissions v9）', () => {
    // 反面：如果哪天有人给"登记"造一个 update 点，老师会点不动（教职工的写点交集为空）
    const i = MP.indexOf("key: 'studentSupport'");
    const seg = MP.slice(i, i + 900);
    expect(seg).toContain('genericCrud: false');
    expect(SVC).toContain("requireModule(user, 'studentSupport', 'read')");
  });
});

describe('I. 已认领无信号（claimed）+ 移除卡片（v10）—— 峰哥 2026-09-30 六条需求之一二四', () => {
  const MP = read('packages/contracts/src/module-permissions.ts');
  const SVC = read('apps/api/src/student-support/student-support.service.ts');
  const MOD = read('apps/api/src/student-support/student-support.module.ts');
  const PAGE = read('apps/web/app/student-support/page.tsx');
  const API = read('apps/web/lib/api.ts');

  it('🔴 claimed 是独立级别、排在最后（不代表紧急，只代表"要看得见"）', () => {
    expect(SUPPORT_LEVELS.map((g) => g.level)).toEqual(['P0', 'P1', 'P2', 'claimed']);
    expect(supportLevelRank('P0')).toBeLessThan(supportLevelRank('P1'));
    expect(supportLevelRank('P1')).toBeLessThan(supportLevelRank('P2'));
    expect(supportLevelRank('P2')).toBeLessThan(supportLevelRank('claimed'));
  });

  it('🔴 上板条件 = 有信号 **或** 有未关闭支持行 **或** 被移除过（三个条件缺一不可）', () => {
    expect(SVC).toContain('if (!signals.length && !openSup && !dis) continue;');
    expect(SVC).toContain('const openSup = Boolean(supPreview) && supportIsOpen(');
    // 没信号但有支持行 ⇒ 进 claimed（不是 P2）
    expect(SVC).toContain("level: signals.length ? supportPriorityOf(signals) || 'P2' : 'claimed',");
  });

  it('🔴🔴 `dis` 必须在**上板条件的 continue 之前**算出来（上线实测抓到的真 bug）', () => {
    // 被移除的学生绝大多数**没有信号**（正因为没信号才被当误报移除）。
    // 若 `dis` 算在上板条件之后 ⇒ 他们在 continue 处就被剔掉了，
    // 永远走不到 dismissed 分支 ⇒ dismissedCount 恒 0、名单里也没有他 ⇒
    // **从界面上再也恢复不了**（无声的数据消失，且不报错）。
    const iDis = SVC.indexOf('const dis = this.dismissedOf(');
    const iGate = SVC.indexOf('if (!signals.length && !openSup');
    expect(iDis).toBeGreaterThan(0);
    expect(iGate).toBeGreaterThan(0);
    expect(iDis, 'dismissedOf 必须排在「上板条件」之前').toBeLessThan(iGate);
    // 且判定分支只有一处（重复算两次说明有人把顺序调回去了）
    expect((SVC.match(/this\.dismissedOf\(/g) ?? []).length).toBe(1);
  });

  it('🔴 `needSupport` 只数有信号的人，claimed 单独一格（两者互斥、相加才是总行数）', () => {
    expect(SVC).toContain('needSupport: out.length - claimedOnly');
    expect(SVC).toContain('claimedOnly,');
  });

  it('「移除卡片」是**独立权限点**，且不随版本迁移发放（破坏性操作不能人人有）', () => {
    const i = MP.indexOf("key: 'studentSupportRemove'");
    expect(i).toBeGreaterThan(0);
    const seg = MP.slice(i, i + 800);
    expect(seg).toContain('legacyRead: null');
    expect(seg).toContain("subOf: 'studentSupport'");
    expect(seg).toContain("actions: ['read']");
    const j = MP.indexOf('MODULE_RESOURCE_INTRODUCED_VERSION');
    expect(MP.slice(j, j + 1800)).toContain('studentSupportRemove: 10');
  });

  it('🔴 `dismiss()` 单独判权限 + 走范围校验 + 必须填原因', () => {
    const i = SVC.indexOf('async dismiss(');
    expect(i).toBeGreaterThan(0);
    const body = SVC.slice(i, i + 1600);
    expect(body).toContain("requireModule(user, 'studentSupportRemove', 'read')");
    expect(body).toContain('this.studentCtx(');
    expect(body).toContain('REASON_REQUIRED');
  });

  it('🔴 忽略是**学生级**判据（任一行有标记即隐藏），且只认「是」', () => {
    const i = SVC.indexOf('private dismissedOf(');
    expect(i).toBeGreaterThan(0);
    const seg = SVC.slice(i, i + 400);
    expect(seg).toContain('supportDismissed(');
    // 反向：别自己写 === '是'（判据在 contracts，只此一份）
    expect(seg).not.toContain("=== '是'");
    // 被移除的人**不算 hiddenByScope**（那个数字的含义是"被权限挡掉的"）
    // ⚠️ 窗口必须**贴紧到下一个判定块**：固定长度（如 +800）会把后面那句
    //    `if (!inScope) { hiddenByScope += 1; ... }` 框进来 —— 断言就测错了对象。
    const j = SVC.indexOf('if (dis) {');
    const k = SVC.indexOf('if (!inScope) {', j);
    const dis = SVC.slice(j, k > j ? k : j + 400);
    expect(dis).toContain('dismissedCount += 1');
    expect(dis).not.toContain('hiddenByScope += 1');
  });

  it('被移除的名单只对有权限者返回', () => {
    expect(SVC).toContain('if (canRemove) {');
    expect(SVC).toContain('dismissed: dismissedList');
    expect(API).toContain('}/dismiss'); // 模板字符串：`/student-support/${id}/dismiss`
    expect(PAGE).toContain('data?.canRemove');
  });

  it('建表包含忽略四字段（漏了就是写不进去、且不报错）', () => {
    for (const f of ['已忽略', '忽略原因', '忽略人', '忽略时间']) {
      expect(MOD, `建表缺 ${f}`).toContain(`name: '${f}'`);
    }
  });

  it('「记一次沟通」不再开新 tab，改为页内 formOnly 新建（复用学生记录的 columns）', () => {
    expect(PAGE).not.toContain("window.open('/student-records'");
    expect(PAGE).toContain("buildStudentRecordColumns('日常跟进')");
    expect(PAGE).toContain('formOnly={{');
    // 🔴 columns / api 必须 useMemo 稳定（CrudPage 依赖它们 ⇒ 不稳定就是渲染死循环）
    expect(PAGE).toContain('const commColumns = useMemo(');
    expect(PAGE).toContain('const commApi = useMemo(');
    expect(PAGE).toContain('关联学生: cur.name');
    expect(PAGE).toContain('沟通时间: nowMinuteText()');
  });

  it('claimed 分组在前端默认折叠、颜色中性', () => {
    expect(PAGE).toContain("new Set(['P2', 'claimed', 'done'])");
    expect(PAGE).toContain("level === 'claimed'");
  });

  it('看板快照复用 board（不另写一份统计）—— 否则任务数字与页面必然不一致', () => {
    const i = SVC.indexOf('async snapshot(');
    expect(i).toBeGreaterThan(0);
    const seg = SVC.slice(i, i + 900);
    expect(seg).toContain('this.board(system)');
    // 反向：不许在 snapshot 里自己循环数数
    expect(seg).not.toContain('supportSignalsOf(');
  });
});
