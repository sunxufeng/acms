'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ContactDedupResult, type DedupLevel, type DedupMember } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import { downloadCsv } from './panels';

/**
 * 报表 · 联系人去重（2026-09-14 新增）。
 *
 * 干什么：把**疑似同一个人的多条联系人记录**分好组列出来，附上证据与「建议保留哪条」，
 * 支持导出 CSV —— 拿着清单去卫瓴里合并（ACMS 是只读副本，**不在本系统做合并**）。
 *
 * 口径要点（页面上也写了，避免被误读成「系统认为这些都该合并」）：
 *  - 卫瓴已按手机号天然去重，**有手机号的记录不会重复** → 清单集中在没有手机号的记录里；
 *  - **反证据**：组内出现 ≥2 个不同手机号 ⇒ 判为不同的人（同渠道批量导入的典型特征），直接不列入；
 *  - 置信等级：强证据（手机号 / 微信ID / 备注一致）> 较可信（归属人或渠道一致）> 仅姓名一致。
 */

/** 置信等级徽标配色（取语义变量，深浅主题自动跟随） */
const LEVEL_STYLE: Record<DedupLevel, { bg: string; fg: string }> = {
  strong: { bg: 'var(--accent-muted)', fg: 'var(--accent)' },
  likely: { bg: 'var(--warning-muted)', fg: 'var(--warning)' },
  weak: { bg: 'var(--bg-subtle)', fg: 'var(--fg-tertiary)' },
};

/** 成员明细的列宽（组内行与表头共用，保证对齐） */
const MEMBER_COLS = '1.1fr 1.2fr 1fr 1.1fr 1.6fr 0.9fr 0.9fr 0.9fr';
const MEMBER_MIN_WIDTH = 940;

function fmtDay(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtStamp(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function DedupPanel() {
  const tl = useTl();
  const [data, setData] = useState<ContactDedupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [level, setLevel] = useState<'likely' | 'strong' | 'all'>('likely');
  const [channel, setChannel] = useState('');
  const [owner, setOwner] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setErr('');
      try {
        const d = await api.getContactDedup({
          level,
          ...(channel ? { channel } : {}),
          ...(owner ? { owner } : {}),
          ...(refresh ? { refresh: '1' } : {}),
        });
        setData(d);
        // 重算后组的编号会变，展开状态必须清掉，否则会错位到别的组
        if (refresh) setOpen(new Set());
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : tl('加载失败'));
      } finally {
        setLoading(false);
      }
    },
    [level, channel, owner, tl],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 导出：一行一个联系人（平铺），便于在 Excel 里按组号排序逐组处理 */
  const exportCsv = useCallback(() => {
    if (!data) return;
    const head = [
      tl('组号'), tl('置信等级'), tl('命中证据'), tl('处理建议'),
      tl('姓名'), tl('手机号'), tl('备注'), tl('来源渠道'), tl('归属人'),
      tl('客户阶段'), tl('流失状态'), tl('关联学生'), tl('创建时间'), tl('最近跟进'), tl('互动分'), tl('卫瓴联系人ID'),
    ];
    const rows: (string | number)[][] = [];
    for (const g of data.groups) {
      for (const m of g.members) {
        rows.push([
          g.key,
          tl(g.level === 'strong' ? '强证据' : g.level === 'likely' ? '较可信' : '仅参考'),
          g.evidences.map((e) => tl(e)).join('、'),
          m.keep ? tl('建议保留') : tl('可合并'),
          m.name,
          m.phone,
          m.remark,
          m.channel,
          m.owner,
          m.stage,
          m.lost,
          m.student,
          fmtDay(m.createdAt),
          fmtDay(m.lastFollowAt),
          m.score,
          m.weilingId,
        ]);
      }
    }
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    downloadCsv(`联系人去重_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`, head, rows);
  }, [data, tl]);

  const stats = data?.stats;
  const groups = useMemo(() => data?.groups ?? [], [data]);

  /**
   * 统计卡的配置。
   *
   * 🔴 「疑似重复」这张卡是**全量口径**（含最弱的「仅参考」一档），而下面的列表受
   * 「置信度」筛选影响、默认只显示「较可信及以上」—— 两个数字对不上是必然的，
   * 用户会把它当 bug 问（2026-09-18 峰哥实问「50 组为什么列表只有 39 组」）。
   * 所以这张卡做成**可点击**：一下把筛选切到「全部（含仅同名）」，数字立刻对齐。
   */
  const cards: { label: string; value: string; unit: string; onClick?: () => void; title?: string }[] = [
    {
      label: '疑似重复',
      value: stats ? `${stats.groups}` : '—',
      unit: '组',
      onClick: level === 'all' ? undefined : () => setLevel('all'),
      title: level === 'all' ? '已是全部口径' : '点击查看全部（含「仅参考」）',
    },
    { label: '涉及记录', value: stats ? `${stats.records}` : '—', unit: '条' },
    { label: '合并后可减少', value: stats ? `${stats.mergeable}` : '—', unit: '条' },
    { label: '其中强证据', value: stats ? `${stats.byLevel.strong}` : '—', unit: '组' },
  ];

  return (
    <div>
      {/* 工具行：重算 + 导出 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: '1rem' }}>
        <button className="btn btn-outline" onClick={() => void load(true)} disabled={loading}>
          {loading ? tl('计算中') + '…' : tl('重新计算')}
        </button>
        <button className="btn btn-outline" onClick={exportCsv} disabled={!groups.length}>
          {tl('导出清单 (CSV)')}
        </button>
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
          {tl('导出的是当前筛选结果，一行一个联系人')}
        </span>
      </div>

      {/* 统计卡：**全量口径**，不随下面的筛选变化 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))',
          gap: 10,
          marginBottom: '1.25rem',
        }}
      >
        {cards.map((c) => (
          <div
            key={c.label}
            onClick={c.onClick}
            title={c.title ? tl(c.title) : undefined}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '12px 14px',
              background: 'var(--bg-elevated)',
              cursor: c.onClick ? 'pointer' : undefined,
            }}
          >
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginBottom: 4 }}>
              {tl(c.label)}
            </div>
            <div style={{ fontSize: 22, fontWeight: 500 }}>
              {c.value}
              <span style={{ fontSize: 'var(--font-xs)', fontWeight: 400, color: 'var(--fg-tertiary)', marginLeft: 4 }}>
                {tl(c.unit)}
              </span>
            </div>
          </div>
        ))}
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '12px 14px',
            background: 'var(--bg-subtle)',
          }}
        >
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginBottom: 4 }}>
            {tl('无手机号记录')}
          </div>
          <div style={{ fontSize: 22, fontWeight: 500 }}>
            {stats ? stats.noPhone : '—'}
            <span style={{ fontSize: 'var(--font-xs)', fontWeight: 400, color: 'var(--fg-tertiary)', marginLeft: 4 }}>
              {tl('条')}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)' }}>
            {tl('重复只可能出现在这些里面')}
          </div>
        </div>
      </div>

      {/* 口径说明（2026-09-18 加）：统计卡走全量、列表受筛选影响 ——
          不写清楚，用户必然把「统计 50 组、列表 39 组」当成 bug 来问 */}
      {stats ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 10,
            margin: '-0.5rem 0 1.25rem',
            fontSize: 'var(--font-xs)',
            color: 'var(--fg-tertiary)',
          }}
        >
          <span>
            {tl('统计为全量口径')}：{tl('强证据')} {stats.byLevel.strong} · {tl('较可信')} {stats.byLevel.likely}
            {' · '}
            {tl('仅参考')} {stats.byLevel.weak}
          </span>
          <span>{tl('列表默认只显示「较可信及以上」，少掉的那些就是「仅参考」')}</span>
          {level === 'all' ? (
            <span>{tl('已显示全部')}</span>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLevel('all')}>
              {`${tl('查看全部')} ${stats.groups} ${tl('组')} →`}
            </button>
          )}
        </div>
      ) : null}

      {/* 筛选：只影响下面的清单 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: '1rem' }}>
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{tl('置信等级')}</span>
        <select
          className="form-input"
          style={{ minWidth: 150, fontSize: 'var(--font-sm)' }}
          value={level}
          onChange={(e) => setLevel(e.target.value as 'likely' | 'strong' | 'all')}
        >
          <option value="likely">{tl('较可信及以上（默认）')}</option>
          <option value="strong">{tl('仅强证据')}</option>
          <option value="all">{tl('全部（含仅同名）')}</option>
        </select>
        <select
          className="form-input"
          style={{ minWidth: 150, fontSize: 'var(--font-sm)' }}
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
        >
          <option value="">{`${tl('来源渠道')}：${tl('全部')}`}</option>
          {(data?.filterOptions.channels ?? []).map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
        <select
          className="form-input"
          style={{ minWidth: 170, fontSize: 'var(--font-sm)' }}
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
        >
          <option value="">{`${tl('归属人')}：${tl('全部')}`}</option>
          {(data?.filterOptions.owners ?? []).map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
        <button className="btn btn-ghost" onClick={() => { setLevel('likely'); setChannel(''); setOwner(''); }}>
          {tl('重置')}
        </button>
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
          {tl('当前显示')} {groups.length} {tl('组')}
          {data ? ` · ${tl('数据截至')} ${fmtStamp(data.generatedAt)}` : ''}
        </span>
      </div>

      {err ? (
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--danger)', marginBottom: '1rem' }}>{err}</div>
      ) : null}

      {!data && loading ? (
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>{tl('加载中')}…</div>
      ) : null}

      {data && !groups.length ? (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '28px 16px',
            textAlign: 'center',
            color: 'var(--fg-tertiary)',
            fontSize: 'var(--font-sm)',
            background: 'var(--bg-subtle)',
          }}
        >
          {tl('当前条件下没有疑似重复的联系人')}
        </div>
      ) : null}

      {/* 分组卡片 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {groups.map((g) => {
          const expanded = open.has(g.key);
          const style = LEVEL_STYLE[g.level];
          return (
            <div
              key={g.key}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 10,
                background: 'var(--bg-elevated)',
                overflow: 'hidden',
              }}
            >
              <div
                onClick={() => toggle(g.key)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 10,
                  padding: '12px 16px',
                  cursor: 'pointer',
                  borderBottom: expanded ? '1px solid var(--border)' : 'none',
                }}
              >
                <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{g.key}</span>
                <span style={{ fontSize: 'var(--font-sm)', fontWeight: 500 }}>{g.label}</span>
                <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)' }}>
                  {g.members.length} {tl('条')}
                </span>
                <span
                  style={{
                    fontSize: 'var(--font-xs)',
                    padding: '1px 7px',
                    borderRadius: 10,
                    background: style.bg,
                    color: style.fg,
                  }}
                >
                  {tl(g.level === 'strong' ? '强证据' : g.level === 'likely' ? '较可信' : '仅参考')}
                </span>
                {g.evidences.map((e) => (
                  <span
                    key={e}
                    style={{
                      fontSize: 'var(--font-xs)',
                      padding: '1px 7px',
                      borderRadius: 10,
                      background: 'var(--bg-subtle)',
                      color: 'var(--fg-secondary)',
                    }}
                  >
                    {tl(e)}
                  </span>
                ))}
                <span style={{ marginLeft: 'auto', fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
                  {expanded ? tl('收起') : tl('展开')}
                </span>
              </div>

              {expanded ? (
                <div style={{ overflowX: 'auto' }}>
                  <div style={{ minWidth: MEMBER_MIN_WIDTH }}>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: MEMBER_COLS,
                        gap: 8,
                        padding: '8px 16px',
                        fontSize: 'var(--font-xs)',
                        color: 'var(--fg-tertiary)',
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      <div>{tl('姓名')}</div>
                      <div>{tl('手机号')}</div>
                      <div>{tl('备注')}</div>
                      <div>{tl('来源渠道')}</div>
                      <div>{tl('归属人')}</div>
                      <div>{tl('客户阶段')}</div>
                      <div>{tl('创建时间')}</div>
                      <div>{tl('处理建议')}</div>
                    </div>
                    {g.members.map((m: DedupMember) => (
                      <div
                        key={m.id}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: MEMBER_COLS,
                          gap: 8,
                          padding: '9px 16px',
                          fontSize: 'var(--font-xs)',
                          color: m.keep ? 'var(--fg)' : 'var(--fg-secondary)',
                          borderBottom: '1px solid var(--border)',
                        }}
                      >
                        <div style={{ fontWeight: m.keep ? 500 : 400 }}>{m.name || '—'}</div>
                        <div style={{ fontWeight: m.keep ? 500 : 400 }}>{m.phone || '—'}</div>
                        <div>{m.remark || '—'}</div>
                        <div>{m.channel || '—'}</div>
                        <div>{m.owner || '—'}</div>
                        <div>{m.stage || '—'}</div>
                        <div>{fmtDay(m.createdAt)}</div>
                        <div style={{ color: m.keep ? 'var(--success)' : 'var(--fg-tertiary)' }}>
                          {m.keep ? tl('建议保留') : tl('可合并')}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* 口径说明：避免被误读成「系统认为这些都该合并」 */}
      <div
        style={{
          marginTop: '1.25rem',
          padding: '12px 16px',
          border: '1px solid var(--border)',
          borderRadius: 10,
          background: 'var(--bg-subtle)',
          fontSize: 'var(--font-xs)',
          color: 'var(--fg-tertiary)',
          lineHeight: 1.8,
        }}
      >
        <div style={{ fontWeight: 500, color: 'var(--fg-secondary)', marginBottom: 4 }}>{tl('判定口径')}</div>
        <div>
          ·{' '}
          {tl(
            '卫瓴侧已按手机号去重，有手机号的记录不会重复，所以清单集中在没有手机号的记录里；',
          )}
        </div>
        <div>
          ·{' '}
          {tl(
            '同一组内如果出现 2 个以上不同手机号，会被判定为不同的人，不列入清单（换号的同一个人也因此可能漏掉）；',
          )}
        </div>
        <div>
          ·{' '}
          {tl(
            '姓名栏的占位符（--、未知）与「王先生」这类宽泛称呼不参与判定，否则会聚出大量假重复；',
          )}
        </div>
        <div>
          ·{' '}
          {tl(
            '「建议保留」是信息最全、创建最早的那条，仅供参考；合并动作请在卫瓴系统里完成，本报表只出清单。',
          )}
        </div>
      </div>
    </div>
  );
}
