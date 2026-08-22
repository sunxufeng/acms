'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const 考勤状态_OPTS = ['正常', '异常'];
const 时段_OPTS = ['上午', '下午', '晚间', '全天'];
const 学期_OPTS = ['第一学期', '第二学期', '暑期'];
const 考勤结果_OPTS = ['出勤', '迟到', '早退', '事假', '病假', '缺勤', '校内活动'];
const 通知状态_OPTS = ['无需通知', '待通知', '已通知', '已确认'];

const COLUMNS: CrudColumn[] = [
  { key: '关联学生编号', label: '学生', width: '110px', form: true, type: 'studentLink', required: true, listOrder: 1 },
  { key: '考勤状态', label: '考勤状态', width: '100px', filter: true, filterOptions: 考勤状态_OPTS, form: true, type: 'select', options: 考勤状态_OPTS, list: false },
  { key: '异常描述', label: '异常描述', form: true, type: 'textarea', list: false },
  { key: '班主任', label: '班主任', width: '100px', list: false },
  { key: '时段', label: '时段', width: '90px', filter: true, filterOptions: 时段_OPTS, form: true, type: 'select', options: 时段_OPTS, listOrder: 6 },
  { key: '学年', label: '学年', width: '80px', list: false },
  { key: '考勤日期', label: '考勤日期', width: '120px', form: true, type: 'date', listOrder: 2 },
  { key: '学期', label: '学期', width: '100px', filter: true, filterOptions: 学期_OPTS, form:  true, type: 'select', options: 学期_OPTS, listOrder: 5 },
  { key: '班级', label: '班级', width: '100px', listOrder: 4 },
  { key: '考勤结果', label: '考勤结果', width: '110px', filter: true, filterOptions: 考勤结果_OPTS, form: true, type: 'select', options: 考勤结果_OPTS, listOrder: 3 },
  { key: '到校时间', label: '到校时间', width: '120px', form: true, type: 'date', list: false },
  { key: '离校时间', label: '离校时间', width: '120px', form: true, type: 'date', list: false },
  { key: '记录人', label: '记录人', width: '100px', list: false },
  { key: '通知状态', label: '通知状态', width: '110px', filter: true, filterOptions: 通知状态_OPTS, form: true, type: 'select', options: 通知状态_OPTS, list: false },
  { key: '处理结果', label: '处理结果', form: true, type: 'textarea', list: false },
];

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
      studentDetailHref={(row) => '/student-360?sid=' + String((row['关联学生编号__link'] as string[])?.[0] ?? '')}
      api={{
        list: (p) => api.listStudentAttendances(p),
        create: (d) => api.createStudentAttendance(d),
        update: (id, d) => api.updateStudentAttendance(id, d),
        archive: (id) => api.archiveStudentAttendance(id),
      }}
    />
  );
}
