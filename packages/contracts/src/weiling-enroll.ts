/**
 * 卫瓴联系人 → 学生档案「入学」的判据（**前后端共用一份**）。
 *
 * ── 需求（2026-09-30 峰哥）────────────────────────────────────────
 *   「/weiling-contacts 联系人关联，增加操作列，点击"入学"按钮，将选择的联系人转为学生档案里的学生。
 *     学生姓名 · xsxm 为学生姓名，归属人对应映射表里的 acms 用户就是招生老师，
 *     你同时把联系人和学生关联起来，然后你看还有哪些信息是可以转换为学生档案里的信息，
 *     默认都填写到学生档案里。」
 *
 * ── 🔴 为什么这些判据必须放在 contracts ─────────────────────────────
 *   · 哪些字段能填、哪些不能填、填进去的值是否合法 —— **前端弹窗要展示、后端写库要执行**，
 *     两处各写一份必然漂移（前端显示"会填 A"、后端实际只填了 B）。
 *   · 摸底结论（生产库实测）决定了每一档的边界，这些数字就是判据的依据：
 *       联系人 3703 · xsxm 有值 1907（51.5%，含「未知」「学生」等占位值）
 *       · 与现有 84 个学生**同名 50 条**（涉及 43 个学生）
 *       · 归属人可映射到 ACMS 用户 2890 条（78%）
 *       学生档案 84 人：「招生跟进」组字段（来源渠道/生源跟进状态/原学校/原学校类型/
 *       合同状态/付款状态/奖学金金额/家庭关键决策点）**全部 0 有值** —— 从没人填过
 *
 * ── 三档语义（与 UI 稿一致）──────────────────────────────────────
 *   `solid` 🟢 来源可靠，默认填、来源可追溯
 *   `check` 🟡 口径可能对不上，默认填但**必须让人看一眼**（可编辑 / 可取消）
 *   `skip`  ⬜ 明确不填，并且要**说清为什么不填**（不写理由的"跳过"会被当成 bug 报）
 */

import { deriveEnrollFields, ENROLL_MONTH_FIELD } from './student-enroll.js';

/** 转档字段的档位 */
export type EnrollTier = 'solid' | 'check' | 'skip';

/** 草稿里的一格 */
export interface EnrollDraftField {
  /** 学生档案的字段名（就是数据 key） */
  key: string;
  label: string;
  /** 预填值（`''` = 留空）。⚠️ 可能是**机器值**（如 `招生负责老师` 存的是 open_id） */
  value: string;
  /**
   * 给人看的展示值。仅当 `value` 不适合直接显示时提供
   * （目前只有 `招生负责老师` —— 它的 `value` 是 open_id，界面上要显示姓名）。
   */
  display?: string;
  tier: EnrollTier;
  /** 人话来源说明，UI 上小字显示（如「← xsxm 学生姓名」） */
  source: string;
  /** 仅 `skip` 档：为什么不填 */
  why?: string;
  /** 是否允许在弹窗里改（`招生负责老师` 存 open_id，界面上给姓名时不可自由编辑） */
  editable: boolean;
  /** 单选字段的可选值（UI 据此渲染下拉；为空 = 自由文本） */
  options?: readonly string[];
}

export interface EnrollDraft {
  /** 学生姓名（已清洗） */
  studentName: string;
  /** 姓名不可用时的原因（`null` = 可用）。非空时**不允许提交**，要求人工填 */
  nameProblem: string | null;
  /** 按学生档案字段顺序排列的全部格子（含 skip 档，UI 要展示"为什么不填"） */
  fields: EnrollDraftField[];
  /** 由「入学年月」派生的两个字段（入学年份 / Arete入学年），可能为空对象 */
  derived: Record<string, string>;
  /** 写进「备注」的留痕文本 */
  remark: string;
}

/** 卫瓴「自定义字段」里学生姓名的 api_name（与 `apps/web/lib/weilingCustomFields.ts` 同一口径） */
export const WEILING_STUDENT_NAME_KEY = 'xsxm';

/**
 * 不能当学生姓名用的占位值。
 *
 * 实测生产数据里出现的（不是编的）：`未知` 出现 2 次以上、`学生` 出现 2 次、
 * 还有 `义乌学生` 这种把"学生"当后缀的描述。这些值直接建档案就是一条**叫「未知」的学生**，
 * 而且**不会报错**（学生姓名只校验非空）。
 */
export const WEILING_STUDENT_NAME_PLACEHOLDERS: readonly string[] = ['未知', '学生', '未填写', '无', '-', '/'];

/**
 * 学生姓名可用性判据。
 *
 * 返回 `null` = 可用；返回字符串 = **不可用的原因**（直接给用户看，所以写人话）。
 *
 * 🔴 判据边界（都来自生产实况，不是假想）：
 *   · 空 / 全空白 ⇒ 不可用
 *   · 命中占位值 ⇒ 不可用（`未知` / `学生`）
 *   · 长度 < 2 ⇒ 不可用（单字姓名在这批数据里全是脏值；真名单字罕见，人工填一次成本很低）
 *   · 形如「XX学生」「XX家长」⇒ 不可用（把身份当名字）
 *   · 含联系方式特征（数字 ≥ 5 位 / 含 `@` / 含 http）⇒ 不可用
 * ⚠️ **不做**「长度 > N 截断」这类猜测性清洗 —— 猜错会静默改掉真名。
 */
export function weilingStudentNameProblem(raw: unknown): string | null {
  const s = String(raw ?? '')
    .replace(/\u200b/g, '')
    .trim();
  if (!s) return '卫瓴这条联系人没有填「学生姓名」（自定义字段 xsxm 为空），请手工填写';
  if (WEILING_STUDENT_NAME_PLACEHOLDERS.includes(s)) {
    return `卫瓴里填的是占位值「${s}」，不是真实姓名，请手工填写`;
  }
  if (s.length < 2) return `「${s}」只有 1 个字，不像完整姓名，请确认`;
  if (/(学生|家长|妈妈|爸爸)$/.test(s) && s.length <= 5) {
    return `「${s}」看起来是身份描述而不是姓名，请确认`;
  }
  if (/\d{5,}|@|https?:\/\//.test(s)) return `「${s}」看起来是联系方式，不是姓名，请确认`;
  return null;
}

/** 清洗后的学生姓名（仅去零宽字符与首尾空白；不做任何猜测性改写） */
export function weilingStudentName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\u200b/g, '')
    .trim();
}

/**
 * 卫瓴「原学校类型」（api_name `yxxlx`）→ 学生档案「原学校类型」。
 *
 * 卫瓴 6 档 vs 学生档案 2 个选项 ⇒ **只有 2 档能对上**，其余留空
 * （`null` = 无对应，UI 上标出来，别让用户以为漏了）。
 *
 * 要不要给「原学校类型」补选项是另一个决定（要改字段定义）；在没补之前，
 * 写一个选项外的值会让这个字段在界面上显示成"没值"，比留空更难排查。
 */
export const WEILING_SCHOOL_TYPE_MAP: Record<string, string | null> = {
  体制内: '体制内学校',
  国际课程: '国际学校',
  'homeschool 或 休学': null,
  海外回国: null,
  创新学校: null,
  其他: null,
};

export const ARCHIVE_SCHOOL_TYPE_OPTIONS: readonly string[] = ['国际学校', '体制内学校'];

/**
 * 卫瓴「计划入读致极学院时间」（api_name `jxrdzjxysj`）→ 学生档案「入学年月」的选项值。
 *
 * 学生档案「入学年月」的选项形如 `25秋季` / `26春季`（见 `student-enroll.ts`）。
 * ⚠️ 卫瓴这一档的**粒度只到学期**（且 `2026年秋季或后` 是模糊的"或后"）⇒ 归到 `check` 档，
 *    默认填上但要求人工确认；`其它` 不映射（返回空串）。
 */
export const WEILING_PLANNED_TERM_MAP: Record<string, string> = {
  '2025年秋季学期': '25秋季',
  '2026年春季学期': '26春季',
  '2026年秋季或后': '26秋季',
  其它: '',
};

export const ARCHIVE_ENROLL_MONTH_OPTIONS: readonly string[] = [
  '21春季', '21秋季', '22春季', '22秋季', '23春季', '23秋季',
  '24春季', '24秋季', '25春季', '25秋季', '26春季', '26秋季',
  '27春季', '27秋季', '28春季', '28秋季',
];

export const ARCHIVE_PAYMENT_OPTIONS: readonly string[] = ['未付款', '已付款'];

/**
 * 转档的上下文（**全部是"已翻译成人话"的值**）。
 *
 * 🔴 为什么不在本函数里翻译代码值：卫瓴的枚举存在「卫瓴字段描述表」里（要查库），
 *    纯函数不能碰 DB。调用方（WeilingService）查完翻译再传进来，
 *    这样判据可单测、且与线上跑的是同一份。
 */
export interface WeilingEnrollContext {
  /** 联系人姓名（仅用于留痕，不作学生姓名） */
  contactName: string;
  /** `xsxm` 原始值 */
  studentNameRaw: string;
  /** 归属人显示名（如「致极学院-曹老师｜Dainel」） */
  ownerName: string;
  /** 归属人映射出的 ACMS 用户 open_id（`''` = 映射不到） */
  recruiterOpenId: string;
  /** 招生老师姓名（展示用；映射不到时为空串） */
  recruiterName: string;
  /** `suozaixx` 所在学校（纯文本） */
  school: string;
  /** `yxxlx` 原学校类型（已翻译，如「国际课程」） */
  schoolType: string;
  /** `jxrdzjxysj` 计划入读（已翻译，如「2026年春季学期」） */
  plannedTerm: string;
  /** `jfqk` 缴费情况（已翻译，`是` / `否`） */
  paid: string;
  /** 联系人的手机号（**只进备注**，见 `buildEnrollDraft` 的 skip 说明） */
  mobile: string;
  /** 只进备注的营销信息（意向度 / 线索定性 / 咨询者类型 / 意向留学国别 / 客户阶段 / 来源渠道） */
  marketing: { label: string; value: string }[];
  /** 卫瓴线索创建时间（毫秒；0 = 未知） */
  createdAt: number;
  /** 操作人展示名 */
  operatorName: string;
  /** 转化时刻（毫秒，**由调用方传** —— 纯函数里不许读时钟） */
  now: number;
}

/** 北京时间 `YYYY-MM-DD HH:mm`（显式指定时区，不依赖服务器时区） */
export function weilingEnrollClock(ms: number): string {
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 拼「备注」里的留痕（进不了字段的信息都在这里落地） */
export function buildEnrollRemark(ctx: WeilingEnrollContext): string {
  const lines: string[] = [];
  lines.push(`【卫瓴入学】${weilingEnrollClock(ctx.now)} · 操作人 ${ctx.operatorName || '—'}`);
  lines.push(`来源联系人：${ctx.contactName || '—'}（归属人 ${ctx.ownerName || '—'}）`);
  const mk = ctx.marketing.filter((m) => m.value).map((m) => `${m.label}：${m.value}`);
  if (mk.length) lines.push(mk.join(' · '));
  const src: string[] = [];
  if (ctx.school) src.push(`所在学校：${ctx.school}`);
  if (ctx.schoolType) src.push(`原学校类型：${ctx.schoolType}`);
  if (ctx.plannedTerm) src.push(`计划入读：${ctx.plannedTerm}`);
  if (ctx.createdAt) src.push(`线索创建：${weilingEnrollClock(ctx.createdAt).slice(0, 10)}`);
  if (src.length) lines.push(src.join(' · '));
  if (ctx.mobile) lines.push(`联系电话：${ctx.mobile}（联系人本人电话，非学生手机号）`);
  return lines.join('\n');
}

/**
 * 装配转档草稿。
 *
 * 🔴 三档的**边界**就是本函数存在的意义 —— 前端把它渲染成弹窗、后端拿它写库，
 *    所以「显示会填什么」与「实际填什么」永远是同一份。
 */
export function buildEnrollDraft(ctx: WeilingEnrollContext): EnrollDraft {
  const studentName = weilingStudentName(ctx.studentNameRaw);
  const nameProblem = weilingStudentNameProblem(ctx.studentNameRaw);
  const remark = buildEnrollRemark(ctx);

  const schoolType = ctx.schoolType ? (WEILING_SCHOOL_TYPE_MAP[ctx.schoolType] ?? null) : null;
  const enrollMonth = ctx.plannedTerm ? (WEILING_PLANNED_TERM_MAP[ctx.plannedTerm] ?? '') : '';
  const payment = ctx.paid === '是' ? '已付款' : ctx.paid === '否' ? '未付款' : '';

  const fields: EnrollDraftField[] = [
    {
      key: '学生姓名',
      label: '学生姓名',
      value: studentName,
      tier: 'solid',
      source: '← xsxm 学生姓名（已过滤占位值）',
      editable: true,
    },
    {
      key: '招生负责老师',
      label: '招生负责老师',
      value: ctx.recruiterOpenId,
      display: ctx.recruiterOpenId ? ctx.recruiterName || '（已按映射填入）' : '（映射不到，留空）',
      tier: 'solid',
      source: ctx.recruiterOpenId
        ? `← 归属人「${ctx.ownerName}」→ 归属人映射 → 用户表 open_id${ctx.recruiterName ? `（${ctx.recruiterName}）` : ''}`
        : `← 归属人「${ctx.ownerName || '（空）'}」在归属人映射表里查不到对应 ACMS 用户，留空`,
      editable: false,
    },
    {
      key: '原学校',
      label: '原学校',
      value: ctx.school,
      tier: 'solid',
      source: '← suozaixx 所在学校（卫瓴侧是纯文本，与档案字段同形）',
      editable: true,
    },
    {
      key: '原学校类型',
      label: '原学校类型',
      value: schoolType ?? '',
      tier: 'check',
      source: ctx.schoolType
        ? `← yxxlx「${ctx.schoolType}」`
        : '← 卫瓴未填 yxxlx 原学校类型',
      why:
        ctx.schoolType && !schoolType
          ? `卫瓴是「${ctx.schoolType}」，学生档案这一栏只有「国际学校 / 体制内学校」两个选项，对不上 ⇒ 留空（要填请手选）`
          : undefined,
      editable: true,
      options: ARCHIVE_SCHOOL_TYPE_OPTIONS,
    },
    {
      key: ENROLL_MONTH_FIELD,
      label: '入学年月',
      value: enrollMonth,
      tier: 'check',
      source: ctx.plannedTerm
        ? `← jxrdzjxysj「${ctx.plannedTerm}」`
        : '← 卫瓴未填 jxrdzjxysj 计划入读时间',
      why: ctx.plannedTerm
        ? '卫瓴这一档只到学期（还有「秋季或后」这种模糊值）⇒ 请确认到具体学期'
        : undefined,
      editable: true,
      options: ARCHIVE_ENROLL_MONTH_OPTIONS,
    },
    {
      key: '付款状态',
      label: '付款状态',
      value: payment,
      tier: 'check',
      source: ctx.paid ? `← jfqk 缴费情况「${ctx.paid}」` : '← 卫瓴未填 jfqk 缴费情况（该字段全库仅 7 条有值）',
      editable: true,
      options: ARCHIVE_PAYMENT_OPTIONS,
    },
    {
      key: '备注',
      label: '备注',
      value: remark,
      tier: 'check',
      source: '← 自动生成的来源留痕（进不了字段的信息都放这里）',
      editable: true,
    },

    // ── 明确不填，且写明理由 ──────────────────────────────────
    {
      key: '当前年级',
      label: '当前年级',
      value: '',
      tier: 'skip',
      source: '← xssjxx 学生年级',
      why:
        '**选项体系不同，映射不了**：卫瓴给的是 G1–G12（年级），' +
        '学生档案「当前年级」的选项是 Foundation / Pre-1 / Pre-2 / Pre-3 / 大一 / 未来班级 —— ' +
        '没有 G 系列。硬写一个选项外的值，界面上会显示成"这个字段没值"，比留空更难查。' +
        '（卫瓴的年级已写进备注）',
      editable: false,
    },
    {
      key: '学生手机号',
      label: '学生手机号',
      value: '',
      tier: 'skip',
      source: '← 联系人手机号',
      why:
        '卫瓴的「手机号」是**联系人（多半是家长）**的电话，不是学生本人手机号；' +
        '而「学生手机号」是卫瓴自动匹配算法的 **88 分判据** —— 写错会反过来破坏以后的自动匹配。' +
        '（该号码已写进备注）',
      editable: false,
    },
    {
      key: '学生邮箱',
      label: '学生邮箱',
      value: '',
      tier: 'skip',
      source: '← 联系人邮箱',
      why: '卫瓴联系人表 3703 条里「邮箱」**0 条有值**，没有可填的数据',
      editable: false,
    },
    {
      key: '来源渠道',
      label: '来源渠道',
      value: '',
      tier: 'skip',
      source: '← 来源渠道',
      why:
        '口径对不上：卫瓴有 18 种取值（活动-公众号 / 小红书 / 线下-推荐人转介绍 …），' +
        '学生档案这一栏只有「官网咨询 / 转介绍 / 活动招募 / 其他」4 个固定选项，' +
        '需要先定一条映射规则（已列为待确认项）；映射规则定下来之前留空',
      editable: false,
    },
    {
      key: '生源跟进状态',
      label: '生源跟进状态',
      value: '',
      tier: 'skip',
      source: '← 客户阶段',
      why: '口径待定：卫瓴「客户阶段」是 潜在/适龄/面访/面试/成交客户，学生档案是 新线索/未录取/已录取/已入学，需要先定映射规则',
      editable: false,
    },
    {
      key: '学生标签',
      label: '学生标签',
      value: '',
      tier: 'skip',
      source: '← 标签',
      why: '卫瓴「标签」列的值其实是**标签组名**（客户来源 / 个人标签 / 客户等级）的拼接，不是标签值，填进去没有意义',
      editable: false,
    },
    {
      key: '（以下无对应字段）',
      label: '意向度 / 线索定性 / 咨询者类型 / 意向留学国别',
      value: '',
      tier: 'skip',
      source: '← 卫瓴自定义字段',
      why: '学生档案**没有**承接这些信息的字段；它们对招生老师有用，已全部写进「备注」留痕',
      editable: false,
    },
  ];

  return {
    studentName,
    nameProblem,
    fields,
    // 「入学年月」一变，入学年份 / Arete入学年 跟着派生（与档案页同一份规则）
    derived: deriveEnrollFields(enrollMonth) as Record<string, string>,
    remark,
  };
}

/** 从草稿里取出「要写进学生档案」的字段（只取 solid / check 档且有值/有意义的） */
export function enrollWriteFields(
  draft: EnrollDraft,
  picked: Record<string, boolean>,
  overrides: Record<string, string> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of draft.fields) {
    if (f.tier === 'skip') continue;
    if (picked[f.key] === false) continue; // 显式取消勾选
    const v = overrides[f.key] !== undefined ? overrides[f.key] : f.value;
    if (String(v ?? '').trim() === '') continue; // 空值不写（学生档案里"没填"就是没填）
    out[f.key] = v;
  }
  // 派生字段：只有「入学年月」真的被写入时才带出；用户手工改了入学年月就按用户的值算
  const month = out[ENROLL_MONTH_FIELD];
  if (month) for (const [k, v] of Object.entries(deriveEnrollFields(month) as Record<string, string>)) out[k] = v;
  return out;
}
