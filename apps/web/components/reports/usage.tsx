'use client';

import { useEffect, useState } from 'react';
import { api, type UsageMatrix, type UsagePayload } from '../../lib/api';

function fmtTime(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Metric({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', background: 'var(--bg-elevated)' }}>
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{label}</div>
      <div style={{ fontSize: 'var(--font-xl, 20px)', fontWeight: 700, marginTop: 4 }}>{value}</div>
      {hint ? <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 2 }}>{hint}</div> : null}
    </div>
  );
}

/** 维度切换（同一批人，换一个维度看）—— 只影响列，不影响行与合计 */
function Segmented<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 行列矩阵表。
 *
 * 三条显示约定（与后端口径对齐，不要改坏）：
 *   1. 「合计」列/行**直接显示后端给的数**，前端不重算 —— 重算就成了两套口径，
 *      一旦后端修了某个归属规则，界面会继续显示旧数字。
 *   2. `0` 显示成淡色 `·`：矩阵里大量格子是 0，全写 `0` 会让表看起来像噪音。
 *   3. 合并行（「系统任务 · 测试」）的 `detail` 挂在行名 title 上 ——
 *      正常不占地方，排查时一悬停能看到「这 80 次都是哪些写法」。
 */
function MatrixTable({ m, unit, firstCol, rowTitle }: {
  m: UsageMatrix;
  unit: string;
  firstCol: string;
  rowTitle?: (label: string) => string | undefined;
}) {
  if (m.rows.length === 0) {
    return <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>所选时间段内没有记录</div>;
  }
  const cell: React.CSSProperties = { padding: '6px 8px', fontSize: 'var(--font-xs)', textAlign: 'right', whiteSpace: 'nowrap' };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 520 }}>
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: 'left', color: 'var(--fg-tertiary)', fontWeight: 500 }}>{firstCol}</th>
            {m.cols.map((c) => (
              <th key={c} title={c} style={{ ...cell, color: 'var(--fg-tertiary)', fontWeight: 500, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c}
              </th>
            ))}
            <th style={{ ...cell, color: 'var(--fg-secondary)', fontWeight: 700 }}>合计</th>
          </tr>
        </thead>
        <tbody>
          {m.rows.map((r) => (
            <tr key={r.label} style={{ borderTop: '1px solid var(--border)' }}>
              <td
                title={r.detail || rowTitle?.(r.label) || r.label}
                style={{ ...cell, textAlign: 'left', color: 'var(--fg-secondary)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                {r.label}
                {r.detail ? <span style={{ color: 'var(--fg-tertiary)', marginLeft: 4 }}>*</span> : null}
              </td>
              {r.cells.map((v, i) => (
                <td key={m.cols[i]} style={{ ...cell, color: v ? 'var(--fg)' : 'var(--fg-tertiary)' }}>
                  {v || '·'}
                </td>
              ))}
              <td style={{ ...cell, fontWeight: 700 }}>{r.total}</td>
            </tr>
          ))}
          <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--bg-subtle)' }}>
            <td style={{ ...cell, textAlign: 'left', color: 'var(--fg-secondary)' }}>合计</td>
            {m.colTotals.map((v, i) => (
              <td key={m.cols[i]} style={{ ...cell, fontWeight: 700 }}>{v}</td>
            ))}
            <td style={{ ...cell, fontWeight: 700 }}>{m.total} {unit}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** 区块外壳：标题 + 右侧维度切换 + 内容 */
function Block({ title, hint, right, children }: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: '1.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--font-sm)', fontWeight: 500 }}>{title}</span>
        {right}
        {hint ? <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function UsagePanel({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<UsagePayload | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  // 每个区块的列维度（默认第一个）
  const [srDim, setSrDim] = useState<'type' | 'channel'>('type');
  const [sfDim, setSfDim] = useState<'activity' | 'channel'>('activity');
  const [auDim, setAuDim] = useState<'module' | 'action'>('module');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .usageStats({ from, to })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setErr('');
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message || '加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [from, to]);

  if (err) {
    return <div style={{ color: 'var(--fg-error)', fontSize: 'var(--font-sm)' }}>加载失败：{err}</div>;
  }
  if (!data) {
    return <div style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)' }}>{loading ? '加载中…' : '暂无数据'}</div>;
  }

  const sr = data.studentRecords;
  const sf = data.sourceFollowups;
  const mt = data.meetings;

  return (
    <div>
      {/* 口径说明：这张卡的数字与「列表条数」经常对不上，原因必须写在界面上 */}
      <div
        style={{
          fontSize: 'var(--font-xs)',
          color: 'var(--fg-tertiary)',
          background: 'var(--bg-subtle)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '8px 12px',
          marginBottom: '1rem',
          lineHeight: 1.8,
        }}
      >
        口径：统计区间 <b>{data.from}</b> ~ <b>{data.to}</b>。
        <b>只统计落在区间内、且带时间字段的记录</b>（缺时间的记录不参与筛选，条数见各区块下方说明）。
        <b>操作人已按系统用户表归一</b>——同一个人写成「孙旭峰 / 孙旭峰｜Richard / Richard」会并成一行；
        <b>系统任务与测试账号</b>（如「验证探针」）单独归到「系统任务 · 测试」，不计入人。
        <b>笔记按「归属人」= 该笔记所属知识库配置的归属人</b>（不是笔记作者）。
        <b>审计日志的时间精度到「天」</b>（存储层会把毫秒时间戳格式化成日期），
        所以按天看用量是准的、跨天边界最多差一天。
        本卡只出计数与聚合，不含任何记录正文。
      </div>

      {data.warnings.length ? (
        <div
          style={{
            fontSize: 'var(--font-xs)',
            color: 'var(--fg-secondary)',
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border)',
            borderLeft: '3px solid var(--fg-error)',
            borderRadius: 8,
            padding: '8px 12px',
            marginBottom: '1rem',
            lineHeight: 1.8,
          }}
        >
          {data.warnings.map((w) => (
            <div key={w}>· {w}</div>
          ))}
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: '1.5rem' }}>
        <Metric label="学生记录" value={sr.total} hint="条（按记录人）" />
        <Metric label="招生跟进" value={sf.total} hint="条（按负责人）" />
        <Metric label="我的笔记" value={data.notes.total} hint="篇（按归属人）" />
        <Metric label="系统操作" value={data.audit.total} hint="次（按操作人）" />
        <Metric label="会议纪要" value={mt.total} hint="场（按主持人）" />
      </div>

      <Block
        title="① 学生记录 · 按记录人"
        hint={`取自「沟通人」字段（该字段在界面上按类型显示为 记录人 / 沟通人 / 观察人）${sr.undated ? ` · 另有 ${sr.undated} 条无沟通时间未计入` : ''}`}
        right={
          <Segmented
            value={srDim}
            onChange={setSrDim}
            options={[
              { value: 'type', label: '按记录类型' },
              { value: 'channel', label: '按沟通方式' },
            ]}
          />
        }
      >
        <MatrixTable
          m={srDim === 'type' ? sr.byType : sr.byChannel}
          unit="条"
          firstCol="记录人"
        />
      </Block>

      <Block
        title="② 招生跟进 · 按负责人"
        hint={sf.undated ? `另有 ${sf.undated} 条无跟进时间未计入` : undefined}
        right={
          <Segmented
            value={sfDim}
            onChange={setSfDim}
            options={[
              { value: 'activity', label: '按活动类型' },
              { value: 'channel', label: '按跟进方式' },
            ]}
          />
        }
      >
        <MatrixTable
          m={sfDim === 'activity' ? sf.byActivityType : sf.byChannel}
          unit="条"
          firstCol="负责人"
        />
      </Block>

      <Block
        title="③ 我的笔记 · 按归属人"
        hint={`归属人 = 该笔记所属知识库配置的归属人（例：为他人代建的配置，笔记计入配置归属人）${data.notes.undated ? ` · 另有 ${data.notes.undated} 篇无创建时间未计入` : ''}`}
      >
        {data.notes.byOwner.length === 0 ? (
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>所选时间段内没有记录</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 480 }}>
              <thead>
                <tr>
                  {['归属人', '笔记数', '占比', '来源配置', '最近一篇'].map((h, i) => (
                    <th
                      key={h}
                      style={{
                        padding: '6px 8px',
                        fontSize: 'var(--font-xs)',
                        fontWeight: 500,
                        color: 'var(--fg-tertiary)',
                        textAlign: i === 0 ? 'left' : 'right',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.notes.byOwner.map((o) => (
                  <tr key={o.label} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 8px', fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)' }}>{o.label}</td>
                    <td style={{ padding: '6px 8px', fontSize: 'var(--font-xs)', textAlign: 'right', fontWeight: 700 }}>{o.count}</td>
                    <td style={{ padding: '6px 8px', fontSize: 'var(--font-xs)', textAlign: 'right', color: 'var(--fg-tertiary)' }}>{o.share}%</td>
                    <td style={{ padding: '6px 8px', fontSize: 'var(--font-xs)', textAlign: 'right', color: 'var(--fg-tertiary)' }}>{o.sources}</td>
                    <td style={{ padding: '6px 8px', fontSize: 'var(--font-xs)', textAlign: 'right', color: 'var(--fg-tertiary)' }}>{fmtTime(o.lastAt)}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--bg-subtle)' }}>
                  <td style={{ padding: '6px 8px', fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)' }}>合计</td>
                  <td style={{ padding: '6px 8px', fontSize: 'var(--font-xs)', textAlign: 'right', fontWeight: 700 }}>{data.notes.total} 篇</td>
                  <td colSpan={3} />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Block>

      <Block
        title="④ 系统操作 · 按操作人"
        hint={`审计日志的写操作（创建 / 更新 / 删除）· 操作人已按系统用户表归一 · 业务模块名取接口路径对应模块${data.audit.skipped ? ` · 另 ${data.audit.skipped} 条无操作时间已忽略` : ''}`}
        right={
          <Segmented
            value={auDim}
            onChange={setAuDim}
            options={[
              { value: 'module', label: '按业务模块' },
              { value: 'action', label: '按操作类型' },
            ]}
          />
        }
      >
        <MatrixTable
          m={auDim === 'module' ? data.audit.byModule : data.audit.byAction}
          unit="次"
          firstCol="操作人"
        />
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 6 }}>
          行名后带 <b>*</b> 的是合并行（系统任务 / 测试账号），鼠标悬停可看由哪些写法合成。
        </div>
      </Block>

      <Block
        title="⑤ 会议纪要 · 按主持人"
        hint={`平均时长取自「开始时间 ~ 结束时间」，缺失时不显示${mt.undated ? ` · 另有 ${mt.undated} 场无会议时间未计入` : ''}`}
      >
        {mt.byHost.length === 0 ? (
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>所选时间段内没有记录</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 480 }}>
              <thead>
                <tr>
                  {['主持人', '会议数', '平均时长', '主要会议类型', '最近一场'].map((h, i) => (
                    <th
                      key={h}
                      style={{
                        padding: '6px 8px',
                        fontSize: 'var(--font-xs)',
                        fontWeight: 500,
                        color: 'var(--fg-tertiary)',
                        textAlign: i === 0 ? 'left' : 'right',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mt.byHost.map((h) => (
                  <tr key={h.label} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 8px', fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)' }}>{h.label}</td>
                    <td style={{ padding: '6px 8px', fontSize: 'var(--font-xs)', textAlign: 'right', fontWeight: 700 }}>{h.count}</td>
                    <td style={{ padding: '6px 8px', fontSize: 'var(--font-xs)', textAlign: 'right', color: 'var(--fg-tertiary)' }}>
                      {h.avgMinutes === null ? '—' : `${h.avgMinutes} 分钟`}
                    </td>
                    <td style={{ padding: '6px 8px', fontSize: 'var(--font-xs)', textAlign: 'right', color: 'var(--fg-tertiary)' }}>{h.mainType || '—'}</td>
                    <td style={{ padding: '6px 8px', fontSize: 'var(--font-xs)', textAlign: 'right', color: 'var(--fg-tertiary)' }}>{fmtTime(h.lastAt)}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--bg-subtle)' }}>
                  <td style={{ padding: '6px 8px', fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)' }}>合计</td>
                  <td style={{ padding: '6px 8px', fontSize: 'var(--font-xs)', textAlign: 'right', fontWeight: 700 }}>{mt.total} 场</td>
                  <td colSpan={3} />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Block>
    </div>
  );
}
