'use client';

import { useMemo, useState } from 'react';
import CrudPage from '../../components/CrudPage';
import FloatingAIPanel from '../../components/FloatingAIPanel';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';
import { buildSelectionContext, studentName } from '../../lib/aiContext';

export default function GradesPage() {
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);

  const context = useMemo(
    () =>
      buildSelectionContext({
        title: '学业成绩',
        selected,
        fields: [
          ['学科', '学科'],
          ['考核类型', '考核类型'],
          ['考核名称', '考核名称'],
          ['考核日期', '考核日期'],
          ['成绩', '成绩'],
          ['满分', '满分'],
          ['成绩等级', '成绩等级'],
          ['课堂表现', '课堂表现'],
          ['任课教师', '任课教师'],
        ],
        detailKeys: [['教师评语', '教师评语']],
      }),
    [selected],
  );

  const studentCount = useMemo(() => new Set(selected.map((r) => studentName(r))).size, [selected]);
  const resetKey = useMemo(() => selected.map((r) => String(r.id)).sort().join(','), [selected]);
  const subject = selected.length ? `已选 ${selected.length} 条 / ${studentCount} 名学生` : '（未选择记录）';

  return (
    <>
      <CrudPage
        title="学业成绩"
        subtitle="学科成绩与考核记录（M1 学生域）"
        search={{ placeholder: '搜索学生姓名 / 学年 / 课程…' }}
        columns={COLUMNS}
        statusField="成绩状态"
        inlineEdit
        standaloneForm
        studentDetailHref={(row) => '/grades/' + String(row.id)}
        selection
        onSelectionChange={setSelected}
        api={{
          list: (p) => api.listGrades(p),
          create: (d) => api.createGrade(d),
          update: (id, d) => api.updateGrade(id, d),
          archive: (id) => api.archiveGrade(id),
        }}
      />

      {/* 右侧悬浮「AI」：参考招生跟进，按勾选的一条或多条成绩记录做分析 */}
      <FloatingAIPanel
        context={context}
        resetKey={resetKey}
        disabled={selected.length === 0}
        disabledHint="请在列表前勾选一条或多条学业成绩记录"
        label="AI"
        title="AI"
        subject={subject}
        storageKey="grades-ai-dialog"
        placeholder="输入与学业成绩相关的问题，Enter 发送…"
      />
    </>
  );
}
