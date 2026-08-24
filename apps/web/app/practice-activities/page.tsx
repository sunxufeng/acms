'use client';

import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

export default function PracticeActivitiesPage() {
  return (
    <CrudPage
      title="实践活动"
      subtitle="研学/志愿/竞赛等实践活动记录（M1 学生域）"
      search={{ placeholder: '搜索活动名称…' }}
      columns={COLUMNS}
      statusField="安全确认状态"
      inlineEdit
      standaloneForm
      studentDetailHref={(row) => '/practice-activities/' + String(row.id)}
      api={{
        list: (p) => api.listPracticeActivities(p),
        create: (d) => api.createPracticeActivity(d),
        update: (id, d) => api.updatePracticeActivity(id, d),
        archive: (id) => api.archivePracticeActivity(id),
      }}
    />
  );
}
