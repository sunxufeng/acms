'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

/** 重算结果/错误提示条（CrudPage 的 extraActions 没有反馈位，这里自己给一行） */
const noteStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  margin: '0 0 12px',
  padding: '8px 12px',
  fontSize: 'var(--font-sm)',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--bg-subtle, var(--bg-secondary))',
  color: 'var(--fg-secondary)',
};

export default function MailArchivePage() {
  const t = useTranslations('mailArchive');
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({});
  /** 可见的邮件账户（账户名称 + 邮箱地址），供「邮箱」列的筛选下拉用 */
  const [accounts, setAccounts] = useState<{ name: string; email: string }[]>([]);
  const [reconciling, setReconciling] = useState(false);
  const [note, setNote] = useState('');
  const [noteErr, setNoteErr] = useState(false);

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

  /**
   * 重算关联（幂等）：补「联系人 → 学生」「学生 → 联系人」的传递关联。
   *
   * 为什么需要手动入口：老师**手工改关联**时服务端已自动补（见 mail-archive.service 的 `link()`），
   * 但历史数据不会自己变 —— 尤其本次上线前老师是"直接在邮件上挂学生"，
   * 那些邮件的「关联联系人」是空的，需要跑一次才能对上。
   */
  const reconcile = useCallback(
    async (reload: () => void) => {
      setReconciling(true);
      setNote('');
      setNoteErr(false);
      try {
        const r = await api.reconcileMailLinks();
        setNote(t('reconcileDone', { scanned: r.scanned, fixed: r.fixed }));
        reload();
      } catch (e) {
        setNoteErr(true);
        setNote(t('reconcileFailed', { msg: String((e as Error)?.message ?? e) }));
      } finally {
        setReconciling(false);
      }
    },
    [t],
  );

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
    <>
      {note ? (
        <div style={{ ...noteStyle, ...(noteErr ? { borderColor: 'var(--danger, #E24B4A)' } : {}) }}>
          <span style={{ flex: 1 }}>{note}</span>
          <button className="btn-icon" onClick={() => setNote('')} title={t('closeNote')}>
            ×
          </button>
        </div>
      ) : null}
      <CrudPage
        moduleKey="mailArchive"
        title="邮件归档"
        subtitle="系统自动留存的招生与国外学校往来邮件（即使员工离职或邮箱删除，记录仍保留可查）。"
        search={{ placeholder: '搜索发件人 / 收件人 / 主题…' }}
        columns={columns}
        readonly
        hideCreate
        detailHref={(id) => `/mail-archive/${id}`}
        extraActions={[
          {
            label: reconciling ? '重算中…' : '重算关联',
            run: (reload) => reconcile(reload),
          },
        ]}
        api={{
          list: (p) => api.listMailArchive(p),
          create: async () => ({}),
          update: async () => ({}),
          archive: async () => ({ ok: true }),
        }}
      />
    </>
  );
}
