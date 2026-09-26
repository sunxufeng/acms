'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api, type NoteArchiveCheckResult, type NoteArchiveProgressItem } from '../../lib/api';
import {
  ARCHIVE_JOB_FIELDS as F,
  ARCHIVE_JOB_WEEKDAY_OPTIONS,
  JOB_FREQS,
  JOB_KINDS,
  JOB_KIND_NOTE_ARCHIVE,
  NOTE_ARCHIVE_KINDS,
  parseFolderToken,
} from '@acms/contracts';

const YES_NO = ['是', '否'];

/** 目标文件夹列：库里存的是 token，列表上显示短尾 + hover 看全（token 很长，全显会撑爆列宽） */
function folderCell(v: unknown): string {
  const t = String(v ?? '').trim();
  if (!t) return '—';
  return t.length > 12 ? `${t.slice(0, 6)}…${t.slice(-4)}` : t;
}

const COLUMNS: CrudColumn[] = [
  { key: F.任务名称, label: '任务名称', width: '140px', form: true, type: 'text', required: true, listOrder: 1 },
  {
    // 任务标识 = 行 id，是归档记录的外键 ⇒ 只读展示、不可改。
    // 改名（任务名称）不影响已归档判定，改标识会 —— 所以它压根不给编辑入口。
    key: 'id',
    label: '任务标识',
    width: '120px',
    listOrder: 2,
    render: (v) => String(v ?? '—'),
  },
  {
    key: F.启用,
    label: '启用',
    width: '70px',
    form: true,
    type: 'select',
    options: YES_NO,
    filter: true,
    filterOptions: YES_NO,
    hint: '停用后定时器不再自动跑；「运行」按钮仍可手动跑一次',
    listOrder: 3,
  },
  {
    // 2026-09-24 新增：任务类型（「定时任务」从"笔记归档专用"升级为通用调度器）
    key: F.任务类型,
    label: '任务类型',
    width: '140px',
    form: true,
    type: 'select',
    options: [...JOB_KINDS],
    filter: true,
    filterOptions: [...JOB_KINDS],
    hint: '到点执行什么。「目标文件夹 / 标题关键词 / 输出内容 / 按人分文件夹」只有「笔记归档」用得上',
    listOrder: 4,
  },
  {
    key: F.频率,
    label: '频率',
    width: '110px',
    form: true,
    type: 'select',
    options: [...JOB_FREQS],
    filter: true,
    filterOptions: [...JOB_FREQS],
    hint: '每天＝按「执行时间」的 HH:MM；每小时＝每小时的第 N 分（取「执行时间」的分钟）；每15分钟＝每小时 0/15/30/45 分',
    listOrder: 5,
  },
  {
    key: F.执行时间,
    label: '执行时间',
    width: '90px',
    form: true,
    type: 'text',
    required: true,
    hint: 'HH:MM，北京时间。频率=每小时时只用其中的「分钟」',
    listOrder: 6,
  },
  {
    key: F.执行日,
    label: '执行日',
    width: '150px',
    form: true,
    type: 'multiselect',
    options: ARCHIVE_JOB_WEEKDAY_OPTIONS,
    hint: '勾「每天」或留空 = 每天都跑',
    listOrder: 7,
  },
  {
    key: F.目标文件夹,
    label: '目标文件夹',
    width: '120px',
    form: true,
    type: 'text',
    // ⚠️ 不能在这里写 required：卫瓴同步 / 邮件收取两类任务没有这个概念，
    //    写了 required 那两类永远存不下去。必填改由下面的「按类型的保存校验」管。
    hint: '【仅「笔记归档」需要】可直接粘飞书文件夹链接（自动取 token），也可以填 26 位 token',
    listOrder: 8,
    render: (v) => <span title={String(v ?? '')}>{folderCell(v)}</span>,
  },
  {
    key: F.标题关键词,
    label: '标题关键词',
    width: '120px',
    form: true,
    type: 'text',
    hint: '标题包含它才归档（大小写不敏感）；留空 = 该任务归档全部有效笔记',
    listOrder: 9,
  },
  {
    key: F.输出内容,
    label: '输出内容',
    width: '120px',
    form: true,
    type: 'multiselect',
    options: [...NOTE_ARCHIVE_KINDS],
    hint: '【仅「笔记归档」需要】每篇出哪些文件；「无明细」指笔记本身没有原始记录（只有总结）',
    listOrder: 10,
  },
  {
    key: F.按人分文件夹,
    label: '按人分文件夹',
    width: '110px',
    form: true,
    type: 'select',
    options: YES_NO,
    hint: '【仅「笔记归档」需要】「否」表示所有文件平铺在目标文件夹根下',
    listOrder: 11,
  },
  {
    key: F.补跑窗口,
    label: '补跑窗口(小时)',
    width: '120px',
    form: true,
    type: 'number',
    hint: '到点后多少小时内仍算「今天这一次」——覆盖凌晨重启/宕机的补跑。默认 6（01:00 → 07:00）',
    listOrder: 12,
  },
  { key: F.上次运行, label: '上次运行', width: '130px', listOrder: 13 },
  { key: F.上次运行详情, label: '上次运行详情', listOrder: 14 },
];

/**
 * 保存前的**按类型**校验。
 *
 * 为什么不能靠 `column.required`：那是全类型共用的 —— 给「目标文件夹」标 required 之后，
 * 卫瓴同步 / 邮件收取两类任务永远存不下去（它们本来就没有这个字段的概念）。
 * 所以必填只在「笔记归档」这一支里判。
 */
function assertJobFields(d: Record<string, unknown>): void {
  const kind = String(d[F.任务类型] ?? JOB_KIND_NOTE_ARCHIVE);
  if (kind !== JOB_KIND_NOTE_ARCHIVE) return;
  if (!parseFolderToken(d[F.目标文件夹])) {
    throw new Error('「笔记归档」任务必须填目标文件夹（可粘飞书文件夹链接）');
  }
}

type Notice = { tone: 'info' | 'ok' | 'warn' | 'error'; text: string } | null;

const TONE_STYLE: Record<string, { bg: string; border: string; fg: string }> = {
  info: { bg: 'var(--bg-subtle)', border: 'var(--border)', fg: 'var(--fg-secondary)' },
  ok: { bg: 'rgba(22,163,74,.08)', border: 'rgba(22,163,74,.35)', fg: '#15803d' },
  warn: { bg: 'rgba(217,119,6,.10)', border: 'rgba(217,119,6,.35)', fg: '#b45309' },
  error: { bg: 'rgba(220,38,38,.08)', border: 'rgba(220,38,38,.35)', fg: '#b91c1c' },
};

export default function ScheduledTasksPage() {
  const [progress, setProgress] = useState<Record<string, NoteArchiveProgressItem>>({});
  const [check, setCheck] = useState<NoteArchiveCheckResult | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [checking, setChecking] = useState(false);
  /** 当前页的行（保存时用来对比「目标文件夹是否变了」）——由 `onRowsLoaded` 填充 */
  const rowsRef = useRef<Map<string, Record<string, unknown>>>(new Map());
  const timerRef = useRef<number | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setProgress(await api.noteArchiveStatus());
    } catch {
      /* 状态读不到不该让页面报错：任务本身在服务端跑，刷新一下列表就能看见结果 */
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    timerRef.current = window.setInterval(() => void refreshStatus(), 8000);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [refreshStatus]);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const r = await api.checkNoteArchive();
      setCheck(r);
      const problems = r.jobs.flatMap((j) => j.problems.map((p) => `${j.label}：${p}`));
      const bad = r.jobs.filter((j) => !j.folderOk);
      if (!r.tokenOk) {
        setNotice({ tone: 'error', text: `飞书用户令牌不可用：${r.tokenError}（归档会全部失败）` });
      } else if (problems.length) {
        setNotice({ tone: 'error', text: `配置有问题 —— ${problems.join('；')}` });
      } else if (bad.length) {
        setNotice({
          tone: 'error',
          text: `目标文件夹不可达：${bad.map((j) => `${j.label}（${j.folderError}）`).join('；')}`,
        });
      } else {
        const total = r.jobs.reduce((n, j) => n + j.pending, 0);
        setNotice({
          tone: 'ok',
          text: `体检通过：令牌可用，${r.jobs.length} 个任务的目标文件夹都可达，共 ${total} 篇待归档。`,
        });
      }
    } catch (e) {
      setNotice({ tone: 'error', text: `体检失败：${(e as Error).message}` });
    } finally {
      setChecking(false);
    }
  }, []);

  /**
   * 手动运行（停用的任务也能跑 —— 手动就是要立刻跑一次）。
   * **按任务类型分发**：笔记归档走归档接口，卫瓴同步 / 邮件收取走各自的手动同步接口 ——
   * 三类任务虽然共享同一张配置表，但执行体完全不同。
   */
  const runJob = useCallback(async (id: string, label: string, kind: string) => {
    const isArchive = kind === JOB_KIND_NOTE_ARCHIVE;
    const ok = window.confirm(
      isArchive
        ? `立刻运行「${label}」？\n\n会归档所有尚未归档的匹配笔记；已经归档过的会自动跳过。\n运行期间可以离开本页 —— 跑完后「上次运行」两列会更新。`
        : `立刻执行一次「${label}」？\n\n执行期间可以离开本页 —— 跑完后「上次运行」两列会更新。`,
    );
    if (!ok) return;
    setNotice({ tone: 'info', text: `已触发「${label}」…` });
    try {
      if (kind === '卫瓴联系人同步') {
        const r = await api.weilingSync(false);
        setNotice({
          tone: r.ok ? 'ok' : 'warn',
          text: r.ok ? `卫瓴同步完成：${r.count} 条联系人` : `未执行：${r.message ?? '未知原因'}`,
        });
      } else if (kind === '邮件收取') {
        const r = await api.syncAllMail();
        setNotice({ tone: 'ok', text: `已触发 ${r.synced} 个账户收取（各账户仍按自己的「收取频率」节流）` });
      } else if (kind === '知识库同步') {
        const r = await api.syncAllNoteSources();
        setNotice({
          tone: 'ok',
          text: `已检查知识库配置：触发 ${r.synced} 个，跳过 ${r.skipped} 个（每条配置仍按自己的「收取频率」节流）`,
        });
      } else {
        const p = await api.runNoteArchiveJob(id);
        setProgress((m) => ({ ...m, [id]: p }));
        setNotice({ tone: 'info', text: `已触发「${label}」，正在归档…（进度每 8 秒刷新一次）` });
      }
    } catch (e) {
      setNotice({ tone: 'error', text: `运行失败：${(e as Error).message}` });
    }
  }, []);

  /**
   * 补归档：清掉该任务的「已归档」记录并重跑一次。
   *
   * 什么时候用：**换过目标文件夹之后** —— 归档记录会让同批笔记在新文件夹里永远不再出现
   * （判据是记录，不是"云盘里有没有文件"）。只删记录、不动云盘上的文件。
   */
  const resyncJob = useCallback(async (id: string, label: string) => {
    const ok = window.confirm(
      `「${label}」补归档 —— 清掉它的归档记录并重新归档一次？\n\n` +
        `· 用途：目标文件夹换过之后，让之前归档过的笔记也进新文件夹\n` +
        `· 代价：该任务匹配的全部笔记会再走一遍（已存在的同名文件自动跳过）\n` +
        `· 云盘上旧文件夹里的文件不会被删除`,
    );
    if (!ok) return;
    setNotice({ tone: 'warn', text: `正在清「${label}」的归档记录并重新归档…` });
    try {
      const r = await api.resetNoteArchiveJob(id, true);
      setNotice({ tone: 'ok', text: `「${label}」：已清掉 ${r.cleared} 条归档记录，重新归档已开始。` });
      if (r.progress) setProgress((m) => ({ ...m, [id]: r.progress as NoteArchiveProgressItem }));
    } catch (e) {
      setNotice({ tone: 'error', text: `补归档失败：${(e as Error).message}` });
    }
  }, []);

  const running = Object.values(progress).filter((p) => p?.running);
  const lastDone = Object.values(progress)
    .filter((p): p is NoteArchiveProgressItem => !!p && !p.running && !!p.finishedAt)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
  const tone = TONE_STYLE[notice?.tone ?? 'info'] ?? TONE_STYLE.info;

  /** 进度 / 体检结果条（跑起来时是唯一需要盯的地方） */
  const banner =
    running.length || notice ? (
      <div
        style={{
          margin: '0 0 12px',
          padding: '8px 12px',
          border: `1px solid ${notice ? tone.border : 'var(--border)'}`,
          background: notice ? tone.bg : 'var(--bg-subtle)',
          color: notice ? tone.fg : 'var(--fg-secondary)',
          borderRadius: 8,
          fontSize: 'var(--font-sm)',
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        {running.map((p) => (
          <span key={p.job}>
            ⏳ <b>{p.label}</b> 运行中：候选 {p.total}，已处理 {p.done}
            {p.total ? `/${p.total}` : ''}，上传 {p.uploaded}，跳过 {p.skipped}，失败 {p.failed}
          </span>
        ))}
        {notice ? <span>{notice.text}</span> : null}
      </div>
    ) : null;

  return (
    <>
      {banner}
      <CrudPage
        moduleKey="scheduledTasks"
        title="定时任务"
        subtitle="到点自动执行的任务都在这里配：笔记归档 / 卫瓴联系人同步 / 邮件收取。改「任务类型 + 频率 + 执行时间」即可，改完下一分钟生效；立刻跑一次用操作列的「运行」。"
        columns={COLUMNS}
        pageSize={20}
        inlineEdit
        standaloneForm
        api={{
          list: (p) => api.listScheduledTasks(p),
          create: (d) => {
            assertJobFields(d as Record<string, unknown>);
            return api.createScheduledTask(d);
          },
          /**
           * 保存前后对比「目标文件夹」：换过文件夹 ⇒ 之前已归档的笔记不会自动出现在新文件夹里
           * （判据是归档记录，不是"云盘里有没有文件"），所以当场问一句要不要**补归档**。
           * 峰哥定的口径是「提示我，我来定」—— 不自动重传 763 篇。
           */
          update: async (id, d) => {
            assertJobFields(d as Record<string, unknown>);
            const before = rowsRef.current.get(id);
            const beforeToken = parseFolderToken(before?.[F.目标文件夹]);
            const afterToken = parseFolderToken(d[F.目标文件夹]);
            const res = await api.updateScheduledTask(id, d);
            const kindAfter = String(d[F.任务类型] ?? JOB_KIND_NOTE_ARCHIVE);
            if (kindAfter === JOB_KIND_NOTE_ARCHIVE && beforeToken !== afterToken && afterToken) {
              const label = String(d[F.任务名称] ?? '该任务');
              const yes = window.confirm(
                `「${label}」的目标文件夹已改变。\n\n` +
                  `之前已归档的笔记不会自动出现在新文件夹里（判据是"已归档记录"，不是云盘里有没有文件）。\n\n` +
                  `要现在补归档吗？—— 会清掉该任务的归档记录并重新归档一次\n` +
                  `（已存在的同名文件自动跳过；旧文件夹里的文件不会被删除）。\n\n` +
                  `选「取消」则只保存配置，稍后可以用操作列的「补归档」再做。`,
              );
              if (yes) await resyncJob(id, label);
            }
            return res;
          },
          archive: (id) => api.archiveScheduledTask(id),
        }}
        extraActions={[{ label: checking ? '体检中…' : '体检', run: () => runCheck() }]}
        onRowsLoaded={(rows) => {
          const m = new Map<string, Record<string, unknown>>();
          for (const r of rows) m.set(String(r.id ?? ''), r);
          rowsRef.current = m;
        }}
        // 操作列的「运行」/「补归档」（CrudPage 只在非只读模式渲染本插槽）
        rowActionSlot={(row) => {
          const id = String(row.id ?? '');
          const label = String(row[F.任务名称] ?? id);
          const kind = String(row[F.任务类型] ?? JOB_KIND_NOTE_ARCHIVE);
          const isArchive = kind === JOB_KIND_NOTE_ARCHIVE;
          const p = progress[id];
          const isRunning = !!p?.running;
          // 「待归档」「补归档」只对笔记归档有意义：另两类没有"归档记录"这个概念
          const pending = isArchive ? check?.jobs.find((j) => j.id === id)?.pending : undefined;
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={isRunning}
                title={isRunning ? '正在跑，跑完可再点' : '立刻跑一次（已归档的自动跳过）'}
                onClick={() => void runJob(id, label, kind)}
              >
                {isRunning ? '运行中…' : '运行'}
              </button>
              {isArchive ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={isRunning}
                  title="清掉该任务的归档记录并重新归档（换过目标文件夹后用）"
                  onClick={() => void resyncJob(id, label)}
                >
                  补归档
                </button>
              ) : null}
              {typeof pending === 'number' && !isRunning ? (
                <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>待 {pending}</span>
              ) : null}
            </span>
          );
        }}
      />
      {!running.length && lastDone ? (
        <div style={{ margin: '8px 0 0', fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
          最近一次完成：<b>{lastDone.label}</b> — 候选 {lastDone.total}，上传 {lastDone.uploaded}，跳过{' '}
          {lastDone.skipped}，无明细 {lastDone.noDetail}，失败 {lastDone.failed}
          {lastDone.error ? `，错误：${lastDone.error}` : ''}
        </div>
      ) : null}
    </>
  );
}
