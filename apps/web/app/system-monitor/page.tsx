'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type SystemStatusPayload } from '../../lib/api';

const REFRESH_MS = 30_000;

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 使用率条：>85% 转红、>70% 转黄，其余用主题色 */
function Bar({ percent }: { percent: number }) {
  const color = percent > 85 ? 'var(--fg-error)' : percent > 70 ? 'var(--fg-warning, #B8860B)' : 'var(--accent)';
  return (
    <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-hover)', overflow: 'hidden', marginTop: 6 }}>
      <div style={{ width: `${Math.min(100, Math.max(0, percent))}%`, height: '100%', background: color }} />
    </div>
  );
}

function Card({
  title,
  extra,
  children,
}: {
  title: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 'var(--font-base)', fontWeight: 700 }}>{title}</div>
        {extra}
      </div>
      {children}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{label}</div>
      <div style={{ fontSize: 'var(--font-sm)', marginTop: 2, fontFamily: mono ? 'var(--font-mono, monospace)' : undefined }}>
        {value}
      </div>
    </div>
  );
}

const grid2: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: '0 24px',
};

function StatusBadge({ state }: { state: 'active' | 'inactive' | 'unknown' }) {
  const map = {
    active: { text: '运行中', color: 'var(--success, #1D9E75)' },
    inactive: { text: '已停止', color: 'var(--fg-error)' },
    unknown: { text: '未知', color: 'var(--fg-tertiary)' },
  } as const;
  const m = map[state];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 'var(--font-sm)',
        fontWeight: 600,
        color: m.color,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 4, background: m.color }} />
      {m.text}
    </span>
  );
}

export default function SystemMonitorPage() {
  const [data, setData] = useState<SystemStatusPayload | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.systemStatus();
      setData(d);
      setErr('');
    } catch (e) {
      setErr((e as Error).message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [auto, load]);

  const host = data?.host ?? null;
  const app = data?.app ?? null;

  return (
    <div>
      <div className="page-eyebrow">SYSTEM</div>
      <h1 className="page-title">系统监控</h1>
      <p style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', margin: '6px 0 1rem' }}>
        服务器与运行时的常用关注项（仅系统管理员可见）
        {data ? ` · 采集于 ${fmtTime(data.collectedAt)}` : ''}
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <button className="btn btn-outline" onClick={() => void load()} disabled={loading}>
          {loading ? '刷新中…' : '立即刷新'}
        </button>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-sm)' }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          每 30 秒自动刷新
        </label>
        {err ? <span style={{ color: 'var(--fg-error)', fontSize: 'var(--font-sm)' }}>{err}</span> : null}
      </div>

      {!data && !err ? <div style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)' }}>加载中…</div> : null}

      {host ? (
        <Card title="主机">
          <div style={grid2}>
            <Field label="主机名" value={host.hostname} />
            <Field label="系统" value={host.platform} />
            <Field label="CPU" value={`${host.cpuModel}（${host.cpuCores} 核）`} />
            <Field label="负载（1 / 5 / 15 分钟）" value={`${host.load1} / ${host.load5} / ${host.load15}`} mono />
            <div style={{ padding: '8px 0' }}>
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>内存</div>
              <div style={{ fontSize: 'var(--font-sm)', marginTop: 2 }}>
                {host.memUsedText} / {host.memTotalText}（{host.memUsagePercent}%）
              </div>
              <Bar percent={host.memUsagePercent} />
            </div>
            <div style={{ padding: '8px 0' }}>
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>磁盘（根分区）</div>
              {host.disk ? (
                <>
                  <div style={{ fontSize: 'var(--font-sm)', marginTop: 2 }}>
                    {host.disk.usedText} / {host.disk.totalText}（{host.disk.usagePercent}%），可用 {host.disk.availableText}
                  </div>
                  <Bar percent={host.disk.usagePercent} />
                </>
              ) : (
                <div style={{ fontSize: 'var(--font-sm)', marginTop: 2, color: 'var(--fg-tertiary)' }}>不可用</div>
              )}
            </div>
            <Field label="系统运行时长" value={host.uptimeText} />
          </div>
        </Card>
      ) : null}

      {app ? (
        <Card title="应用进程">
          <div style={grid2}>
            <Field label="进程 PID" value={app.pid} mono />
            <Field label="Node 版本" value={app.nodeVersion} mono />
            <Field label="运行时长" value={app.uptimeText} />
            <Field label="启动时间" value={fmtTime(app.startedAt)} />
            <Field label="常驻内存（RSS）" value={app.rssText} />
            <Field label="堆内存已用" value={app.heapUsedText} />
            <Field label="当前部署槽位" value={app.slot ? `API ${app.slot} / Web ${Number(app.slot) + 100}` : '—'} mono />
            <Field label="构建号" value={app.buildId ?? '—'} mono />
          </div>
        </Card>
      ) : null}

      {data?.deps ? (
        <Card title="依赖服务">
          <div style={grid2}>
            <div style={{ padding: '8px 0' }}>
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>PostgreSQL</div>
              {data.deps.postgres.ok ? (
                <div style={{ fontSize: 'var(--font-sm)', marginTop: 2 }}>
                  正常 · 库大小 {data.deps.postgres.dbSizeText} · 表 {data.deps.postgres.tableCount} 张 · 连接{' '}
                  {data.deps.postgres.connections} 个
                </div>
              ) : (
                <div style={{ fontSize: 'var(--font-sm)', marginTop: 2, color: 'var(--fg-error)' }}>不可用</div>
              )}
            </div>
            <div style={{ padding: '8px 0' }}>
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>Redis</div>
              {data.deps.redis.ok ? (
                <div style={{ fontSize: 'var(--font-sm)', marginTop: 2 }}>
                  正常 · Key {data.deps.redis.keys} 个 · 占用 {data.deps.redis.memoryText}
                </div>
              ) : (
                <div style={{ fontSize: 'var(--font-sm)', marginTop: 2, color: 'var(--fg-error)' }}>不可用</div>
              )}
            </div>
          </div>
        </Card>
      ) : null}

      {data && data.services.length > 0 ? (
        <Card title="服务状态">
          <div style={grid2}>
            {data.services.map((s) => (
              <div
                key={s.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <div>
                  <div style={{ fontSize: 'var(--font-sm)' }}>{s.name}</div>
                  <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', fontFamily: 'var(--font-mono, monospace)' }}>
                    {s.unit}
                  </div>
                </div>
                <StatusBadge state={s.active} />
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {data?.backups ? (
        <Card title="数据库备份" extra={<span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{data.backups.dir}</span>}>
          {data.backups.ok && data.backups.items.length > 0 ? (
            <div>
              {data.backups.items.map((b) => (
                <div
                  key={b.name}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '6px 0',
                    borderBottom: '1px solid var(--border)',
                    fontSize: 'var(--font-sm)',
                  }}
                >
                  <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{b.name}</span>
                  <span style={{ color: 'var(--fg-tertiary)', whiteSpace: 'nowrap' }}>
                    {b.sizeText} · {fmtTime(b.at)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>未找到备份文件或目录不可读</div>
          )}
        </Card>
      ) : null}

      {data?.errors ? (
        <Card
          title="近期错误日志"
          extra={
            <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
              {data.errors.unit ?? '—'} · 最近 20 条
            </span>
          }
        >
          {data.errors.ok && data.errors.lines.length > 0 ? (
            <pre
              style={{
                margin: 0,
                padding: 12,
                background: 'var(--bg-hover)',
                borderRadius: 8,
                fontSize: 'var(--font-xs)',
                lineHeight: 1.6,
                maxHeight: 320,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                fontFamily: 'var(--font-mono, monospace)',
              }}
            >
              {data.errors.lines.join('\n')}
            </pre>
          ) : (
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>
              {data.errors.ok ? '暂无错误日志' : '日志不可用（journalctl 无权限或单元不存在）'}
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
