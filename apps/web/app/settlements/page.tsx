'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const STATUS_OPTS = ['草拟', '已提交', '审批中', '已批准', '已关闭'];

const TRANSITIONS: Record<string, string[]> = {
  草拟: ['已提交'],
  已提交: ['审批中'],
  审批中: ['已批准'],
  已批准: ['已关闭'],
};

const COLUMNS: CrudColumn[] = [
  { key: '结算周期', label: '结算周期', width: '120px', filter: true, form: true, required: true, type: 'text' },
  { key: '结算主体', label: '结算主体', width: '140px', form: true, type: 'text' },
  { key: '明细数量', label: '明细数', width: '90px', form: true, type: 'number' },
  { key: '总金额', label: '总金额', width: '110px', form: true, type: 'number' },
  { key: '结算状态', label: '状态', width: '100px', filter: true, filterOptions: STATUS_OPTS, form: true, type: 'select', options: STATUS_OPTS },
  { key: '审批人', label: '审批人', width: '110px', form: true, type: 'text' },
  { key: '审批意见', label: '审批意见', form: true, type: 'textarea' },
  { key: '备注', label: '备注', form: true, type: 'text' },
];

export default function SettlementsPage() {
  return (
    <CrudPage
      title="月度结算"
      subtitle="按周期聚合已确认计费，状态机审批后关闭锁定金额（SoD 审批，M3 计费）"
      columns={COLUMNS}
      inlineEdit
      api={{
        list: (p) => api.listSettlements(p),
        create: (d) => api.createSettlement(d),
        update: (id, d) => api.updateSettlement(id, d),
        archive: (id) => api.archiveSettlement(id),
        transition: (id, to) => api.transitionSettlement(id, to),
      }}
      statusField="结算状态"
      transitions={TRANSITIONS}
      extraActions={[
        {
          label: '按周期聚合',
          run: async (reload) => {
            const period = window.prompt('输入结算周期（如 2026-08）：');
            if (!period?.trim()) return;
            const subject = window.prompt('结算主体（可选）：') || '';
            await api.aggregateSettlement({ 结算周期: period.trim(), 结算主体: subject });
            await reload();
          },
        },
      ]}
    />
  );
}
