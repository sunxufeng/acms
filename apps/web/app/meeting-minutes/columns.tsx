import type { CrudColumn } from '../../components/CrudPage';

/**
 * 日期显示：SQL 自建表没有飞书字段元数据，日期字段读出来是毫秒时间戳（number），
 * 直接渲染会显示成一串数字，这里统一格式化。
 */
function fmtTime(v: unknown, withTime: boolean): string {
  if (v == null || v === '') return '—';
  const raw = typeof v === 'number' ? v : /^\d+$/.test(String(v).trim()) ? Number(v) : new Date(String(v)).getTime();
  if (!raw || Number.isNaN(raw)) return String(v);
  const d = new Date(raw);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date;
}

/**
 * 会议纪要列定义。
 *
 * 结构照搬「日常跟进」，但主体从「学生」换成「部门」：
 *  - 沟通方式 → 会议类型（字典：周会 / 月度会议 / 年中会 / 临时会议 …）
 *  - 沟通主题 → 会议议题
 *  - 沟通时间 → 会议时间（列表排序与范围筛选字段，另有开始/结束时间存具体时刻）
 *  - 沟通明细 / 沟通总结 → 会议明细 / 会议总结（详情页只读展示）
 *  - 待办事项 → 待办事宜
 * 飞书字段名即 key，与后端 lifecycle.meta.ts 的 dateFields / timeRange / rangeField 严格对齐。
 */
export const COLUMNS: CrudColumn[] = [
  {
    key: '部门',
    label: '部门',
    width: '130px',
    form: true,
    type: 'department',
    required: true,
    filter: true,
    openRecord: true,
    render: (_v, row) => {
      const name = deptName(row);
      if (!name) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      return <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{name}</span>;
    },
  },
  { key: '会议类型', label: '会议类型', width: '110px', filter: true, form: true, type: 'select', dictKey: '会议类型', required: true },
  { key: '会议议题', label: '会议议题', width: '180px', filter: true, filterType: 'text', form: true, required: true },
  { key: '会议地点', label: '会议地点', width: '120px', filter: true, filterType: 'text', form: true },
  {
    key: '会议时间',
    label: '会议时间',
    width: '120px',
    form: true,
    type: 'date',
    required: true,
    render: (v) => fmtTime(v, false),
  },
  { key: '开始时间', label: '开始时间', width: '150px', form: true, type: 'datetime', render: (v) => fmtTime(v, true) },
  {
    key: '结束时间',
    label: '结束时间',
    width: '150px',
    form: true,
    type: 'datetime',
    // 结束时间必须晚于开始时间（后端 meta.timeRange 也会校验，这里只是给录入提示）
    hint: '结束时间须晚于开始时间',
    render: (v) => fmtTime(v, true),
  },
  { key: '主持人', label: '主持人', width: '100px', form: true, type: 'person' },
  { key: '记录人', label: '记录人', width: '100px', list: false, form: true, type: 'person' },
  // 参会/缺席/列席都是「人名清单」，用单行输入框即可（textarea 太高，表单被拉得很长）
  { key: '参会人员', label: '参会人员', width: '160px', list: false, form: true, type: 'text' },
  { key: '缺席人员', label: '缺席人员', width: '160px', list: false, form: true, type: 'text' },
  { key: '列席人员', label: '列席人员', width: '160px', list: false, form: true, type: 'text' },
  // 会议总结放在会议明细之前：先看清结论，再看原始记录
  { key: '会议总结', label: '会议总结（纪要）', list: false, form: true, type: 'markdown' },
  {
    key: '会议明细',
    label: '会议明细（MD 会议记录）',
    list: false,
    form: true,
    type: 'markdown',
    // 原始记录属正式留痕，用**专项权限**控制（比模块读写权限更严格）：
    // 无 md:edit 只能浏览，无 md:import 不显示「MD导入」按钮
    mdEditPerm: 'md:edit',
    mdImportPerm: 'md:import',
  },
  { key: '待办事宜', label: '待办事宜', list: false, form: true, type: 'textarea' },
  {
    key: '状态',
    label: '状态',
    width: '100px',
    filter: true,
    form: true,
    type: 'select',
    dictKey: '会议状态',
  },
  {
    key: '敏感级别',
    label: '敏感级别',
    width: '100px',
    list: false,
    filter: true,
    form: true,
    type: 'select',
    dictKey: '信息敏感级别',
  },
];

/**
 * 从「会议总结 / 会议明细」文本里抽取结构化字段，供**笔记转换预填**使用。
 *
 * 为什么用规则而不是调 AI：
 *  - 转换是高频动作，每次都打一次模型既慢又费额度，还依赖用户自己的 AI 配置；
 *  - Get笔记 的总结有稳定套路（「会议主题：」「参会人员：」这类标题行），规则命中率足够；
 *  - 规则零依赖、可预测，抽错了用户一眼能看出来并在表单里改。
 *
 * ⚠️ 只填**表单里真实存在且当前为空**的字段，已有值（笔记映射写进来的）不覆盖。
 */
const FIELD_PATTERNS: { key: string; patterns: RegExp[] }[] = [
  { key: '会议议题', patterns: [/会议议题\s*[:：]\s*(.+)/, /会议主题\s*[:：]\s*(.+)/, /议题\s*[:：]\s*(.+)/, /主题\s*[:：]\s*(.+)/] },
  { key: '会议地点', patterns: [/会议地点\s*[:：]\s*(.+)/, /地点\s*[:：]\s*(.+)/] },
  { key: '主持人', patterns: [/主持人\s*[:：]\s*(.+)/, /主持\s*[:：]\s*(.+)/] },
  { key: '记录人', patterns: [/记录人\s*[:：]\s*(.+)/, /纪要员\s*[:：]\s*(.+)/] },
  { key: '参会人员', patterns: [/参会人员\s*[:：]\s*(.+)/, /出席人员\s*[:：]\s*(.+)/, /参会\s*[:：]\s*(.+)/, /出席\s*[:：]\s*(.+)/] },
  { key: '缺席人员', patterns: [/缺席人员\s*[:：]\s*(.+)/, /缺席\s*[:：]\s*(.+)/, /请假\s*[:：]\s*(.+)/] },
  { key: '列席人员', patterns: [/列席人员\s*[:：]\s*(.+)/, /列席\s*[:：]\s*(.+)/] },
];

/** 行首可能是 Markdown 的 #、**、- 等符号，先清掉再匹配 */
function cleanLine(line: string): string {
  return line.replace(/^[\s>#\-*·]+/, '').replace(/\*\*/g, '').trim();
}

/**
 * 把 Markdown 表格行 `| 会议议题 | 秋季教学安排 |` 还原成 `会议议题：秋季教学安排`。
 * Get笔记 / AI 总结常用两列表格罗列会议要素，不做这层转换会整片漏抽。
 */
function normalizeTableLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim();
      if (!line.startsWith('|')) return raw;
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim())
        .filter((c) => !/^:?-{2,}:?$/.test(c)); // 去掉 |---|---| 分隔行
      if (cells.length >= 2 && cells[0] && cells[1]) return `${cells[0]}：${cells[1]}`;
      return raw;
    })
    .join('\n');
}

function firstMatch(text: string, patterns: RegExp[]): string {
  for (const line of text.split(/\r?\n/)) {
    const cleaned = cleanLine(line);
    if (!cleaned) continue;
    for (const re of patterns) {
      const m = cleaned.match(re);
      if (m?.[1]) {
        const v = m[1].trim().replace(/\s{2,}/g, ' ');
        // 截断到行尾多余的分隔符前，避免把后面半句话也吃进来
        return v.split(/[；;]/)[0]?.trim() || v;
      }
    }
  }
  return '';
}

/** 抽取日期：2026-09-10 / 2026/9/10 / 2026年9月10日 */
function pickDate(text: string): string {
  const m =
    text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/) ??
    text.match(/会议时间\s*[:：]\s*(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2})/);
  if (!m) return '';
  const y = m[1] ?? '';
  const mo = String(m[2] ?? '').padStart(2, '0');
  const d = String(m[3] ?? '').padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/** 抽取时刻：09:00 / 9点 / 9:30 */
function pickTime(text: string, keywords: string[]): string {
  for (const kw of keywords) {
    const re = new RegExp(`${kw}\\s*[:：]?\\s*(?:20\\d{2}[-/.年]\\d{1,2}[-/.月]\\d{1,2}\\s*)?(\\d{1,2})\\s*[:：点時时]\\s*(\\d{2})?`);
    const m = text.match(re);
    if (m) {
      const h = String(m[1] ?? '').padStart(2, '0');
      const mi = String(m[2] ?? '00').padStart(2, '0');
      return `${h}:${mi}`;
    }
  }
  return '';
}

/**
 * 从笔记转换预填的内容里解析会议字段。
 * 解析源优先级：会议总结 > 会议明细（总结更凝练、字段名更规整）。
 */
export function parseMeetingFromSummary(values: Record<string, unknown>): Record<string, unknown> {
  const src = String(values['会议总结'] ?? values['会议明细'] ?? '');
  if (!src.trim()) return values;

  const out: Record<string, unknown> = { ...values };
  const has = (k: string) => {
    const v = out[k];
    return v != null && String(v).trim() !== '';
  };

  for (const { key, patterns } of FIELD_PATTERNS) {
    if (has(key)) continue;
    const v = firstMatch(src, patterns);
    if (v) out[key] = v;
  }

  // 时间与时刻用「清掉 Markdown 记号」的文本匹配：
  // 笔记里常写成 `- **开始时间**：09:00`，不清理的话 `**` 会卡在冒号位置导致漏抽；
  // 再叠一层表格行还原，兼容 `| 开始时间 | 09:00 |` 的写法。
  const plain = normalizeTableLines(src)
    .split(/\r?\n/)
    .map(cleanLine)
    .join('\n');

  // 表格还原后可能才出现字段行，所以再补抽一轮（只填空字段）
  for (const { key, patterns } of FIELD_PATTERNS) {
    if (has(key)) continue;
    const v = firstMatch(plain, patterns);
    if (v) out[key] = v;
  }

  if (!has('会议时间')) {
    const d = pickDate(plain);
    if (d) out['会议时间'] = d;
  }

  // 起止时刻：拼成 datetime-local 能识别的 "YYYY-MM-DDTHH:mm"
  const date = String(out['会议时间'] ?? pickDate(plain) ?? '').trim();
  if (date) {
    if (!has('开始时间')) {
      const t = pickTime(plain, ['开始时间', '会议开始', '开始']);
      if (t) out['开始时间'] = `${date}T${t}`;
    }
    if (!has('结束时间')) {
      const t = pickTime(plain, ['结束时间', '会议结束', '结束']);
      if (t) out['结束时间'] = `${date}T${t}`;
    }
  }

  return out;
}

export function deptName(row: Record<string, unknown>): string {
  const v = row['部门'];
  if (Array.isArray(v) && v.length > 0) {
    const first = v[0];
    if (first && typeof first === 'object') return String((first as { text?: string }).text ?? '');
    return String(first ?? '');
  }
  if (v && typeof v === 'object') return String((v as { text?: string }).text ?? '');
  return String(v ?? '');
}
