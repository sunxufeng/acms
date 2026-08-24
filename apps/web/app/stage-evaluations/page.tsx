'use client';

import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

export default function StageEvaluationsPage() {
  return (
    <CrudPage
      title="阶段评价"
      subtitle="学业/行为/身心等阶段性综合评价（M1 学生域）"
      search={{ placeholder: '搜索学生姓名…' }}
      columns={COLUMNS}
      statusField="评价完整度"
      inlineEdit
      standaloneForm
      studentDetailHref={(row) => '/stage-evaluations/' + String(row.id)}
      api={{
        list: (p) => api.listStageEvaluations(p),
        create: (d) => api.createStageEvaluation(d),
        update: (id, d) => api.updateStageEvaluation(id, d),
        archive: (id) => api.archiveStageEvaluation(id),
      }}
    />
  );
}
