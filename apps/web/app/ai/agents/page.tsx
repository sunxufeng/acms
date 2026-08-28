'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import CrudPage, { type CrudColumn } from '../../../components/CrudPage';
import { api } from '../../../lib/api';

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

export default function AiAgentsPage() {
  const router = useRouter();
  const t = useTranslations('ai.agents');
  const locale = useLocale();

  const COLUMNS: CrudColumn[] = [
    {
      key: 'name',
      label: t('colName'),
      render: (v, row) => (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <strong>{str(v)}</strong>
            {row.emoji ? <span>{str(row.emoji)}</span> : null}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)' }}>{str(row.owner) || t('ownerDefault')}</div>
        </div>
      ),
    },
    {
      key: 'owner',
      label: t('colOrg'),
      render: (v) => <span style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>{str(v) || '—'}</span>,
    },
    {
      key: 'provider',
      label: t('colFeishu'),
      filter: true,
      filterOptions: [t('filterBound'), t('filterUnbound')],
      render: (v) => {
        const bound = !!v;
        return (
          <span className={`status-dot ${bound ? 'status-on' : 'status-off'}`}>{bound ? t('feishuBound') : t('feishuUnbound')}</span>
        );
      },
    },
    {
      key: 'updatedAt',
      label: t('colUpdated'),
      render: (v) =>
        v ? new Date(Number(v)).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', { hour12: false }) : '—',
    },
  ];

  return (
    <CrudPage
      title={t('pageTitle')}
      subtitle={t('pageSubtitle')}
      search={{ placeholder: t('searchPlaceholder') }}
      columns={COLUMNS}
      createHref="/ai/agents/new"
      editHref={(id) => `/ai/agents/${id}/edit`}
      rowExtraActions={[
        {
          label: t('openChat'),
          run: (row) => {
            router.push(`/ai/chat?agentId=${String(row.id)}`);
          },
        },
        {
          label: t('bindFeishu'),
          run: () => {
            alert(t('bindFeishuAlert'));
          },
        },
      ]}
      api={{
        list: async (p) => {
          const all = (await api.aiListAgents()) as Record<string, unknown>[];
          let items = all;
          if (p.q) {
            const q = String(p.q).toLowerCase();
            items = items.filter((it) => str(it.name).toLowerCase().includes(q));
          }
          if (p.provider) {
            items = items.filter((it) => (p.provider === t('filterBound')) === !!it.provider);
          }
          return { items, total: items.length, pageToken: undefined, hasMore: false };
        },
        create: async () => ({}),
        update: async () => ({}),
        archive: (id) => api.aiDeleteAgent(id),
      }}
    />
  );
}
