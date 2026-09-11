/**
 * 笔记转换 → 业务表单的「自动预填」工具。
 *
 * 背景：从 Get笔记 转过来时，转换配置只把「总结/明细」两个长文本映射到目标模块，
 * 其余结构化字段（时间、时长、主题、沟通人…）全靠用户手填。而 AI 总结往往已经
 * 把这些要素写清楚了，再让人敲一遍纯属浪费。
 *
 * 设计：
 * - **规则解析，不调 AI**：转换是高频动作，规则零依赖、可预测、不依赖用户 AI 配置；
 *   Get笔记 的总结有稳定套路（「会议主题：」「参会人员：」这类标题行），命中率足够。
 * - **只填空字段**：笔记映射或解析已写入的值不覆盖（has() 判断）。
 * - 遇到带 Markdown 记号（`- **开始时间**：09:00`）或表格行（`| 议题 | xxx |`）的写法
 *   先还原成纯文本再匹配，否则会整片漏抽。
 */

/** 行首可能是 Markdown 的 #、**、- 等符号，先清掉再匹配 */
export function cleanLine(line: string): string {
  return line.replace(/^[\s>#\-*·]+/, '').replace(/\*\*/g, '').trim();
}

/** 把 Markdown 表格行 `| 会议议题 | 秋季教学安排 |` 还原成 `会议议题：秋季教学安排` */
export function normalizeTableLines(text: string): string {
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

/** 去掉 Markdown 记号 + 还原表格行，得到适合正则匹配的纯文本 */
export function toPlainText(src: string): string {
  return normalizeTableLines(src)
    .split(/\r?\n/)
    .map(cleanLine)
    .join('\n');
}

/** 逐行匹配，返回第一个命中捕获组的值 */
export function firstMatch(text: string, patterns: RegExp[]): string {
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

/** 抽取日期：2026-09-10 / 2026/9/10 / 2026年9月10日 → YYYY-MM-DD */
export function pickDate(text: string): string {
  const m = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!m) return '';
  const y = m[1] ?? '';
  const mo = String(m[2] ?? '').padStart(2, '0');
  const d = String(m[3] ?? '').padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/**
 * 带标签的日期抽取：先找「会议时间：2026-09-10」这种明确标注，找不到再退回
 * 全文第一个日期。正文里常常混着别的日期（「上次会议 9/1…」），有标签时更准。
 */
export function pickDateWith(text: string, keywords?: string[]): string {
  for (const kw of keywords ?? []) {
    const re = new RegExp(`${kw}\\s*[:：]?\\s*(20\\d{2})[-/.年](\\d{1,2})[-/.月](\\d{1,2})`);
    const m = text.match(re);
    if (m) return `${m[1]}-${String(m[2] ?? '').padStart(2, '0')}-${String(m[3] ?? '').padStart(2, '0')}`;
  }
  return pickDate(text);
}

/** 抽取时刻：09:00 / 9点 / 9:30 → HH:mm */
export function pickTime(text: string, keywords: string[]): string {
  for (const kw of keywords) {
    const re = new RegExp(
      `${kw}\\s*[:：]?\\s*(?:20\\d{2}[-/.年]\\d{1,2}[-/.月]\\d{1,2}\\s*)?(\\d{1,2})\\s*[:：点時时]\\s*(\\d{2})?`,
    );
    const m = text.match(re);
    if (m) {
      const h = String(m[1] ?? '').padStart(2, '0');
      const mi = String(m[2] ?? '00').padStart(2, '0');
      return `${h}:${mi}`;
    }
  }
  return '';
}

/** 抽取时长（分钟）：沟通时长 30 / 时长：45分钟 / 约 1 小时 → 数字字符串 */
export function pickDuration(text: string, keywords: string[] = ['沟通时长', '会议时长', '时长', '持续时间']): string {
  for (const kw of keywords) {
    const re = new RegExp(`${kw}\\s*[:：]?\\s*(?:约\\s*)?(\\d+(?:\\.\\d+)?)\\s*(?:分钟|min|分)?`);
    const m = text.match(re);
    if (m?.[1]) return String(Math.round(Number(m[1])));
  }
  // 退化：整段里出现「N 分钟」
  const m = text.match(/(\d+)\s*分钟/);
  return m?.[1] ? String(Math.round(Number(m[1]))) : '';
}

export interface NoteAutoFillSpec {
  /** 解析源字段（按优先级取第一个非空），通常是「总结」再「明细」 */
  sourceKeys: string[];
  /** 标签行 → 目标字段 */
  patterns?: { key: string; patterns: RegExp[] }[];
  /** 需要拼成 `YYYY-MM-DDTHH:mm` 的日期时间字段 */
  datetime?: { key: string; dateKeywords?: string[]; timeKeywords: string[] };
  /**
   * 纯日期字段（表单里 type='date' 的列，如会议「会议时间」）——只填 YYYY-MM-DD。
   * 带时刻会让 <input type="date"> 渲染成空框，所以跟 datetime 分开处理。
   */
  dateKeys?: { key: string; keywords?: string[] }[];
  /** 时长（分钟）字段 */
  durationKey?: string;
  /** 起止时刻字段（拼到日期后面），如会议的开始/结束时间 */
  ranges?: { key: string; timeKeywords: string[] }[];
}

/**
 * 按 spec 从长文本里抽字段，只填空字段。
 * `defaults` 里的值（如当前登录用户名）同样只填空字段。
 */
export function enrichFromNotes(
  values: Record<string, unknown>,
  spec: NoteAutoFillSpec,
  defaults: Record<string, string> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  const has = (k: string) => {
    const v = out[k];
    return v != null && String(v).trim() !== '';
  };

  const srcRaw = spec.sourceKeys.map((k) => String(values[k] ?? '')).find((s) => s.trim()) ?? '';
  const plain = srcRaw ? toPlainText(srcRaw) : '';

  // 1) 标签行抽取（原文 + 还原文本各来一轮，覆盖表格写法）
  for (const { key, patterns } of spec.patterns ?? []) {
    if (has(key)) continue;
    const v = firstMatch(srcRaw, patterns) || (plain ? firstMatch(plain, patterns) : '');
    if (v) out[key] = v;
  }

  if (!plain) {
    for (const [k, v] of Object.entries(defaults)) if (v && !has(k)) out[k] = v;
    return out;
  }

  // 2) 纯日期字段（type='date' 的列）
  for (const dk of spec.dateKeys ?? []) {
    if (has(dk.key)) continue;
    const d = pickDateWith(plain, dk.keywords);
    if (d) out[dk.key] = d;
  }

  // 3) 日期时间：datetime-local 需要 YYYY-MM-DDTHH:mm
  if (spec.datetime && !has(spec.datetime.key)) {
    const d = pickDateWith(plain, spec.datetime.dateKeywords);
    if (d) {
      const t = pickTime(plain, spec.datetime.timeKeywords);
      // 补 T00:00：<input type="datetime-local"> 只接受 YYYY-MM-DDTHH:mm，
      // 只给日期会显示成空框，等于白填。没有时刻信息时先占个位，用户可改。
      out[spec.datetime.key] = `${d}T${t || '00:00'}`;
    }
  }

  // 4) 起止时刻：日期优先用已解析出的日期字段，保证与「会议时间」是同一天
  const baseDate =
    (spec.dateKeys?.[0] ? String(out[spec.dateKeys[0].key] ?? '') : '') || pickDate(plain);
  for (const r of spec.ranges ?? []) {
    if (has(r.key)) continue;
    if (!baseDate) continue;
    const t = pickTime(plain, r.timeKeywords);
    if (t) out[r.key] = `${baseDate}T${t}`;
  }

  // 5) 时长
  if (spec.durationKey && !has(spec.durationKey)) {
    const v = pickDuration(plain);
    if (v) out[spec.durationKey] = v;
  }

  // 6) 固定默认值（登录用户名等）最后填，优先级最低但能兜底
  for (const [k, v] of Object.entries(defaults)) {
    if (v && !has(k)) out[k] = v;
  }

  return out;
}

/**
 * 沟通类模块（日常跟进 / 家校沟通 / 学生观察）共用的抽取规则 —— 三个模块底层是
 * 同一套飞书字段（沟通人 / 沟通主题 / 沟通时间 / 沟通时长），只是界面叫法不同。
 */
export const COMM_SPEC: NoteAutoFillSpec = {
  sourceKeys: ['沟通总结', '沟通明细'],
  patterns: [
    {
      key: '沟通主题',
      patterns: [
        /沟通主题\s*[:：]\s*(.+)/,
        /主题\s*[:：]\s*(.+)/,
        /事由\s*[:：]\s*(.+)/,
        /议题\s*[:：]\s*(.+)/,
        /沟通事项\s*[:：]\s*(.+)/,
      ],
    },
  ],
  datetime: { key: '沟通时间', timeKeywords: ['沟通时间', '沟通日期', '观察时间', '时间', '日期'] },
  durationKey: '沟通时长(分钟)',
};

let meNameCache: string | null = null;
let meNameInflight: Promise<string> | null = null;

/**
 * 当前登录用户的姓名（首次调用拉 /auth/me，之后内存缓存）。
 * 笔记转换时用它给「沟通人 / 观察人 / 责任人」填默认值 —— 笔记是谁录的，跟进人就是谁。
 */
export async function currentUserName(): Promise<string> {
  if (meNameCache) return meNameCache;
  if (meNameInflight) return meNameInflight;
  meNameInflight = fetch('/api/v1/auth/me', { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { name?: string } | null) => {
      meNameCache = String(d?.name ?? '');
      return meNameCache;
    })
    .catch(() => '')
    .finally(() => {
      meNameInflight = null;
    });
  return meNameInflight;
}
