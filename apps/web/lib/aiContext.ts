/** 多列表页「勾选记录 → AI 分析」共用工具：把已选记录聚合为 AI 上下文 */

export function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v))
    return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

/** 学生姓名：取自关联学生 link 字段的文本 */
export function studentName(row: Record<string, unknown>): string {
  return str(row['关联学生编号__link']) || '未知学生';
}

/**
 * 按学生聚合已选记录，生成 AI 上下文。
 * @param title   模块名（如「学生考勤」）
 * @param selected 已选记录
 * @param fields  紧凑行展示的字段 [标签, 字段键]
 * @param detailKeys 额外长文本字段（按学生切片追加），可空
 */
export function buildSelectionContext(opts: {
  title: string;
  selected: Record<string, unknown>[];
  fields: [string, string][];
  detailKeys?: [string, string][];
}): string {
  const { title, selected, fields, detailKeys } = opts;
  if (selected.length === 0) return `（未选择${title}记录）`;

  const byStudent = new Map<string, Record<string, unknown>[]>();
  for (const row of selected) {
    const name = studentName(row);
    if (!byStudent.has(name)) byStudent.set(name, []);
    byStudent.get(name)!.push(row);
  }

  const lines: string[] = [];
  lines.push(
    `你是 ACMS ${title}智能分析助手。用户从${title}列表勾选了若干条记录，请基于以下聚合信息回答关于${title}的分析、趋势、风险与下一步建议等问题。若信息不足请明确说明。`,
  );
  lines.push('');
  lines.push(`【已选${title}记录】（共 ${selected.length} 条，涉及 ${byStudent.size} 名学生）`);

  for (const [name, rows] of byStudent) {
    lines.push(`◆ 学生：${name}（${rows.length} 条）`);
    for (const r of rows) {
      const parts = fields.map(([label, key]) => `${label}：${str(r[key]) || '—'}`);
      lines.push(`  · ${parts.join(' | ')}`);
      if (detailKeys) {
        for (const [label, key] of detailKeys) {
          const v = str(r[key]);
          if (v) lines.push(`    ${label}：${v.slice(0, 200)}${v.length > 200 ? '...' : ''}`);
        }
      }
    }
  }
  return lines.join('\n');
}
