'use client';

import { useCallback, useMemo, useState } from 'react';
import { api } from '../../lib/api';

/**
 * AI 路由的专用表单控件。
 * ──────────────────────────────────────────────────────────────────
 * 这几个控件用 columns 的声明式字段表达不了（卡片选择、多值编辑器、规则表格），
 * 通过 CrudColumn.renderField 挂进去 —— 仍然复用 CrudPage 的必填校验与提交链路。
 */

const hint: React.CSSProperties = { fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 4 };
const rowGap: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' };

// ── 卡片式单选（平台 / 账号类型）────────────────────────────────────
export function CardPicker({
  value,
  onChange,
  options,
  columns = 4,
  subtitleOf,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  columns?: number;
  subtitleOf?: (o: string) => string;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 8 }}>
      {options.map((o) => {
        const on = value === o;
        return (
          <button
            key={o}
            type="button"
            onClick={() => onChange(o)}
            style={{
              textAlign: 'left',
              padding: '10px 12px',
              borderRadius: 10,
              border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
              background: on ? 'var(--accent-soft)' : 'transparent',
              cursor: 'pointer',
              color: 'inherit',
            }}
          >
            <div style={{ fontSize: 'var(--font-sm)', fontWeight: on ? 600 : 400 }}>{o}</div>
            {subtitleOf ? (
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 2 }}>
                {subtitleOf(o)}
              </div>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ── 模型白名单：chips + 候选 + 同步 / 清除 / 自定义 ──────────────────
/**
 * 白名单 = 准入闸门。配了之后，只有命中的**逻辑模型**才允许走这个上游账号；
 * 支持 `xxx*` 尾部通配（如 `gpt-4o*`）。
 *
 * 「同步最新支持模型」是真调上游 `/models` 接口拿清单，不是内置列表 ——
 * 模型名变化太快，写死的清单很快就会过期。
 */
export function ModelWhitelistField({
  value,
  onChange,
  provider,
  baseUrl,
  credential,
  upstreamId,
  suggestions = [],
}: {
  value: string[];
  onChange: (v: string[]) => void;
  provider: string;
  baseUrl: string;
  credential: Record<string, string>;
  upstreamId?: string;
  /** 额外候选（页面会把「模型路由」里已用的逻辑模型传进来，避免手敲） */
  suggestions?: string[];
}) {
  const [synced, setSynced] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [kw, setKw] = useState('');
  const [custom, setCustom] = useState('');
  const [expanded, setExpanded] = useState(false);

  const candidates = useMemo(
    () => Array.from(new Set([...synced, ...suggestions])).filter(Boolean).sort(),
    [synced, suggestions],
  );
  const pool = useMemo(() => {
    const k = kw.trim().toLowerCase();
    const list = candidates.filter((m) => !value.includes(m));
    return k ? list.filter((m) => m.toLowerCase().includes(k)) : list;
  }, [candidates, kw, value]);

  const sync = useCallback(async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await api.aiUpstreamSyncModels({ baseUrl, provider, credential, upstreamId });
      setSynced(r.models);
      setMsg(
        r.models.length
          ? `已从 ${r.source} 取到 ${r.models.length} 个模型，点下方候选加入白名单`
          : (r.warnings[0] ?? '没有取到模型'),
      );
    } catch (e) {
      setMsg(`同步失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [baseUrl, provider, credential, upstreamId]);

  const addCustom = useCallback(
    (raw: string) => {
      const v = raw.trim();
      if (!v) return;
      if (value.includes(v)) {
        setMsg('该条目已存在');
        return;
      }
      onChange([...value, v]);
      setMsg('');
    },
    [value, onChange],
  );

  return (
    <div>
      <div style={rowGap}>
        <input
          className="form-input"
          style={{ flex: '1 1 220px' }}
          placeholder="搜索候选模型，或直接输入要加的名字后回车"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && kw.trim() && !pool.length) {
              e.preventDefault();
              addCustom(kw);
              setKw('');
            }
          }}
        />
        <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void sync()}>
          {busy ? '同步中…' : '同步最新支持模型'}
        </button>
        {value.length ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([])}>
            清除所有模型
          </button>
        ) : null}
      </div>

      {msg ? <div style={{ ...hint, color: msg.includes('失败') ? 'var(--fg-error)' : 'var(--fg-tertiary)' }}>{msg}</div> : null}

      {/* 已选：默认只展示前 8 个，其余折叠（白名单动辄几十条，全铺开会把表单撑爆） */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {(expanded ? value : value.slice(0, 8)).map((m) => (
          <span
            key={m}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 999,
              border: '1px solid var(--accent)', background: 'var(--accent-soft)', fontSize: 'var(--font-xs)',
            }}
          >
            {m}
            <button
              type="button"
              onClick={() => onChange(value.filter((x) => x !== m))}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0, lineHeight: 1 }}
              aria-label={`移除 ${m}`}
            >
              ×
            </button>
          </span>
        ))}
        {!value.length ? (
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
            未配置 = 不限制（该账号可服务任何路由过来的模型）
          </span>
        ) : null}
        {value.length > 8 ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起' : `展开其余 ${value.length - 8} 个`}
          </button>
        ) : null}
      </div>

      {pool.length ? (
        <div
          style={{
            marginTop: 8, maxHeight: 160, overflow: 'auto', padding: 8,
            border: '1px solid var(--border)', borderRadius: 8,
          }}
        >
          {pool.slice(0, 200).map((m) => (
            <label key={m} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 12, fontSize: 'var(--font-xs)' }}>
              <input type="checkbox" checked={false} onChange={() => onChange([...value, m])} />
              {m}
            </label>
          ))}
        </div>
      ) : null}

      <div style={{ ...rowGap, marginTop: 8 }}>
        <input
          className="form-input"
          style={{ flex: '1 1 220px' }}
          placeholder="自定义模型名称（支持结尾 * 通配，如 gpt-4o*）"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => {
            addCustom(custom);
            setCustom('');
          }}
        >
          填入
        </button>
      </div>
      <div style={hint}>
        已选 {value.length} 个模型{value.length ? '' : '（未配置 = 不限制）'}；命中其一即可走本账号。
      </div>
    </div>
  );
}

// ── 模型映射：请求模型 → 上游实际模型 ───────────────────────────────
/**
 * 兜底改名表：当「模型路由」没有为该逻辑模型指定上游模型时，用这里的映射决定发什么模型名。
 * 支持 `from` 结尾通配（`gpt-4o-* => gpt-4o`）；`to` 不允许带通配。
 */
export function ModelMapField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const parse = (s: string): [string, string] => {
    const [a, b] = String(s).split('=>');
    return [(a ?? '').trim(), (b ?? '').trim()];
  };
  const write = (next: [string, string][]) =>
    onChange(next.filter(([a, b]) => a || b).map(([a, b]) => `${a} => ${b}`));

  const rows = value.map(parse);
  return (
    <div>
      {rows.map(([from, to], i) => (
        <div key={`${from}-${i}`} style={{ ...rowGap, marginBottom: 6 }}>
          <input
            className="form-input"
            style={{ flex: '1 1 160px' }}
            placeholder="请求模型（可结尾 *）"
            value={from}
            onChange={(e) => {
              const next = rows.slice() as [string, string][];
              next[i] = [e.target.value, to];
              write(next);
            }}
          />
          <span style={{ color: 'var(--fg-tertiary)' }}>→</span>
          <input
            className="form-input"
            style={{ flex: '1 1 160px' }}
            placeholder="上游实际模型"
            value={to}
            onChange={(e) => {
              const next = rows.slice() as [string, string][];
              next[i] = [from, e.target.value];
              write(next);
            }}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => write(rows.filter((_, j) => j !== i) as [string, string][])}
          >
            删除
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-outline btn-sm" onClick={() => write([...rows, ['', '']])}>
        + 添加映射
      </button>
      <div style={hint}>
        优先级：先看「模型路由」里为该模型配的「上游模型」，没配才用这里的映射；都没有就按请求的模型名原样透传。
      </div>
    </div>
  );
}

// ── 临时不可调度规则 ───────────────────────────────────────────────
/**
 * 「某个上游开始抽风就自动把它下线一会儿」的可配置兜底。
 * 存储格式 `错误码|关键词|时长分钟|描述`（列里存多值）。
 */
export function TempRuleField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const parse = (s: string): [string, string, string, string] => {
    const p = String(s).split('|');
    return [(p[0] ?? '').trim(), (p[1] ?? '').trim(), (p[2] ?? '').trim(), (p[3] ?? '').trim()];
  };
  const write = (rows: [string, string, string, string][]) =>
    onChange(rows.filter(([code, kw, min]) => code || kw || min).map((r) => r.join('|')));

  const rows = value.map(parse);
  return (
    <div>
      {rows.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 90px 1fr 60px', gap: 6, marginBottom: 4 }}>
          {['错误码', '关键词', '时长(分)', '描述', ''].map((h) => (
            <span key={h} style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{h}</span>
          ))}
        </div>
      ) : null}
      {rows.map(([code, kw, min, desc], i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 90px 1fr 60px', gap: 6, marginBottom: 6 }}>
          {([0, 1, 2, 3] as const).map((idx) => (
            <input
              key={idx}
              className="form-input"
              placeholder={['500,502', 'overloaded', '10', '上游抽风'][idx]}
              value={[code, kw, min, desc][idx]}
              onChange={(e) => {
                const next = rows.map((r) => [...r]) as [string, string, string, string][];
                next[i]![idx] = e.target.value;
                write(next);
              }}
            />
          ))}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => write(rows.filter((_, j) => j !== i) as [string, string, string, string][])}
          >
            删除
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-outline btn-sm" onClick={() => write([...rows, ['', '', '10', '']])}>
        + 添加规则
      </button>
      <div style={hint}>
        错误码与关键词必须**同时**命中才摘除；关键词可写多个（逗号分隔，命中其一即可），留空表示只看错误码。
        时长 1 ~ 1440 分钟，到期自动恢复，不需要人工解锁。未命中规则时按默认策略处理（429 限流冷却 / 529 过载 10 分钟 / 401 临时摘除 10 分钟）。
      </div>
    </div>
  );
}

// ── 账号额度进度条（列表与详情共用）────────────────────────────────
/**
 * 展示账号的日 / 月额度用量。0 或空 = 该档不限。
 * 颜色按 sub2api 的口径分档：≥90% 红、≥75% 琥珀、其余绿。
 */
export function QuotaBar({
  used,
  limit,
  label,
}: {
  used: number;
  limit: number;
  label: string;
}) {
  if (!(limit > 0)) {
    return (
      <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
        {label} 不限
      </span>
    );
  }
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const color = pct >= 90 ? '#b3261e' : pct >= 75 ? '#8a5a12' : '#2c6b45';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 150 }}>
      <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', width: 26 }}>{label}</span>
      <span style={{ flex: 1, height: 6, borderRadius: 999, background: 'var(--border)', overflow: 'hidden', minWidth: 60 }}>
        <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: color }} />
      </span>
      <span style={{ fontSize: 'var(--font-xs)', color }}>
        {pct}% (${used.toFixed(4)}/${limit})
      </span>
    </span>
  );
}

// ── 分组复选（带倍率与账号数）────────────────────────────────────────
/**
 * 一个上游账号可以同时服务多个分组（对齐 sub2api 的 account_groups 多对多）。
 * 每项显示「分组名 · 费率 xN · 本组 N 个账号」—— 只给名字的话，选之前没法判断
 * 这个分组是不是已经挤满了账号、费率是不是划算。
 */
export function GroupPicker({
  value,
  onChange,
  options,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  options: { id: string; name: string; rate: number; count: number }[];
}) {
  const arr = Array.isArray(value) ? value : [];
  if (!options.length) {
    return <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>还没有分组，先去「分组管理」建一个</span>;
  }
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
        {options.map((g) => {
          const on = arr.includes(g.id);
          return (
            <label
              key={g.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8,
                border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                background: on ? 'var(--accent-soft)' : 'transparent',
                fontSize: 'var(--font-sm)', cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => onChange(e.target.checked ? [...arr, g.id] : arr.filter((x) => x !== g.id))}
              />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {g.name}
              </span>
              <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', whiteSpace: 'nowrap' }}>
                {g.rate}x · {g.count} 个账号
              </span>
            </label>
          );
        })}
      </div>
      <div style={hint}>已选 {arr.length} 个分组；不选表示这个账号不参与任何分组的调度。</div>
    </div>
  );
}
