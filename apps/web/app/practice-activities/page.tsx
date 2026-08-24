'use client';

import { useMemo, useState } from 'react';
import CrudPage from '../../components/CrudPage';
import FloatingAIPanel from '../../components/FloatingAIPanel';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';
import { buildSelectionContext, studentName } from '../../lib/aiContext';

export default function PracticeActivitiesPage() {
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);

  const context = useMemo(
    () =>
      buildSelectionContext({
        title: '实践活动',
        selected,
        fields: [
          ['活动名称', '活动名称'],
          ['活动类型', '活动类型'],
          ['参与情况', '参与情况'],
          ['活动表现', '活动表现'],
          ['开始日期', '活动开始日期'],
          ['时长', '服务或参与时长'],
        ],
        detailKeys: [
          ['活动内容', '活动内容'],
          ['成果与反思', '成果与反思'],
        ],
      }),
    [selected],
  );

  const studentCount = useMemo(() => new Set(selected.map((r) => studentName(r))).size, [selected]);
  const resetKey = useMemo(() => selected.map((r) => String(r.id)).sort().join(','), [selected]);
  const subject = selected.length ? `已选 ${selected.length} 条 / ${studentCount} 名学生` : '（未选择记录）';

  return (
    <>
      <CrudPage
        title="实践活动"
        subtitle="研学/志愿/竞赛等实践活动记录（M1 学生域）"
        search={{ placeholder: '搜索活动名称…' }}
        columns={COLUMNS}
        statusField="安全确认状态"
        inlineEdit
        standaloneForm
        studentDetailHref={(row) => '/practice-activities/' + String(row.id)}
        selection
        onSelectionChange={setSelected}
        api={{
          list: (p) => api.listPracticeActivities(p),
          create: (d) => api.createPracticeActivity(d),
          update: (id, d) => api.updatePracticeActivity(id, d),
          archive: (id) => api.archivePracticeActivity(id),
        }}
      />

      {/* 右侧悬浮「AI」：参考招生跟进，按勾选的一条或多条实践活动记录做分析 */}
      <FloatingAIPanel
        context={context}
        resetKey={resetKey}
        disabled={selected.length === 0}
        disabledHint="请在列表前勾选一条或多条实践活动记录"
        label="AI"
        title="AI"
        subject={subject}
        storageKey="practice-activities-ai-dialog"
        placeholder="输入与实践活动相关的问题，Enter 发送…"
      />
    </>
  );
}
