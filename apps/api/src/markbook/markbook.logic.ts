/**
 * 成绩册的加权汇总、等级映射与达标判定 —— **零依赖纯函数**。
 *
 * ⚠️ 为什么单独一个文件：这套口径在「实时计算网格」「保存条目时写快照」
 * 「重算历史条目」三处都要用。写成两份必然漂移（出现「网格显示 A、条目快照却是 B」），
 * 所以集中在这里，任何一处改口径都只改这一个文件。
 *
 * 口径对照（参照 GibbonEdu/core 的 Markbook）：
 * 1. **两层权重**：列权重 × 类型权重。两者都允许缺省（缺省 = 1）。
 * 2. **汇总分母 = 实际参与项的权重和**（自归一化），不要求各类型权重合计 100。
 *    只录了部分考核时，这样算出来的才是「已录部分的表现」，而不是被没录的项拉低。
 * 3. **分数先归一化到百分制**再加权（列上「满分」不同也能混算）。
 * 4. **达标判定用等级序号，不是分数**：序号越小越好（1 = 最好），
 *    所以「达标 = 实际序号 ≤ 目标序号」—— 与「分数 ≥ 及格线」的直觉相反，前端必须写清。
 */

export interface ColumnDef {
  id: string;
  name: string;
  /** 考核类型（与类型权重表按「类型」匹配） */
  type: string;
  /** 列权重 */
  weight: number;
  /** 满分 */
  fullMark: number;
  /** 等级体系 id（可空：空则用默认体系） */
  scaleId: string;
}

export interface LevelDef {
  id: string;
  scaleId: string;
  /** 显示值，如 A / 优秀 / 90 */
  label: string;
  /** 序号：越小越好（1 = 最好） */
  order: number;
  /** 分数区间（可空；空则按序号等分兜底） */
  min: number | null;
  max: number | null;
  /** 关注标记：落在该等级要不要提示关注 */
  concern: boolean;
}

export interface EntryValue {
  columnId: string;
  studentId: string;
  /** 原始得分（按列的满分制）；null = 未录入 */
  score: number | null;
}

export const DEFAULT_FULL_MARK = 100;

/** 权重兜底：非正数一律当 1（权重为 0 会让分母归零、总评变成无意义） */
export function safeWeight(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** 两层权重相乘 */
export function effectiveWeight(columnWeight: unknown, typeWeight: unknown): number {
  return safeWeight(columnWeight) * safeWeight(typeWeight);
}

/** 得分 → 百分制（保留 2 位）。满分缺失/非正数一律按 100 处理 */
export function normScore(score: number, fullMark: unknown): number {
  const f = Number(fullMark);
  const mk = Number.isFinite(f) && f > 0 ? f : DEFAULT_FULL_MARK;
  return Math.round((score / mk) * 10000) / 100;
}

/**
 * 加权汇总（自归一化）。
 * @param items 已归一化到百分制的分数 + 该列的有效权重（只传有值的项）
 */
export function weightedTotal(items: { score: number; weight: number }[]): {
  total: number | null;
  weightSum: number;
  count: number;
} {
  let acc = 0;
  let wsum = 0;
  let n = 0;
  for (const it of items) {
    if (!Number.isFinite(it.score)) continue;
    const w = safeWeight(it.weight);
    acc += it.score * w;
    wsum += w;
    n++;
  }
  if (!wsum) return { total: null, weightSum: 0, count: n };
  return { total: Math.round((acc / wsum) * 100) / 100, weightSum: Math.round(wsum * 100) / 100, count: n };
}

/**
 * 按百分制分数在等级体系里找等级。
 * 优先用等级自身配的分数区间；没有配区间时按序号等分兜底
 * （序号越小越好 ⇒ 分数越高，所以按 (100 - 分数) 定位）。
 */
export function pickLevel(levels: LevelDef[], score: number | null | undefined): LevelDef | null {
  if (score == null || !Number.isFinite(score) || !levels.length) return null;
  const withRange = levels.filter((l) => l.min != null || l.max != null);
  if (withRange.length) {
    const hit = withRange.find((l) => score >= (l.min ?? -Infinity) && score <= (l.max ?? Infinity));
    if (hit) return hit;
  }
  const sorted = [...levels].sort((a, b) => a.order - b.order);
  const step = 100 / sorted.length;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((100 - score) / step)));
  return sorted[idx] ?? null;
}

/**
 * 达标判定。
 * @returns true 达标 / false 未达标 / null 无法判定（缺目标或没成绩）
 */
export function isAttained(actualOrder: number | null | undefined, targetOrder: number | null | undefined): boolean | null {
  if (actualOrder == null || targetOrder == null) return null;
  if (!Number.isFinite(Number(actualOrder)) || !Number.isFinite(Number(targetOrder))) return null;
  // 序号越小越好 → 实际序号 ≤ 目标序号才算达标
  return Number(actualOrder) <= Number(targetOrder);
}

/**
 * 从任意字段值里安全取出**可读文本**。
 *
 * ⚠️ 为什么必须有这个函数（2026-09-13 实测踩坑）：
 * 飞书的关联字段在 PG 的 jsonb 里是对象形态（如 `{"link_record_ids": null}`），
 * 直接 `String(v)` 会得到字面量 **`"[object Object]"`** —— 这个字符串会一路
 * 写进「班级」字段、再被前端当成真实班级展示（列表全部显示 [object Object]，
 * 而且因为所有学生都变成同一个值，分班过滤等于失效）。
 *
 * 取值顺序：字符串/数字原样 → 数组逐项、连接 → 对象依次尝试 text/name/value/label
 * → 都取不到返回空串（宁可空，也不要 [object Object]，也不要吐 rec_xxx 主键）。
 */
export function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v
      .map((x) => textOf(x))
      .filter(Boolean)
      .join('、');
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['text', 'name', 'value', 'label']) {
      const t = textOf(o[k]);
      if (t) return t;
    }
    return '';
  }
  return '';
}

/**
 * 成绩等级下拉的候选项（「学生成绩目标」选目标等级序号用）。
 *
 * 值 = 等级序号（字符串形式，后端按数字存），label 形如 `A（序号 10）` ——
 * 把「序号」和「显示值」放在同一个选项里，避免用户只知道要填个数字却不知道填几。
 *
 * ⚠️ **按序号去重**：多个等级体系可能有相同序号（各自的 A/B/C）。`multi` 为真时
 * label 里附上体系名以便区分，并保留排序后的第一个。
 * 判据是「值必须真实存在于等级体系」—— 达标判定就是 `实际序号 ≤ 目标序号`，
 * 序号非法 ⇒ 那条目标永远判不出达标（`isAttained` 返回 false，而不是「无法判定」）。
 */
export function levelOptionItems(
  levels: LevelDef[],
  scaleNameOf: (scaleId: string) => string = () => '',
  multi = false,
): { value: string; label: string }[] {
  const seen = new Set<string>();
  const out: { value: string; label: string }[] = [];
  for (const l of [...levels].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'zh-CN'))) {
    const value = String(l.order);
    if (seen.has(value)) continue;
    seen.add(value);
    const scale = multi ? ` · ${scaleNameOf(l.scaleId)}` : '';
    out.push({ value, label: `${l.label}（序号 ${l.order}）${scale}` });
  }
  return out;
}

/**
 * 目标等级的**显示名**：记录上写了名字就用名字，没写就按「目标等级序号」在
 * **该生实际用的那套等级体系**（`levels`）里反查。
 *
 * 🔴 为什么需要这层推导（2026-09-20 实测）：「学生成绩目标」页的表单只有
 * **目标分 + 目标等级序号**，`目标等级` 是一个**没有录入入口**的字段 ⇒
 * 生产上 2 条目标记录里它根本不存在（只有 `目标等级序号 = 1`、`目标分 = 95 / 99`）。
 * 而成绩册网格原来**只认这个名字**（前端 `targetLevel ? … : 未设目标`）⇒
 * 老师明明设了目标，网格却显示「未设目标」—— 更糟的是「达标」其实算得出来，等于白算。
 *
 * 传进来的 `levels` 必须是**该生算总评用的同一套**（服务的 `getGrid` 就是这么取的），
 * 否则会出现「网格上的等级来自 A 体系、目标名来自 B 体系」这种对不上的展示。
 */
export function targetLabelOf(levelName: unknown, order: number | null | undefined, levels: LevelDef[]): string {
  const name = typeof levelName === 'string' ? levelName.trim() : '';
  if (name) return name;
  if (order == null || !Number.isFinite(Number(order))) return '';
  return levels.find((l) => Number(l.order) === Number(order))?.label ?? '';
}

/**
 * 分组维度归一化（成绩册按它把学生分到「班级」下）。
 *
 * ⚠️ 学生档案实测（2026-09-13，82 名学生）：
 *   - 「当前班级」「当前学年」「学籍与班级历史」都是**关联字段且生产数据全为 null**
 *     （`{"link_record_ids": null}`）→ 取不到任何可读值；
 *   - 「当前年级」才是真有值的分群维度：Pre-1(33) / Pre-3(19) / Pre-2(17) /
 *     大一(7) / 未来企业家班(4) / 全球领航计划(2)。
 *   ⇒ 所以分组按 `当前班级 → 当前年级` 依次回落，字段名见 service 的 CLASS_FIELDS。
 *     将来「当前班级」的关联补上了，会自动优先用它（无需改代码）。
 */
export function normClass(v: unknown): string {
  return textOf(v);
}

/** 条目快照：保存条目时把等级写死在条目上，等级改名不篡改历史 */
export interface EntrySnapshot {
  level: string;
  levelOrder: number | null;
  levelConcern: boolean;
  attained: string;
}

export function snapshotOf(
  levels: LevelDef[],
  normedScore: number | null,
  targetOrder: number | null,
): EntrySnapshot {
  const lv = pickLevel(levels, normedScore);
  const att = isAttained(lv ? lv.order : null, targetOrder);
  return {
    level: lv ? lv.label : '',
    levelOrder: lv ? lv.order : null,
    levelConcern: lv ? lv.concern : false,
    attained: att === null ? '' : att ? '达标' : '未达标',
  };
}

/**
 * 成绩册列的写入字段构造（`POST /markbook/columns`）。
 *
 * 🔴 **只写「本次真的传了的字段」**（2026-09-20 修，原来是「没传 = 写空串」）。
 *
 * 为什么必须这样：新建/编辑列的表单并不会把每个字段都渲染出来 ——
 * 「学生可见 / 家长可见 / 完成日期」在 2026-09-20 之前根本没有输入项，
 * 「科目」也没有。于是老师「只改一下权重」，保存后**科目、描述、可见性、完成闸门被一起清空**：
 * 不报错、不留痕，而且后果很重 —— 科目没了，期末总评就按科目拆不出来。
 *
 * 所以约定：`undefined` = 本次不管这个字段（保留库里的值）；显式传 `''` 才是「清空」。
 * 前端表单现在会把每个字段都带上（空串表示清空），两边语义一致。
 *
 * ⚠️ 「班级」与「列名称」是定位字段，任何时候都写：
 * 班级缺了会把整列挂到错误的班，列名称是唯一必填。
 * 「关联作业」不在这里 —— 它由作业同步面板走 `/markbook/homework-bind` 单独绑定（唯一真源）。
 */
export interface ColumnSavePayload {
  id?: string;
  cls: string;
  name: string;
  type?: string;
  subject?: string;
  weight?: number;
  fullMark?: number;
  scaleId?: string;
  date?: string;
  desc?: string;
  sort?: number;
  status?: string;
  studentVisible?: string;
  parentVisible?: string;
  completeDate?: string;
}

export function buildColumnFields(payload: ColumnSavePayload): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    班级: normClass(payload.cls),
    列名称: String(payload.name ?? '').trim(),
  };
  const set = (key: string, raw: unknown, cast: (v: unknown) => unknown) => {
    if (raw !== undefined) fields[key] = cast(raw);
  };
  set('考核类型', payload.type, (v) => String(v ?? ''));
  // 科目：文本（与「班级」同一套口径）。期末总评按它拆科目，
  // 写法不一致（数学 / 数学课）会拆成两个科目 ⇒ 前端用已有值下拉，别手打。
  set('科目', payload.subject, (v) => String(v ?? '').trim());
  set('列权重', payload.weight, (v) => (Number(v) > 0 ? Number(v) : 1));
  set('满分', payload.fullMark, (v) => (Number(v) > 0 ? Number(v) : DEFAULT_FULL_MARK));
  // 等级体系是关联字段 ⇒ 存数组（与 markbookColumn 其他 link 字段同口径）
  set('等级体系', payload.scaleId, (v) => (v ? [String(v)] : []));
  set('考核日期', payload.date, (v) => String(v ?? ''));
  set('描述', payload.desc, (v) => String(v ?? ''));
  set('排序', payload.sort, (v) => Number(v) || 0);
  set('状态', payload.status, (v) => String(v ?? '启用'));
  set('学生可见', payload.studentVisible, (v) => String(v ?? ''));
  set('家长可见', payload.parentVisible, (v) => String(v ?? ''));
  set('完成日期', payload.completeDate, (v) => String(v ?? ''));
  return fields;
}
