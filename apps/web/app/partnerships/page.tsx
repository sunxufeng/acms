'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const STATUS_OPTS = ['生效中', '已结束', '暂停'];
const METHOD_OPTS = ['按课时', '按月', '打包'];

const COLUMNS: CrudColumn[] = [
  { key: '教师文本', label: '教师', width: '120px', filter: true, form: true, required: true, type: 'text' },
  { key: '合作机构文本', label: '合作机构', width: '140px', form: true, type: 'text' },
  { key: '计费方式', label: '计费方式', width: '100px', filter: true, filterOptions: METHOD_OPTS, form: true, type: 'select', options: METHOD_OPTS },
  { key: '费率', label: '费率', width: '90px', form: true, type: 'number' },
  { key: '计费规则说明', label: '计费规则', form: true, type: 'textarea' },
  { key: '生效开始', label: '生效开始', width: '130px', form: true, type: 'date' },
  { key: '生效结束', label: '生效结束', width: '130px', form: true, type: 'date' },
  { key: '合作状态', label: '状态', width: '100px', filter: true, filterOptions: STATUS_OPTS, form: true, type: 'select', options: STATUS_OPTS },
  { key: '备注', label: '备注', form: true, type: 'text' },
];

export default function PartnershipsPage() {
  return (
    <CrudPage
      title="聘用合作关系"
      subtitle="外聘教师合作关系与计费规则（M3 计费配置）"
      columns={COLUMNS}
      api={{
        list: (p) => api.listPartnerships(p),
        create: (d) => api.createPartnership(d),
        update: (id, d) => api.updatePartnership(id, d),
        archive: (id) => api.archivePartnership(id),
      }}
    />
  );
}
