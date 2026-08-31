'use client';

import { useEffect, useMemo, useState } from 'react';
import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

export default function MailArchivePage() {
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({});

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
    return () => {
      alive = false;
    };
  }, []);

  const columns = useMemo(
    () => COLUMNS.map((c) => (filterOptions[c.key] ? { ...c, filterOptions: filterOptions[c.key] } : c)),
    [filterOptions],
  );

  return (
    <CrudPage
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
