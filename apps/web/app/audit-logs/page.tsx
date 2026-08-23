'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const 操作类型_OPTS = ['创建', '更新', '删除'];

function fmtTime(v: unknown): string {
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) {
    const t = new Date(Number(v));
    if (!Number.isNaN(t.getTime())) return t.toLocaleString('zh-CN', { hour12: false });
  }
  return String(v ?? '');
}

const COLUMNS: CrudColumn[] = [
  { key: '操作时间', label: '操作时间', width: '170px', render: (v) => fmtTime(v) },
  { key: '操作人', label: '操作人', width: '120px', filter: true, filterType: 'text', filterParam: 'actor' },
  { key: '操作类型', label: '操作类型', width: '90px', filter: true, filterOptions: 操作类型_OPTS },
  { key: '业务模块', label: '业务模块', width: '160px', filter: true },
  { key: '记录标识', label: '记录标识', width: '160px' },
  { key: '摘要', label: '摘要' },
  { key: '详情', label: '详情' },
];

export default function AuditLogsPage() {
  return (
    <CrudPage
      title="审计日志"
      subtitle="关键写操作（创建/更新/删除）留痕，仅系统内部记录，不可修改（需审计权限）"
      columns={COLUMNS}
      readonly
      hideCreate
      rangeFilters={[{ key: 'time', label: '操作时间', fromParam: 'from', toParam: 'to' }]}
      api={{
        list: (p) => api.listAuditLogs(p),
        create: async () => ({}),
        update: async () => ({}),
        archive: async () => ({}),
      }}
    />
  );
}
