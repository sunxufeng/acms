'use client';

import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

export default function GradesPage() {
  return (
    <CrudPage
      title="学业成绩"
      subtitle="学科成绩与考核记录（M1 学生域）"
      search={{ placeholder: '搜索学生姓名 / 学年 / 课程…' }}
      columns={COLUMNS}
      statusField="成绩状态"
      inlineEdit
      standaloneForm
      studentDetailHref={(row) => '/grades/' + String(row.id)}
      api={{
        list: (p) => api.listGrades(p),
        create: (d) => api.createGrade(d),
        update: (id, d) => api.updateGrade(id, d),
        archive: (id) => api.archiveGrade(id),
      }}
    />
  );
}
