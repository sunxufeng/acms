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
    key: 'name',
    label: '名称',
    render: (v, row) => (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <strong>{str(v)}</strong>
          {row.emoji ? <span>{str(row.emoji)}</span> : null}
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-tertiary)' }}>{str(row.owner) || '组织'}</div>
      </div>
    ),
  },
  {
    key: 'owner',
    label: '组织',
    render: (v) => <span style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>{str(v) || '—'}</span>,
  },
  {
    key: 'provider',
    label: '绑定飞书',
    filter: true,
    filterOptions: ['已绑定', '未绑定'],
    render: (v) => {
      const bound = !!v;
      return (
        <span className={`status-dot ${bound ? 'status-on' : 'status-off'}`}>{bound ? '已绑定' : '未绑定'}</span>
      );
    },
  },
  {
    key: 'updatedAt',
    label: '更新时间',
    render: (v) =>
      v ? new Date(Number(v)).toLocaleString('zh-CN', { hour12: false }) : '—',
  },
];

export default function AiAgentsPage() {
  const router = useRouter();

  return (
    <CrudPage
      title="智能体配置"
      subtitle="创建 / 编辑智能体并绑定飞书应用，实现「每个智能体对应一个飞书机器人」。"
      search={{ placeholder: '搜索智能体名称…' }}
      columns={COLUMNS}
      createHref="/ai/agents/new"
      editHref={(id) => `/ai/agents/${id}/edit`}
      rowExtraActions={[
        {
          label: '开启对话',
          run: (row) => {
            router.push(`/ai/chat?agentId=${String(row.id)}`);
          },
        },
        {
          label: '绑定飞书',
          run: () => {
            alert('绑定飞书功能：在编辑页填写飞书应用 App ID / Secret，即可让该智能体以独立机器人身份推送消息');
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
            items = items.filter((it) => (p.provider === '已绑定') === !!it.provider);
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
