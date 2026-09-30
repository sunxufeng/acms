import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_ENROLL_MONTH_OPTIONS,
  ARCHIVE_SCHOOL_TYPE_OPTIONS,
  MODULE_RESOURCES,
  MODULE_RESOURCE_INTRODUCED_VERSION,
  ROLE_PERMISSION_VERSION,
  WEILING_PLANNED_TERM_MAP,
  WEILING_SCHOOL_TYPE_MAP,
  buildEnrollDraft,
  buildEnrollRemark,
  enrollWriteFields,
  weilingEnrollClock,
  weilingStudentName,
  weilingStudentNameProblem,
  type WeilingEnrollContext,
} from '@acms/contracts';

/**
 * 「卫瓴联系人 → 学生档案入学」的判据测试（2026-09-30）。
 *
 * 分两类：
 *  ① **纯函数**：姓名可用性 / 档位划分 / 写库字段装配 / 留痕文本 —— 这些是前后端共用的判据；
 *  ② **源码级守卫**：权限点声明与判据必须成对、CrudPage 的只读行操作开关必须真的接线
 *     —— 这两件事**不会有任何类型错误**，只有跑起来才发现（"勾了没反应" / "按钮永远不出现"）。
 *
 * 下面用到的每个边界值都来自生产库实测，不是假想：
 *   联系人 3703 · xsxm 有值 1907 · 与现有 84 个学生同名 50 条
 *   · 卫瓴「标签」值是标签组名 · 「邮箱」0 条有值 · 归位人映射只有 3 条
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(path.join(here, '..', '..', ...p), 'utf8');

/**
 * 剥掉注释后再断言。
 *
 * 🔴 本仓反复踩到的同一类问题（套件里记过好几次）：**源码守卫里的 `not.toContain`
 *    必须先剥注释** —— 注释里为了讲清规矩，必然会把"被禁的写法"原样写出来。
 *    本次实例：我在 `weiling.service.ts` 的 JSDoc 里写了
 *    「🔴 走 `StudentService.create()` 而**不是**直接 `sql.create(TABLES.studentProfile…)`」，
 *    于是 `not.toContain('sql.create(TABLES.studentProfile')` 命中的是我自己的说明文字，
 *    断言永远红（而这跟实现对不对毫无关系）。
 */
const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/[ \t]+\/\/[^\n]*/g, '');

function ctx(over: Partial<WeilingEnrollContext> = {}): WeilingEnrollContext {
  return {
    contactName: '秦明辉妈妈',
    studentNameRaw: '秦明辉',
    ownerName: '致极学院刘老师 | 10.18开放日',
    recruiterOpenId: 'ou_test_amy',
    recruiterName: '刘攀扬｜Amy',
    school: '昆山康桥学校',
    schoolType: '国际课程',
    plannedTerm: '2026年春季学期',
    paid: '是',
    mobile: '13998950335',
    marketing: [
      { label: '意向度', value: '考虑中' },
      { label: '线索定性', value: '适龄' },
      { label: '意向留学国别', value: '' },
    ],
    createdAt: 1_700_000_000_000,
    operatorName: '曹德强｜Daniel',
    now: 1_790_000_000_000,
    ...over,
  };
}

describe('学生姓名可用性判据（线上真实脏值）', () => {
  it('正常姓名可用', () => {
    expect(weilingStudentNameProblem('秦明辉')).toBeNull();
    expect(weilingStudentNameProblem(' 王悦熹 G8 ')).toBeNull(); // 含年级后缀也放行，只 trim
    expect(weilingStudentNameProblem('欧阳娜娜')).toBeNull();
  });

  it('🔴 占位值不可用 —— 「未知」「学生」在线上真的存在，直接建档会造出叫「未知」的学生', () => {
    expect(weilingStudentNameProblem('未知')).toContain('占位值');
    expect(weilingStudentNameProblem('学生')).toContain('占位值');
    expect(weilingStudentNameProblem('未填写')).toContain('占位值');
  });

  it('空 / 全空白不可用（提示去手工填，而不是静默放行）', () => {
    expect(weilingStudentNameProblem('')).toContain('没有填');
    expect(weilingStudentNameProblem('   ')).toContain('没有填');
    expect(weilingStudentNameProblem(null)).toContain('没有填');
    expect(weilingStudentNameProblem(undefined)).toContain('没有填');
  });

  it('🔴 把身份当名字的（「义乌学生」这种）不可用', () => {
    expect(weilingStudentNameProblem('义乌学生')).toContain('身份描述');
    expect(weilingStudentNameProblem('小明家长')).toContain('身份描述');
  });

  it('单字姓名判为可疑（这批数据里单字全是脏值；真名单字罕见，手填一次成本很低）', () => {
    expect(weilingStudentNameProblem('王')).toContain('1 个字');
  });

  it('误填成联系方式的不可用', () => {
    expect(weilingStudentNameProblem('13800138000')).toContain('联系方式');
    expect(weilingStudentNameProblem('abc@qq.com')).toContain('联系方式');
  });

  it('清洗只去零宽字符与首尾空白 —— **不做**猜测性改写（猜错会静默改掉真名）', () => {
    expect(weilingStudentName('  秦​明辉  ')).toBe('秦明辉');
    expect(weilingStudentName('王悦熹 G8')).toBe('王悦熹 G8'); // 不截断
  });
});

describe('字段映射判据', () => {
  it('🔴 原学校类型：卫瓴 6 档只有 2 档能对上，其余必须留空而不是硬写', () => {
    expect(WEILING_SCHOOL_TYPE_MAP['体制内']).toBe('体制内学校');
    expect(WEILING_SCHOOL_TYPE_MAP['国际课程']).toBe('国际学校');
    // 学生档案这一栏只有「国际学校 / 体制内学校」两个选项 ⇒ 其余 4 档无对应
    expect(WEILING_SCHOOL_TYPE_MAP['homeschool 或 休学']).toBeNull();
    expect(WEILING_SCHOOL_TYPE_MAP['海外回国']).toBeNull();
    expect(WEILING_SCHOOL_TYPE_MAP['创新学校']).toBeNull();
    expect(WEILING_SCHOOL_TYPE_MAP['其他']).toBeNull();
    // 映射结果必须落在字段选项集合里（否则界面上会显示成"没值"）
    for (const v of Object.values(WEILING_SCHOOL_TYPE_MAP)) {
      if (v) expect(ARCHIVE_SCHOOL_TYPE_OPTIONS).toContain(v);
    }
  });

  it('🔴 计划入读 → 入学年月：映射结果必须是「入学年月」的合法选项', () => {
    for (const v of Object.values(WEILING_PLANNED_TERM_MAP)) {
      if (v) expect(ARCHIVE_ENROLL_MONTH_OPTIONS).toContain(v);
    }
    expect(WEILING_PLANNED_TERM_MAP['2026年春季学期']).toBe('26春季');
    expect(WEILING_PLANNED_TERM_MAP['2025年秋季学期']).toBe('25秋季');
    expect(WEILING_PLANNED_TERM_MAP['其它']).toBe(''); // 模糊值不映射
  });

  it('🔴 「当前年级」必须是 skip 档 —— 卫瓴是 G1–G12，档案是 Pre-1/Pre-2/大一，硬写会显示成没值', () => {
    const d = buildEnrollDraft(ctx());
    const grade = d.fields.find((f) => f.key === '当前年级');
    expect(grade?.tier).toBe('skip');
    expect(grade?.value).toBe('');
    expect(grade?.why).toContain('选项体系不同');
  });

  it('🔴 「学生手机号」必须是 skip 档（联系人电话 ≠ 学生手机号，且它是自动匹配的 88 分判据）', () => {
    const d = buildEnrollDraft(ctx());
    const mobile = d.fields.find((f) => f.key === '学生手机号');
    expect(mobile?.tier).toBe('skip');
    expect(mobile?.why).toContain('88 分判据');
    // 号码本身要有地方落地 —— 写进备注
    expect(d.remark).toContain('13998950335');
  });

  it('🔴 口径未定的两栏（来源渠道 / 生源跟进状态）也必须是 skip，且写明"待定"而不是装死', () => {
    const d = buildEnrollDraft(ctx());
    for (const k of ['来源渠道', '生源跟进状态']) {
      const f = d.fields.find((x) => x.key === k);
      expect(f?.tier, k).toBe('skip');
      expect(f?.why, k).toMatch(/口径|映射规则/);
    }
  });

  it('🟢 可靠档：学生姓名 / 招生负责老师 / 原学校', () => {
    const d = buildEnrollDraft(ctx());
    for (const k of ['学生姓名', '招生负责老师', '原学校']) {
      expect(d.fields.find((f) => f.key === k)?.tier, k).toBe('solid');
    }
    const r = d.fields.find((f) => f.key === '招生负责老师');
    expect(r?.value).toBe('ou_test_amy'); // 落库的是 open_id
    expect(r?.display).toBe('刘攀扬｜Amy'); // 界面显示的是姓名
    expect(r?.editable).toBe(false); // open_id 不给自由编辑
  });

  it('招生负责老师映射不到时留空，且来源说明里讲清"查不到"（不静默）', () => {
    const d = buildEnrollDraft(ctx({ recruiterOpenId: '', recruiterName: '', ownerName: '致极学院招生中心' }));
    const r = d.fields.find((f) => f.key === '招生负责老师');
    expect(r?.value).toBe('');
    expect(r?.source).toContain('查不到');
    expect(r?.display).toContain('映射不到');
  });

  it('🔴 原学校类型口径对不上时：值留空 + 给出原因（否则用户以为漏了）', () => {
    const d = buildEnrollDraft(ctx({ schoolType: '创新学校' }));
    const f = d.fields.find((x) => x.key === '原学校类型');
    expect(f?.value).toBe('');
    expect(f?.why).toContain('创新学校');
    expect(f?.why).toContain('对不上');
  });

  it('入学年月随「计划入读」带出，并派生入学年份 / Arete入学年（复用档案页同一份规则）', () => {
    const d = buildEnrollDraft(ctx({ plannedTerm: '2026年春季学期' }));
    expect(d.fields.find((f) => f.key === '入学年月')?.value).toBe('26春季');
    expect(d.derived['入学年份']).toBe('2026');
    expect(d.derived['Arete入学年']).toBe('第6年');
  });
});

describe('写库字段装配', () => {
  it('空值不写（学生档案里"没填"就是没填，不写空串去覆盖）', () => {
    const d = buildEnrollDraft(ctx({ school: '', schoolType: '', plannedTerm: '', paid: '', mobile: '' }));
    const fields = enrollWriteFields(d, {});
    expect(fields['原学校']).toBeUndefined();
    expect(fields['原学校类型']).toBeUndefined();
    expect(fields['付款状态']).toBeUndefined();
    expect(fields['学生姓名']).toBe('秦明辉'); // 有值的照写
  });

  it('🔴 skip 档**任何情况都不写**（即使用户手工塞了值）', () => {
    const d = buildEnrollDraft(ctx());
    const fields = enrollWriteFields(d, {}, { 学生手机号: '13800138000', 当前年级: 'G8' });
    expect(fields['学生手机号']).toBeUndefined();
    expect(fields['当前年级']).toBeUndefined();
  });

  it('取消勾选 = 不写（默认全填，但要保留否决权）', () => {
    const d = buildEnrollDraft(ctx());
    const fields = enrollWriteFields(d, { 原学校: false });
    expect(fields['原学校']).toBeUndefined();
    expect(fields['学生姓名']).toBe('秦明辉');
  });

  it('用户在弹窗里改过的值优先', () => {
    const d = buildEnrollDraft(ctx());
    const fields = enrollWriteFields(d, {}, { 学生姓名: '秦明晖' });
    expect(fields['学生姓名']).toBe('秦明晖');
  });

  it('🔴 派生字段只在「入学年月」真被写入时才带出（没写入学年月却写入学年份 = 假数据）', () => {
    const d = buildEnrollDraft(ctx({ plannedTerm: '' }));
    const fields = enrollWriteFields(d, {});
    expect(fields['入学年月']).toBeUndefined();
    expect(fields['入学年份']).toBeUndefined();
    expect(fields['Arete入学年']).toBeUndefined();

    const d2 = buildEnrollDraft(ctx({ plannedTerm: '2025年秋季学期' }));
    const f2 = enrollWriteFields(d2, {});
    expect(f2['入学年份']).toBe('2025');
    expect(f2['Arete入学年']).toBe('第5年');
  });
});

describe('备注留痕（进不了字段的信息必须有地方落地）', () => {
  it('含来源联系人 / 操作人 / 转化时间', () => {
    const t = buildEnrollRemark(ctx());
    expect(t).toContain('【卫瓴入学】');
    expect(t).toContain('秦明辉妈妈');
    expect(t).toContain('曹德强｜Daniel');
    expect(t).toContain('2026-');
  });

  it('🔴 营销信息（无对应字段的那批）必须进备注，否则整条线索的信息就丢了', () => {
    const t = buildEnrollRemark(ctx());
    expect(t).toContain('意向度：考虑中');
    expect(t).toContain('线索定性：适龄');
    expect(t).not.toContain('意向留学国别：'); // 空值不占位
  });

  it('手机号如实标注它是"联系人本人电话"，避免以后被误当学生手机号', () => {
    const t = buildEnrollRemark(ctx());
    expect(t).toContain('非学生手机号');
  });

  it('北京时间格式化显式指定时区（不依赖服务器时区）', () => {
    // 2026-09-30 07:20 UTC = 北京 15:20
    expect(weilingEnrollClock(Date.UTC(2026, 8, 30, 7, 20))).toBe('2026-09-30 15:20');
  });
});

describe('源码级守卫：权限点声明与判据成对', () => {
  const controller = read('api', 'src', 'weiling', 'weiling.controller.ts');
  const service = read('api', 'src', 'weiling', 'weiling.service.ts');
  const apiTs = read('web', 'lib', 'api.ts');
  const page = read('web', 'app', 'weiling-contacts', 'page.tsx');
  const crud = read('web', 'components', 'CrudPage.tsx');
  const modal = read('web', 'components', 'WeilingEnrollModal.tsx');

  it('权限点已声明：legacyRead 为 null（不随迁移发放）+ actions 含 update', () => {
    const r = MODULE_RESOURCES.find((x) => x.key === 'weilingEnroll');
    expect(r, 'MODULE_RESOURCES 里没有 weilingEnroll').toBeTruthy();
    expect(r?.legacyRead).toBeNull();
    expect(r?.actions).toContain('update');
    // 没有自己的菜单 ⇒ 必须 subOf，否则矩阵里生不出勾选行（勾不到 = 连管理员都没有）
    expect(r?.subOf).toBe('weilingContacts');
  });

  it('🔴🔴 actions 里不得有 `enter` —— 它会被**无条件发给所有角色**，与"默认谁都没有"直接冲突', () => {
    // 2026-09-30 上线验证实测：`actions: [...READ, 'update']`（含 enter）上线后，
    // **12 个角色**（含 student / parent）都拿到了 `module:weilingEnroll:enter`。
    // 根因：`inheritModulePermissions` 对 `enter` 用另一套规则 ——
    //   `!adminOnly && (!menuPermission || legacy.has(menuPermission)) && …`
    // 本资源 `menuPermission: null` ⇒ 前半段恒真 ⇒ 无条件发放。
    // 也就是说：**「legacyRead: null ⇒ 不发给任何人」只对 read/update/refresh 成立**。
    const r = MODULE_RESOURCES.find((x) => x.key === 'weilingEnroll');
    expect(r?.actions).not.toContain('enter');
    expect([...(r?.actions ?? [])]).toEqual(['read', 'update']);
  });

  it('🔴 通用规则：**增量迁移引入的**「不发给任何人」资源不得声明 `enter`', () => {
    // 上面那个坑的推广，但**只针对"通过增量迁移发放过"的资源** ——
    // 判据取 `MODULE_RESOURCE_INTRODUCED_VERSION` 里登记过的 key：
    // 登记过 ⇒ 它会走 `inheritModulePermissions(…, onlyKeys)`，此时只要有 `enter`
    // 就必然无条件发给全站（因为这类资源的 menuPermission 都是 null）。
    //
    // ⚠️ 为什么不写成"一切 legacyRead:null 的资源"：存量里 `studentRecords` / `examGrades` /
    //    `examTypes` / `examComments` / `departmentManagement` 也是 `legacyRead:null` + `enter`,
    //    那几个是**容器型/历史资源**，`enter` 的发放面本来就是宽的（菜单可见性），
    //    不在本次交付范围、也不该由这条守卫替它们下结论。写成全局规则会直接红在一片存量上，
    //    然后守卫就会被加豁免加到失效 —— 那是"守卫变噪音"的老路。
    const introduced = new Set(Object.keys(MODULE_RESOURCE_INTRODUCED_VERSION));
    const bad = MODULE_RESOURCES.filter(
      (r) =>
        introduced.has(r.key) &&
        r.legacyRead === null &&
        r.menuPermission === null &&
        !r.adminOnly &&
        r.actions.includes('enter'),
    ).map((r) => `${r.key}（会被无条件发给所有角色）`);
    expect(bad).toEqual([]);
  });

  it('path 用不存在的子路径，避免与父资源抢 moduleByPath', () => {
    const r = MODULE_RESOURCES.find((x) => x.key === 'weilingEnroll');
    expect(r?.path).toBe('/weiling-contacts/enroll');
    expect(r?.path).not.toBe('/weiling-contacts');
  });

  it('🔴 引入版本 == 当次抬的版本号（否则 `(v-1, v]` 增量覆盖不到它）', () => {
    expect(MODULE_RESOURCE_INTRODUCED_VERSION.weilingEnroll).toBe(ROLE_PERMISSION_VERSION);
  });

  it('🔴 后端判据与声明的点**同名**（错开一半就是"勾了没反应"）', () => {
    expect(controller).toContain('module:weilingEnroll:update');
    // 建学生那道也要判，否则会在 StudentService 里才 403，错误离按钮太远
    expect(controller).toContain('module:students:create');
  });

  it('两条路由存在，且权限判据挂在它们上面', () => {
    expect(controller).toContain("@Get('contacts/:id/enroll-preview')");
    expect(controller).toContain("@Post('contacts/:id/enroll')");
    // 两个处理函数里都要调 requireEnroll（漏一个就是"能预览但不能提交"或反之）
    expect(controller.match(/requireEnroll\(/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('🔴 建学生必须走 `StudentService.create`，不能自己 sql.create 学生表', () => {
    expect(service).toContain('this.students.create(');
    expect(strip(service)).not.toContain('sql.create(TABLES.studentProfile');
    // 模块也要 import 它（漏了是启动期 DI 报错，见 nest-module-di.test.ts）
    expect(read('api', 'src', 'weiling', 'weiling.module.ts')).toContain('StudentModule');
  });

  it('🔴 前端按钮门控与后端判据一致（前端只藏按钮不算门控，但判据要同名）', () => {
    expect(page).toContain('module:weilingEnroll:update');
    expect(page).toContain('module:students:create');
  });

  it('已关联过联系人的行不给「入学」按钮（避免重复建档），只给查看入口', () => {
    expect(page).toContain('查看学生');
    expect(page).toContain('关联学生ID');
  });

  it('🔴 转档失败要抛 Nest 的 HTTP 异常，不能 `throw new Error`（否则一律 500）', () => {
    // 2026-09-30 线上验证揪到：`throw new Error('VALIDATION:…')` 被 Nest 兜成 **500**，
    // 于是"用户需要改一下输入"显示成"服务端故障"，监控也会把它计成服务端错误。
    // 判据：`VALIDATION:` / `NOT_FOUND:` 前缀的行必须走 BadRequest / NotFound。
    const lines = strip(service)
      .split('\n')
      .filter((l) => /VALIDATION:|NOT_FOUND:/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const l of lines) {
      const isThrow = /throw\s/.test(l);
      if (!isThrow) continue;
      expect(l, `这行用了普通 Error（会变 500）：${l.trim()}`).toMatch(/BadRequestException|NotFoundException/);
      expect(l, `这行不该用普通 Error：${l.trim()}`).not.toMatch(/throw new Error\(/);
    }
    expect(service).toContain('BadRequestException');
    expect(service).toContain('NotFoundException');
  });

  it('弹窗用服务端预检，不在前端重算判据', () => {
    expect(modal).toContain('weilingEnrollPreview');
    // 前端不许自己写映射表（写了必然与 contracts 漂移）
    expect(modal).not.toContain('国际学校');
    expect(modal).not.toContain('体制内学校');
    expect(apiTs).toContain('/enroll-preview');
  });
});

describe('源码级守卫：CrudPage 的只读行操作开关真的接线了', () => {
  const crud = read('web', 'components', 'CrudPage.tsx');

  it('prop 已声明且默认关闭（向后兼容 —— 其他只读页不该突然长出操作列）', () => {
    expect(crud).toContain('rowActionSlotWhenReadonly?: boolean;');
  });

  it('🔴 「操作」列会被渲染出来（只放开槽、不放这一列 = 静默无效果）', () => {
    expect(crud).toContain('const showActions = !hideActions || !!rowActionSlotWhenReadonly;');
  });

  it('🔴 槽的渲染条件已放开，但**只**放开它（新建/编辑/删除仍由 readonly 挡住）', () => {
    expect(crud).toContain('{(!readonly || rowActionSlotWhenReadonly) && rowActionSlot?.(row, () => reload())}');
    // 这三条不能跟着放开
    expect(crud).toContain('const canCreate = !readonly && !hideCreate && modOk(\'create\');');
    expect(crud).toContain('const canUpdate = !readonly && modOk(\'update\');');
    expect(crud).toContain('const canDelete = !readonly && modOk(\'delete\');');
    // 状态流转与 rowExtraActions（语义是"改这一行"）也不放开
    expect(crud).toContain('{!readonly && api.transition && allowed.length > 0 && (');
  });

  it('卫瓴联系人页已把 `hideActions` 去掉、并开了开关（否则两个条件打架）', () => {
    expect(page_noHide()).toBe(true);
  });

  /** 页面里不该再有光秃秃的 `hideActions`（开关是 string 属性写法，不会误命中） */
  function page_noHide(): boolean {
    const p = read('web', 'app', 'weiling-contacts', 'page.tsx');
    return !/^\s*hideActions\s*$/m.test(p);
  }
});
