'use client';

import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

export default function MailArchivePage() {
  return (
    <CrudPage
      title="邮件归档"
      subtitle="系统自动留存的招生与国外学校往来邮件（即使员工离职或邮箱删除，记录仍保留可查）。"
      search={{ placeholder: '搜索发件人 / 收件人 / 主题…' }}
      columns={COLUMNS}
      readonly
      hideCreate
      detailHref={(id) => `/mail-archive/${id}`}
      api={{
        list: (p) => api.listMailArchive(p),
        create: async () => ({}),
        update: async () => ({}),
        archive: async () => ({ ok: true }),
      }}
    />
  );
}
