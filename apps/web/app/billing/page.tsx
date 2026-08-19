'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const STATUS_OPTS = ['待生成', '待确认', '已确认', '已纳入结算'];

const TRANSITIONS: Record<string, string[]> = {
  待生成: ['待确认'],
  待确认: ['已确认'],
  已确认: ['已纳入结算'],
};

const COLUMNS: CrudColumn[] = [
  { key: '教学班文本', label: '教学班', width: '150px', form: true, type: 'text' },
  { key: '教师文本', label: '教师', width: '110px', filter: true, form: true, type: 'text' },
  { key: '计费周期', label: '计费周期', width: '110px', filter: true, form: true, type: 'text' },
  { key: '课时数量', label: '课时', width: '80px', form: true, type: 'number' },
  { key: '单价', label: '单价', width: '90px', form: true, type: 'number' },
  { key: '金额', label: '金额', width: '100px', form: true, type: 'number' },
  { key: '计费状态', label: '状态', width: '110px', filter: true, filterOptions: STATUS_OPTS, form: true, type: 'select', options: STATUS_OPTS },
  { key: '来源课次文本', label: '来源课次', form: true, type: 'text' },
  { key: '备注', label: '备注', form: true, type: 'text' },
];

export default function BillingPage() {
  return (
    <CrudPage
      title="计费明细"
      subtitle="基于已审核履约 + 有效合作关系生成计费（BR-008 快照固化），月度结算纳入（M3 计费）"
      columns={COLUMNS}
      inlineEdit
      api={{
        list: (p) => api.listBilling(p),
        create: (d) => api.createBilling(d),
        update: (id, d) => api.updateBilling(id, d),
        archive: (id) => api.archiveBilling(id),
        transition: (id, to) => api.transitionBilling(id, to),
      }}
      statusField="计费状态"
      transitions={TRANSITIONS}
      extraActions={[
        {
          label: '从履约生成',
          run: async (reload) => {
            const id = window.prompt('输入教师履约记录 ID（教师履约记录表）：');
            if (!id?.trim()) return;
            await api.generateBilling(id.trim());
            await reload();
          },
        },
      ]}
    />
  );
}
