'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

/**
 * AI 路由 · 审计日志。
 *
 * 记录这一套网关上的**管理动作**：代发/吊销密钥、查看上游凭证明文、上游体检等。
 * 与系统审计日志分开（系统审计记的是业务数据变更），这里聚焦「谁动了网关配置」。
 * 只读 + 时间区间筛选。
 */
const COLUMNS: CrudColumn[] = [
  { key: '操作时间', label: '时间', width: '160px', listOrder: 1 },
  { key: '操作人', label: '操作人', width: '130px', filter: true, filterType: 'text', listOrder: 2 },
  {
    key: '动作',
    label: '动作',
    width: '150px',
    filter: true,
    filterOptions: ['代发密钥', '吊销密钥', '查看上游凭证'],
    listOrder: 3,
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
  { key: '对象类型', label: '对象类型', width: '110px', filter: true, filterOptions: ['密钥', '上游账号', '分组', '模型路由'] },
  { key: '对象名称', label: '对象', width: '180px' },
  {
    key: '详情',
    label: '详情',
    width: '320px',
    render: (v) => {
      const s = String(v ?? '');
      if (!s || s === '{}') return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      let text = s;
      try {
        const o = JSON.parse(s) as Record<string, unknown>;
        text = Object.entries(o)
          .filter(([, x]) => x !== '' && x !== null && x !== undefined)
          .map(([k, x]) => `${k}: ${Array.isArray(x) ? x.join('、') : String(x)}`)
          .join('　');
      } catch {
        /* 非 JSON 就原样显示 */
      }
      return <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)', wordBreak: 'break-all' }}>{text}</span>;
    },
  },
  { key: '客户端IP', label: '客户端 IP', width: '130px' },
];

export default function AiOpLogsPage() {
  return (
    <CrudPage
      title="AI 路由 · 审计日志"
      subtitle="密钥代发/吊销、上游凭证查看等管理动作留痕（网关调用明细见「用量统计」）"
      search={{ placeholder: '搜索操作人 / 对象名称…' }}
      columns={COLUMNS}
      moduleKey="aiOpLogs"
      readonly
      hideCreate
      rangeFilters={[
        { key: '操作时间', label: '操作时间', fromParam: '操作时间_from', toParam: '操作时间_to' },
      ]}
      api={{ list: (p) => api.listAiOpLogs(p) }}
    />
  );
}
