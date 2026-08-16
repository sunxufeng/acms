'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const STATUS_OPTS = ['待提交', '已提交', '教师已确认', '教务已审核', '可计费'];
const PERIOD_OPTS = ['上午', '下午', '晚上'];

const TRANSITIONS: Record<string, string[]> = {
  待提交: ['已提交'],
  已提交: ['教师已确认'],
  教师已确认: ['教务已审核'],
  教务已审核: ['可计费'],
};

const COLUMNS: CrudColumn[] = [
  { key: '教学班文本', label: '教学班', width: '150px', filter: true, form: true, type: 'text' },
  { key: '授课教师文本', label: '授课教师', width: '120px', filter: true, form: true, required: true, type: 'text' },
  { key: '出勤日期', label: '出勤日期', width: '130px', form: true, type: 'date' },
  { key: '时段', label: '时段', width: '90px', filter: true, filterOptions: PERIOD_OPTS, form: true, type: 'select', options: PERIOD_OPTS },
  { key: '计划课时', label: '计划课时', width: '90px', form: true, type: 'number' },
  { key: '实到人数', label: '实到', width: '80px', form: true, type: 'number' },
  { key: '出勤状态', label: '状态', width: '110px', filter: true, filterOptions: STATUS_OPTS, form: true, type: 'select', options: STATUS_OPTS },
  { key: '异常描述', label: '异常描述', form: true, type: 'textarea' },
  { key: '校区', label: '校区', width: '100px', form: true, type: 'text' },
];

export default function AttendancePage() {
  return (
    <CrudPage
      title="教师履约 / 出勤"
      subtitle="教师提交并确认本人课次出勤，教务审核后转为可计费（M3 教学履约）"
      columns={COLUMNS}
      api={{
        list: (p) => api.listAttendances(p),
        create: (d) => api.createAttendance(d),
        update: (id, d) => api.updateAttendance(id, d),
        archive: (id) => api.archiveAttendance(id),
        transition: (id, to) => api.transitionAttendance(id, to),
      }}
      statusField="出勤状态"
      transitions={TRANSITIONS}
    />
  );
}
