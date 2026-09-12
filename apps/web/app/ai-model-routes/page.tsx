'use client';

import { useEffect, useMemo, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

/**
 * AI 路由 · 模型路由。
 *
 * 这里定义「对外暴露的逻辑模型名 → 某个上游账号上的真实模型名」的映射。
 * 同一个逻辑模型可以配多条（不同上游）：
 *  - 优先级小的先用（一个档次用完才降级到下一档）
 *  - 同优先级内按权重加权随机（做负载分担）
 *  - 上游调用失败会自动尝试下一条（最多 3 条）
 */
function buildColumns(upstreamOptions: { value: string; label: string }[]): CrudColumn[] {
  return [
    {
      key: '逻辑模型',
      label: '逻辑模型（对外）',
      width: '190px',
      form: true,
      required: true,
      filter: true,
      filterType: 'text',
      listOrder: 1,
      hint: '使用方在 SDK 里填的 model 名，如 gpt-4o-mini',
      render: (v) => <span style={{ fontWeight: 600 }}>{String(v ?? '—')}</span>,
    },
    {
      key: '上游账号',
      label: '上游账号',
      width: '160px',
      form: true,
      required: true,
      type: 'link',
      linkOptions: upstreamOptions,
      listOrder: 2,
      render: (v) => (
        <span
          style={{
            fontSize: 'var(--font-xs)',
            padding: '1px 6px',
            borderRadius: 8,
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
          }}
        >
          {String(v ?? '—')}
        </span>
      ),
    },
    {
      key: '上游模型',
      label: '上游实际模型',
      width: '190px',
      form: true,
      required: true,
      listOrder: 3,
      hint: '转发时替换成的真实模型名，如 gpt-4o-2024-08-06',
      render: (v) => <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)' }}>{String(v ?? '—')}</span>,
    },
    { key: '优先级', label: '优先级', width: '80px', form: true, type: 'number', hint: '数字小的先用' },
    { key: '权重', label: '权重', width: '70px', form: true, type: 'number', hint: '同级按权重随机分担' },
    {
      key: '状态',
      label: '状态',
      width: '80px',
      form: true,
      type: 'select',
      dictKey: 'AI路由状态',
      filter: true,
      filterOptions: ['启用', '停用'],
      listOrder: 6,
    },
  ];
}

export default function AiModelRoutesPage() {
  const [upstreams, setUpstreams] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .listAiUpstreams({ pageSize: '200' })
      .then((p) => {
        if (!alive) return;
        setUpstreams(
          (p.items ?? []).map((u) => ({
            value: String(u.id ?? ''),
            label: `${String(u['名称'] ?? '')}（${String(u['供应商'] ?? '')}）`,
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const columns = useMemo(() => buildColumns(upstreams), [upstreams]);

  return (
    <CrudPage
      title="AI 路由 · 模型路由"
      subtitle="逻辑模型 → 上游账号 + 上游真实模型名；优先级决定降级顺序，权重决定同级分担"
      search={{ placeholder: '搜索逻辑模型 / 上游模型…' }}
      columns={columns}
      moduleKey="aiModelRoutes"
      statusField="状态"
      inlineEdit
      standaloneForm
      api={{
        list: (p) => api.listAiModelRoutes(p),
        create: (d) => api.createAiModelRoute(d),
        update: (id, d) => api.updateAiModelRoute(id, d),
        archive: (id) => api.deleteAiModelRoute(id),
      }}
    />
  );
}
