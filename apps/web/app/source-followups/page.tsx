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

export default function SourceFollowupsPage() {
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);

  // 按学生聚合已选招生跟进记录，构建 AI 上下文
  const context = useMemo(() => {
    if (selected.length === 0) return '（未选择招生跟进记录）';
    const byStudent = new Map<string, Record<string, unknown>[]>();
    for (const row of selected) {
      const name = studentName(row) || '未知学生';
      if (!byStudent.has(name)) byStudent.set(name, []);
      byStudent.get(name)!.push(row);
    }
    const lines: string[] = [];
    lines.push(
      '你是 ACMS 招生跟进智能分析助手。用户从招生跟进列表勾选了若干条记录，请基于以下聚合信息回答关于招生意向、跟进进度、家长反馈、风险与下一步建议等问题。若信息不足请明确说明。',
    );
    lines.push('');
    lines.push(`【已选招生跟进记录】（共 ${selected.length} 条，涉及 ${byStudent.size} 名学生）`);
    for (const [name, rows] of byStudent) {
      lines.push(`◆ 学生：${name}（${rows.length} 条）`);
      for (const r of rows) {
        const parts = [
          `沟通主题：${str(r['沟通主题']) || '—'}`,
          `跟进时间：${str(r['跟进时间']) || '—'}`,
          `跟进状态：${str(r['跟进状态']) || '—'}`,
          `活动类型：${str(r['活动类型']) || '—'}`,
          `负责人：${str(r['跟进负责人']) || '—'}`,
        ];
        lines.push(`  · ${parts.join(' | ')}`);
        const summary = str(r['沟通总结']);
        const detail = str(r['沟通明细']);
        if (summary) lines.push(`    沟通总结：${summary.slice(0, 200)}${summary.length > 200 ? '...' : ''}`);
        else if (detail) lines.push(`    沟通明细：${detail.slice(0, 200)}${detail.length > 200 ? '...' : ''}`);
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
        title="招生跟进"
        subtitle="招生线索与跟进闭环（M1 学生域）"
        search={{ placeholder: '搜索学生姓名…' }}
        columns={COLUMNS}
        statusField="跟进状态"
        inlineEdit
        standaloneForm
        detailHref={(id) => `/source-followups/${id}`}
        selection
        onSelectionChange={setSelected}
        api={{
          list: (p) => api.listSourceFollowups(p),
          create: (d) => api.createSourceFollowup(d),
          update: (id, d) => api.updateSourceFollowup(id, d),
          archive: (id) => api.archiveSourceFollowup(id),
        }}
        rowExtraActions={[
          {
            label: 'AI 总结',
            run: async (row, reload) => {
              const id = String(row.id);
              const res = await api.sourceFollowupAiPrepare(id);
              const hasSource = (res.attachments?.length ?? 0) > 0 || (res.content ?? '').trim().length > 0;
              if (!hasSource) throw new Error('该记录没有可读取的附件或沟通主题，无法生成总结');
              await api.sourceFollowupAiMergeAll(id, true, true);
              reload();
            },
          },
        ]}
      />

      {/* 右侧悬浮「AI助手」：参考学生全景，按勾选的一条或多条招生跟进记录做分析 */}
      <FloatingAIPanel
        context={context}
        resetKey={resetKey}
        disabled={selected.length === 0}
        disabledHint="请在列表前勾选一条或多条招生跟进记录"
        label="AI助手"
        title="AI助手"
        subject={subject}
        storageKey="sourcefollowups-ai-dialog"
        placeholder="输入与招生跟进相关的问题，Enter 发送…"
      />
    </>
  );
}
