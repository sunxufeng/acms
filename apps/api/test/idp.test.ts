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
  myIdpMenuVisible,
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

describe('A. 「我的 IDP」菜单判据（myIdpMenuVisible）', () => {
  it('🔴 有 studentRecords:read ⇒ 可见（老师们的实际权限）', () => {
    expect(myIdpMenuVisible({ perms: [modulePermission('studentRecords', 'read')] })).toBe(true);
  });

  it('只有某一记录类型的 read（合并前的老角色）⇒ 也可见', () => {
    expect(myIdpMenuVisible({ perms: [modulePermission('dailyFollowups', 'read')] })).toBe(true);
    expect(myIdpMenuVisible({ perms: [modulePermission('studentObservations', 'read')] })).toBe(true);
  });

  it('🔴 只有 idpPlans:read ⇒ **不可见**（这正是不能复用它当判据的原因）', () => {
    expect(myIdpMenuVisible({ perms: [modulePermission('idpPlans', 'read')] })).toBe(false);
  });

  it('一个记录权限都没有 ⇒ 不可见（家长/学生若不持记录权限也看不到）', () => {
    expect(myIdpMenuVisible({ perms: [] })).toBe(false);
    expect(myIdpMenuVisible({ perms: null })).toBe(false);
  });

  it('角色菜单白名单：含 myIdp 或 studentRecords 或合并前的旧 key 都放行', () => {
    const perms = [modulePermission('studentRecords', 'read')];
    expect(myIdpMenuVisible({ perms, menus: [MY_IDP_MENU_KEY] })).toBe(true);
    expect(myIdpMenuVisible({ perms, menus: ['studentRecords'] })).toBe(true);
    expect(myIdpMenuVisible({ perms, menus: ['dailyFollowups'] })).toBe(true);
    // 白名单里明确列出了别的菜单、没有它 ⇒ 收敛生效（管理员可以刻意不给）
    expect(myIdpMenuVisible({ perms, menus: ['dashboard', 'students'] })).toBe(false);
  });

  it('菜单 key 常量与 homepage 里的一致（改名了要一起改）', () => {
    const hp = read('packages/contracts/src/homepage.ts');
    expect(hp).toContain(`key: '${MY_IDP_MENU_KEY}'`);
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

  it('可见性判据用 myIdpMenuVisible（与前端菜单同一个函数），不用 idpPlans', () => {
    const i = svc.indexOf('private requireMyIdp');
    expect(i).toBeGreaterThan(-1);
    const seg = svc.slice(i, i + 260);
    expect(seg).toContain('myIdpMenuVisible');
    expect(seg).not.toContain('idpPlans');
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
