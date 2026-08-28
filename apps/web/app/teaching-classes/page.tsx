'use client';

import { useTranslations } from 'next-intl';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/date';

const TYPE_OPTS = ['行政班', '教学班', '选修班', '定制班', '兴趣班', '补习班'];
const STATUS_OPTS = ['筹备', '进行中', '已结课', '取消'];
const SCHEDULE_OPTS = ['待排课', '排课中', '已排课'];

const TRANSITIONS: Record<string, string[]> = {
  筹备: ['进行中', '取消'],
  进行中: ['已结课', '取消'],
  已结课: [],
  取消: [],
};

function statusClass(s: string): string {
  if (s === '进行中') return 'status-active';
  if (s === '已结课' || s === '取消') return 'status-left';
  if (s === '筹备') return 'status-draft';
  return '';
}

export default function TeachingClassesPage() {
  const t = useTranslations('academic');

  const COLUMNS: CrudColumn[] = [
    { key: '教学班名称', label: t('colTcName'), width: '180px', form: true, required: true, type: 'text' },
    { key: '教学班类型', label: t('colType'), width: '110px', filter: true, filterOptions: TYPE_OPTS, form: true, type: 'select', options: TYPE_OPTS },
    { key: '学期', label: t('colTerm'), width: '110px', form: true, type: 'text' },
    { key: '主讲教师文本', label: t('colTcLeadTeacher'), width: '120px', form: true, type: 'text' },
    { key: '上课地点', label: t('colTcLocation'), width: '120px', form: true, type: 'text' },
    { key: '教学状态', label: t('colTcTeachingStatus'), width: '100px', filter: true, filterOptions: STATUS_OPTS },
    { key: '排课状态', label: t('colTcScheduleStatus'), width: '100px', filter: true, filterOptions: SCHEDULE_OPTS },
    { key: '更新时间', label: t('colUpdated'), width: '150px', render: (v) => <span className="muted">{formatDateTime(v)}</span> },
  ];

  return (
    <CrudPage
      title={t('titleTeachingClasses')}
      subtitle={t('subtitleTeachingClasses')}
      columns={COLUMNS}
      statusField="教学状态"
      transitions={TRANSITIONS}
      statusClass={statusClass}
      inlineEdit
      standaloneForm
      search={{ placeholder: t('searchTcName') }}
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
