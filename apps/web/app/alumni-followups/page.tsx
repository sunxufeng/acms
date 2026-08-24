'use client';

import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

export default function AlumniFollowupsPage() {
  return (
    <CrudPage
      title="校友跟进"
      subtitle="毕业校友去向追踪与关系维护（M1 学生域）"
      search={{ placeholder: '搜索学生姓名…' }}
      columns={COLUMNS}
      statusField="跟进状态"
      inlineEdit
      standaloneForm
      studentDetailHref={(row) => '/alumni-followups/' + String(row.id)}
      api={{
        list: (p) => api.listAlumniFollowups(p),
        create: (d) => api.createAlumniFollowup(d),
        update: (id, d) => api.updateAlumniFollowup(id, d),
        archive: (id) => api.archiveAlumniFollowup(id),
      }}
    />
  );
}
