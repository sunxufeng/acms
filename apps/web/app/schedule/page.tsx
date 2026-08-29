'use client';

import { useTranslations } from 'next-intl';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { SessionForm } from '../../components/SessionForm';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/date';

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

function statusClass(s: string): string {
  if (s === '已确认' || s === '已完成') return 'status-active';
  if (s === '已取消') return 'status-left';
  if (s === '待确认') return 'status-draft';
  if (s === '已调课') return 'status-warn';
  return '';
}

export default function SchedulePage() {
  const t = useTranslations('academic');

  const COLUMNS: CrudColumn[] = [
    { key: '课次名称', label: t('colSession'), width: '160px', form: true, required: true, type: 'text' },
    { key: '教学班文本', label: t('colTcName'), width: '140px', filter: true, filterType: 'text', form: true, type: 'text' },
    { key: '授课教师文本', label: t('colSessionTeacher'), width: '120px', filter: true, filterType: 'text', form: true, type: 'text' },
    { key: '场地文本', label: t('colSessionVenue'), width: '120px', filter: true, filterType: 'text', form: true, type: 'text' },
    { key: '课次日期', label: t('colSessionDate'), width: '120px', form: true, type: 'date' },
    { key: '开始时间', label: t('colSessionStart'), width: '80px', form: true, type: 'text' },
    { key: '结束时间', label: t('colSessionEnd'), width: '80px', form: true, type: 'text' },
    { key: '授课方式', label: t('colSessionMethod'), width: '90px', filter: true, filterOptions: METHOD_OPTS, form: true, type: 'select', options: METHOD_OPTS },
    { key: '课次状态', label: t('colStatus'), width: '100px', filter: true, filterOptions: STATUS_OPTS },
    { key: '更新时间', label: t('colUpdated'), width: '150px', render: (v) => <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-xs)' }}>{formatDateTime(v)}</span> },
  ];

  return (
    <div className="page">
      <CrudPage
        title={t('titleSessions')}
        subtitle={t('subtitleSessions')}
        columns={COLUMNS}
        statusField="课次状态"
        transitions={TRANSITIONS}
        statusClass={statusClass}
        search={{ placeholder: t('searchSessionName') }}
        api={{
          list: (p) => api.listSessions(p),
          create: (d) => api.createSession(d),
          update: (id, d) => api.updateSession(id, d),
          archive: (id) => api.archiveSession(id),
          transition: (id, to) => api.transitionSession(id, to),
        }}
        extraLinks={[{ label: t('linkPrecheck'), href: '/schedule/precheck' }]}
        inlineEdit
        standaloneForm
        renderForm={({ row, onDone }) => (
          <SessionForm
            initial={row ?? undefined}
            onSubmit={onDone}
          />
        )}
      />
    </div>
  );
}
