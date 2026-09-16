'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import CrudPage from '../../../components/CrudPage';
import { api, type SourceSyncProgress, type RefetchBodiesProgress } from '../../../lib/api';
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
  /** 「重新收取」正文的进度（与「立即收取」分开：那个只拉列表，这个逐条拉正文） */
  const [bodyJob, setBodyJob] = useState<RefetchBodiesProgress | null>(null);
  const bodyTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (bodyTimerRef.current) {
      clearInterval(bodyTimerRef.current);
      bodyTimerRef.current = null;
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

  /**
   * 「重新收取」：把该知识库配置下的笔记**正文**（智能总结 + 原始记录）逐条拉回并落库。
   *
   * 为什么必须异步 + 轮询：上游限速 QPS 2，一条 0.6 秒；一个配置几十上百条要几分钟，
   * 同步等会被 nginx 掐成 504。后端同样是「POST 立即返回 + 这里轮询」的范式。
   * 幂等：按笔记 ID upsert，重复点不会重复入库（但会重复消耗上游额度，故按钮加确认）。
   */
  const startRefetchBodies = useCallback(
    async (id: string, name: string, reload: () => void) => {
      if (bodyTimerRef.current) {
        clearInterval(bodyTimerRef.current);
        bodyTimerRef.current = null;
      }
      setTest(null);
      setSyncName(name);
      const first = await api.refetchNoteBodies(id);
      setBodyJob(first);
      if (!first.running) {
        await reload();
        return;
      }
      bodyTimerRef.current = setInterval(async () => {
        try {
          const p = await api.getRefetchBodiesStatus();
          setBodyJob(p);
          if (!p.running) {
            if (bodyTimerRef.current) clearInterval(bodyTimerRef.current);
            bodyTimerRef.current = null;
            await reload();
          }
        } catch {
          if (bodyTimerRef.current) clearInterval(bodyTimerRef.current);
          bodyTimerRef.current = null;
        }
      }, 2000);
    },
    [],
  );

  return (
    <>
      {bodyJob && (
        <Banner
          tone={bodyJob.running ? 'running' : bodyJob.error ? 'error' : 'ok'}
          title={
            bodyJob.running
              ? t('refetching', { name: syncName })
              : t('refetchDone', { name: syncName })
          }
          detail={
            bodyJob.error
              ? `${t('failed')}：${bodyJob.error}`
              : `已处理 ${bodyJob.done} / ${bodyJob.total} · 正文入库 ${bodyJob.stored} ｜ 空正文 ${bodyJob.skipped} ｜ 失败 ${bodyJob.failed}`
          }
        />
      )}
      {sync && (        <Banner
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
        moduleKey="getnoteSources"
        title={t('title')}
        subtitle={t('subtitle')}
        search={{ placeholder: t('searchPlaceholder') }}
        columns={COLUMNS}
        inlineEdit
        standaloneForm
        formExtraActions={[
          {
            label: t('testConnect'),
            run: async (values) => {
              const r = await api.testGetnoteSourceCred({
                apiKey: String(values.apiKey ?? ''),
                clientId: String(values.clientId ?? ''),
                笔记类型: String(values.笔记类型 ?? ''),
              });
              return { ok: r.ok, text: r.note || (r.ok ? t('testOk') : t('testFailed')) };
            },
          },
        ]}
        rowExtraActions={[
          {
            label: t('syncNow'),
            run: async (row, reload) => {
              await startSync(String(row.id), String(row['配置名称'] ?? ''), reload);
            },
          },
          {
            label: t('refetchBodies'),
            run: async (row, reload) => {
              await startRefetchBodies(String(row.id), String(row['配置名称'] ?? ''), reload);
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
