'use client';

import { useRouter } from 'next/navigation';
import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

export default function MailAccountsPage() {
  const router = useRouter();
  return (
    <CrudPage
      title="邮件账户"
      subtitle="配置招生人员的邮箱 IMAP 接入（密码以 AES 加密入库）。系统每 15 分钟按频率自动收取，留存全部往来邮件。"
      search={{ placeholder: '搜索账户名称 / 归属人员…' }}
      columns={COLUMNS}
      inlineEdit
      standaloneForm
      extraActions={[
        {
          label: '同步全部启用账户',
          run: async (reload) => {
            await api.syncAllMail();
            await reload();
          },
        },
      ]}
      rowExtraActions={[
        {
          label: '立即收取',
          run: async (row, reload) => {
            await api.syncMailAccount(String(row.id));
            await reload();
          },
        },
      ]}
      api={{
        list: (p) => api.listMailAccounts(p),
        create: (d) => api.createMailAccount(d),
        update: (id, d) => api.updateMailAccount(id, d),
        archive: (id) => api.archiveMailAccount(id),
      }}
    />
  );
}
