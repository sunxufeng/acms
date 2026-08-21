'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const TYPE_OPTS = ['行政班', '教学班', '选修班', '定制班', '兴趣班', '补习班'];
const STATUS_OPTS = ['筹备', '进行中', '已结课', '取消'];
const SCHEDULE_OPTS = ['待排课', '排课中', '已排课'];

const TRANSITIONS: Record<string, string[]> = {
  筹备: ['进行中', '取消'],
  进行中: ['已结课', '取消'],
  已结课: [],
  取消: [],
};

const COLUMNS: CrudColumn[] = [
  { key: '教学班名称', label: '教学班', width: '180px', form: true, required: true, type: 'text' },
  { key: '教学班类型', label: '类型', width: '110px', filter: true, filterOptions: TYPE_OPTS, form: true, type: 'select', options: TYPE_OPTS },
  { key: '学期', label: '学期', width: '110px', form: true, type: 'text' },
  { key: '主讲教师文本', label: '主讲教师', width: '120px', form: true, type: 'text' },
  { key: '上课地点', label: '上课地点', width: '120px', form: true, type: 'text' },
  { key: '教学状态', label: '教学状态', width: '100px', filter: true, filterOptions: STATUS_OPTS },
  { key: '排课状态', label: '排课状态', width: '100px', filter: true, filterOptions: SCHEDULE_OPTS },
  { key: '更新时间', label: '更新', width: '90px', render: (v) => <span className="muted">{String(v ?? '').slice(0, 10)}</span> },
];

function statusClass(s: string): string {
  if (s === '进行中') return 'status-active';
  if (s === '已结课' || s === '取消') return 'status-left';
  if (s === '筹备') return 'status-draft';
  return '';
}

export default function TeachingClassesPage() {
  return (
    <CrudPage
      title="教学班级"
      subtitle="教学班开设与运行状态管理（M2 教学域）"
      columns={COLUMNS}
      statusField="教学状态"
      transitions={TRANSITIONS}
      statusClass={statusClass}
      inlineEdit
      standaloneForm
      api={{
        list: (p) => api.listTeachingClasses(p),
        create: (d) => api.createTeachingClass(d),
        update: (id, d) => api.updateTeachingClass(id, d),
        archive: (id) => api.archiveTeachingClass(id),
        transition: (id, to) => api.transitionTeachingClass(id, to),
      }}
    />
  );
}
