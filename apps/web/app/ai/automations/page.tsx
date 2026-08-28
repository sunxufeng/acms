'use client';

import { useRouter } from 'next/navigation';
import CrudPage, { type CrudColumn } from '../../../components/CrudPage';
import { api } from '../../../lib/api';

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

const COLUMNS: CrudColumn[] = [
  {
    key: 'title',
    label: '任务名',
    render: (v) => <strong>{str(v)}</strong>,
  },
  {
    key: 'cronText',
    label: '调度',
    render: (v, row) => {
      const sched = str(row.cronText) || str(row.cron);
      return <span>{sched}{row.idleOnly ? '（闲时）' : ''}</span>;
    },
  },
  {
    key: 'pushTo',
    label: '收件人',
    render: (v) => `${(Array.isArray(v) ? v : []).length} 人`,
  },
  {
    key: 'actionType',
    label: '结果动作',
    render: (v) => (str(v) === 'memory' ? '仅记忆' : '推送'),
  },
  {
    key: 'enabled',
    label: '状态',
    filter: true,
    filterOptions: ['启用', '停用'],
    render: (v) => (
      <span className={`status-dot ${v ? 'status-on' : 'status-off'}`}>{v ? '启用' : '停用'}</span>
    ),
  },
];

export default function AiAutomationsPage() {
  const router = useRouter();

  return (
    <CrudPage
      title="自动化任务"
      subtitle="按 cron 定时调用模型并将结果推送至飞书。可关联智能体（自动沿用其 Provider / Model），否则使用收件人个人配置。"
      search={{ placeholder: '搜索任务名…' }}
      columns={COLUMNS}
      createHref="/ai/automations/new"
      editHref={(id) => `/ai/automations/${id}/edit`}
      rowExtraActions={[
        {
          label: '运行',
          run: async (row) => {
            await api.aiRunAutomation(String(row.id));
            alert('已触发（后台异步执行，可在运行记录查看）');
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
            items = items.filter((it) => (p.enabled === '启用') === !!it.enabled);
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
