'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const STATUS_OPTS = ['候选', '在职', '离职', '退休', '合作中'];
const CATEGORY_OPTS = ['专职教师', '兼职教师', '外聘专家', '助教', '行政教师'];
const LEVEL_OPTS = ['L1', 'L2', 'L3', 'L4', '内部', '公开'];

const COLUMNS: CrudColumn[] = [
  { key: '教师姓名', label: '教师姓名', width: '140px', form: true, required: true, type: 'text' },
  { key: '教师类别', label: '类别', width: '110px', filter: true, filterOptions: CATEGORY_OPTS, form: true, type: 'select', options: CATEGORY_OPTS },
  { key: '所属部门', label: '部门', width: '120px', filter: true, form: true, type: 'text' },
  { key: '主要学科', label: '主要学科', form: true, type: 'multiselect', options: ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '政治', '音乐', '美术', '体育', '信息科技'] },
  { key: '在职合作状态', label: '状态', width: '100px', filter: true, filterOptions: STATUS_OPTS, form: true, type: 'select', options: STATUS_OPTS },
  { key: '数据密级', label: '密级', width: '90px', filter: true, filterOptions: LEVEL_OPTS, form: true, type: 'select', options: LEVEL_OPTS },
  { key: '更新时间', label: '更新', width: '90px', render: (v) => <span className="muted">{String(v ?? '').slice(0, 10)}</span> },
];

export default function TeachersPage() {
  return (
    <CrudPage
      title="教师档案"
      subtitle="教师基本信息与师资管理（M2 教师域）"
      columns={COLUMNS}
      api={{
        list: (p) => api.listTeachers(p),
        create: (d) => api.createTeacher(d),
        update: (id, d) => api.updateTeacher(id, d),
        archive: (id) => api.archiveTeacher(id),
      }}
    />
  );
}
