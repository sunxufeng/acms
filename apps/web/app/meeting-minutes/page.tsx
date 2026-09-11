'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage from '../../components/CrudPage';
import FloatingAIPanel from '../../components/FloatingAIPanel';
import { api } from '../../lib/api';
import { COLUMNS, deptName, parseMeetingFromSummary } from './columns';

function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

export default function MeetingMinutesPage() {
  const ts = useTranslations('students');
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);

  // 按部门聚合已选会议纪要，构建 AI 上下文
  const context = useMemo(() => {
    if (selected.length === 0) return '（未选择会议纪要记录）';
    const byDept = new Map<string, Record<string, unknown>[]>();
    for (const row of selected) {
      const name = deptName(row) || '未指定部门';
      if (!byDept.has(name)) byDept.set(name, []);
      byDept.get(name)!.push(row);
    }
    const lines: string[] = [];
    lines.push(
      '你是 ACMS 会议纪要智能分析助手。用户从会议纪要列表勾选了若干条记录，请基于以下聚合信息回答关于会议议题、决议、待办跟进、风险与下一步建议等问题。若信息不足请明确说明。',
    );
    lines.push('');
    lines.push(`【已选会议纪要记录】（共 ${selected.length} 条，涉及 ${byDept.size} 个部门）`);
    for (const [name, rows] of byDept) {
      lines.push(`◆ 部门：${name}（${rows.length} 条）`);
      for (const r of rows) {
        const parts = [
          `会议类型：${str(r['会议类型']) || '—'}`,
          `会议议题：${str(r['会议议题']) || '—'}`,
          `会议地点：${str(r['会议地点']) || '—'}`,
          `会议时间：${str(r['会议时间']) || '—'}`,
          `状态：${str(r['状态']) || '—'}`,
        ];
        lines.push(`  · ${parts.join(' | ')}`);
        const summary = str(r['会议总结']);
        const detail = str(r['会议明细']);
        const todo = str(r['待办事宜']);
        if (summary) lines.push(`    会议总结：${summary.slice(0, 200)}${summary.length > 200 ? '...' : ''}`);
        else if (detail) lines.push(`    会议明细：${detail.slice(0, 200)}${detail.length > 200 ? '...' : ''}`);
        if (todo) lines.push(`    待办事宜：${todo.slice(0, 160)}${todo.length > 160 ? '...' : ''}`);
      }
    }
    return lines.join('\n');
  }, [selected]);

  const deptCount = useMemo(() => new Set(selected.map((r) => deptName(r))).size, [selected]);
  const resetKey = useMemo(() => selected.map((r) => String(r.id)).sort().join(','), [selected]);
  const subject = selected.length
    ? ts('aiSubjectSelected', { count: selected.length, students: deptCount })
    : ts('aiSubjectNone');

  return (
    <>
      <CrudPage
        title="会议纪要"
        subtitle="部门会议记录与决议闭环（组织管理域）"
        search={{ placeholder: '搜索会议议题…' }}
        columns={COLUMNS}
        // 模块 key：让按钮级授权、导入按钮、以及「会议明细」的写权限保护都能生效
        moduleKey="meetingMinutes"
        // 从笔记转换进来时，按会议总结文案自动识别议题/地点/时间/人员等字段
        enrichPrefill={parseMeetingFromSummary}
        statusField="状态"
        // 会议时间范围筛选（后端 rangeField='会议时间'，走 listDeep 内存过滤）
        rangeFilters={[{ key: 'meetingTime', label: '会议时间', fromParam: 'from', toParam: 'to' }]}
        inlineEdit
        standaloneForm
        detailHref={(id) => `/meeting-minutes/${id}`}
        selection
        onSelectionChange={setSelected}
        api={{
          list: (p) => api.listMeetingMinutes(p),
          create: (d) => api.createMeetingMinute(d),
          update: (id, d) => api.updateMeetingMinute(id, d),
          archive: (id) => api.archiveMeetingMinute(id),
        }}
      />

      {/* 右侧悬浮「AI」：按勾选的一条或多条会议纪要做分析 */}
      <FloatingAIPanel
        context={context}
        resetKey={resetKey}
        disabled={selected.length === 0}
        disabledHint="请在列表前勾选一条或多条会议纪要记录"
        label="AI"
        title="AI"
        subject={subject}
        storageKey="meeting-minutes-ai-dialog"
        placeholder="输入与会议纪要相关的问题，Enter 发送…"
      />
    </>
  );
}
