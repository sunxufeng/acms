/**
 * 行为记录（Behaviour）的**零依赖纯逻辑**：窗口切分 / 告警判级 / 触发原因与信件正文生成。
 *
 * 为什么单独抽一层（对照 skill「坑 5：同一份判据不要写两遍」）：
 *   1. 告警重算（BehaviourService.recalcAlerts）与「记录写入后立即算一次」用的必须是**同一套判据**，
 *      各写一份必然漂移 —— 出现「列表说轻度、重算接口说中度」这种最难查的不一致。
 *   2. 阈值改口径时只改这一处（ALERT_TIERS / ALERT_COUNT_THRESHOLD）。
 *
 * ⚠️ 本文件**不许 import 任何东西**（Nest / pg / 存储层都不行）：
 *    它是纯数据模块的共用件，一旦引入 Nest 依赖就可能与 service 形成环。
 *
 * ── 最终口径（改这里就等于改口径，务必同步报告）────────────────────
 *   统计窗口   「最近30天」（滚动 30 天）与「本学期」（9/1 或 2/1 起到现在）两档，各出一条告警
 *   计入口径   行为类型=「负向」的记录；分值累计取**绝对值**
 *   触发条件   负向分值绝对值累计 ≥ 5（轻度）/ 10（中度）/ 20（严重），或负向条数 ≥ 3（轻度）
 *   等级        满足的**最高档**
 *   解除        分值累计 < 5 且 条数 < 3 → 状态改「已解除」（保留历史，不删记录）
 */

// ── 口径常量 ─────────────────────────────────────────────────────────

/** 短窗口名（落库到「告警窗口」） */
export const ALERT_WINDOW_RECENT = '最近30天';
/** 最近 N 天（滚动窗口） */
export const RECENT_WINDOW_DAYS = 30;

/** 分值档：由高到低（判级从高往低试，第一个满足的就是最终等级） */
export const ALERT_TIERS: readonly { level: string; points: number }[] = [
  { level: '严重', points: 20 },
  { level: '中度', points: 10 },
  { level: '轻度', points: 5 },
];
/** 条数阈值：负向行为达到这个条数即触发**最低档**（更高的档只由分值决定） */
export const ALERT_COUNT_THRESHOLD = 3;

export const ALERT_LEVELS = ['轻度', '中度', '严重'] as const;
export const ALERT_STATUSES = ['未处理', '处理中', '已解除'] as const;
export const BEHAVIOUR_DIRECTIONS = ['正向', '负向'] as const;
export const BEHAVIOUR_RECORD_STATUSES = ['草稿', '已发布', '已归档'] as const;
export const FOLLOW_UP_METHODS = ['谈话', '电话', '家访', '书面', '其它'] as const;
export const FOLLOW_UP_STATUSES = ['待跟进', '进行中', '已完成'] as const;
export const LETTER_TYPES = ['提醒', '警告', '严重警告'] as const;
export const LETTER_STATUSES = ['草稿', '已发送', '已确认'] as const;

// ── 基础取值/解析（与 record 的宽松形态对齐）────────────────────────

/** 数值字段解析（空值/非法值给 0；分值可能是 '3'、'-2'、3 三种形态） */
export function numOf(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * 归一成 epoch 毫秒；解析不了返回 null。
 *
 * 为什么三种形态都要认：本模块的自建表 `ensureTable` 没登记 `acms_fields` 元数据，
 * SqlStore 的 `normalize()` 不会把日期还原成 `YYYY-MM-DD`，读出来仍是毫秒戳（number）；
 * 但前端表单提交的可能又是 `YYYY-MM-DD` / `YYYY-MM-DD HH:mm` 字符串。
 */
export function toMs(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = new Date(s.includes('T') ? s : s.replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? null : t;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 毫秒戳 → 本地时区 `YYYY-MM-DD` */
export function toDateStr(v: unknown): string {
  const ms = toMs(v);
  if (ms == null) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? '').trim());
    return m ? (m[1] as string) : '';
  }
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 关联字段原始值是否包含某个 record id。
 * 兼容 `['rec_x']`（本模块写入形态）、`[{ record_ids:['rec_x'] }]`（迁移态）与兜底的文本包含。
 */
export function hasLinkId(v: unknown, id: string): boolean {
  if (!id) return false;
  const arr = Array.isArray(v) ? v : [v];
  for (const it of arr) {
    if (typeof it === 'string' && it === id) return true;
    if (it && typeof it === 'object') {
      const o = it as Record<string, unknown>;
      for (const key of ['record_ids', 'link_record_ids'] as const) {
        const list = o[key];
        if (Array.isArray(list) && list.some((x) => String(x) === id)) return true;
      }
      for (const key of ['record_id', 'link_record_id', 'id'] as const) {
        if (o[key] != null && String(o[key]) === id) return true;
      }
    }
  }
  return String(v ?? '').includes(id);
}

/** 取关联字段里的第一个 record id（本模块的关联都是单值语义） */
export function firstLinkId(v: unknown): string {
  const arr = Array.isArray(v) ? v : [v];
  for (const it of arr) {
    if (typeof it === 'string' && it) return it;
    if (it && typeof it === 'object') {
      const o = it as Record<string, unknown>;
      for (const key of ['record_ids', 'link_record_ids'] as const) {
        const list = o[key];
        if (Array.isArray(list) && list.length) return String(list[0]);
      }
      for (const key of ['record_id', 'link_record_id', 'id'] as const) {
        if (o[key] != null && String(o[key])) return String(o[key]);
      }
    }
  }
  return '';
}

// ── 行为事实 ─────────────────────────────────────────────────────────

/** 一条行为记录（已归一化为告警统计用的事实） */
export interface BehaviourFact {
  id: string;
  studentId: string;
  studentName: string;
  className: string;
  /** 是否负向行为 */
  negative: boolean;
  /** 分值**绝对值**（正向也取绝对值，只是不进负向累计） */
  magnitude: number;
  /** 发生时刻（毫秒；缺失时服务端会用落库时间兜底） */
  occurredMs: number;
  /** 行为分类（自由文本/字典值） */
  category: string;
  /** 描述原文 */
  description: string;
  /** 行为类型原文（正向/负向/空） */
  direction: string;
}

/**
 * 是否负向行为。
 * 优先认「行为类型」字段；未填类型时按**分值符号**兜底（分值 < 0 视为负向），
 * 这样历史数据/快速录入不至于完全不计入告警。
 */
export function isNegativeBehaviour(v: unknown, points?: unknown): boolean {
  const dir = String(v ?? '').trim();
  if (dir === '负向') return true;
  if (dir === '正向') return false;
  return numOf(points) < 0;
}

/** 由一条行为记录字段构造事实；recordId 用 `recordId ?? id` 兜底（SqlStore 返回的是 recordId） */
export function factOf(
  recordId: string,
  fields: Record<string, unknown>,
  fallbackMs = 0,
): BehaviourFact {
  const points = fields['分值'];
  return {
    id: recordId,
    studentId: firstLinkId(fields['学生']),
    studentName: String(fields['学生姓名'] ?? ''),
    className: String(fields['班级'] ?? ''),
    negative: isNegativeBehaviour(fields['行为类型'], points),
    magnitude: Math.abs(numOf(points)),
    occurredMs: toMs(fields['发生时间']) ?? toMs(fields['发生日期']) ?? fallbackMs,
    category: String(fields['行为分类'] ?? ''),
    description: String(fields['描述'] ?? ''),
    direction: String(fields['行为类型'] ?? ''),
  };
}

// ── 窗口 ─────────────────────────────────────────────────────────────

/** 学年/学期：9/1 起到次年 8/31 为一个学年；9-12 月与 1 月属第一学期，2-8 月属第二学期 */
export function termOf(nowMs: number): { startMs: number; label: string } {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  if (m >= 9) return { startMs: new Date(y, 8, 1).getTime(), label: `${y}-${y + 1}学年第一学期` };
  if (m === 1) return { startMs: new Date(y - 1, 8, 1).getTime(), label: `${y - 1}-${y}学年第一学期` };
  return { startMs: new Date(y - 1, 8, 1).getTime(), label: `${y - 1}-${y}学年第二学期` };
}

/** 本学期窗口名（含学期标识）—— 半学年一变，保证「同一学生同一窗口一条告警」的稳定 id 不会跨学期复用 */
export function termWindow(nowMs: number): string {
  return `本学期（${termOf(nowMs).label}）`;
}

/**
 * 两个统计窗口。
 * ⚠️ 窗口名会被拼进告警记录 id（`<studentId>__<窗口>`），所以「本学期」必须带学期标识 ——
 *    否则下个学期会 upsert 到上学期的同一条记录上，历史被覆盖。
 */
export function alertWindows(nowMs: number): { window: string; from: number; to: number }[] {
  return [
    { window: ALERT_WINDOW_RECENT, from: nowMs - RECENT_WINDOW_DAYS * 86400_000, to: nowMs },
    { window: termWindow(nowMs), from: termOf(nowMs).startMs, to: nowMs },
  ];
}

/** 告警记录 id：同一学生同一窗口只有一条（upsert 用） */
export function alertIdOf(studentId: string, window: string): string {
  return `${studentId}__${window}`;
}

/**
 * 由窗口名反解时间区间（生成信件正文时要把窗口内的行为明细列出来）。
 * 「本学期（xxxx-xxxx学年第一学期）」按**当前**学期解析 —— 学期一过，历史信件也不会再重生成，
 * 所以不需要（也无法）从标签里反推任意学期的起止。
 */
export function windowRangeOf(window: string, nowMs: number): { from: number; to: number } {
  if (window === ALERT_WINDOW_RECENT) {
    return { from: nowMs - RECENT_WINDOW_DAYS * 86400_000, to: nowMs };
  }
  if (window.startsWith('本学期')) {
    return { from: termOf(nowMs).startMs, to: nowMs };
  }
  // 未知窗口：不设下界，按「全部历史」处理（宁多勿少，便于人工核对）
  return { from: 0, to: nowMs };
}

// ── 判级 ─────────────────────────────────────────────────────────────

/** 分值/条数 → 告警等级；空串表示未触发 */
export function levelOf(points: number, count: number): string {
  for (const t of ALERT_TIERS) {
    if (points >= t.points) return t.level;
  }
  if (count >= ALERT_COUNT_THRESHOLD) return '轻度';
  return '';
}

/** 该分值档的阈值（未达档返回 0） */
export function tierPointsOf(level: string): number {
  return ALERT_TIERS.find((t) => t.level === level)?.points ?? 0;
}

export interface AlertEvaluation {
  window: string;
  /** 命中的最高档；空串 = 未触发 */
  level: string;
  /** 负向分值绝对值累计 */
  points: number;
  /** 负向行为条数 */
  count: number;
  /** 触发原因（自动拼文本，写清是分值还是条数） */
  reason: string;
  /** 首次/最近触发时刻（毫秒） */
  firstMs: number;
  lastMs: number;
  /** 参与统计的行为记录 id */
  relatedIds: string[];
  /** 参与统计的行为事实（生成信件正文要用） */
  facts: BehaviourFact[];
}

/**
 * 单窗口评估：把某个学生的全部行为事实按窗口过滤后判级。
 * `facts` 传该学生的全部事实（函数内部按窗口过滤），这样两个窗口可复用同一份输入。
 */
export function evaluateWindow(
  facts: readonly BehaviourFact[],
  window: string,
  from: number,
  to: number,
): AlertEvaluation {
  const hit = facts
    .filter((f) => f.negative && f.occurredMs >= from && f.occurredMs <= to)
    .sort((a, b) => a.occurredMs - b.occurredMs);
  const points = hit.reduce((s, f) => s + f.magnitude, 0);
  const count = hit.length;
  const level = levelOf(points, count);
  const reason = level
    ? buildTriggerReason(level, points, count, window)
    : buildReleaseReason(points, count, window);
  return {
    window,
    level,
    points: Math.round(points * 100) / 100,
    count,
    reason,
    firstMs: hit.length ? (hit[0] as BehaviourFact).occurredMs : 0,
    lastMs: hit.length ? (hit[hit.length - 1] as BehaviourFact).occurredMs : 0,
    relatedIds: hit.map((f) => f.id),
    facts: hit,
  };
}

/** 两个窗口全算（顺序固定：最近30天 → 本学期） */
export function evaluateAll(facts: readonly BehaviourFact[], nowMs: number): AlertEvaluation[] {
  return alertWindows(nowMs).map((w) => evaluateWindow(facts, w.window, w.from, w.to));
}

/** 触发原因：必须写清是「分值达标」还是「条数达标」 */
export function buildTriggerReason(level: string, points: number, count: number, window: string): string {
  const parts: string[] = [];
  const tierPoints = tierPointsOf(level);
  if (tierPoints > 0 && points >= tierPoints) {
    parts.push(`负向行为分值累计 ${fmtNum(points)} 分（达到「${level}」阈值 ${tierPoints} 分）`);
  }
  if (count >= ALERT_COUNT_THRESHOLD) {
    parts.push(`负向行为 ${count} 条（达到「轻度」条数阈值 ${ALERT_COUNT_THRESHOLD} 条）`);
  }
  if (!parts.length) return `${window}内触发「${level}」告警`;
  return `${window}内${parts.join('，且')}，判定为「${level}」告警。`;
}

/** 解除原因：累计值与条数都低于最低档 */
export function buildReleaseReason(points: number, count: number, window: string): string {
  const mild = tierPointsOf('轻度');
  return (
    `${window}内负向行为分值累计 ${fmtNum(points)} 分、共 ${count} 条，` +
    `均低于「轻度」阈值（${mild} 分 / ${ALERT_COUNT_THRESHOLD} 条），告警已解除。`
  );
}

/** 数字展示：整数不带小数，小数最多两位 */
export function fmtNum(v: unknown): string {
  const n = numOf(v);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// ── 信件 ─────────────────────────────────────────────────────────────

/** 告警等级 → 信件类型 */
export function letterTypeOf(level: string): string {
  if (level === '严重') return '严重警告';
  if (level === '中度') return '警告';
  return '提醒';
}

export interface LetterBodyInput {
  studentName: string;
  className: string;
  window: string;
  level: string;
  points: number;
  count: number;
  facts: readonly BehaviourFact[];
  /** 该学生该档的第几次（≥1） */
  nth: number;
  issueDate: string;
}

const LEVEL_ADVICE: Record<string, string> = {
  轻度: '孩子近期出现的行为提示我们需要多关注，请在家多与孩子沟通，帮助他调整状态；必要时可与班主任联系了解在校情况。',
  中度: '上述行为已持续出现，建议家长尽快与班主任沟通，共同商定家庭与学校两端的改进办法。',
  严重: '上述行为已较为集中，学校将安排专人跟进，请家长尽快到校与班主任面谈，一起制定后续改进计划。',
};

/**
 * 家长通知信件正文：**服务端按模板 + 行为事实生成**，不允许手填。
 * 正文里的每一条事实都来自行为记录（日期/分类/描述/分值），保证与数据一致。
 */
export function buildLetterBody(i: LetterBodyInput): string {
  const name = i.studentName || '学生';
  const lines: string[] = [];
  lines.push(`致 ${name} 家长：`);
  lines.push('');
  lines.push(
    `您好！为了让孩子得到更及时的支持，现将 ${name} 近期在校的行为表现通报如下，希望能得到您的理解与配合。`,
  );
  lines.push('');
  lines.push('【基本情况】');
  lines.push(`· 班级：${i.className || '—'}`);
  lines.push(`· 统计窗口：${i.window}`);
  lines.push(`· 负向行为条数：${i.count} 条`);
  lines.push(`· 负向分值累计：${fmtNum(i.points)} 分`);
  lines.push(`· 提醒等级：${i.level}`);
  lines.push('');
  lines.push('【行为明细】');
  if (i.facts.length) {
    i.facts.forEach((f, idx) => {
      const date = toDateStr(f.occurredMs) || '日期未填';
      const cat = f.category ? `${f.category} · ` : '';
      const desc = f.description ? `：${f.description}` : '';
      lines.push(`${idx + 1}. ${date} ${cat}负向行为${desc}（${fmtNum(f.magnitude)} 分）`);
    });
  } else {
    lines.push('· （统计窗口内没有明细记录）');
  }
  lines.push('');
  lines.push('【学校的建议】');
  lines.push(LEVEL_ADVICE[i.level] ?? LEVEL_ADVICE['轻度'] ?? '');
  lines.push('');
  if (i.nth > 1) {
    lines.push(`此信是我们就 ${name} 的表现向您发出的第 ${i.nth} 次书面通知。`);
    lines.push('');
  }
  lines.push(`${i.issueDate}`);
  lines.push('（本信由系统根据行为记录自动生成，如有疑问请联系班主任。）');
  return lines.join('\n');
}

// ── 统计（按班级/年级汇总）───────────────────────────────────────────

/** 空桶工厂：各处汇总行形状一致，避免三处各写一遍默认值 */
export function emptyStatsRow(className: string, grade: string) {
  return {
    班级: className,
    年级: grade,
    行为条数: 0,
    正向条数: 0,
    负向条数: 0,
    涉及学生数: 0,
    告警数: 0,
    告警人数: 0,
    轻度: 0,
    中度: 0,
    严重: 0,
  };
}

export type StatsRow = ReturnType<typeof emptyStatsRow>;
