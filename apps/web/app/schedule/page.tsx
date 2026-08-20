'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const METHOD_OPTS = ['线下', '线上', '混合'];
const STATUS_OPTS = ['待确认', '已确认', '已完成', '已取消', '已调课'];
const SOURCE_OPTS = ['公共课批量生成', '定制课生成', '人工加课', '调课'];

const TRANSITIONS: Record<string, string[]> = {
  待确认: ['已确认', '已取消', '已调课'],
  已确认: ['已完成', '已取消', '已调课'],
  已完成: [],
  已取消: [],
  已调课: ['待确认'],
};

const COLUMNS: CrudColumn[] = [
  { key: '课次名称', label: '课次', width: '160px', form: true, required: true, type: 'text' },
  { key: '教学班文本', label: '教学班', width: '140px', filter: true, form: true, type: 'text' },
  { key: '授课教师文本', label: '授课教师', width: '120px', filter: true, form: true, type: 'text' },
  { key: '场地文本', label: '场地', width: '120px', filter: true, form: true, type: 'text' },
  { key: '课次日期', label: '日期', width: '120px', form: true, type: 'date' },
  { key: '开始时间', label: '开始', width: '80px', form: true, type: 'text' },
  { key: '结束时间', label: '结束', width: '80px', form: true, type: 'text' },
  { key: '授课方式', label: '方式', width: '90px', filter: true, filterOptions: METHOD_OPTS, form: true, type: 'select', options: METHOD_OPTS },
  { key: '课次状态', label: '状态', width: '100px', filter: true, filterOptions: STATUS_OPTS },
  { key: '更新时间', label: '更新', width: '90px', render: (v) => <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-xs)' }}>{String(v ?? '').slice(0, 10)}</span> },
];

function statusClass(s: string): string {
  if (s === '已确认' || s === '已完成') return 'status-active';
  if (s === '已取消') return 'status-left';
  if (s === '待确认') return 'status-draft';
  if (s === '已调课') return 'status-warn';
  return '';
}

export default function SchedulePage() {
  return (
    <div className="page">
      <CrudPage
        title="课次列表"
        subtitle="课次排课与冲突预检（M2 排课域）"
        columns={COLUMNS}
        statusField="课次状态"
        transitions={TRANSITIONS}
        statusClass={statusClass}
        api={{
          list: (p) => api.listSessions(p),
          create: (d) => api.createSession(d),
          update: (id, d) => api.updateSession(id, d),
          archive: (id) => api.archiveSession(id),
          transition: (id, to) => api.transitionSession(id, to),
        }}
        extraLinks={[{ label: '排课与课次', href: '/schedule/precheck' }]}
        createHref="/schedule/new"
        editHref={(id) => `/schedule/${id}/edit`}
      />
    </div>
  );
}
