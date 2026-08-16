'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const TYPE_OPTS = ['公共基础课', '专业核心课', '选修课', '定制课', '实践课', '素养课'];
const STAGE_OPTS = ['幼儿园', '小学', '初中', '高中', '国际课程', '全学段'];
const STATUS_OPTS = ['草拟', '审核中', '已发布', '停用'];
const GRADE_OPTS = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '初一', '初二', '初三', '高一', '高二', '高三'];

const TRANSITIONS: Record<string, string[]> = {
  草拟: ['审核中'],
  审核中: ['已发布', '草拟'],
  已发布: ['停用'],
  停用: ['草拟'],
};

const COLUMNS: CrudColumn[] = [
  { key: '课程方案名称', label: '方案名称', width: '200px', form: true, required: true, type: 'text' },
  { key: '方案类型', label: '类型', width: '120px', filter: true, filterOptions: TYPE_OPTS, form: true, type: 'select', options: TYPE_OPTS },
  { key: '适用学段', label: '学段', width: '110px', filter: true, filterOptions: STAGE_OPTS, form: true, type: 'select', options: STAGE_OPTS },
  { key: '适用年级', label: '适用年级', form: true, type: 'multiselect', options: GRADE_OPTS },
  { key: '方案状态', label: '状态', width: '100px', filter: true, filterOptions: STATUS_OPTS },
  { key: '标准总课时', label: '总课时', width: '90px', form: true, type: 'number' },
  { key: '版本号', label: '版本', width: '80px', form: true, type: 'text' },
  { key: '更新时间', label: '更新', width: '90px', render: (v) => <span className="muted">{String(v ?? '').slice(0, 10)}</span> },
];

function statusClass(s: string): string {
  if (s === '已发布') return 'status-active';
  if (s === '停用') return 'status-left';
  if (s === '审核中') return 'status-warn';
  return 'status-draft';
}

export default function CoursesPage() {
  return (
    <CrudPage
      title="课程方案"
      subtitle="课程体系与方案管理，状态机：草拟→审核中→已发布→停用（M2 教学域）"
      columns={COLUMNS}
      statusField="方案状态"
      transitions={TRANSITIONS}
      statusClass={statusClass}
      api={{
        list: (p) => api.listCoursePlans(p),
        create: (d) => api.createCoursePlan(d),
        update: (id, d) => api.updateCoursePlan(id, d),
        archive: (id) => api.archiveCoursePlan(id),
        transition: (id, to) => api.transitionCoursePlan(id, to),
      }}
    />
  );
}
