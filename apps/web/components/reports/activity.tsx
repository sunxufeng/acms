'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, type ActivityPayload } from '../../lib/api';

const HOURS = Array.from({ length: 24 }, (_, i) => i);

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

/** 热力格：按该时段次数占个人峰值的比例上色 */
function cell(count: number, max: number): React.CSSProperties {
  if (!count) return { background: 'var(--bg-hover)' };
  const ratio = max > 0 ? count / max : 0;
  const alpha = 0.15 + Math.min(0.85, ratio * 0.85);
  return { background: `color-mix(in srgb, var(--accent) ${Math.round(alpha * 100)}%, transparent)` };
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '12px 14px',
        background: 'var(--bg-elevated)',
      }}
    >
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{label}</div>
      <div style={{ fontSize: 'var(--font-xl, 20px)', fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}

export function ActivityPanel() {
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(today());
  const [data, setData] = useState<ActivityPayload | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async (f: string, t: string) => {
    setLoading(true);
    try {
      setData(await api.activity({ from: f, to: t }));
      setErr('');
    } catch (e) {
      setErr((e as Error).message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(from, to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maxHour = useMemo(() => Math.max(1, ...(data?.byHour ?? [0])), [data]);
  const maxCell = useMemo(
    () => Math.max(1, ...(data?.byUser ?? []).flatMap((u) => u.hours)),
    [data],
  );

  return (
    <div>
      {/* 时间范围 */}
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
      </div>

      {err ? (
        <div style={{ color: 'var(--fg-error)', fontSize: 'var(--font-sm)', marginBottom: '1rem' }}>{err}</div>
      ) : null}

      {!data ? (
        <div style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)' }}>加载中…</div>
      ) : (
        <>
          {/* 口径说明：避免被误读成在线时长 */}
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
            口径：<b>登录</b> = 每次成功登录（登录日志表）；<b>操作</b> = 审计日志里的写操作（创建 / 更新 / 删除）。
            系统不记录访问日志与在线时长，所以这是「什么时候登录过、什么时候动过数据」，不是在线时长。
          </div>

          {/* 汇总 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
              gap: 12,
              marginBottom: '1.25rem',
            }}
          >
            <Metric label="活跃人数" value={data.summary.activeUsers} />
            <Metric label="登录次数" value={data.summary.logins} />
            <Metric label="操作次数" value={data.summary.actions} />
            <Metric label="活跃天数" value={data.summary.activeDays} />
            <Metric label="最活跃时段" value={`${data.summary.peakHour}:00`} />
          </div>

          {/* 全站小时分布 */}
          <div style={{ marginBottom: '1.5rem' }}>
            <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500, marginBottom: 8 }}>全站时段分布</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 90 }}>
              {HOURS.map((h) => (
                <div key={h} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div
                    title={`${h}:00 — ${data.byHour[h] ?? 0} 次`}
                    style={{
                      width: '100%',
                      height: Math.max(2, ((data.byHour[h] ?? 0) / maxHour) * 62),
                      background: 'var(--accent)',
                      borderRadius: '2px 2px 0 0',
                    }}
                  />
                  {h % 3 === 0 ? (
                    <span style={{ fontSize: '10px', color: 'var(--fg-tertiary)' }}>{h}</span>
                  ) : (
                    <span style={{ fontSize: '10px', color: 'transparent' }}>·</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 人 × 小时热力表 */}
          <div style={{ marginBottom: '1.5rem' }}>
            <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500, marginBottom: 8 }}>
              每人活跃时段（颜色越深 = 该时段越活跃）
            </div>
            {data.byUser.length === 0 ? (
              <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>所选时间段内没有记录</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 'var(--font-xs)' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--fg-tertiary)', fontWeight: 400 }}>姓名</th>
                      {HOURS.map((h) => (
                        <th key={h} style={{ padding: '4px 1px', color: 'var(--fg-tertiary)', fontWeight: 400, width: 14 }}>
                          {h % 3 === 0 ? h : ''}
                        </th>
                      ))}
                      <th style={{ padding: '4px 8px', color: 'var(--fg-tertiary)', fontWeight: 400 }}>登录</th>
                      <th style={{ padding: '4px 8px', color: 'var(--fg-tertiary)', fontWeight: 400 }}>操作</th>
                      <th style={{ padding: '4px 8px', color: 'var(--fg-tertiary)', fontWeight: 400 }}>活跃天</th>
                      <th style={{ padding: '4px 8px', color: 'var(--fg-tertiary)', fontWeight: 400 }}>最近活跃</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byUser.map((u) => (
                      <tr key={u.name}>
                        <td style={{ padding: '3px 8px', whiteSpace: 'nowrap' }}>{u.name}</td>
                        {HOURS.map((h) => (
                          <td key={h} style={{ padding: 0 }}>
                            <div
                              title={`${u.name} ${h}:00 — ${u.hours[h] ?? 0} 次`}
                              style={{
                                width: 14,
                                height: 18,
                                borderRadius: 2,
                                ...cell(u.hours[h] ?? 0, maxCell),
                              }}
                            />
                          </td>
                        ))}
                        <td style={{ padding: '3px 8px', textAlign: 'right' }}>{u.logins}</td>
                        <td style={{ padding: '3px 8px', textAlign: 'right' }}>{u.actions}</td>
                        <td style={{ padding: '3px 8px', textAlign: 'right' }}>{u.activeDays}</td>
                        <td style={{ padding: '3px 8px', color: 'var(--fg-tertiary)', whiteSpace: 'nowrap' }}>
                          {fmtTime(u.lastAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 按天趋势 */}
          {data.byDay.length > 0 ? (
            <div style={{ marginBottom: '1.5rem' }}>
              <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500, marginBottom: 8 }}>按天趋势</div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 80, overflowX: 'auto' }}>
                {data.byDay.map((d) => {
                  const max = Math.max(1, ...data.byDay.map((x) => x.logins + x.actions));
                  const total = d.logins + d.actions;
                  return (
                    <div key={d.date} style={{ minWidth: 10, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                      <div
                        title={`${d.date} 登录 ${d.logins} / 操作 ${d.actions}`}
                        style={{
                          width: '100%',
                          height: Math.max(2, (total / max) * 54),
                          background: 'var(--accent)',
                          borderRadius: '2px 2px 0 0',
                        }}
                      />
                      <span style={{ fontSize: '9px', color: 'var(--fg-tertiary)', writingMode: 'vertical-rl' }}>
                        {d.date.slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* 操作模块 TOP */}
          {data.modules.length > 0 ? (
            <div>
              <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500, marginBottom: 8 }}>操作最多的模块</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {data.modules.map((m) => {
                  const max = Math.max(...data.modules.map((x) => x.count));
                  return (
                    <div key={m.module} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 130, fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)' }}>{m.module}</span>
                      <div style={{ flex: 1, height: 10, background: 'var(--bg-hover)', borderRadius: 5, overflow: 'hidden' }}>
                        <div
                          style={{
                            width: `${(m.count / max) * 100}%`,
                            height: '100%',
                            background: 'var(--accent)',
                          }}
                        />
                      </div>
                      <span style={{ width: 40, textAlign: 'right', fontSize: 'var(--font-xs)' }}>{m.count}</span>
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
