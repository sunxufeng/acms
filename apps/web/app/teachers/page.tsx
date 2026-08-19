'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const STATUS_OPTS = ['候选', '在职', '离职', '退休', '合作中'];
const SUBJECT_OPTS = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '政治', '音乐', '美术', '体育', '信息科技'];

const COLUMNS: CrudColumn[] = [
  { key: '教师姓名', label: '教师姓名', width: '120px', form: true, required: true, type: 'text' },
  { key: '教师类别', label: '教师类别', width: '100px', filter: true, form: true, type: 'select', dictKey: '教师类别' },
  { key: '英文名', label: '英文名', form: true, type: 'text' },
  { key: '微信号', label: '微信号', form: true, type: 'text' },
  { key: '邮箱', label: '邮箱', form: true, type: 'text' },
  { key: '在职合作状态', label: '合作状态', width: '100px', filter: true, form: true, type: 'select', options: STATUS_OPTS },
  { key: '所属部门', label: '所属部门', form: true, type: 'text' },
  { key: '常驻城市', label: '常驻城市', form: true, type: 'text' },
  { key: '授课学段', label: '授课学段', form: true, type: 'select', dictKey: '授课学段' },
  { key: '授课科目类型', label: '授课科目类型', form: true, type: 'select', dictKey: '授课科目类型' },
  { key: '授课科目', label: '授课科目', form: true, type: 'multiselect', dictKey: '授课科目' },
  { key: '合作开始时间', label: '合作开始时间', form: true, type: 'select', dictKey: '合作开始时间' },
  { key: '开课人数说明', label: '开课人数说明', form: true, type: 'text' },
  { key: '个人描述', label: '个人描述', form: true, type: 'textarea' },
  { key: '附件', label: '附件', form: true, type: 'textarea' },
  { key: '教师合作等级', label: '教师合作等级', form: true, type: 'text' },
  { key: '教学评估', label: '教学评估', form: true, type: 'textarea' },
  { key: '收款主体', label: '收款主体', form: true, type: 'select', dictKey: '收款主体' },
  { key: '主要学科', label: '主要学科', form: true, type: 'multiselect', options: SUBJECT_OPTS },
  { key: '可授年级与课程', label: '可授年级与课程', form: true, type: 'text' },
  { key: '资质与证书摘要', label: '资质与证书摘要', form: true, type: 'textarea' },
  { key: '数据密级', label: '密级', width: '90px', filter: true, form: true, type: 'select', dictKey: '数据密级' },
  { key: '更新时间', label: '更新', width: '90px', render: (v) => <span className="muted">{String(v ?? '').slice(0, 10)}</span> },
];

export default function TeachersPage() {
  return (
    <CrudPage
      title="教师档案"
      subtitle="教师基本信息与师资管理（M2 教师域）"
      columns={COLUMNS}
      inlineEdit
      api={{
        list: (p) => api.listTeachers(p),
        create: (d) => api.createTeacher(d),
        update: (id, d) => api.updateTeacher(id, d),
        archive: (id) => api.archiveTeacher(id),
      }}
    />
  );
}
