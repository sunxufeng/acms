/**
 * IDP 重构（2026-09-26）的守卫测试。
 *
 * 两类断言，各有明确目的：
 *
 * **A. 纯函数行为** —— 这些判据被「后端重算 / 后端聚合 / 前端展示 / 单测」四处共用，
 *    写错一处就是"数字看着有值、其实是错的"。
 *    尤其是 `idpIsEnrolled`：生产真实值是「**在校在读**」（不是「在校」），
 *    我第一版差点写成严格等值 —— 那样 82 个在校生会被全部排除、拉学生拉出 0 人且不报错。
 *
 * **B. 源码接线守卫** —— 本项目最贵的一类 bug 是"声明与判据错开一半、静默失效"：
 *    · 「我的 IDP」若挂了 `idpPlans` 权限点 ⇒ 老师们（Phase1~9）**上线即看不到菜单**；
 *    · 重拉学生若把 `IDP老师` 一起写 ⇒ **人工分配的导师被静默清空**；
 *    · 抽屉里若把附件写进 `沟通附件`（少一个"清单"）⇒ 那是 meta 的 `readonly` 字段，
 *      写入侧会被**静默丢弃**，用户传完发现附件没了。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  IDP_ARCHIVED,
  IDP_CONFIG_FIELDS,
  IDP_STUDENT_FIELDS,
  MY_IDP_MENU_KEY,
  idpConfigKey,
  idpIsEnrolled,
  idpLinkId,
  idpLinkIds,
  idpStudentKey,
  idpSummarizeComms,
  idpTextOf,
  idpTermRange,
  IDP_STATS_MENU_KEY,
  idpDaysAgo,
  idpGapDaysAsc,
  idpMenuVisible,
  idpMonthKey,
  idpStatsSeeAll,
  modulePermission,
} from '@acms/contracts';

// 测试文件在 apps/api/test/ ⇒ 回三层才是仓库根（两层会落在 apps/）
const root = new URL('../../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');

// 生产实测的学年（2026-09-26）：
//   2026-2027学年 = 1788192000000 ~ 1819727999000（2026-09-01 ~ 2027-08-31）
const Y_START = Date.parse('2026-09-01T00:00:00+08:00');
const Y_END = Date.parse('2027-08-31T23:59:59+08:00');

describe('A. 学年学期 → 统计区间（idpTermRange）', () => {
  it('2026-2027 学年 + 2026秋 → 开学日起到次年 1/31', () => {
    const r = idpTermRange(Y_START, Y_END, '2026秋');
    expect(r).not.toBeNull();
    expect(new Date(r!.from).getFullYear()).toBe(2026);
    expect(new Date(r!.from).getMonth()).toBe(8); // 9 月
    expect(new Date(r!.to).getMonth()).toBe(0); // 次年 1 月
    expect(new Date(r!.to).getFullYear()).toBe(2027);
  });

  it('2026-2027 学年 + 2027春 → 次年 2/1 到学年结束', () => {
    const r = idpTermRange(Y_START, Y_END, '2027春');
    expect(r).not.toBeNull();
    expect(new Date(r!.from).getFullYear()).toBe(2027);
    expect(new Date(r!.from).getMonth()).toBe(1); // 2 月
    expect(r!.to).toBeGreaterThanOrEqual(Y_END - 24 * 3600 * 1000);
  });

  it('🔴 学期与学年对不上 ⇒ null（**不能退化成整学年统计**，那会把别的学期算进来）', () => {
    expect(idpTermRange(Y_START, Y_END, '2027秋')).toBeNull();
    expect(idpTermRange(Y_START, Y_END, '2025春')).toBeNull();
    expect(idpTermRange(Y_START, Y_END, '2026春')).toBeNull();
  });

  it('学年日期缺失 / 学期格式不对 ⇒ null', () => {
    expect(idpTermRange('', Y_END, '2026秋')).toBeNull();
    expect(idpTermRange(Y_START, '', '2026秋')).toBeNull();
    expect(idpTermRange(Y_START, Y_END, '2026秋季')).toBeNull();
    expect(idpTermRange(Y_START, Y_END, '')).toBeNull();
  });

  it('时间字段宽容解析：年份-月份-日期串也算得出来（别用 Number()，那会 NaN）', () => {
    const r = idpTermRange('2026-09-01', '2027-08-31', '2026秋');
    expect(r).not.toBeNull();
    expect(new Date(r!.from).getMonth()).toBe(8);
  });
});

describe('A. 在校判据（idpIsEnrolled）', () => {
  it('🔴 生产真实值是「在校在读」—— 必须算在校（严格等值 "在校" 会漏掉全部 82 人）', () => {
    expect(idpIsEnrolled('在校在读')).toBe(true);
    expect(idpIsEnrolled('在校')).toBe(true);
  });

  it('状态为空也算在校（"读不到 ≠ 0"，别让缺失值静默排除学生）', () => {
    expect(idpIsEnrolled('')).toBe(true);
    expect(idpIsEnrolled(null)).toBe(true);
    expect(idpIsEnrolled(undefined)).toBe(true);
  });

  it('毕业 / 离校 / 流失 / 退学 排除（与成绩册班级名单同一份判据）', () => {
    for (const s of ['已毕业', '毕业', '离校', '已离校', '流失', '退学']) {
      expect(idpIsEnrolled(s), s).toBe(false);
    }
  });
});

describe('A. 沟通次数口径（idpSummarizeComms）', () => {
  const range = { from: Date.parse('2026-09-01T00:00:00+08:00'), to: Date.parse('2027-01-31T23:59:59+08:00') };
  const inRange = Date.parse('2026-10-10T10:00:00+08:00');

  it('只数区间内的；区间外的与时间读不出来的都不计入', () => {
    const stat = idpSummarizeComms(
      [
        { time: inRange },
        { time: Date.parse('2026-12-01T00:00:00+08:00') },
        { time: Date.parse('2026-03-01T00:00:00+08:00') }, // 区间外（上一学期）
        { time: '' }, // 读不出 → 单独计数
      ],
      range,
    );
    expect(stat.count).toBe(2);
    expect(stat.noTime).toBe(1);
  });

  it('最近一次的时间与摘要取**最新那条**（主题优先，退回总结截断）', () => {
    const stat = idpSummarizeComms(
      [
        { time: inRange, subject: '第一次', summary: 'aaa' },
        { time: Date.parse('2026-11-05T09:00:00+08:00'), subject: '第二次', summary: 'bbb' },
        { time: Date.parse('2026-10-20T09:00:00+08:00'), summary: 'ccc' },
      ],
      range,
    );
    expect(stat.count).toBe(3);
    expect(new Date(stat.lastAt).getMonth()).toBe(10); // 11 月
    expect(stat.lastSummary).toBe('第二次');
  });

  it('一条都没有 ⇒ 0 / lastAt=0 / noTime=0', () => {
    expect(idpSummarizeComms([], range)).toEqual({ count: 0, lastAt: 0, lastSummary: '', noTime: 0 });
  });

  it('🔴 时间读不出来的一律不算进 count，但必须报在 noTime 里', () => {
    const stat = idpSummarizeComms([{ time: '不是时间' }, { time: null }, { time: inRange }], range);
    expect(stat.count).toBe(1);
    expect(stat.noTime).toBe(2);
  });
});

describe('A. 关联字段宽容解析（idpLinkIds）', () => {
  it('四种形态都吃', () => {
    expect(idpLinkIds(['a', 'b'])).toEqual(['a', 'b']);
    expect(idpLinkIds({ link_record_ids: ['a'] })).toEqual(['a']);
    expect(idpLinkIds('["a","b"]')).toEqual(['a', 'b']);
    expect(idpLinkIds('recX')).toEqual(['recX']);
  });

  it('🔴 `{link_record_ids: null}` 是「空关联」的形态之一 ⇒ 必须解析成空数组', () => {
    // 生产实测：邮件归档 816/6383 封就是这个值，字符串判空会误判成"有值"
    expect(idpLinkIds({ link_record_ids: null })).toEqual([]);
    expect(idpLinkIds('')).toEqual([]);
    expect(idpLinkIds(null)).toEqual([]);
    expect(idpLinkId({ link_record_ids: null })).toBe('');
  });

  it('非法 JSON 串不抛异常，返回空', () => {
    expect(idpLinkIds('[not json')).toEqual([]);
  });
});

describe('A. 文本宽容解析（idpTextOf）—— [object Object] 的教训', () => {
  it('🔴 关联字段的空壳值必须解析成**空串**，不能变成 "[object Object]"', () => {
    // 生产实测：学生表「当前班级」是关联字段且值为空壳
    // ⇒ `String(v)` 得到 "[object Object]"，82 行的「班级」列全被写坏（不报错、不写日志）
    expect(idpTextOf({ link_record_ids: null })).toBe('');
    expect(idpTextOf({ link_record_ids: [] })).toBe('');
    expect(String({ link_record_ids: null })).toBe('[object Object]'); // 反例：这就是不能这么写的原因
  });

  it('字符串 / 数字直接返回（并去空格）', () => {
    expect(idpTextOf('Pre-1')).toBe('Pre-1');
    expect(idpTextOf('  Pre-1 ')).toBe('Pre-1');
    expect(idpTextOf(7)).toBe('7');
  });

  it('对象优先取 text / name / value（关联字段带出的可读值）', () => {
    expect(idpTextOf({ text: 'Pre-1' })).toBe('Pre-1');
    expect(idpTextOf({ name: '未来企业家班' })).toBe('未来企业家班');
    expect(idpTextOf([{ text: 'Pre-2' }])).toBe('Pre-2');
  });

  it('取不到可读值的对象（结构未知）返回空串，而不是把结构 stringify 出去', () => {
    expect(idpTextOf({ foo: 'bar' })).toBe('');
    expect(idpTextOf({})).toBe('');
    expect(idpTextOf(null)).toBe('');
    expect(idpTextOf(undefined)).toBe('');
  });
});

describe('A. 幂等键', () => {
  it('配置键 = 学年 + 学期；明细键 = 配置 + 学生', () => {
    expect(idpConfigKey('recY1', '2026秋')).toBe('recY1__2026秋');
    expect(idpStudentKey('cfg1', 'stu1')).toBe('cfg1__stu1');
    expect(idpConfigKey('a', 'b')).not.toBe(idpConfigKey('a', 'c'));
  });
});

describe('A. IDP 菜单判据（idpMenuVisible，2026-09-29 改独立权限点）', () => {
  const myIdp = (perms: string[] | null, menus?: string[]) =>
    idpMenuVisible({ perms, menus }, MY_IDP_MENU_KEY);
  const stats = (perms: string[] | null, menus?: string[]) =>
    idpMenuVisible({ perms, menus }, IDP_STATS_MENU_KEY);

  it('🔴 硬闸门：持有本菜单自己的权限点才可见', () => {
    expect(myIdp([modulePermission('myIdp', 'read')])).toBe(true);
    expect(stats([modulePermission('idpStats', 'read')])).toBe(true);
    // 两个点互不通用（各有各的开关）
    expect(myIdp([modulePermission('idpStats', 'read')])).toBe(false);
    expect(stats([modulePermission('myIdp', 'read')])).toBe(false);
  });

  it('🔴 其它权限点**一律不能**放行（这正是"另造权限"的意义）', () => {
    // 改造前的判据是「任一记录类型 read」⇒ student / parent 也持有 dailyFollowups:read
    // ⇒ 他们能看到老师端菜单。现在必须都不能放行。
    for (const p of [
      modulePermission('studentRecords', 'read'),
      modulePermission('dailyFollowups', 'read'),
      modulePermission('studentObservations', 'read'),
      modulePermission('idpPlans', 'read'),
      modulePermission('meetingMinutes', 'read'),
    ]) {
      expect(myIdp([p]), p).toBe(false);
      expect(stats([p]), p).toBe(false);
    }
  });

  it('一个权限都没有 / undefined ⇒ 不可见', () => {
    expect(myIdp([])).toBe(false);
    expect(myIdp(null)).toBe(false);
    expect(stats([])).toBe(false);
    expect(stats(undefined)).toBe(false);
  });

  it('角色菜单白名单：含本菜单 key / studentRecords / 合并前旧 key 都放行', () => {
    const perms = [modulePermission('myIdp', 'read')];
    expect(idpMenuVisible({ perms, menus: [MY_IDP_MENU_KEY] }, MY_IDP_MENU_KEY)).toBe(true);
    expect(idpMenuVisible({ perms, menus: ['studentRecords'] }, MY_IDP_MENU_KEY)).toBe(true);
    // 生产实测：Phase1 的 13 项白名单里就有 studentObservations（不含 myIdp）
    expect(idpMenuVisible({ perms, menus: ['studentObservations'] }, MY_IDP_MENU_KEY)).toBe(true);
    // 白名单里明确列了别的菜单、没有兼容 key ⇒ 收敛生效（管理员可以刻意不给）
    expect(idpMenuVisible({ perms, menus: ['dashboard', 'students'] }, MY_IDP_MENU_KEY)).toBe(false);
  });

  it('两个菜单 key 常量都被 homepage 用上（改名了要一起改）', () => {
    const hp = read('packages/contracts/src/homepage.ts');
    expect(hp).toContain(`key: '${MY_IDP_MENU_KEY}'`);
    expect(hp).toContain(`key: '${IDP_STATS_MENU_KEY}'`);
  });

  it('🔴 「IDP 统计」看全部老师 = 持有 idpStatsAll:read（专用点，不连带 IDP配置）', () => {
    expect(idpStatsSeeAll([modulePermission('idpStatsAll', 'read')])).toBe(true);
    // 只有页面权限 ≠ 能看全部
    expect(idpStatsSeeAll([modulePermission('idpStats', 'read')])).toBe(false);
    // 🔴 反向：光有「IDP配置」的读权限**不再**等于能看全部（2026-09-29 v8 解绑）
    expect(idpStatsSeeAll([modulePermission('idpPlans', 'read')])).toBe(false);
    expect(idpStatsSeeAll([])).toBe(false);
    expect(idpStatsSeeAll(null)).toBe(false);
  });
});

describe('A2. 统计口径的纯函数（月份 / 自然日间隔）', () => {
  const ms = (s: string) => new Date(s + '+08:00').getTime();

  it('月份按**北京时间**取，不看服务器本地时区', () => {
    expect(idpMonthKey(ms('2026-09-30T23:30:00'))).toBe('2026-09');
    // 北京时间 10-01 00:30 = UTC 09-30 16:30 ⇒ 必须算 10 月
    expect(idpMonthKey(ms('2026-10-01T00:30:00'))).toBe('2026-10');
    expect(idpMonthKey(0)).toBe('');
  });

  it('「相隔几天」按**自然日**差算，不是 24 小时差', () => {
    // 09-14 13:53 → 09-17 13:57（线上真实的两条）
    expect(idpGapDaysAsc([ms('2026-09-14T13:53:00'), ms('2026-09-17T13:57:00')])).toEqual([null, 3]);
    // 只差 2 小时但跨了自然日 ⇒ 算 1 天（用 24h 差会算成 0，明显反直觉）
    expect(idpGapDaysAsc([ms('2026-09-14T23:00:00'), ms('2026-09-15T01:00:00')])).toEqual([null, 1]);
    // 同一天两次 ⇒ 0 天
    expect(idpGapDaysAsc([ms('2026-09-14T09:00:00'), ms('2026-09-14T18:00:00')])).toEqual([null, 0]);
  });

  it('「距今天数」：当天 = 0；本月无沟通 = null', () => {
    expect(idpDaysAgo(ms('2026-09-29T09:00:00'), ms('2026-09-29T23:00:00'))).toBe(0);
    expect(idpDaysAgo(ms('2026-09-17T13:57:00'), ms('2026-09-29T00:15:00'))).toBe(12);
    expect(idpDaysAgo(0, ms('2026-09-29T00:15:00'))).toBe(null);
  });

  it('间隔函数的输入顺序 = 调用方排好的升序（传反了会得到负数 —— 断言这个"约定"）', () => {
    const g = idpGapDaysAsc([ms('2026-09-17T13:57:00'), ms('2026-09-14T13:53:00')]);
    expect(g[1]).toBeLessThan(0);
  });
});

describe('B. 菜单与权限接线（静态）', () => {
  const hp = read('packages/contracts/src/homepage.ts');
  const mp = read('packages/contracts/src/module-permissions.ts');

  it('🔴 「我的 IDP」菜单的 perm 必须为空 —— 挂上 idpPlans 等于上线后老师全看不到', () => {
    const line = hp.split('\n').find((l) => l.includes(`key: '${MY_IDP_MENU_KEY}'`));
    expect(line, '找不到「我的 IDP」菜单项').toBeTruthy();
    expect(line).toContain("href: '/my-idp'");
    expect(line).toMatch(/perm: ''/);
    expect(line).not.toContain('idpPlans');
  });

  it('原「IDP管理」菜单改为「IDP配置」并指向 /idp-configs（key 保持 idpPlans，白名单兼容）', () => {
    const line = hp.split('\n').find((l) => l.includes("key: 'idpPlans'"));
    expect(line).toBeTruthy();
    expect(line).toContain("label: 'IDP配置'");
    expect(line).toContain("href: '/idp-configs'");
    expect(line).not.toContain("'/idp-plans'");
  });

  it('权限资源：label 改「IDP配置」、path 改 /idp-configs，但 aliases 里保留 /idp-plans', () => {
    const line = mp.split('\n').find((l) => l.includes("key: 'idpPlans'"));
    expect(line).toBeTruthy();
    expect(line).toContain("label: 'IDP配置'");
    expect(line).toContain("path: '/idp-configs'");
    expect(line).toContain("'/idp-plans'"); // 旧路径仍映射到本模块
  });
});

describe('B. 后端服务接线（静态）', () => {
  const svc = read('apps/api/src/idp/idp.service.ts');

  it('🔴 重拉学生只能刷新快照，**不许写 IDP老师**（写了就等于清空人工分配）', () => {
    const i = svc.indexOf('async pullStudents');
    const seg = svc.slice(i, i + 4200);
    // 新增的行里 IDP老师 初始为空（这是新建，不是覆盖）
    expect(seg).toContain('await sql.create');
    // 已存在行的 patch 只允许出现这三个快照字段
    const patchIdx = seg.indexOf('const patch: Record<string, unknown> = {};');
    expect(patchIdx).toBeGreaterThan(-1);
    const patchSeg = seg.slice(patchIdx, patchIdx + 420);
    expect(patchSeg).toContain('SF.学生姓名');
    expect(patchSeg).not.toContain('SF.IDP老师');
  });

  it('新增明细时「IDP老师」写空串（不是不写：不写会让行结构不一致）', () => {
    const i = svc.indexOf('async pullStudents');
    const seg = svc.slice(i, i + 2400);
    expect(seg).toContain('[SF.IDP老师]: \'\'');
  });

  it('分配老师前校验 open_id 在用户表里存在（防"分配了却看不到"的静默失败）', () => {
    expect(svc).toContain('BAD_TEACHER');
    const i = svc.indexOf('async assignTeachers');
    expect(svc.slice(i, i + 1600)).toContain('userIndex()');
  });

  it('归档批次不可写（拉学生 / 分配 / 改明细三处都拦）', () => {
    const hits = svc.split('IDP_ARCHIVED:').length - 1;
    expect(hits).toBeGreaterThanOrEqual(3);
  });

  it('🔴 「我的 IDP」按登录人 openId 过滤（数据面靠这个卡，不是靠权限点）', () => {
    const i = svc.indexOf('async myIdp');
    const seg = svc.slice(i, i + 2600);
    expect(seg).toContain('String(user.openId ?? \'\').trim()');
    expect(seg).toContain('SF.IDP老师');
  });

  it('🔴 可见性判据用 idpMenuVisible + 本菜单自己的权限点（不用宽判据、不用 idpPlans）', () => {
    const i = svc.indexOf('private requireMyIdp');
    expect(i).toBeGreaterThan(-1);
    const seg = svc.slice(i, i + 400);
    expect(seg).toContain('idpMenuVisible({ perms }, MY_IDP_MENU_KEY)');
    expect(seg).not.toContain('anyStudentRecordPerm');
    const j = svc.indexOf('private requireIdpStats');
    expect(j).toBeGreaterThan(-1);
    const seg2 = svc.slice(j, j + 600);
    expect(seg2).toContain('idpMenuVisible({ perms }, IDP_STATS_MENU_KEY)');
    expect(seg2).toContain('idpStatsSeeAll(perms)');
  });

  it('配置侧权限点用 module:idpPlans:*（管理员/院级现成持有，零角色改动）', () => {
    expect(svc).toContain('module:idpPlans:${action}');
  });

  it('沟通记录只读「记录类型=IDP沟通」（不新建表、不查旧 IDP 沟通记录表）', () => {
    expect(svc).toContain('IDP_COMM_RECORD_TYPE');
    expect(svc).not.toContain('TABLES.idpCommunication');
  });

  it('🔴 学期候选必须来自**字典**（`学期`）—— 首版误读 systemConfig 的 `semester` 导致线上 /idp-options 500', () => {
    // 生产实测：systemConfig 的 `semester` 是「**当前**学期」的单个文本值
    // （值是「2026-2027学年第一学期」），不是学期清单 ⇒ JSON.parse 失败 → null → `.map` 崩。
    expect(svc).toContain("getAllLabels()['学期']");
    expect(svc).not.toMatch(/配置键['"]\s*\)\s*!==\s*['"]semester/);
    expect(svc).not.toContain("=== 'semester'");
  });

  it('学期字典读不到也不阻断（返回空数组，弹窗仍能打开）', () => {
    const i = svc.indexOf('private semesterDict');
    expect(i).toBeGreaterThan(-1);
    expect(svc.slice(i, i + 900)).toContain('catch');
  });
});

describe('B. 学生快照字段的读写（静态）', () => {
  const svc = read('apps/api/src/idp/idp.service.ts');

  it('🔴 班级 / 年级必须走 idpTextOf（用 String() 会把关联空壳写成 "[object Object]"）', () => {
    expect(svc).toContain('idpTextOf(f[k])');
    // 断言"代码里别再出现用 String() 取字段值"的形态（注释里提到那个反例字符串是允许的 ——
    // 所以用调用形态正则，而不是 not.toContain 字面量）
    expect(svc).not.toMatch(/String\(\s*f\[k\]\s*\?\?\s*''\s*\)/);
    expect(svc).not.toMatch(/String\(\s*(f|fields)\[/);
  });

  it('班级候选顺序与成绩册一致（当前班级 → 当前年级）', () => {
    expect(svc).toContain("const STUDENT_CLASS_FIELDS = ['当前班级', '当前年级']");
    expect(svc).toContain("const STUDENT_GRADE_FIELDS = ['当前年级', '入学年级']");
  });
});

describe('B. 表格与页面接线（静态）', () => {
  const drawer = read('apps/web/components/IdpCommDrawer.tsx');
  const myPage = read('apps/web/app/my-idp/page.tsx');
  const cfgPage = read('apps/web/app/idp-configs/page.tsx');
  const oldPage = read('apps/web/app/idp-plans/page.tsx');

  it('旧 /idp-plans 页面改成重定向到 /my-idp（307，不是 permanentRedirect）', () => {
    expect(oldPage).toContain("redirect('/my-idp')");
    expect(oldPage).not.toContain('permanentRedirect');
  });

  it('🔴 抽屉写的是「沟通附件清单」——「沟通附件」是 meta 的 readonly，写进去会被静默丢弃', () => {
    expect(drawer).toContain('沟通附件清单');
    expect(drawer).not.toContain('沟通附件:');
  });

  it('抽屉新建的沟通记录类型固定为 IDP沟通，并带上学生姓名（靠 linkBackfill 回填编号）', () => {
    // 类型用 contracts 常量（2026-09-26 改版）：类型名改了要跟着变，别写裸字符串
    expect(drawer).toMatch(/记录类型:\s*IDP_COMM_RECORD_TYPE/);
    expect(drawer).toContain('关联学生: target.studentName');
  });

  it('笔记详情用**全站公用**组件（2026-09-26 三次改版：自造弹窗已删）', () => {
    // 改版理由：「我的笔记」页与「我的 IDP」都要看同一篇笔记的详情，
    // 各写一份必然漂移（形态、字段、空态各不相同）。
    // 与 NotePanel 的分工仍然成立：那个是"语义搜索并关联一篇"，不是"看已关联的"。
    expect(drawer).not.toContain("from './NotePanel'");
    expect(drawer).toContain("from './GetnoteNoteModal'");
    expect(drawer).toContain('<GetnoteNoteModal');
    // 旧的页面内自造弹窗必须消失
    expect(drawer).not.toContain('function NoteViewerModal');
  });

  it('我的 IDP 页：显示沟通次数与区间说明，未配置区间时给出提示', () => {
    expect(myPage).toContain('s.commCount');
    expect(myPage).toContain("t('rangeIs'");
    expect(myPage).toContain("t('rangeBad')");
  });

  it('IDP 配置页：沟通次数与「读不到时间」的条数都要显示', () => {
    expect(cfgPage).toContain('r.commCount');
    expect(cfgPage).toContain('r.noTime');
  });

  it('IDP 配置页不允许在归档批次上写（按钮禁用 + 后端也拦）', () => {
    expect(cfgPage).toContain('active.archived');
  });

  it('i18n：两个页面用到的命名空间都已在 messages 里（中英对称）', () => {
    const zh = JSON.parse(read('apps/web/messages/zh.json')) as Record<string, Record<string, string>>;
    const en = JSON.parse(read('apps/web/messages/en.json')) as Record<string, Record<string, string>>;
    for (const ns of ['myIdp', 'idpConfig']) {
      expect(Object.keys(zh[ns] ?? {}).length, ns).toBeGreaterThan(20);
      expect(Object.keys(zh[ns]).sort()).toEqual(Object.keys(en[ns]).sort());
    }
  });
});

describe('B. 字段常量自洽', () => {
  it('归档态字面量与配置状态清单一致', () => {
    expect(IDP_ARCHIVED).toBe('已归档');
  });

  it('明细表字段名自洽（页面与 service 共用同一份常量，别各写字面量）', () => {
    expect(IDP_STUDENT_FIELDS.IDP老师).toBe('IDP老师');
    expect(IDP_STUDENT_FIELDS.所属配置).toBe('所属配置');
    expect(IDP_CONFIG_FIELDS.学期).toBe('学期');
  });
});

describe('C. IDP 统计（2026-09-29 新增）', () => {
  const svc = read('apps/api/src/idp/idp.service.ts');
  const mod = read('apps/api/src/idp/idp.module.ts');
  const page = read('apps/web/app/idp-stats/page.tsx');
  const shell = read('apps/web/components/AppShell.tsx');
  const mp = read('packages/contracts/src/module-permissions.ts');

  it('🔴 两个 IDP 只读页的引入版本是 7（v6 迁移被整体跳过，靠 v7 重跑补齐）', () => {
    // 「当前版本号」由 C3 段钉住（现为 8），这里只钉这两个资源的引入版本 ——
    // 它们必须停在 7：改成 8 会让下一次迁移把它们当成"新资源"再发一遍。
    const i = mp.indexOf('MODULE_RESOURCE_INTRODUCED_VERSION');
    const seg = mp.slice(i, i + 1600);
    expect(seg).toContain('myIdp: 7');
    expect(seg).toContain('idpStats: 7');
  });

  it('🔴 每个资源的引入版本都必须 ≤ 当前版本（否则 `v <= toVersion` 永远过滤掉 ⇒ 该资源永不迁移）', () => {
    // 这条是 2026-09-29 的教训守卫：v6 上线后 Phase1~8 一个 idpStats 都没拿到，
    // 根因就是"资源引入版本 == 角色已到达的版本"，迁移整体被跳过。
    const cur = Number(/ROLE_PERMISSION_VERSION = (\d+)/.exec(mp)?.[1]);
    expect(cur).toBeGreaterThan(0);
    const i = mp.indexOf('MODULE_RESOURCE_INTRODUCED_VERSION');
    const body = mp.slice(i, mp.indexOf('};', i));
    const pairs = [...body.matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])] as const);
    expect(pairs.length).toBeGreaterThan(2);
    for (const [key, v] of pairs) {
      expect(v, `${key} 的引入版本 ${v} 超过当前版本 ${cur}`).toBeLessThanOrEqual(cur);
    }
  });

  it('🔴 两个资源的继承源必须是 module:meetingMinutes:read（11 个教职工角色，学生家长不持有）', () => {
    for (const key of ['myIdp', 'idpStats']) {
      const i = mp.indexOf(`{ key: '${key}'`);
      expect(i, key).toBeGreaterThan(-1);
      const line = mp.slice(i, mp.indexOf('\n', i));
      expect(line, key).toContain("legacyRead: 'module:meetingMinutes:read'");
      // 只读页：不给写权限继承
      expect(line, key).toContain('legacyWrite: null');
    }
  });

  it('后端：/idp-stats 控制器 + service.stats 用 requireIdpStats（含数据范围）', () => {
    expect(mod).toContain("@Controller('idp-stats')");
    expect(mod).toContain('IdpStatsController');
    expect(mod).toContain('this.svc.stats(userOf(req)');
    expect(svc).toContain('async stats(');
    expect(svc).toContain('this.requireIdpStats(user)');
    // 数据范围收口在 contracts 的判据上
    expect(svc).toContain('idpStatsSeeAll(perms)');
  });

  it('🔴 「名下学生」的归属 key 必须与 commsByStudent 的 key 规则同源（否则老师卡挂不上记录）', () => {
    expect(svc).toContain('private studentKeyOf(');
    // 明细侧：编号优先、退化成姓名（姓名那一支走 idpTextOf 的统一宽容口径）
    const k = svc.indexOf('private studentKeyOf(');
    const segK = svc.slice(k, k + 320);
    expect(segK).toContain('idpLinkId(f[SF.学生])');
    expect(segK).toContain('idpTextOf(f[SF.学生姓名])');
    // 记录侧：同样两个分支
    const i = svc.indexOf('private async commsByStudent');
    const seg = svc.slice(i, i + 2600);
    expect(seg).toContain("const sid = idpLinkId(r.f['关联学生编号']);");
    expect(seg).toContain('name:');
  });

  it('统计的月份 / 间隔全走 contracts 纯函数（不许在 service 里另算一遍）', () => {
    for (const fn of ['idpMonthKey', 'idpGapDaysAsc', 'idpDaysAgo']) {
      expect(svc, fn).toContain(fn);
    }
    // 自己写 hours/24 的日期减法 = 两套口径漂移的开始
    expect(svc).not.toContain('/ 86400000');
    expect(svc).not.toContain('/ (24 * 3600');
  });

  it('前端页面：调 api.idpStats、复用笔记详情弹窗、两个间隔口径都显示', () => {
    expect(page).toContain('api.idpStats(');
    expect(page).toContain('<GetnoteNoteModal');
    // 「相隔」与「距今」都显示（峰哥样例里"只 1 次也有相隔"⇒ 口径待他挑，两个都摆出来）
    expect(page).toContain("t('gapShort'");
    expect(page).toContain("t('daysAgoShort'");
    // 未沟通的学生要列名字（这页最有用的信息）
    expect(page).toContain("t('notTalkedLine'");
  });

  it('🔴 菜单可见性：两个 key 都走 idpMenuVisible（不是单一模块权限点，也不是宽判据）', () => {
    const i = shell.indexOf('item.key === MY_IDP_MENU_KEY || item.key === IDP_STATS_MENU_KEY');
    expect(i).toBeGreaterThan(-1);
    const seg = shell.slice(i, i + 500);
    expect(seg).toContain('idpMenuVisible(');
    expect(seg).toContain('IDP_STATS_MENU_KEY');
  });
});

describe('C2. 笔记关联的实体类型判据（2026-09-29 实测修正）', () => {
  const idpTs = read('packages/contracts/src/idp.ts');
  const svc = read('apps/api/src/idp/idp.service.ts');

  it('🔴 必须同时认「IDP沟通」与「学生记录」——写侧写的是**模块标签**', () => {
    // 生产实测（13 条 IDP沟通记录）：实体类型=学生记录 → 13 行，实体类型=IDP沟通 → 0 行。
    // 只认记录类型 ⇒ 页面「笔记」列恒空且不报错（这就是修之前的线上状态）。
    expect(idpTs).toContain('export const IDP_COMM_NOTE_ENTITY_TYPES');
    const i = idpTs.indexOf('export const IDP_COMM_NOTE_ENTITY_TYPES');
    const decl = idpTs.slice(i, idpTs.indexOf(';', i));
    expect(decl).toContain('IDP_COMM_RECORD_TYPE');
    expect(decl).toContain("'学生记录'");
  });

  it('service 用这个常量筛，且**不许**再拿单一字面量比对（两套判据 = 静默 bug）', () => {
    expect(svc).toContain("IDP_COMM_NOTE_ENTITY_TYPES.includes(idpTextOf(f['实体类型']))");
    expect(svc).not.toContain("idpTextOf(f['实体类型']) !== IDP_COMM_RECORD_TYPE");
  });

  it('只放宽「关联行」的判据，**记录类型**的判据仍必须是单一值', () => {
    // 997 行附近：筛 IDP沟通 记录用的还是 IDP_COMM_RECORD_TYPE（放宽这里会串到别的记录类型）
    expect(svc).toContain('value: [IDP_COMM_RECORD_TYPE]');
  });
});

describe('C3. 「看全部」是专用权限点 idpStatsAll（2026-09-29 v8 与 IDP配置解绑）', () => {
  const mp = read('packages/contracts/src/module-permissions.ts');

  it('🔴 当前版本 ≥ 8，且 idpStatsAll 的引入版本恒为 8（v8 引入的，之后抬版本不该动它）', () => {
    // ⚠️ 这里**不写死当前版本号**：每加一批资源就会抬一版（v9 起是学生支持看板），
    //    写死会让每次抬版本都得回来改断言（撞了两次了）。
    //    真正的语义是"这个资源在 v8 引入" ⇒ 断言它的引入版本恒为 8，当前版本只要求 ≥ 8。
    const cur = Number(/ROLE_PERMISSION_VERSION = (\d+)/.exec(mp)?.[1]);
    expect(cur).toBeGreaterThanOrEqual(8);
    const i = mp.indexOf('MODULE_RESOURCE_INTRODUCED_VERSION');
    const seg = mp.slice(i, i + 1600);
    expect(seg).toContain('idpStatsAll: 8');
  });

  it('🔴 legacyRead 必须是 null —— 这个开关**绝不能**随版本迁移自动发放（否则人人看全部）', () => {
    const i = mp.indexOf("key: 'idpStatsAll'");
    expect(i).toBeGreaterThan(-1);
    const block = mp.slice(i, mp.indexOf('genericCrud', i) + 40);
    expect(block).toContain('legacyRead: null');
    expect(block).toContain('legacyWrite: null');
    expect(block).toContain('menuPermission: null');
    // 只给 read：它没有自己的页面，不存在「进入菜单」
    expect(block).toContain("actions: ['read']");
    // 🔴 必须挂到「IDP 统计」菜单下：不填 subOf，权限矩阵里生不出这一行，
    //    管理员**找不到勾选的地方** ⇒ 功能等于不可用
    expect(block).toContain("subOf: 'idpStats'");
  });

  it('🔴 解绑的核心断言：光有「IDP配置」读权限**不再**等于能看全部', () => {
    expect(idpStatsSeeAll([modulePermission('idpPlans', 'read')])).toBe(false);
    expect(idpStatsSeeAll([modulePermission('idpStatsAll', 'read')])).toBe(true);
  });

  it('idpStatsAll 不是「IDP配置」的别名，也不会抢 /idp-stats 的路由匹配', () => {
    const c = read('packages/contracts/src/module-permissions.ts');
    const i = c.indexOf("key: 'idpStatsAll'");
    const block = c.slice(i, c.indexOf('genericCrud', i) + 40);
    expect(block).toContain("path: '/idp-stats/all'");
    expect(block).not.toContain("path: '/idp-stats',");
  });
});
