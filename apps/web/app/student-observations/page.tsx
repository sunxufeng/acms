'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
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

export default function StudentObservationsPage() {
  const ts = useTranslations('students');
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);

  // 按学生聚合已选学生观察记录，构建 AI 上下文
  const context = useMemo(() => {
    if (selected.length === 0) return '（未选择学生观察记录）';
    const byStudent = new Map<string, Record<string, unknown>[]>();
    for (const row of selected) {
      const name = studentName(row) || ts('unknownStudent');
      if (!byStudent.has(name)) byStudent.set(name, []);
      byStudent.get(name)!.push(row);
    }
    const lines: string[] = [];
    lines.push(
      '你是 ACMS 学生观察智能分析助手。用户从学生观察列表勾选了若干条记录，请基于以下聚合信息回答关于学生日常表现、观察类型分布、风险与下一步建议等问题。若信息不足请明确说明。',
    );
    lines.push('');
    lines.push(`【已选学生观察记录】（共 ${selected.length} 条，涉及 ${byStudent.size} 名学生）`);
    for (const [name, rows] of byStudent) {
      lines.push(`◆ 学生：${name}（${rows.length} 条）`);
      for (const r of rows) {
        const parts = [
          `观察人：${str(r['沟通人']) || '—'}`,
          `观察类型：${str(r['观察类型']) || '—'}`,
          `主题：${str(r['沟通主题']) || '—'}`,
          `观察时间：${str(r['沟通时间']) || '—'}`,
          `闭环状态：${str(r['闭环状态']) || '—'}`,
        ];
        lines.push(`  · ${parts.join(' | ')}`);
        const summary = str(r['沟通总结']);
        const note = str(r['沟通人备注']);
        const todo = str(r['待办事项']);
        if (summary) lines.push(`    观察总结：${summary.slice(0, 200)}${summary.length > 200 ? '...' : ''}`);
        else if (note) lines.push(`    观察人备注：${note.slice(0, 200)}${note.length > 200 ? '...' : ''}`);
        if (todo) lines.push(`    待办事项：${todo.slice(0, 160)}${todo.length > 160 ? '...' : ''}`);
      }
    }
    return lines.join('\n');
  }, [selected]);

  const studentCount = useMemo(() => new Set(selected.map((r) => studentName(r))).size, [selected]);
  const resetKey = useMemo(() => selected.map((r) => String(r.id)).sort().join(','), [selected]);
  const subject = selected.length
    ? ts('aiSubjectSelected', { count: selected.length, students: studentCount })
    : ts('aiSubjectNone');

  return (
    <>
      <CrudPage
        title="学生观察"
        subtitle="学生日常观察记录与待办闭环"
        search={{ placeholder: '搜索学生…' }}
        columns={COLUMNS}
        statusField="闭环状态"
        inlineEdit
        standaloneForm
        detailHref={(id) => `/student-observations/${id}`}
        selection
        onSelectionChange={setSelected}
        api={{
          list: (p) => api.listStudentObservations(p),
          create: (d) => api.createStudentObservation(d),
          update: (id, d) => api.updateStudentObservation(id, d),
          archive: (id) => api.archiveStudentObservation(id),
        }}
      />

      {/* 右侧悬浮「AI」：参考日常跟进，按勾选的一条或多条学生观察记录做分析 */}
      <FloatingAIPanel
        context={context}
        resetKey={resetKey}
        disabled={selected.length === 0}
        disabledHint="请在列表前勾选一条或多条学生观察记录"
        label="AI"
        title="AI"
        subject={subject}
        storageKey="student-observations-ai-dialog"
        placeholder="输入与学生观察相关的问题，Enter 发送…"
      />
    </>
  );
}
