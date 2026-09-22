'use client';

import { useEffect, useMemo, useState } from 'react';
import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

export default function MailArchivePage() {
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({});
  /** 可见的邮件账户（账户名称 + 邮箱地址），供「邮箱」列的筛选下拉用 */
  const [accounts, setAccounts] = useState<{ name: string; email: string }[]>([]);

  // 挂载时拉取筛选列的真实候选项（发件人/收件人/归属账户/邮箱文件夹/关联学生），
  // 注入到对应列的 filterOptions，使下拉框可选而非只剩「全部」。
  useEffect(() => {
    let alive = true;
    api
      .listMailArchiveFilterOptions()
      .then((opts) => {
        if (alive) setFilterOptions(opts ?? {});
      })
      .catch(() => {});
    // 「邮箱」列的候选来自**邮件账户配置**，不是归档记录里出现过的值 ——
    // 刚配好、还没收到邮件的账户也要能选到，否则老师会以为配置没生效。
    api
      .listMailArchiveAccountOptions()
      .then((list) => {
        if (alive) setAccounts(list ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const columns = useMemo(
    () =>
      COLUMNS.map((c) => {
        if (c.key === '邮箱') {
          // 下拉里显示邮箱地址、提交给后端的仍是账户名称（列上 filterParam='归属账户'）：
          // 归档记录里存的是账户名，拿邮箱去等值匹配会一条都筛不出来。
          return {
            ...c,
            filterOptions: accounts.map((a) => a.name),
            filterOptionLabels: Object.fromEntries(accounts.map((a) => [a.name, a.email || a.name])),
          };
        }
        return filterOptions[c.key] ? { ...c, filterOptions: filterOptions[c.key] } : c;
      }),
    [filterOptions, accounts],
  );

  return (
    <CrudPage
      moduleKey="mailArchive"
      title="邮件归档"
      subtitle="系统自动留存的招生与国外学校往来邮件（即使员工离职或邮箱删除，记录仍保留可查）。"
      search={{ placeholder: '搜索发件人 / 收件人 / 主题…' }}
      columns={columns}
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
