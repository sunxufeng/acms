'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage from '../../components/CrudPage';
import FloatingAIPanel from '../../components/FloatingAIPanel';
import { api } from '../../lib/api';
import { buildPracticeColumns } from './columns';
import { buildSelectionContext, studentName } from '../../lib/aiContext';

export default function PracticeActivitiesPage() {
  const t = useTranslations('academic');
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);
  const COLUMNS = buildPracticeColumns(t);

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
  const subject = selected.length ? t('aiSubjectSelected', { count: selected.length, students: studentCount }) : t('aiSubjectNone');

  return (
    <>
      <CrudPage
        title={t('titlePractice')}
        subtitle={t('subtitlePractice')}
        search={{ placeholder: t('searchPractice') }}
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
        disabledHint={t('hintSelectPractice')}
        label="AI"
        title="AI"
        subject={subject}
        storageKey="practice-activities-ai-dialog"
        placeholder={t('aiPlaceholderPractice')}
      />
    </>
  );
}
