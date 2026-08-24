'use client';

import { useMemo, useState } from 'react';
import CrudPage from '../../components/CrudPage';
import FloatingAIPanel from '../../components/FloatingAIPanel';
import { api } from '../../lib/api';
import { COLUMNS, studentName } from './columns';

function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

export default function DailyFollowupsPage() {
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);

  // 按学生聚合已选日常跟进记录，构建 AI 上下文
  const context = useMemo(() => {
    if (selected.length === 0) return '（未选择日常跟进记录）';
    const byStudent = new Map<string, Record<string, unknown>[]>();
    for (const row of selected) {
      const name = studentName(row) || '未知学生';
      if (!byStudent.has(name)) byStudent.set(name, []);
      byStudent.get(name)!.push(row);
    }
    const lines: string[] = [];
    lines.push(
      '你是 ACMS 日常跟进智能分析助手。用户从日常跟进列表勾选了若干条记录，请基于以下聚合信息回答关于学生日常跟进、沟通反馈、待办闭环、风险与下一步建议等问题。若信息不足请明确说明。',
    );
    lines.push('');
    lines.push(`【已选日常跟进记录】（共 ${selected.length} 条，涉及 ${byStudent.size} 名学生）`);
    for (const [name, rows] of byStudent) {
      lines.push(`◆ 学生：${name}（${rows.length} 条）`);
      for (const r of rows) {
        const parts = [
          `沟通人：${str(r['沟通人']) || '—'}`,
          `沟通方式：${str(r['沟通方式']) || '—'}`,
          `沟通主题：${str(r['沟通主题']) || '—'}`,
          `沟通时间：${str(r['沟通时间']) || '—'}`,
          `闭环状态：${str(r['闭环状态']) || '—'}`,
        ];
        lines.push(`  · ${parts.join(' | ')}`);
        const summary = str(r['沟通总结']);
        const note = str(r['沟通人备注']);
        const todo = str(r['待办事项']);
        if (summary) lines.push(`    沟通总结：${summary.slice(0, 200)}${summary.length > 200 ? '...' : ''}`);
        else if (note) lines.push(`    沟通人备注：${note.slice(0, 200)}${note.length > 200 ? '...' : ''}`);
        if (todo) lines.push(`    待办事项：${todo.slice(0, 160)}${todo.length > 160 ? '...' : ''}`);
      }
    }
    return lines.join('\n');
  }, [selected]);

  const studentCount = useMemo(() => new Set(selected.map((r) => studentName(r))).size, [selected]);
  const resetKey = useMemo(() => selected.map((r) => String(r.id)).sort().join(','), [selected]);
  const subject = selected.length ? `已选 ${selected.length} 条 / ${studentCount} 名学生` : '（未选择记录）';

  return (
    <>
      <CrudPage
        title="日常跟进"
        subtitle="学生日常跟进与待办闭环（M1 学生域）"
        search={{ placeholder: '搜索学生…' }}
        columns={COLUMNS}
        statusField="闭环状态"
        inlineEdit
        standaloneForm
        detailHref={(id) => `/daily-followups/${id}`}
        selection
        onSelectionChange={setSelected}
        api={{
          list: (p) => api.listDailyFollowups(p),
          create: (d) => api.createDailyFollowup(d),
          update: (id, d) => api.updateDailyFollowup(id, d),
          archive: (id) => api.archiveDailyFollowup(id),
        }}
      />

      {/* 右侧悬浮「AI」：参考招生跟进，按勾选的一条或多条日常跟进记录做分析 */}
      <FloatingAIPanel
        context={context}
        resetKey={resetKey}
        disabled={selected.length === 0}
        disabledHint="请在列表前勾选一条或多条日常跟进记录"
        label="AI"
        title="AI"
        subject={subject}
        storageKey="daily-followups-ai-dialog"
        placeholder="输入与日常跟进相关的问题，Enter 发送…"
      />
    </>
  );
}
