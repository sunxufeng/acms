'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import CrudPage from '../../../components/CrudPage';
import { api, type SourceSyncProgress } from '../../../lib/api';
import { useTranslations } from 'next-intl';
import { COLUMNS } from './columns';

/** 提示条：同步进度 / 测试连接结果，两者共用一套样式 */
function Banner({
  tone,
  title,
  detail,
}: {
  tone: 'running' | 'ok' | 'error';
  title: string;
  detail?: string;
}) {
  const color = tone === 'running' ? 'var(--accent)' : tone === 'error' ? 'var(--danger)' : 'var(--success)';
  const bg =
    tone === 'running' ? 'var(--accent-muted)' : tone === 'error' ? 'var(--danger-muted)' : 'var(--success-muted)';
  return (
    <div
      className="mb-4 rounded-lg border px-4 py-3 text-sm"
      style={{ borderColor: color, background: bg, color: 'var(--fg)' }}
    >
      <div className="font-medium">{title}</div>
      {detail && (
        <div className="mt-1 text-xs" style={{ color: 'var(--fg-tertiary)' }}>
          {detail}
        </div>
      )}
    </div>
  );
}

export default function GetnoteSourcesPage() {
  const t = useTranslations('getnoteSources');

  const [sync, setSync] = useState<SourceSyncProgress | null>(null);
  const [syncName, setSyncName] = useState('');
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  /**
   * 立即收取：POST 立即返回，后台跑，这里轮询进度。
   * 大笔记库翻页要几十秒到几分钟，同步等会被 nginx 掐成 504，所以必须异步化。
   */
  const startSync = useCallback(
    async (id: string, name: string, reload: () => void) => {
      stopPolling();
      setTest(null);
      setSyncName(name);
      const first = await api.syncGetnoteSource(id);
      setSync(first);
      if (!first.running) {
        await reload();
        return;
      }
      timerRef.current = setInterval(async () => {
        try {
          const p = await api.getGetnoteSourceSyncStatus(id);
          setSync(p);
          if (!p.running) {
            stopPolling();
            await reload();
          }
        } catch {
          stopPolling(); // 查不到就不再轮询，避免刷屏报错
        }
      }, 2000);
    },
    [stopPolling],
  );

  return (
    <>
      {sync && (
        <Banner
          tone={sync.running ? 'running' : sync.error ? 'error' : 'ok'}
          title={sync.running ? t('syncing', { name: syncName }) : t('syncDone', { name: syncName })}
          detail={
            sync.error
              ? `${t('failed')}：${sync.error}`
              : sync.result || `已处理 ${sync.stored} / 拉取 ${sync.fetched} 条`
          }
        />
      )}
      {test && (
        <Banner tone={test.ok ? 'ok' : 'error'} title={test.ok ? t('testOk') : t('testFailed')} detail={test.text} />
      )}
      <CrudPage
        title={t('title')}
        subtitle={t('subtitle')}
        search={{ placeholder: t('searchPlaceholder') }}
        columns={COLUMNS}
        inlineEdit
        standaloneForm
        rowExtraActions={[
          {
            label: t('syncNow'),
            run: async (row, reload) => {
              await startSync(String(row.id), String(row['配置名称'] ?? ''), reload);
            },
          },
          {
            label: t('testConnect'),
            run: async (row) => {
              setSync(null);
              const r = await api.testGetnoteSource(String(row.id));
              setTest({ ok: r.ok, text: r.note || (r.ok ? t('testOk') : t('testFailed')) });
            },
          },
        ]}
        api={{
          list: (p) => api.listGetnoteSources(p),
          create: (d) => api.createGetnoteSource(d),
          update: (id, d) => api.updateGetnoteSource(id, d),
          archive: (id) => api.archiveGetnoteSource(id),
        }}
      />
    </>
  );
}
