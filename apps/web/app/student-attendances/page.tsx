'use client';

import { useMemo, useState } from 'react';
import CrudPage from '../../components/CrudPage';
import FloatingAIPanel from '../../components/FloatingAIPanel';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';
import { buildSelectionContext, studentName } from '../../lib/aiContext';

export default function StudentAttendancesPage() {
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);

  const context = useMemo(
    () =>
      buildSelectionContext({
        title: '学生考勤',
        selected,
        fields: [
          ['考勤日期', '考勤日期'],
          ['时段', '时段'],
          ['考勤结果', '考勤结果'],
          ['班级', '班级'],
          ['通知状态', '通知状态'],
        ],
        detailKeys: [
          ['异常描述', '异常描述'],
          ['处理结果', '处理结果'],
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
        title="学生考勤"
        subtitle="日常出勤与异常记录（M1 学生域）"
        search={{ placeholder: '搜索学生姓名 / 学年 / 班级…' }}
        columns={COLUMNS}
        statusField="考勤状态"
        inlineEdit
        standaloneForm
        studentDetailHref={(row) => '/student-attendances/' + String(row.id)}
        selection
        onSelectionChange={setSelected}
        api={{
          list: (p) => api.listStudentAttendances(p),
          create: (d) => api.createStudentAttendance(d),
          update: (id, d) => api.updateStudentAttendance(id, d),
          archive: (id) => api.archiveStudentAttendance(id),
        }}
      />

      {/* 右侧悬浮「AI」：参考招生跟进，按勾选的一条或多条考勤记录做分析 */}
      <FloatingAIPanel
        context={context}
        resetKey={resetKey}
        disabled={selected.length === 0}
        disabledHint="请在列表前勾选一条或多条考勤记录"
        label="AI"
        title="AI"
        subject={subject}
        storageKey="student-attendances-ai-dialog"
        placeholder="输入与学生考勤相关的问题，Enter 发送…"
      />
    </>
  );
}
