'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import CrudPage, { type CrudColumn } from '../../../components/CrudPage';
import { api } from '../../../lib/api';

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

export default function AiAutomationsPage() {
  const router = useRouter();
  const t = useTranslations('ai.automations');

  const COLUMNS: CrudColumn[] = [
    {
      key: 'title',
      label: t('colTitle'),
      render: (v) => <strong>{str(v)}</strong>,
    },
    {
      key: 'cronText',
      label: t('colSchedule'),
      render: (v, row) => {
        const sched = str(row.cronText) || str(row.cron);
        return <span>{sched}{row.idleOnly ? t('colIdle') : ''}</span>;
      },
    },
    {
      key: 'pushTo',
      label: t('colRecipients'),
      render: (v) => `${(Array.isArray(v) ? v : []).length} 人`,
    },
    {
      key: 'actionType',
      label: t('colResultAction'),
      render: (v) => (str(v) === 'memory' ? t('resultMemory') : t('resultPush')),
    },
    {
      key: 'enabled',
      label: t('colStatus'),
      filter: true,
      filterOptions: [t('filterEnabled'), t('filterDisabled')],
      render: (v) => (
        <span className={`status-dot ${v ? 'status-on' : 'status-off'}`}>{v ? t('statusEnabled') : t('statusDisabled')}</span>
      ),
    },
  ];

  return (
    <CrudPage
      title={t('pageTitle')}
      subtitle={t('pageSubtitle')}
      search={{ placeholder: t('searchPlaceholder') }}
      columns={COLUMNS}
      createHref="/ai/automations/new"
      editHref={(id) => `/ai/automations/${id}/edit`}
      rowExtraActions={[
        {
          label: t('run'),
          run: async (row) => {
            await api.aiRunAutomation(String(row.id));
            alert(t('runTriggered'));
          },
        },
      ]}
      api={{
        list: async (p) => {
          const all = (await api.aiListAutomations()) as Record<string, unknown>[];
          let items = all;
          if (p.q) {
            const q = String(p.q).toLowerCase();
            items = items.filter((it) =>
              (str(it.title) + str(it.description)).toLowerCase().includes(q),
            );
          }
          if (p.enabled) {
            items = items.filter((it) => (p.enabled === t('filterEnabled')) === !!it.enabled);
          }
          return { items, total: items.length, pageToken: undefined, hasMore: false };
        },
        create: async () => ({}),
        update: async () => ({}),
        archive: (id) => api.aiDeleteAutomation(id),
      }}
    />
  );
}
