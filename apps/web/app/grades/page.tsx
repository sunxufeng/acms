'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage from '../../components/CrudPage';
import FloatingAIPanel from '../../components/FloatingAIPanel';
import { api } from '../../lib/api';
import { buildGradeColumns } from './columns';
import { buildSelectionContext, studentName } from '../../lib/aiContext';

export default function GradesPage() {
  const t = useTranslations('academic');
  const [selected, setSelected] = useState<Record<string, unknown>[]>([]);
  const COLUMNS = buildGradeColumns(t);

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
  const subject = selected.length ? t('aiSubjectSelected', { count: selected.length, students: studentCount }) : t('aiSubjectNone');

  return (
    <>
      <CrudPage
        title={t('titleGrades')}
        subtitle={t('subtitleGrades')}
        search={{ placeholder: t('searchGrades') }}
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
        disabledHint={t('hintSelectGrades')}
        label="AI"
        title="AI"
        subject={subject}
        storageKey="grades-ai-dialog"
        placeholder={t('aiPlaceholderGrades')}
      />
    </>
  );
}
