'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const CHANNEL_OPTS = ['飞书', '短信', '邮件'];
const TPL_STATUS_OPTS = ['启用', '停用'];

const TPL_COLUMNS: CrudColumn[] = [
  { key: '模板名称', label: '模板名称', width: '150px', filter: true, form: true, required: true, type: 'text' },
  { key: '渠道', label: '渠道', width: '90px', filter: true, filterOptions: CHANNEL_OPTS, form: true, type: 'select', options: CHANNEL_OPTS },
  { key: '标题', label: '标题', width: '160px', form: true, type: 'text' },
  { key: '内容模板', label: '内容模板', form: true, type: 'textarea' },
  { key: '状态', label: '状态', width: '90px', filter: true, filterOptions: TPL_STATUS_OPTS, form: true, type: 'select', options: TPL_STATUS_OPTS },
  { key: '备注', label: '备注', form: true, type: 'text' },
];

export default function NotificationTemplatesPage() {
  return (
    <CrudPage
      title="通知模板"
      subtitle="通知模板"
      columns={TPL_COLUMNS}
      inlineEdit
      standaloneForm
      api={{
        list: (p) => api.listTemplates(p),
        create: (d) => api.createTemplate(d),
        update: (id, d) => api.updateTemplate(id, d),
        archive: (id) => api.archiveTemplate(id),
      }}
    />
  );
}
