'use client';

import { useEffect, useState } from 'react';
import { api, type NoteStatsPayload } from '../../lib/api';

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtTime(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', background: 'var(--bg-elevated)' }}>
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{label}</div>
      <div style={{ fontSize: 'var(--font-xl, 20px)', fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function BarList({ items, unit }: { items: { label: string; count: number }[]; unit: string }) {
  if (items.length === 0) {
    return <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>所选时间段内没有记录</div>;
  }
  const max = Math.max(...items.map((i) => i.count));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((i) => (
        <div key={i.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 120, fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {i.label}
          </span>
          <div style={{ flex: 1, height: 10, background: 'var(--bg-hover)', borderRadius: 5, overflow: 'hidden' }}>
            <div style={{ width: `${(i.count / max) * 100}%`, height: '100%', background: 'var(--accent)' }} />
          </div>
          <span style={{ width: 56, textAlign: 'right', fontSize: 'var(--font-xs)' }}>
            {i.count} {unit}
          </span>
        </div>
      ))}
    </div>
  );
}

function ConfigList({ items }: { items: { source: string; count: number }[] }) {
  // 降序（后端已排，这里再兜一次，避免任何情况下顺序不一致）
  const sorted = [...items].sort((a, b) => b.count - a.count);
  const total = sorted.reduce((sum, i) => sum + i.count, 0);
  if (sorted.length === 0) {
    return <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>所选时间段内没有记录</div>;
  }
  const max = Math.max(...sorted.map((i) => i.count));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {sorted.map((i, idx) => (
        <div key={i.source} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 16, fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', textAlign: 'right' }}>
            {idx + 1}
          </span>
          <span
            title={i.source}
            style={{
              width: 104,
              fontSize: 'var(--font-xs)',
              color: 'var(--fg-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {i.source}
          </span>
          <div style={{ flex: 1, height: 10, background: 'var(--bg-hover)', borderRadius: 5, overflow: 'hidden' }}>
            <div style={{ width: `${(i.count / max) * 100}%`, height: '100%', background: 'var(--accent)' }} />
          </div>
          <span style={{ width: 84, textAlign: 'right', fontSize: 'var(--font-xs)' }}>
            {i.count} 篇（{total > 0 ? Math.round((i.count / total) * 100) : 0}%）
          </span>
        </div>
      ))}
    </div>
  );
}

export function NotesPanel() {
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(today());
  const [data, setData] = useState<NoteStatsPayload | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const load = async (f: string, t: string) => {
    setLoading(true);
    try {
      setData(await api.noteStats({ from: f, to: t }));
      setErr('');
    } catch (e) {
      setErr((e as Error).message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  const sync = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const r = await api.syncNoteSnapshot();
      setSyncMsg(r.ok ? `已同步 ${r.count} 篇笔记` : `同步失败：${r.message ?? '未知原因'}`);
      if (r.ok) await load(from, to);
    } catch (e) {
      setSyncMsg(`同步失败：${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    void load(from, to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <input type="date" className="form-input" value={from} onChange={(e) => setFrom(e.target.value)} style={{ fontSize: 'var(--font-sm)' }} />
        <span style={{ color: 'var(--fg-tertiary)' }}>至</span>
        <input type="date" className="form-input" value={to} onChange={(e) => setTo(e.target.value)} style={{ fontSize: 'var(--font-sm)' }} />
        <button className="btn btn-outline" disabled={loading} onClick={() => void load(from, to)}>
          {loading ? '查询中…' : '查询'}
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            const f = daysAgo(6);
            const t = today();
            setFrom(f);
            setTo(t);
            void load(f, t);
          }}
        >
          近 7 天
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            const f = daysAgo(29);
            const t = today();
            setFrom(f);
            setTo(t);
            void load(f, t);
          }}
        >
          近 30 天
        </button>
        <button className="btn btn-primary" disabled={syncing} onClick={() => void sync()}>
          {syncing ? '同步中…' : '立即同步笔记'}
        </button>
        {syncMsg ? (
          <span style={{ fontSize: 'var(--font-sm)', color: syncMsg.includes('失败') ? 'var(--fg-error)' : 'var(--fg-secondary)' }}>
            {syncMsg}
          </span>
        ) : null}
      </div>

      {err ? <div style={{ color: 'var(--fg-error)', fontSize: 'var(--font-sm)', marginBottom: '1rem' }}>{err}</div> : null}

      {!data ? (
        <div style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)' }}>加载中…</div>
      ) : (
        <>
          <div
            style={{
              fontSize: 'var(--font-xs)',
              color: 'var(--fg-tertiary)',
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '8px 12px',
              marginBottom: '1rem',
              lineHeight: 1.7,
            }}
          >
            口径：<b>新增笔记</b> = 笔记快照表里「笔记创建时间」落在区间内的笔记；<b>转换次数</b> = 区间内从笔记转成业务记录的次数。
            快照在管理员浏览笔记页时顺带更新（复用已拉取的数据，不额外消耗上游额度），
            最后同步：{fmtTime(data.syncedAt)}
            {data.syncedAt ? '' : '（还没有同步过 —— 用管理员账号打开一次「知识库」页即可）'}。
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: '1.25rem' }}>
            <Metric label="新增笔记" value={data.summary.newNotes} />
            <Metric label="转换次数" value={data.summary.converts} />
            <Metric label="涉及人数" value={data.summary.owners} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: '1.5rem', marginBottom: '1.5rem' }}>
            <div>
              <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500, marginBottom: 8 }}>按人（新增笔记）</div>
              <BarList items={data.byOwner.map((o) => ({ label: o.owner, count: o.newNotes }))} unit="篇" />
            </div>
            <div>
              <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500, marginBottom: 8 }}>按配置名称（笔记数）</div>
              <ConfigList items={data.bySource} />
            </div>
            <div>
              <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500, marginBottom: 8 }}>转换到哪些模块</div>
              <BarList items={data.byModule.map((m) => ({ label: m.module, count: m.count }))} unit="次" />
            </div>
            <div>
              <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500, marginBottom: 8 }}>谁转得最多（转换次数）</div>
              <BarList items={data.byConverter.map((c) => ({ label: c.converter, count: c.count }))} unit="次" />
            </div>
          </div>

          {data.byDay.length > 0 ? (
            <div>
              <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500, marginBottom: 8 }}>按天趋势</div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 80, overflowX: 'auto' }}>
                {data.byDay.map((d) => {
                  const max = Math.max(1, ...data.byDay.map((x) => x.newNotes + x.converts));
                  const total = d.newNotes + d.converts;
                  return (
                    <div key={d.date} style={{ minWidth: 10, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                      <div
                        title={`${d.date} 新增 ${d.newNotes} 篇 / 转换 ${d.converts} 次`}
                        style={{ width: '100%', height: Math.max(2, (total / max) * 54), background: 'var(--accent)', borderRadius: '2px 2px 0 0' }}
                      />
                      <span style={{ fontSize: '9px', color: 'var(--fg-tertiary)', writingMode: 'vertical-rl' }}>{d.date.slice(5)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
