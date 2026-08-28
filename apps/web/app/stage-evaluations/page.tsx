'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage from '../../components/CrudPage';
import FloatingAIPanel from '../../components/FloatingAIPanel';
import { api } from '../../lib/api';
import { buildStageColumns } from './columns';
import { buildSelectionContext, studentName } from '../../lib/aiContext';

export default function StageEvaluationsPage() {
  const t = useTranslations('academic');
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);
  const COLUMNS = buildStageColumns(t);

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
  const subject = selected.length ? t('aiSubjectSelected', { count: selected.length, students: studentCount }) : t('aiSubjectNone');

  return (
    <>
      <CrudPage
        title={t('titleStage')}
        subtitle={t('subtitleStage')}
        search={{ placeholder: t('searchStage') }}
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
        disabledHint={t('hintSelectStage')}
        label="AI"
        title="AI"
        subject={subject}
        storageKey="stage-evaluations-ai-dialog"
        placeholder={t('aiPlaceholderStage')}
      />
    </>
  );
}
