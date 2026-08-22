'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const 状态_OPTS = ['启用', '停用'];

const COLUMNS: CrudColumn[] = [
  { key: '配置键', label: '配置键', width: '200px', form: true, type: 'text' },
  { key: '配置值', label: '配置值', form: true, type: 'text' },
  { key: '分组', label: '分组', width: '120px', filter: true, filterType: 'text', form: true, type: 'text' },
  { key: '说明', label: '说明', form: true, type: 'text' },
  { key: '状态', label: '状态', width: '90px', filter: true, filterOptions: 状态_OPTS, form: true, type: 'select', options: 状态_OPTS },
];

export default function SettingsPage() {
  return (
    <CrudPage
      title="系统设置"
      subtitle="机构/教务/通知等全局配置项（key-value，仅管理员可写）"
      columns={COLUMNS}
      statusField="状态"
      inlineEdit
      search={{ placeholder: '配置键、配置值' }}
      api={{
        list: (p) => api.listSettings(p),
        create: (d) => api.createSetting(d),
        update: (id, d) => api.updateSetting(id, d),
        archive: (id) => api.archiveSetting(id),
      }}
    />
  );
}
