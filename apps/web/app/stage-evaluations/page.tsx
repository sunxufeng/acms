'use client';

import { useMemo, useState } from 'react';
import CrudPage from '../../components/CrudPage';
import FloatingAIPanel from '../../components/FloatingAIPanel';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';
import { buildSelectionContext, studentName } from '../../lib/aiContext';

export default function StageEvaluationsPage() {
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);

  const context = useMemo(
    () =>
      buildSelectionContext({
        title: '阶段评价',
        selected,
        fields: [
          ['评价周期', '评价周期'],
          ['评价类型', '评价类型'],
          ['评价日期', '评价日期'],
          ['评价等级', '评价等级'],
          ['评价完整度', '评价完整度'],
          ['评价人', '评价人'],
        ],
        detailKeys: [
          ['评价内容', '评价内容'],
          ['优势表现', '优势表现'],
          ['待改进项', '待改进项'],
          ['改进计划', '改进计划'],
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
        title="阶段评价"
        subtitle="学业/行为/身心等阶段性综合评价（M1 学生域）"
        search={{ placeholder: '搜索学生姓名…' }}
        columns={COLUMNS}
        statusField="评价完整度"
        inlineEdit
        standaloneForm
        studentDetailHref={(row) => '/stage-evaluations/' + String(row.id)}
        selection
        onSelectionChange={setSelected}
        api={{
          list: (p) => api.listStageEvaluations(p),
          create: (d) => api.createStageEvaluation(d),
          update: (id, d) => api.updateStageEvaluation(id, d),
          archive: (id) => api.archiveStageEvaluation(id),
        }}
      />

      {/* 右侧悬浮「AI」：参考招生跟进，按勾选的一条或多条阶段评价记录做分析 */}
      <FloatingAIPanel
        context={context}
        resetKey={resetKey}
        disabled={selected.length === 0}
        disabledHint="请在列表前勾选一条或多条阶段评价记录"
        label="AI"
        title="AI"
        subject={subject}
        storageKey="stage-evaluations-ai-dialog"
        placeholder="输入与阶段评价相关的问题，Enter 发送…"
      />
    </>
  );
}
