'use client';

import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

export default function StudentAttendancesPage() {
  return (
    <CrudPage
      title="学生考勤"
      subtitle="日常出勤与异常记录（M1 学生域）"
      search={{ placeholder: '搜索学生姓名 / 学年 / 班级…' }}
      columns={COLUMNS}
      statusField="考勤状态"
      inlineEdit
      standaloneForm
      studentDetailHref={(row) => '/student-attendances/' + String(row.id)}
      api={{
        list: (p) => api.listStudentAttendances(p),
        create: (d) => api.createStudentAttendance(d),
        update: (id, d) => api.updateStudentAttendance(id, d),
        archive: (id) => api.archiveStudentAttendance(id),
      }}
    />
  );
}
