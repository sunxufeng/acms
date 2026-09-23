'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/date';

/**
 * 归属人映射（招生管理 › 归属人映射，2026-09-24）。
 *
 * 一行 = 一个「卫瓴联系人表的归属人」→ 一个或多个 ACMS 用户。
 * 「我的跟进」用这张表决定**登录人能看到哪些联系人**（取代之前按姓名猜的做法）。
 *
 * 为什么必须显式配：卫瓴侧的归属人是
 * `致极学院-曹老师｜Dainel|1510` 这种**复合串**（机构前缀 + 称呼 + 英文名 + `|条数`），
 * 与我们系统里的用户姓名对不上、英文名还有错拼（Dainel/Daniel）。
 * 靠算法猜只是兜底，而**猜错等于让人看到别人的联系人**。
 *
 * ⚠️ 「卫瓴归属人」用**下拉**而不是自由文本：值必须与联系人表里的写法**完全一致**
 *    （多一个空格就筛不出数据），所以候选直接取联系人表的实际取值。
 * ⚠️ 「ACMS用户」用关联字段（存 record id）而非姓名 —— 重名不认姓名（全站一致的纪律）。
 */
export default function OwnerMappingsPage() {
  const t = useTranslations('ownerMapping');
  const [ownerOptions, setOwnerOptions] = useState<string[]>([]);
  const [userOptions, setUserOptions] = useState<{ value: string; label: string }[]>([]);

  useEffect(() => {
    // 归属人候选：联系人表里出现过的实际值（精确匹配用）
    api
      .listMyFollowupOwners()
      .then((l) => setOwnerOptions(l ?? []))
      .catch(() => {});
    // 用户候选：人员目录（全员可读、含 record id —— 关联字段要存的就是它）
    api
      .listUserDirectory()
      .then((l) => setUserOptions((l ?? []).map((u) => ({ value: u.id, label: u.name }))))
      .catch(() => {});
  }, []);

  const COLUMNS: CrudColumn[] = [
    {
      key: '卫瓴归属人',
      label: t('colOwner'),
      width: '260px',
      filter: true,
      filterOptions: ownerOptions,
      form: true,
      type: 'select',
      options: ownerOptions,
      required: true,
      hint: t('hintOwner'),
    },
    {
      key: 'ACMS用户',
      label: t('colUser'),
      width: '220px',
      form: true,
      type: 'link',
      linkMulti: true,
      linkOptions: userOptions,
      required: true,
      hint: t('hintUser'),
    },
    { key: '备注', label: t('colRemark'), width: '200px', form: true, type: 'text' },
    {
      key: '更新时间',
      label: t('colUpdated'),
      width: '150px',
      render: (v) => <span className="muted">{formatDateTime(v)}</span>,
    },
  ];

  return (
    <CrudPage
      title={t('title')}
      subtitle={t('subtitle')}
      columns={COLUMNS}
      moduleKey="ownerMappings"
      standaloneForm
      search={{ placeholder: t('search') }}
      api={{
        list: (p) => api.ownerMappings.list(p),
        create: (d) => api.ownerMappings.create(d),
        update: (id, d) => api.ownerMappings.update(id, d),
        archive: (id) => api.ownerMappings.archive(id),
      }}
    />
  );
}
