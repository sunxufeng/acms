'use client';

import { useMemo, useState } from 'react';
import CrudPage from '../../components/CrudPage';
import FloatingAIPanel from '../../components/FloatingAIPanel';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';
import { buildSelectionContext, studentName } from '../../lib/aiContext';

export default function AlumniFollowupsPage() {
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);

  const context = useMemo(
    () =>
      buildSelectionContext({
        title: '校友跟进',
        selected,
        fields: [
          ['跟进事项', '跟进事项'],
          ['跟进日期', '跟进时间'],
          ['跟进方式', '跟进方式'],
          ['跟进状态', '跟进状态'],
          ['跟进人', '跟进负责人'],
          ['当前去向', '当前去向类型'],
          ['学校/单位', '当前学校或单位'],
        ],
        detailKeys: [['跟进备注', '跟进备注']],
      }),
    [selected],
  );

  const studentCount = useMemo(() => new Set(selected.map((r) => studentName(r))).size, [selected]);
  const resetKey = useMemo(() => selected.map((r) => String(r.id)).sort().join(','), [selected]);
  const subject = selected.length ? `已选 ${selected.length} 条 / ${studentCount} 名学生` : '（未选择记录）';

  return (
    <>
      <CrudPage
        title="校友跟进"
        subtitle="毕业校友去向追踪与关系维护（M1 学生域）"
        search={{ placeholder: '搜索学生姓名…' }}
        columns={COLUMNS}
        statusField="跟进状态"
        inlineEdit
        standaloneForm
        studentDetailHref={(row) => '/alumni-followups/' + String(row.id)}
        selection
        onSelectionChange={setSelected}
        api={{
          list: (p) => api.listAlumniFollowups(p),
          create: (d) => api.createAlumniFollowup(d),
          update: (id, d) => api.updateAlumniFollowup(id, d),
          archive: (id) => api.archiveAlumniFollowup(id),
        }}
      />

      {/* 右侧悬浮「AI」：参考招生跟进，按勾选的一条或多条校友跟进记录做分析 */}
      <FloatingAIPanel
        context={context}
        resetKey={resetKey}
        disabled={selected.length === 0}
        disabledHint="请在列表前勾选一条或多条校友跟进记录"
        label="AI"
        title="AI"
        subject={subject}
        storageKey="alumni-followups-ai-dialog"
        placeholder="输入与校友跟进相关的问题，Enter 发送…"
      />
    </>
  );
}
