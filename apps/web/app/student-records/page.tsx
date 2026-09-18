'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage from '../../components/CrudPage';
import FloatingAIPanel from '../../components/FloatingAIPanel';
import { api } from '../../lib/api';
import { STUDENT_RECORD_TYPE_FIELD, STUDENT_RECORD_TYPES } from '@acms/contracts';
import { buildStudentRecordColumns, parseStudentRecordFromSummary, studentName } from './columns';

function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

/**
 * 学生记录（2026-09-18）：日常跟进 / 家校沟通 / 学生观察 三合一后的唯一入口。
 *
 * 为什么用「顶部类型 Tab」而不是 CrudPage 自带的列筛选：
 *   ① 表头措辞要随类型切换（沟通人 ↔ 观察人），而 columns 是按类型重新生成的，
 *      两套筛选并存会出现「筛选器说学生观察、表头却是沟通人」的矛盾；
 *   ② CrudPage 拿不到「当前筛选值」，只有页面自己知道，所以类型必须由页面持有。
 *
 * ⚠️ `extraParams` 必须用 useMemo 稳定住：CrudPage 把它放进了拉数据的依赖里，
 *    每次 render 新建一个对象字面量会导致**渲染死循环**（页面持续闪烁 + 每圈打一次接口）。
 */
export default function StudentRecordsPage() {
  const ts = useTranslations('students');
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);
  const [activeType, setActiveType] = useState('');

  // URL 是类型的唯一事实来源（旧地址 301 过来带 ?type=、刷新后也保持一致）。
  // ⚠️ 用 window.location.search 而非 useSearchParams：App Router 下后者要求 Suspense 边界
  //    （全站既有约定，见 CrudPage 的同款注释）。
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('type') ?? '';
    if (t && STUDENT_RECORD_TYPES.some((x) => x.value === t)) setActiveType(t);
  }, []);

  const switchType = (v: string) => {
    setActiveType(v);
    const qs = new URLSearchParams(window.location.search);
    if (v) qs.set('type', v);
    else qs.delete('type');
    const q = qs.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
  };

  const columns = useMemo(() => buildStudentRecordColumns(activeType || undefined), [activeType]);
  const extraParams = useMemo(
    () => (activeType ? { [STUDENT_RECORD_TYPE_FIELD]: activeType } : undefined),
    [activeType],
  );
  // 新建时的默认类型跟当前 Tab 走（在后端 RecordMeta.defaults 之上，用户不改也能建对类型）
  const createDefaults = useMemo(
    () => ({ [STUDENT_RECORD_TYPE_FIELD]: activeType || '日常跟进' }),
    [activeType],
  );

  // AI 上下文：按学生聚合已选记录（与合并前三个页面同一套语义）
  const context = useMemo(() => {
    if (selected.length === 0) return '（未选择学生记录）';
    const byStudent = new Map<string, Record<string, unknown>[]>();
    for (const row of selected) {
      const name = studentName(row) || ts('unknownStudent');
      if (!byStudent.has(name)) byStudent.set(name, []);
      byStudent.get(name)!.push(row);
    }
    const lines: string[] = [];
    lines.push(
      '你是 ACMS 学生记录智能分析助手。用户从学生记录列表（含日常跟进 / 家校沟通 / 学生观察三类）勾选了若干条记录，' +
        '请基于以下聚合信息回答关于学生日常表现、家校反馈、待办闭环、风险与下一步建议等问题。若信息不足请明确说明。',
    );
    lines.push('');
    lines.push(`【已选学生记录】（共 ${selected.length} 条，涉及 ${byStudent.size} 名学生）`);
    for (const [name, rows] of byStudent) {
      lines.push(`◆ 学生：${name}（${rows.length} 条）`);
      for (const r of rows) {
        const parts = [
          `类型：${str(r[STUDENT_RECORD_TYPE_FIELD]) || '—'}`,
          `记录人：${str(r['沟通人']) || '—'}`,
          `主题：${str(r['沟通主题']) || '—'}`,
          `时间：${str(r['沟通时间']) || '—'}`,
          `闭环状态：${str(r['闭环状态']) || '—'}`,
        ];
        lines.push(`  · ${parts.join(' | ')}`);
        const summary = str(r['沟通总结']);
        const note = str(r['沟通人备注']);
        const todo = str(r['待办事项']);
        if (summary) lines.push(`    总结：${summary.slice(0, 200)}${summary.length > 200 ? '...' : ''}`);
        else if (note) lines.push(`    备注：${note.slice(0, 200)}${note.length > 200 ? '...' : ''}`);
        if (todo) lines.push(`    待办事项：${todo.slice(0, 160)}${todo.length > 160 ? '...' : ''}`);
      }
    }
    return lines.join('\n');
  }, [selected, ts]);

  const studentCount = useMemo(() => new Set(selected.map((r) => studentName(r))).size, [selected]);
  const resetKey = useMemo(() => selected.map((r) => String(r.id)).sort().join(','), [selected]);
  const subject = selected.length
    ? ts('aiSubjectSelected', { count: selected.length, students: studentCount })
    : ts('aiSubjectNone');

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '0 0 12px' }}>
        {[{ value: '', label: '全部' }, ...STUDENT_RECORD_TYPES.map((t) => ({ value: t.value, label: t.value }))].map(
          (t) => {
            const on = activeType === t.value;
            return (
              <button
                key={t.value || 'all'}
                type="button"
                className={on ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}
                onClick={() => switchType(t.value)}
              >
                {t.label}
              </button>
            );
          },
        )}
      </div>

      <CrudPage
        moduleKey="studentRecords"
        title="学生记录"
        subtitle="日常跟进 / 家校沟通 / 学生观察（按「记录类型」区分）"
        search={{ placeholder: '搜索学生…' }}
        columns={columns}
        extraParams={extraParams}
        createDefaults={createDefaults}
        enrichPrefill={parseStudentRecordFromSummary}
        statusField="闭环状态"
        inlineEdit
        standaloneForm
        detailHref={(id) => `/student-records/${id}`}
        selection
        onSelectionChange={setSelected}
        api={{
          list: (p) => api.listStudentRecords(p),
          create: (d) => api.createStudentRecord(d),
          update: (id, d) => api.updateStudentRecord(id, d),
          archive: (id) => api.archiveStudentRecord(id),
        }}
      />

      {/* 右侧悬浮「AI」：按勾选的一条或多条记录做分析（三类记录可混选） */}
      <FloatingAIPanel
        context={context}
        resetKey={resetKey}
        disabled={selected.length === 0}
        disabledHint="请在列表前勾选一条或多条学生记录"
        label="AI"
        title="AI"
        subject={subject}
        storageKey="student-records-ai-dialog"
        placeholder="输入与学生记录相关的问题，Enter 发送…"
      />
    </>
  );
}
