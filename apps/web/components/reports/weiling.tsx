'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/api';

interface Item {
  name: string;
  count?: number;
  total?: number;
  deal?: number;
  dealRate?: number;
  follow30?: number;
  /** 下钻用的原始键（自定义字段枚举值） */
  raw?: string;
  /** 下钻用的时间区间（YYYY-MM-DD，跟进健康度） */
  from?: string;
  to?: string;
}
interface FunnelDim {
  name: string;
  apiName: string;
  covered: number;
  items: { name: string; count: number; raw?: string }[];
}
interface FollowItem {
  name: string;
  records: number;
  contacts: number;
  last30: number;
  avg: number;
}
interface Follow {
  summary: {
    records: number;
    contacts: number;
    coverage: number;
    avgPerContact: number;
    last30: number;
    activeFollowers: number;
    synced: number;
  };
  byFollower: FollowItem[];
  trend: { month: string; records: number; contacts: number }[];
}
interface Data {
  summary: {
    total: number;
    monthNew: number;
    deal: number;
    dealRate: number;
    matched: number;
    owners: number;
    followRecords?: number;
    followAvg?: number;
  };
  stage: Item[];
  owners: Item[];
  channels: Item[];
  components: Item[];
  funnels: FunnelDim[];
  pipeline: { name: string; apiName?: string; yes: number; answered: number; raw?: string }[];
  trend: { month: string; newCount: number; dealCount: number }[];
  health: Item[];
  follow?: Follow;
  lost?: Lost;
}

/**
 * 流失分析。
 * 口径：流失率的分母只算「查得到流失状态」的（已流失 + 未流失）；
 * 没关联企业微信客户、查不到流失状态的单列在 noData，不进分母 ——
 * 否则数据缺失会被当成「没流失」，把流失率系统性拉低。
 */
interface LostDimItem {
  name: string;
  lost: number;
  kept: number;
  valid: number;
  rate: number;
}
interface Lost {
  summary: { lost: number; kept: number; noData: number; valid: number; rate: number };
  byChannel: LostDimItem[];
  byOwner: LostDimItem[];
  byStage: LostDimItem[];
}

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function today(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 月份（YYYY-MM）→ 该月首末日，用于趋势柱下钻 */
function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-');
  const last = new Date(Number(y), Number(m), 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export function WeilingPanel() {
  const router = useRouter();
  const [from, setFrom] = useState(daysAgo(365));
  const [to, setTo] = useState(today());
  const [owner, setOwner] = useState('');
  const [channel, setChannel] = useState('');
  const [stage, setStage] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setErr('');
    api
      .weilingAnalyze({ from, to, owner, channel, stage })
      .then((d) => setData(d as unknown as Data))
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [from, to, owner, channel, stage]);

  /**
   * 下钻到联系人列表。
   * ⚠️ 必须带上报表当前的筛选（时间区间 + 已选维度），否则列表页会显示全量联系人 ——
   * 用户点某根柱子想看的是「这批人」，不是所有人。extra 里的空值不传。
   */
  const drill = (extra: Record<string, string>) => {
    const merged: Record<string, string> = {};
    if (from) merged.from = from;
    if (to) merged.to = to;
    if (owner) merged['归属人'] = owner;
    if (channel) merged['来源渠道'] = channel;
    if (stage) merged['客户阶段'] = stage;
    for (const [k, v] of Object.entries(extra)) if (v) merged[k] = v;
    router.push(`/weiling-contacts?${new URLSearchParams(merged).toString()}`);
  };

  const opts = useMemo(
    () => ({
      owners: [...new Set((data?.owners ?? []).map((o) => o.name))],
      channels: [...new Set((data?.channels ?? []).map((c) => c.name))],
      stages: [...new Set((data?.stage ?? []).map((s) => s.name))],
    }),
    [data],
  );

  if (loading && !data)
    return <div style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)' }}>加载中…（首次需扫描全量线索）</div>;
  if (err) return <div style={{ color: 'var(--fg-error)', fontSize: 'var(--font-sm)' }}>加载失败：{err}</div>;
  if (!data) return null;

  const maxOf = (items: Item[], key: 'count' | 'total' = 'total') =>
    Math.max(1, ...items.map((i) => Number(i[key] ?? 0)));

  // 旧缓存可能没有 follow 字段，兜底成空结构，避免白屏
  const follow: Follow = data.follow ?? {
    summary: { records: 0, contacts: 0, coverage: 0, avgPerContact: 0, last30: 0, activeFollowers: 0, synced: 0 },
    byFollower: [],
    trend: [],
  };
  // 同上：流失分析是后加的区块，缓存里可能还没有
  const lost: Lost = data.lost ?? {
    summary: { lost: 0, kept: 0, noData: 0, valid: 0, rate: 0 },
    byChannel: [],
    byOwner: [],
    byStage: [],
  };

  return (
    <div>
      {/* 筛选 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' }}>
        <input className="form-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} />
        <span style={{ color: 'var(--fg-tertiary)' }}>至</span>
        <input className="form-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} />
        <select className="form-input" value={owner} onChange={(e) => setOwner(e.target.value)} style={{ width: 170 }}>
          <option value="">归属人：全部</option>
          {opts.owners.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
        <select className="form-input" value={channel} onChange={(e) => setChannel(e.target.value)} style={{ width: 150 }}>
          <option value="">来源渠道：全部</option>
          {opts.channels.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select className="form-input" value={stage} onChange={(e) => setStage(e.target.value)} style={{ width: 130 }}>
          <option value="">客户阶段：全部</option>
          {opts.stages.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button
          className="btn btn-ghost"
          onClick={() => {
            setFrom(daysAgo(365));
            setTo(today());
            setOwner('');
            setChannel('');
            setStage('');
          }}
        >
          重置
        </button>
        {loading ? <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>刷新中…</span> : null}
      </div>

      {/* KPI */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 10, marginBottom: '1.25rem' }}>
        {[
          { label: '线索总数', value: data.summary.total },
          { label: '本月新增', value: data.summary.monthNew },
          { label: '成交客户', value: data.summary.deal },
          { label: '转化率', value: `${data.summary.dealRate.toFixed(1)}%` },
          { label: '已匹配在校生', value: data.summary.matched },
          { label: '归属人数', value: data.summary.owners },
          { label: '跟进记录', value: data.summary.followRecords ?? 0 },
          { label: '人均跟进次数', value: Number(data.summary.followAvg ?? 0).toFixed(1) },
          { label: '已流失', value: lost.summary.lost },
          { label: '流失率', value: `${lost.summary.rate.toFixed(1)}%` },
        ].map((k) => (
          <div key={k.label} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-elevated,#fff)' }}>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{k.label}</div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* ① 客户阶段漏斗 */}
      <Section title="① 客户阶段分布（点击下钻）">
        <BarList items={data.stage} max={maxOf(data.stage, 'count')} onPick={(n) => drill({ 客户阶段: n })} />
      </Section>

      {/* ② 归属人 */}
      <Section title="② 归属人分析（线索 / 成交 / 成交率 / 近30天跟进）">
        <table style={{ width: '100%', fontSize: 'var(--font-sm)', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'var(--fg-tertiary)', textAlign: 'left' }}>
              <th style={th}>归属人</th><th style={thN}>线索</th><th style={thN}>成交</th><th style={thN}>成交率</th><th style={thN}>近30天跟进</th>
            </tr>
          </thead>
          <tbody>
            {data.owners.map((o) => (
              <tr key={o.name} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={td}>
                  <button className="link-btn" onClick={() => drill({ 归属人: o.name })}>{o.name}</button>
                </td>
                <td style={tdN}>{o.total}</td>
                <td style={tdN}>{o.deal}</td>
                <td style={tdN}>{Number(o.dealRate ?? 0).toFixed(1)}%</td>
                <td style={tdN}>{o.follow30}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* ③ 来源渠道 */}
      <Section title="③ 来源渠道（线索数 + 成交率，看哪个渠道又多又好）">
        <table style={{ width: '100%', fontSize: 'var(--font-sm)', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'var(--fg-tertiary)', textAlign: 'left' }}>
              <th style={th}>渠道</th><th style={thN}>线索</th><th style={thN}>成交</th><th style={thN}>成交率</th><th style={{ width: 140, padding: '6px 0' }} />
            </tr>
          </thead>
          <tbody>
            {data.channels.slice(0, 15).map((c) => (
              <tr key={c.name} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={td}>
                  <button className="link-btn" onClick={() => drill({ 来源渠道: c.name })}>{c.name}</button>
                </td>
                <td style={tdN}>{c.total}</td>
                <td style={tdN}>{c.deal}</td>
                <td style={tdN}>{Number(c.dealRate ?? 0).toFixed(1)}%</td>
                <td style={{ padding: '6px 0' }}>
                  <div style={{ height: 8, background: 'var(--bg-hover)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${(Number(c.total ?? 0) / maxOf(data.channels)) * 100}%`, height: '100%', background: 'var(--accent)' }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* ④ 来源组件 / 活动 */}
      <Section title="④ 来源组件 · 活动效果（TOP10）">
        <table style={{ width: '100%', fontSize: 'var(--font-sm)', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'var(--fg-tertiary)', textAlign: 'left' }}>
              <th style={th}>活动 / 组件</th><th style={thN}>线索</th><th style={thN}>成交</th><th style={thN}>成交率</th>
            </tr>
          </thead>
          <tbody>
            {data.components.map((c) => (
              <tr key={c.name} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ ...td, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.name}>
                  {/* ⚠️ 之前传的是 q（关键字），而 q 只搜姓名/手机/企业/备注，搜不到组件名 */}
                  <button className="link-btn" onClick={() => drill({ 来源组件: c.name })}>{c.name}</button>
                </td>
                <td style={tdN}>{c.total}</td>
                <td style={tdN}>{c.deal}</td>
                <td style={tdN}>{Number(c.dealRate ?? 0).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* ⑤ 招生漏斗自定义维度 */}
      <Section title="⑤ 招生漏斗维度（卫瓴自定义字段，已翻译为中文）">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 16 }}>
          {data.funnels.map((f) => (
            <div key={f.apiName}>
              <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500, marginBottom: 6 }}>
                {f.name}
                <span style={{ fontWeight: 400, color: 'var(--fg-tertiary)', marginLeft: 6 }}>（{f.covered} 条有值）</span>
              </div>
              <BarList
                items={f.items.map((i) => ({ name: i.name, count: i.count, raw: i.raw }))}
                max={Math.max(1, ...f.items.map((i) => i.count))}
                // 自定义字段不是列表列，用 dim/dimval 让后端在「自定义字段」JSON 里匹配原始键
                onPick={(_n, item) => {
                  if (item?.raw) drill({ dim: f.apiName, dimval: item.raw });
                }}
              />
            </div>
          ))}
        </div>
      </Section>

      {/* ⑥ 漏斗后半段 */}
      <Section title="⑥ 转化后半段（到访 → 缴费 → 面试 → Offer）">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {data.pipeline.map((p) => (
            <div
              key={p.name}
              onClick={() => {
                if (p.apiName && p.raw) drill({ dim: p.apiName, dimval: p.raw });
              }}
              style={{
                flex: '1 1 150px',
                padding: '10px 12px',
                border: '1px solid var(--border)',
                borderRadius: 10,
                background: 'var(--bg-elevated,#fff)',
                cursor: p.apiName && p.raw ? 'pointer' : 'default',
              }}
              title={p.apiName && p.raw ? `查看「${p.name}」的线索名单` : undefined}
            >
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{p.name}</div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{p.yes}</div>
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>已填 {p.answered}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ⑦ 趋势 */}
      <Section title="⑦ 新增线索 / 成交趋势（按月）">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 130 }}>
              {data.trend.map((t) => {
                const max = Math.max(1, ...data.trend.map((x) => x.newCount));
                return (
                  <div
                    key={t.month}
                    onClick={() => drill(monthRange(t.month))}
                    title={`查看 ${t.month} 新增的线索`}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, cursor: 'pointer' }}
                  >
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{t.newCount}</div>
                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: 92 }}>
                  <div style={{ height: `${(t.newCount / max) * 88}px`, background: 'var(--accent)', borderRadius: '3px 3px 0 0' }} />
                  <div style={{ height: `${(t.dealCount / max) * 88}px`, background: '#2c6b45', borderRadius: '3px 3px 0 0', marginTop: 2, minHeight: t.dealCount ? 3 : 0 }} />
                </div>
                <div style={{ fontSize: 10, color: 'var(--fg-tertiary)' }}>{t.month.slice(2)}</div>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 6 }}>
          <span style={{ color: 'var(--accent)' }}>■</span> 新增线索　<span style={{ color: '#2c6b45' }}>■</span> 成交
        </div>
      </Section>

      {/* ⑧ 跟进健康度 */}
      <Section title="⑧ 跟进健康度（最近跟进距今，点击下钻）">
        <BarList
          items={data.health}
          max={Math.max(1, ...data.health.map((h) => Number(h.count ?? 0)))}
          onPick={(_n, item) => {
            // 「从未跟进」没有时间区间，不可下钻
            if (!item?.from && !item?.to) return;
            drill({ 最近跟进时间_from: item.from ?? '', 最近跟进时间_to: item.to ?? '' });
          }}
        />
      </Section>

      {/* ⑨ 跟进分析 · 概览 */}
      <Section title="⑨ 跟进分析 · 概览（人均跟进次数 / 覆盖率）">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 10 }}>
          {[
            { label: '跟进记录总数', value: follow.summary.records },
            { label: '人均跟进次数', value: follow.summary.avgPerContact.toFixed(1) },
            { label: '被跟进线索', value: follow.summary.contacts },
            { label: '跟进覆盖率', value: `${follow.summary.coverage.toFixed(1)}%` },
            { label: '近30天跟进', value: follow.summary.last30 },
            { label: '活跃跟进人', value: follow.summary.activeFollowers },
          ].map((k) => (
            <div key={k.label} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-elevated,#fff)' }}>
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{k.label}</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{k.value}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 6 }}>
          人均跟进次数 = 跟进记录总数 ÷ 被跟进线索数；跟进记录由后台异步同步（库内共 {follow.summary.synced} 条），未同步完时数字偏小。
        </div>
      </Section>

      {/* ⑩ 按跟进人排行 */}
      <Section title="⑩ 按跟进人排行（TOP15）">
        {follow.byFollower.length === 0 ? (
          <div style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)' }}>暂无跟进记录</div>
        ) : (
          <table style={{ width: '100%', fontSize: 'var(--font-sm)', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--fg-tertiary)', textAlign: 'left' }}>
                <th style={th}>跟进人</th>
                <th style={thN}>跟进次数</th>
                <th style={thN}>覆盖线索</th>
                <th style={thN}>人均</th>
                <th style={thN}>近30天</th>
                <th style={{ width: 140, padding: '6px 0' }} />
              </tr>
            </thead>
            <tbody>
              {follow.byFollower.map((p) => (
                <tr key={p.name} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={td}>
                    {/* 跟进人不是联系人字段（联系人只有归属人），后端按跟进记录反查其跟进过的线索 */}
                    <button className="link-btn" onClick={() => drill({ follower: p.name })}>{p.name}</button>
                  </td>
                  <td style={tdN}>{p.records}</td>
                  <td style={tdN}>{p.contacts}</td>
                  <td style={tdN}>{p.avg.toFixed(1)}</td>
                  <td style={tdN}>{p.last30}</td>
                  <td style={{ padding: '6px 0' }}>
                    <div style={{ height: 8, background: 'var(--bg-hover)', borderRadius: 4, overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${(p.records / Math.max(1, ...follow.byFollower.map((x) => x.records))) * 100}%`,
                          height: '100%',
                          background: 'var(--accent)',
                        }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* ⑪ 跟进趋势 */}
      <Section title="⑪ 跟进趋势（按月：跟进记录数 / 被跟进线索数）">
        {follow.trend.length === 0 ? (
          <div style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)' }}>暂无跟进记录</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 130 }}>
              {follow.trend.map((t) => {
                const max = Math.max(1, ...follow.trend.map((x) => x.records));
                return (
                  <div
                    key={t.month}
                    onClick={() => drill({ 最近跟进时间_from: monthRange(t.month).from, 最近跟进时间_to: monthRange(t.month).to })}
                    title={`查看 ${t.month} 有跟进的线索`}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, cursor: 'pointer' }}
                  >
                    <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{t.records}</div>
                    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: 92 }}>
                      <div style={{ height: `${(t.records / max) * 88}px`, background: 'var(--accent)', borderRadius: '3px 3px 0 0' }} />
                      <div
                        style={{
                          height: `${(t.contacts / max) * 88}px`,
                          background: '#2c6b45',
                          borderRadius: '3px 3px 0 0',
                          marginTop: 2,
                          minHeight: t.contacts ? 3 : 0,
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--fg-tertiary)' }}>{t.month.slice(2)}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 6 }}>
              <span style={{ color: 'var(--accent)' }}>■</span> 跟进记录　<span style={{ color: '#2c6b45' }}>■</span> 被跟进线索
            </div>
          </>
        )}
      </Section>

      {/* ⑫ 流失分析 */}
      <Section title="⑫ 流失分析（流失率按渠道 / 归属人，点击下钻）">
        {lost.summary.valid === 0 ? (
          <div style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)' }}>
            暂无流失数据（需在联系人列表点「同步流失状态」后才能统计）
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10, fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
              <span>
                已流失 <b style={{ color: 'var(--fg-primary,#1a1a1a)' }}>{lost.summary.lost}</b>
              </span>
              <span>
                未流失 <b style={{ color: 'var(--fg-primary,#1a1a1a)' }}>{lost.summary.kept}</b>
              </span>
              <span>
                流失率 <b style={{ color: '#b3261e' }}>{lost.summary.rate.toFixed(1)}%</b>
              </span>
              <span title="没关联企业微信客户、查不到流失状态，不计入流失率的分母">
                未关联（不计）{lost.summary.noData}
              </span>
            </div>
            <LostTable rows={lost.byChannel} title="按来源渠道" dimKey="来源渠道" drill={drill} />
            <LostTable rows={lost.byOwner} title="按归属人" dimKey="归属人" drill={drill} />
            <LostTable rows={lost.byStage} title="按客户阶段" dimKey="客户阶段" drill={drill} />
          </>
        )}
      </Section>
    </div>
  );
}

/**
 * 流失率表：点维度值 → 下钻到「该维度 + 已流失」的名单。
 * 流失率用条形表示，条越长越该警惕。
 */
function LostTable({
  rows,
  title,
  dimKey,
  drill,
}: {
  rows: LostDimItem[];
  title: string;
  dimKey: string;
  drill: (params: Record<string, string>) => void;
}) {
  if (rows.length === 0) return null;
  const maxRate = Math.max(1, ...rows.map((r) => r.rate));
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginBottom: 4 }}>{title}</div>
      <table style={{ width: '100%', fontSize: 'var(--font-sm)', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: 'var(--fg-tertiary)', textAlign: 'left' }}>
            <th style={th}>{title.replace('按', '')}</th>
            <th style={thN}>已流失</th>
            <th style={thN}>未流失</th>
            <th style={thN}>流失率</th>
            <th style={{ width: 150, padding: '6px 0' }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={td}>
                <button className="link-btn" onClick={() => drill({ [dimKey]: r.name, 流失状态: '已流失' })}>
                  {r.name}
                </button>
              </td>
              <td style={tdN}>{r.lost}</td>
              <td style={tdN}>{r.kept}</td>
              <td style={tdN}>{r.rate.toFixed(1)}%</td>
              <td style={{ padding: '6px 0' }}>
                <div style={{ height: 8, background: 'var(--bg-hover)', borderRadius: 4, overflow: 'hidden' }}>
                  <div
                    style={{ width: `${(r.rate / maxRate) * 100}%`, height: '100%', background: '#b3261e' }}
                    title={`流失率 ${r.rate.toFixed(1)}%（${r.lost}/${r.valid}）`}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── 小组件 ────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function BarList({
  items,
  max,
  onPick,
}: {
  items: Item[];
  max: number;
  /** 第二参数带上整条数据：下钻常需要原始键 / 时间区间，光有名字不够 */
  onPick?: (name: string, item: Item) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((i) => {
        const v = Number(i.count ?? i.total ?? 0);
        return (
          <div key={i.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              title={i.name}
              style={{ width: 130, fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {onPick ? (
                <button className="link-btn" onClick={() => onPick(i.name, i)}>{i.name}</button>
              ) : (
                i.name
              )}
            </span>
            <div style={{ flex: 1, height: 10, background: 'var(--bg-hover)', borderRadius: 5, overflow: 'hidden' }}>
              <div style={{ width: `${(v / max) * 100}%`, height: '100%', background: 'var(--accent)' }} />
            </div>
            <span style={{ width: 52, textAlign: 'right', fontSize: 'var(--font-xs)' }}>{v}</span>
          </div>
        );
      })}
    </div>
  );
}

const th: React.CSSProperties = { padding: '6px 8px 6px 0', fontWeight: 500 };
const thN: React.CSSProperties = { padding: '6px 8px', fontWeight: 500, textAlign: 'right', width: 70 };
const td: React.CSSProperties = { padding: '6px 8px 6px 0' };
const tdN: React.CSSProperties = { padding: '6px 8px', textAlign: 'right' };
