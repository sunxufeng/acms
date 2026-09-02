'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import CrudPage from '../../components/CrudPage';
import { api, type MailSyncProgress } from '../../lib/api';
import { COLUMNS } from './columns';

export default function MailAccountsPage() {
  const router = useRouter();
  const [sync, setSync] = useState<MailSyncProgress | null>(null);
  const [syncName, setSyncName] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 卸载时清掉轮询，避免组件销毁后还在 setState
  useEffect(() => stopPolling, [stopPolling]);

  /**
   * 触发收取后立即返回，后台轮询进度。
   * 大邮箱数百封要收几分钟，同步等待会被 nginx 掐断成 504，所以这里只负责触发+跟踪。
   */
  const startSync = useCallback(
    async (id: string, name: string, reload: () => void) => {
      stopPolling();
      setSyncName(name);
      const first = await api.syncMailAccount(id);
      setSync(first);
      if (!first.running) {
        await reload();
        return;
      }
      timerRef.current = setInterval(async () => {
        try {
          const p = await api.getMailSyncStatus(id);
          setSync(p);
          if (!p.running) {
            stopPolling();
            await reload();
          }
        } catch {
          stopPolling(); // 查询失败就不再轮询，避免刷屏报错
        }
      }, 2000);
    },
    [stopPolling],
  );

  return (
    <>
      {sync && (
        <div
          className="mb-4 rounded-lg border px-4 py-3 text-sm"
          style={{
            borderColor: sync.running ? 'var(--accent)' : (sync.error ? 'var(--danger)' : 'var(--success)'),
            background: sync.running ? 'var(--accent-muted)' : (sync.error ? 'var(--danger-muted)' : 'var(--success-muted)'),
            color: 'var(--fg)',
          }}
        >
          <div className="font-medium">
            {sync.running ? `正在收取「${syncName}」…` : `「${syncName}」收取完成`}
          </div>
          <div className="mt-1 text-xs" style={{ color: 'var(--fg-tertiary)' }}>
            已读取 {sync.fetched} 封，新增 {sync.stored} 封
            {sync.folders?.length
              ? `　|　${sync.folders
                  .map((f) => `${f.isSent ? '发件箱' : '收件箱'}(${f.folder}) ${f.fetched} 封/新增 ${f.stored}`)
                  .join('；')}`
              : ''}
          </div>
          {sync.error && <div className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>失败：{sync.error}</div>}
          {!sync.running && sync.result && (
            <div className="mt-1 text-xs" style={{ color: 'var(--fg-tertiary)' }}>
              {sync.result}
            </div>
          )}
        </div>
      )}
      <CrudPage
        title="邮件账户"
        subtitle="邮件账户"
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
              await startSync(String(row.id), String(row['账户名称'] ?? ''), reload);
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
    </>
  );
}
