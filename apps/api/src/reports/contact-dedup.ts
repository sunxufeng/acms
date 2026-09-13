/**
 * 联系人去重 —— 判据、分组与置信度（**纯函数**，service 与线下校验共用）。
 *
 * 背景（2026-09-14 设计，基于生产 3664 条实测）：
 *  - 卫瓴已按手机号天然去重：1746 条有号的记录**零重复**，
 *    所以「疑似重复」几乎只发生在**没有手机号的 1996 条**里；
 *  - 顶层 `联系人姓名` 有大量占位符（`--` 85 条、`-`、`未知`）与宽泛称呼（`王先生`/`李女士`），
 *    这些**不能当判据** —— 否则 85 条 `--` 会聚成一个巨型假组；
 *  - 线索批量导入（如「广告平台-其他」同日导入）会让「同名」大量假命中，
 *    必须用**反证据**把它排除：**组内出现 ≥2 个不同手机号 ⇒ 是不同的人**。
 *    实测这一条把 56 组降到 40 组，砍掉的全是「王先生 × 6 条不同手机号」这类假重复。
 *
 * 置信度分级（默认只给 strong + likely，weak 需显式打开）：
 *  - strong  手机号一致 / 微信 ID 一致 / 姓名+备注都一致
 *  - likely  姓名 + 归属人一致，或姓名 + 来源渠道一致
 *  - weak    仅姓名一致（含英文昵称这类容易撞名的）
 */

/** 参与匹配的行（由 service 从 PG 宽表投影出来） */
export interface DedupRow {
  id: string;
  /** 原始姓名（展示用） */
  name: string;
  /** 原始手机号（展示用） */
  phone: string;
  /** 归一化手机号（内部匹配用） */
  phoneKey: string;
  remark: string;
  channel: string;
  owner: string;
  stage: string;
  /** 流失状态 */
  lost: string;
  /** 关联学生（已匹配时才有） */
  student: string;
  /** 学生姓名（自定义字段 xsxm，用于佐证） */
  studentName: string;
  createdAt: number;
  lastFollowAt: number;
  score: number;
  /** 卫瓴联系人 ID（导出后回卫瓴核对用） */
  weilingId: string;
  /** 卫瓴的微信 ID（判据用；实测当前 143 条有值、其中 40 条是占位 `-`，故暂时不产生命中） */
  wxId: string;
}

export interface DedupMember extends DedupRow {
  /** 建议保留（信息最全 + 最早创建） */
  keep: boolean;
}

export type DedupLevel = 'strong' | 'likely' | 'weak';

export interface DedupGroup {
  /** 稳定编号（G-001…），导出清单与页面共用 */
  key: string;
  /** 归一化后的姓名（组标题） */
  label: string;
  level: DedupLevel;
  /** 命中证据（给人看的标签） */
  evidences: string[];
  members: DedupMember[];
}

export interface DedupStats {
  /** 联系人总数 */
  total: number;
  /** 无手机号的记录数（重复只可能出现在这里） */
  noPhone: number;
  /** 疑似重复组数（全量口径，不受页面筛选影响） */
  groups: number;
  /** 涉及的记录数 */
  records: number;
  /** 合并后可减少的记录数 = records - groups */
  mergeable: number;
  byLevel: Record<DedupLevel, number>;
}

export interface DedupResult {
  generatedAt: number;
  stats: DedupStats;
  groups: DedupGroup[];
  filterOptions: { channels: string[]; owners: string[] };
}

/** 不能作为判据的姓名（占位符） */
const PLACEHOLDER_NAMES = new Set([
  '', '-', '--', '---', '.', '。', '...', '未知', '无', '暂无', '匿名', 'null', 'undefined', 'none', 'n/a', 'na', 'nan', '0',
]);

/**
 * 宽泛称呼（`王先生` / `李女士` / `张同学` …）。
 * 这类名字撞名率极高且几乎都是「没填真名」，单独成组只会制造噪声 —— 直接不参与。
 */
const BROAD_NAME_RE = /^[\u4e00-\u9fa5]{1,2}(先生|女士|小姐|老师|同学|家长|爸爸|妈妈)$/;

/**
 * 姓名里紧跟的渠道后缀（人工在姓名栏写渠道留下的，如 `Annie-公众号`）。
 * 去掉后再比，才能把 `Annie-公众号` 与 `Annie` 归到同一组（实测多找回 11 组）。
 */
const CHANNEL_SUFFIX_RE =
  /[-—－–·•_\s]*(公众号|视频号|小红书|直播|朋友圈|抖音|快手|微博|知乎|表单|现场报名|广告平台|其他|腾讯|微信|企微|客服)\s*$/;

/** 归一化姓名：去空白、去渠道后缀、英文统一小写（仅用于匹配，展示仍用原值） */
export function normalizeName(raw: unknown): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/\s+/g, '');
  // 渠道后缀可能叠加（`张三-公众号-直播`），最多剥 3 层
  for (let i = 0; i < 3; i += 1) {
    const next = s.replace(CHANNEL_SUFFIX_RE, '');
    if (next === s) break;
    s = next;
  }
  s = s.replace(/[-—－–·•_]+$/, '');
  return s.toLowerCase();
}

/** 归一化手机号：只留数字，剥掉 +86 / 086 前缀 */
export function normalizePhone(raw: unknown): string {
  const d = String(raw ?? '').replace(/[^0-9]/g, '');
  if (d.length === 13 && d.startsWith('86')) return d.slice(2);
  if (d.length === 14 && d.startsWith('086')) return d.slice(3);
  return d;
}

/** 是否为「可作为判据的姓名」：非占位符、非宽泛称呼、至少 2 个字符 */
export function isUsableName(norm: string): boolean {
  if (!norm) return false;
  if (PLACEHOLDER_NAMES.has(norm)) return false;
  if (BROAD_NAME_RE.test(norm)) return false;
  // 纯符号/纯数字（如 `123`、`....`）不是姓名
  if (!/[\u4e00-\u9fa5a-z]/.test(norm)) return false;
  // 单字符撞名率过高（实测「王」「李」各出现 2~4 次却互不相干）
  if (norm.length < 2) return false;
  return true;
}

/** 有效手机号：7~15 位（库里存在 19/23 位的异常值，那些不算） */
export function isValidPhone(phoneKey: string): boolean {
  return phoneKey.length >= 7 && phoneKey.length <= 15;
}

/** 安全取 JSON 字符串里的键（`原始数据` / `自定义字段` 存的是 JSON 文本，不是 jsonb 对象） */
export function pickJson(raw: unknown, key: string): string {
  if (raw == null) return '';
  if (typeof raw === 'object') {
    const v = (raw as Record<string, unknown>)[key];
    return v == null ? '' : String(v);
  }
  const s = String(raw).trim();
  if (!s.startsWith('{')) return '';
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const v = o[key];
    return v == null ? '' : String(v);
  } catch {
    return '';
  }
}

/** 有值判断（0 也算有值） */
function filled(v: string): boolean {
  return String(v ?? '').trim().length > 0;
}

/**
 * 时间字段安全转毫秒。
 * 宽表里的「创建时间 / 最近跟进时间」是上游原始值，可能是毫秒数、秒数，或 ISO 字符串
 * （直接 `Number()` 会得到 NaN，排序与「同分取最早」就会静默失效）。
 */
export function toMs(v: unknown): number {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
    // < 1e11 视为秒级时间戳（毫秒级的是 1.7e12 量级）
    return n < 1e11 ? n * 1000 : n;
  }
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * 宽表记录 → 匹配行。
 *
 * ⚠️ `原始数据` 与 `自定义字段` 在 PG 里存的是 **JSON 文本字符串**，不是 jsonb 对象 ——
 * 必须走 `pickJson`（`(data->>'原始数据')::jsonb->>'key'` 的等价实现）。
 * 早前直接 `记录['原始数据']['contact_id']` 取到的恒为空。
 */
export function toDedupRow(recordId: string, fields: Record<string, unknown>): DedupRow {
  const phone = String(fields['手机号'] ?? '').trim();
  return {
    id: recordId,
    name: String(fields['联系人姓名'] ?? '').trim(),
    phone,
    phoneKey: normalizePhone(phone),
    remark: String(fields['备注'] ?? '').trim(),
    channel: String(fields['来源渠道'] ?? '').trim(),
    owner: String(fields['归属人'] ?? '').trim(),
    stage: String(fields['客户阶段'] ?? '').trim(),
    lost: String(fields['流失状态'] ?? '').trim(),
    student: String(fields['关联学生'] ?? '').trim(),
    studentName: pickJson(fields['自定义字段'], 'xsxm'),
    createdAt: toMs(fields['创建时间']),
    lastFollowAt: toMs(fields['最近跟进时间']),
    score: Number(fields['互动分'] ?? 0) || 0,
    weilingId: pickJson(fields['原始数据'], 'contact_id'),
    wxId: pickJson(fields['原始数据'], 'wx_id'),
  };
}

/**
 * 组内证据与置信度。
 * 只统计「≥2 条同时命中」的证据 —— 一条记录的字段值不能自证同一人。
 */
function judge(group: DedupMember[]): { level: DedupLevel; evidences: string[] } {
  const evidences: string[] = [];
  const countBy = (fn: (m: DedupMember) => string): number => {
    const m = new Map<string, number>();
    for (const x of group) {
      const k = fn(x);
      if (!k) continue;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return Math.max(0, ...m.values());
  };

  // ── 强证据：只要有一条成立，就基本可以确定是同一人 ──
  //    「记一致」不需要再叠加姓名：分桶时已经按归一化姓名分好组，组内姓名必然一致。
  const samePhone = countBy((m) => (isValidPhone(m.phoneKey) ? m.phoneKey : '')) >= 2;
  const sameWx = countBy((m) => (m.wxId && !PLACEHOLDER_NAMES.has(m.wxId.trim()) ? m.wxId.trim() : '')) >= 2;
  const sameRemark = countBy((m) => (filled(m.remark) && !PLACEHOLDER_NAMES.has(m.remark.trim()) ? m.remark.trim() : '')) >= 2;
  if (samePhone) evidences.push('手机号一致');
  if (sameWx) evidences.push('微信ID一致');
  if (sameRemark) evidences.push('备注一致');

  // ── 补充证据：作为标签展示（判定等级时只在没有强证据时才算数）──
  const sameOwner = countBy((m) => m.owner) >= 2;
  const sameChannel = countBy((m) => m.channel) >= 2;
  if (sameOwner) evidences.push('归属人一致');
  if (sameChannel) evidences.push('来源渠道一致');

  if (samePhone || sameWx || sameRemark) return { level: 'strong', evidences };
  if (sameOwner || sameChannel) return { level: 'likely', evidences };
  evidences.push('仅姓名一致');
  return { level: 'weak', evidences };
}

/**
 * 「建议保留哪条」：合并时应该留下信息最全的那条。
 * 权重：有手机号 >> 有关联学生 > 有备注 > 有渠道 > 有归属人；同分取**创建最早**（老记录是主档）。
 */
function keepScore(m: DedupMember): number {
  let s = 0;
  if (isValidPhone(m.phoneKey)) s += 100;
  if (filled(m.student)) s += 20;
  if (filled(m.remark) && !PLACEHOLDER_NAMES.has(m.remark.trim())) s += 10;
  if (filled(m.channel)) s += 5;
  if (filled(m.owner)) s += 2;
  if (filled(m.weilingId)) s += 1;
  return s;
}

const LEVEL_ORDER: Record<DedupLevel, number> = { strong: 0, likely: 1, weak: 2 };

export interface BuildOptions {
  /** 'strong' 只给强证据；'likely'（默认）给强+较可信；'all' 全部 */
  level?: 'strong' | 'likely' | 'all';
  channel?: string;
  owner?: string;
}

/**
 * 分组主流程。
 * 注意：**统计口径（stats）用全量，返回的 groups 才受筛选影响** ——
 * 页面上的统计卡是「这批数据整体有多少重复」，不该随用户切换筛选而跳变。
 */
export function buildDedupGroups(rows: DedupRow[], opts: BuildOptions = {}): DedupResult {
  const stats: DedupStats = {
    total: rows.length,
    noPhone: rows.filter((r) => !isValidPhone(r.phoneKey)).length,
    groups: 0,
    records: 0,
    mergeable: 0,
    byLevel: { strong: 0, likely: 0, weak: 0 },
  };

  // 1) 按归一化姓名分桶（只有可用姓名参与）
  const buckets = new Map<string, DedupRow[]>();
  for (const r of rows) {
    const key = normalizeName(r.name);
    if (!isUsableName(key)) continue;
    const list = buckets.get(key);
    if (list) list.push(r);
    else buckets.set(key, [r]);
  }

  // 2) 组内判定 + 反证据
  const all: DedupGroup[] = [];
  for (const [key, list] of buckets) {
    if (list.length < 2) continue;
    // 🔴 反证据：出现 ≥2 个**不同**手机号 ⇒ 这是不同的人（同渠道批量导入的典型特征）
    const phones = new Set(list.map((r) => r.phoneKey).filter(isValidPhone));
    if (phones.size >= 2) continue;

    const members: DedupMember[] = list.map((r) => ({ ...r, keep: false }));
    // 建议保留：分数最高，同分取创建最早（时间缺失的排最后）
    const best = members.reduce((acc, m) => {
      const a = keepScore(acc);
      const b = keepScore(m);
      if (b !== a) return b > a ? m : acc;
      const at = acc.createdAt || Number.MAX_SAFE_INTEGER;
      const bt = m.createdAt || Number.MAX_SAFE_INTEGER;
      return bt < at ? m : acc;
    }, members[0] as DedupMember);
    best.keep = true;

    const { level, evidences } = judge(members);
    // 组标签：优先用未归一化的原始名（可读），去掉渠道后缀的那条更好看
    const label = members.map((m) => m.name).sort((a, b) => a.length - b.length)[0] ?? key;
    all.push({ key: '', label, level, evidences, members });
  }

  for (const g of all) {
    stats.byLevel[g.level] += 1;
    stats.groups += 1;
    stats.records += g.members.length;
  }
  stats.mergeable = Math.max(0, stats.records - stats.groups);

  // 3) 排序 + 编号：等级优先 → 组内条数多优先 → 姓名
  all.sort((a, b) => {
    const la = LEVEL_ORDER[a.level];
    const lb = LEVEL_ORDER[b.level];
    if (la !== lb) return la - lb;
    if (a.members.length !== b.members.length) return b.members.length - a.members.length;
    return a.label.localeCompare(b.label, 'zh');
  });
  all.forEach((g, i) => {
    g.key = `G-${String(i + 1).padStart(3, '0')}`;
  });

  // 4) 筛选（只影响列表，不影响上面的 stats）
  const minLevel = opts.level ?? 'likely';
  const kept = all.filter((g) => {
    if (minLevel === 'strong' && g.level !== 'strong') return false;
    if (minLevel === 'likely' && g.level === 'weak') return false;
    if (opts.channel && !g.members.some((m) => m.channel === opts.channel)) return false;
    if (opts.owner && !g.members.some((m) => m.owner === opts.owner)) return false;
    return true;
  });

  const filterOptions = {
    channels: [...new Set(rows.map((r) => r.channel).filter(Boolean))].sort(),
    owners: [...new Set(rows.map((r) => r.owner).filter(Boolean))].sort(),
  };

  return { generatedAt: Date.now(), stats, groups: kept, filterOptions };
}
