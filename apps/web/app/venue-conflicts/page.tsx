'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';

/**
 * 教室冲突（教学管理 › 教室冲突，2026-10-03）。
 *
 * 聚合排课课次，按「场地文本 + 课次日期 + 开始时间」分组，找出同一时间同一场地被多个教学班
 * 占用的冲突。纯前端聚合，复用现有 `listSessions` 接口。与「排课课次」页的预检
 * （/schedule/conflicts:precheck，新建前单条校验）互补：本页是全局冲突巡检。
 */
interface SessionRow {
  场地文本?: string;
  课次日期?: string;
  开始时间?: string;
  结束时间?: string;
  教学班文本?: string;
  课次名称?: string;
  授课教师文本?: string;
  [k: string]: unknown;
}

interface ConflictGroup {
  key: string;
  venue: string;
  date: string;
  start: string;
  sessions: SessionRow[];
}

export default function VenueConflictsPage() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .listSessions({ pageSize: '500' })
      .then((res) => {
        if (!active) return;
        setRows((res?.items as SessionRow[]) ?? []);
        setError(null);
      })
      .catch((e) => {
        if (!active) return;
        setError(e?.message ?? '加载失败');
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const conflicts = useMemo<ConflictGroup[]>(() => {
    const map = new Map<string, SessionRow[]>();
    for (const r of rows) {
      const venue = (r.场地文本 ?? '').trim();
      const date = (r.课次日期 ?? '').trim();
      const start = (r.开始时间 ?? '').trim();
      if (!venue || !date || !start) continue;
      const key = `${venue}|${date}|${start}`;
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    return Array.from(map.entries())
      .map(([key, ss]) => {
        const [venue, date, start] = key.split('|');
        return { key, venue, date, start, sessions: ss };
      })
      .filter((g) => g.sessions.length > 1)
      .sort((a, b) => b.sessions.length - a.sessions.length);
  }, [rows]);

  const totalConflicting = conflicts.reduce((s, g) => s + g.sessions.length, 0);

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>教室冲突</h1>
      <p style={{ color: 'var(--muted, #888)', marginBottom: 16 }}>
        同一时间同一场地的多教学班占用冲突巡检。共 {conflicts.length} 处冲突、{totalConflicting} 个课次。
      </p>

      {loading && <p style={{ color: 'var(--muted, #888)' }}>加载中…</p>}
      {error && <p style={{ color: '#e5484d' }}>加载失败：{error}</p>}
      {!loading && !error && conflicts.length === 0 && (
        <p style={{ color: 'var(--muted, #888)' }}>未发现教室时间冲突。</p>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        {conflicts.map((g) => (
          <div
            key={g.key}
            style={{
              border: '1px solid var(--border, #2a2a2a)',
              borderRadius: 10,
              padding: 14,
              background: 'var(--card, #161616)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <strong>
                {g.venue} · {g.date} · {g.start}
              </strong>
              <span style={{ color: '#e5484d', fontWeight: 600 }}>{g.sessions.length} 个课次</span>
            </div>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--muted, #888)', textAlign: 'left' }}>
                  <th style={{ padding: '4px 8px' }}>教学班</th>
                  <th style={{ padding: '4px 8px' }}>课次名称</th>
                  <th style={{ padding: '4px 8px' }}>授课教师</th>
                  <th style={{ padding: '4px 8px' }}>结束时间</th>
                </tr>
              </thead>
              <tbody>
                {g.sessions.map((s, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border, #222)' }}>
                    <td style={{ padding: '4px 8px' }}>{s.教学班文本 ?? '-'}</td>
                    <td style={{ padding: '4px 8px' }}>{s.课次名称 ?? '-'}</td>
                    <td style={{ padding: '4px 8px' }}>{s.授课教师文本 ?? '-'}</td>
                    <td style={{ padding: '4px 8px' }}>{s.结束时间 ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
