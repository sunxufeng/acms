'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';

/**
 * 考勤预警（学生闭环 › 考勤预警，2026-10-03）。
 *
 * 聚合学生考勤记录，按「关联学生编号」分组，统计非正常考勤（迟到 / 缺勤 / 异常等），
 * 帮助班主任与学务快速定位需要关注的学生。纯前端聚合，复用现有 `listStudentAttendances` 接口。
 *
 * 判定口径：考勤状态不在「正常 / 出勤 / 已出勤 / 准时报到」集合内即视为需关注。
 * 若实际字段取值不同，调整本页 `NORMAL_STATUS` 即可。
 */
const NORMAL_STATUS = new Set(['正常', '出勤', '已出勤', '准时报到']);

interface AttendanceRow {
  关联学生编号?: string;
  考勤日期?: string;
  考勤状态?: string;
  考勤结果?: string;
  异常描述?: string;
  [k: string]: unknown;
}

interface StudentAlert {
  student: string;
  rows: AttendanceRow[];
}

export default function AttendanceAlertsPage() {
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .listStudentAttendances({ pageSize: '500' })
      .then((res) => {
        if (!active) return;
        const list = (res?.items as AttendanceRow[]) ?? [];
        setRows(list);
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

  const alerts = useMemo<StudentAlert[]>(() => {
    const map = new Map<string, AttendanceRow[]>();
    for (const r of rows) {
      const st = (r.考勤状态 ?? '').trim();
      if (st && !NORMAL_STATUS.has(st)) {
        const key = r.关联学生编号 ?? '未关联学生';
        const arr = map.get(key) ?? [];
        arr.push(r);
        map.set(key, arr);
      }
    }
    return Array.from(map.entries())
      .map(([student, rs]) => ({ student, rows: rs }))
      .sort((a, b) => b.rows.length - a.rows.length);
  }, [rows]);

  const totalAbnormal = alerts.reduce((s, a) => s + a.rows.length, 0);

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>考勤预警</h1>
      <p style={{ color: 'var(--muted, #888)', marginBottom: 16 }}>
        按学生聚合非正常考勤（迟到 / 缺勤 / 异常）。共 {alerts.length} 名学生、{totalAbnormal} 条需关注记录。
      </p>

      {loading && <p style={{ color: 'var(--muted, #888)' }}>加载中…</p>}
      {error && <p style={{ color: '#e5484d' }}>加载失败：{error}</p>}
      {!loading && !error && alerts.length === 0 && (
        <p style={{ color: 'var(--muted, #888)' }}>暂无非正常考勤记录。</p>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        {alerts.map((a) => (
          <div
            key={a.student}
            style={{
              border: '1px solid var(--border, #2a2a2a)',
              borderRadius: 10,
              padding: 14,
              background: 'var(--card, #161616)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <strong>{a.student}</strong>
              <span style={{ color: '#e5484d', fontWeight: 600 }}>{a.rows.length} 条</span>
            </div>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--muted, #888)', textAlign: 'left' }}>
                  <th style={{ padding: '4px 8px' }}>考勤日期</th>
                  <th style={{ padding: '4px 8px' }}>考勤状态</th>
                  <th style={{ padding: '4px 8px' }}>考勤结果</th>
                  <th style={{ padding: '4px 8px' }}>异常描述</th>
                </tr>
              </thead>
              <tbody>
                {a.rows.slice(0, 8).map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border, #222)' }}>
                    <td style={{ padding: '4px 8px' }}>{r.考勤日期 ?? '-'}</td>
                    <td style={{ padding: '4px 8px' }}>{r.考勤状态 ?? '-'}</td>
                    <td style={{ padding: '4px 8px' }}>{r.考勤结果 ?? '-'}</td>
                    <td style={{ padding: '4px 8px' }}>{r.异常描述 ?? '-'}</td>
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
