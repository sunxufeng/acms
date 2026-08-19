'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const STATUS_OPTS = ['待审核', '已审核'];
const DIR_OPTS = ['调整', '冲销'];

const TRANSITIONS: Record<string, string[]> = {
  待审核: ['已审核'],
};

const COLUMNS: CrudColumn[] = [
  { key: '关联结算文本', label: '关联结算', width: '150px', filter: true, form: true, type: 'text' },
  { key: '关联计费文本', label: '关联计费', width: '150px', form: true, type: 'text' },
  { key: '方向', label: '方向', width: '90px', filter: true, filterOptions: DIR_OPTS, form: true, required: true, type: 'select', options: DIR_OPTS },
  { key: '金额', label: '金额', width: '100px', form: true, type: 'number' },
  { key: '状态', label: '状态', width: '90px', filter: true, filterOptions: STATUS_OPTS, form: true, type: 'select', options: STATUS_OPTS },
  { key: '原因', label: '原因', form: true, type: 'textarea' },
  { key: '审核人', label: '审核人', width: '110px', form: true, type: 'text' },
  { key: '备注', label: '备注', form: true, type: 'text' },
];

export default function AdjustmentsPage() {
  return (
    <CrudPage
      title="调整冲销"
      subtitle="对结算/计费发起调整或冲销，引用原记录、净额可回溯；审核人与发起人分离（SoD，M3 计费）"
      columns={COLUMNS}
      inlineEdit
      standaloneForm
      api={{
        list: (p) => api.listAdjustments(p),
        create: (d) => api.createAdjustment(d),
        update: (id, d) => api.updateAdjustment(id, d),
        archive: (id) => api.archiveAdjustment(id),
        transition: (id, to) => api.transitionAdjustment(id, to),
      }}
      statusField="状态"
      transitions={TRANSITIONS}
    />
  );
}
