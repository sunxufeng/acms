'use client';

/**
 * 「卫瓴映射」配置页（v13，2026-09-30 峰哥需求）。
 *
 * 需求原文：「卫瓴 18 种或者更多的来源渠道 → 档案 4 个选项或者更多的对应关系
 * 做成可配置的页面，放到后台管理里，菜单名称叫"卫瓴映射"」。
 *
 * ── 这个页面在解决什么 ────────────────────────────────────────
 *   转档（联系人 → 学生档案）时，有五栏的取值需要「翻译」：
 *     卫瓴「来源渠道」（运营随手建，18+ 种）→ 档案「来源渠道」（8 个选项）
 *     卫瓴「客户阶段」                      → 档案「生源跟进状态」
 *     卫瓴 yxxlx 原学校类型                  → 档案「原学校类型」
 *     卫瓴 jxrdzjxysj 计划入读               → 档案「入学年月」
 *     卫瓴 jfqk 缴费情况                     → 档案「付款状态」
 *   口径只有招生老师知道（「活动-公众号」到底算官网还是活动招募？），
 *   所以从代码里的 `const` 提成可配置。
 *
 * ── 🔴 三条设计约束 ─────────────────────────────────────────
 *   ① **选项不在这里抄一份**：右列下拉的候选来自服务端（字典优先，见
 *      `WEILING_MAPPING_FIELDS.archiveDictKey`）—— 老师改字典后这里自动跟着变。
 *   ② **左列列的是真实出现过的取值**（带出现条数，降序），不是凭空想的候选；
 *      配完还能看到覆盖了多少条联系人。
 *   ③ **试算不在这里算**：点「试算」走服务端 `POST /weiling/mapping/preview`，
 *      用的是**转档时同一份判据** ⇒ 试算数字与保存后的实际效果必然一致。
 *      （本仓踩过"前端照抄判据估出 8 人、线上 42 人"的坑。）
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
// ⚠️ `api` 是**命名导出**（`export const api = {...}`），没有 default ⇒ 不能写 `import api from`
import { api, type WeilingMappingResult, type WeilingMappingFieldView } from '../../lib/api';
import { forbiddenText } from '../../lib/apiError';

/** 「不映射」在下拉里的哨兵值（不能用空串——空串是"没选"，这里是显式选择） */
const NO_MAP = '\u0000none';

type Draft = WeilingMappingResult['config'];

/**
 * 翻译函数的宽松签名。
 *
 * ⚠️ 为什么不写 `ReturnType<typeof useTranslations<'weilingMapping'>>`：那个类型依赖
 *    next-intl 的泛型推导，在"把 t 当 prop 往下传"的场景里会把 `values` 推成 never，
 *    子组件里 `t('coverage', { n: pct })` 反而报错。这里用一个显式的宽松签名 +
 *    传参处一次 cast，把类型噪音关在一个地方（页面本身仍受 key 检查约束）。
 */
type TFn = (key: string, values?: Record<string, string | number>) => string;

export default function WeilingMappingPage() {
  const t = useTranslations('weilingMapping');
  const [meta, setMeta] = useState<WeilingMappingResult | null>(null);
  /** 打开页面时服务端那份（用来对比"改了什么"） */
  const [base, setBase] = useState<WeilingMappingResult | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  /** 每张卡片的「手工添加一条」输入 */
  const [newFrom, setNewFrom] = useState<Record<string, string>>({});

  const apply = useCallback((r: WeilingMappingResult) => {
    setMeta(r);
    setDraft(JSON.parse(JSON.stringify(r.config)) as Draft);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await api.weilingMappingGet();
      setBase(r);
      apply(r);
    } catch (e) {
      setErr(forbiddenText(e) ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(base?.config ?? null),
    [draft, base],
  );

  const runPreview = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setErr('');
    setNotice('');
    try {
      // 🔴 试算走服务端同一份判据（转档时用的那个），拿回来的就是"这样配的真实效果"
      setMeta(await api.weilingMappingPreview(draft));
      setNotice(t('previewDone'));
    } catch (e) {
      setErr(forbiddenText(e) ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, t]);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setErr('');
    setNotice('');
    try {
      const r = await api.weilingMappingSave(draft);
      setBase(r);
      apply(r);
      setNotice(t('saved'));
    } catch (e) {
      setErr(forbiddenText(e) ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, apply, t]);

  /** 改某一条映射（`NO_MAP` = 显式「不映射」） */
  const setEntry = (key: string, from: string, to: string) => {
    setDraft((d) => {
      if (!d) return d;
      const next = JSON.parse(JSON.stringify(d)) as Draft;
      const map = next[key as keyof Draft] as unknown as Record<string, string>;
      if (to === NO_MAP) map[from] = '';
      else if (to === '') delete map[from];
      else map[from] = to;
      return next;
    });
  };

  const setFallback = (key: string, value: string) => {
    setDraft((d) => {
      if (!d) return d;
      const next = JSON.parse(JSON.stringify(d)) as Draft;
      next.fallback[key as keyof Draft['fallback']] = value === NO_MAP ? '' : value;
      return next;
    });
  };

  const addEntry = (key: string) => {
    const from = (newFrom[key] ?? '').trim();
    if (!from) return;
    setDraft((d) => {
      if (!d) return d;
      const next = JSON.parse(JSON.stringify(d)) as Draft;
      const map = next[key as keyof Draft] as unknown as Record<string, string>;
      if (!Object.prototype.hasOwnProperty.call(map, from)) map[from] = '';
      return next;
    });
    setNewFrom((s) => ({ ...s, [key]: '' }));
  };

  const restoreDefault = () => {
    if (!base) return;
    setDraft(JSON.parse(JSON.stringify(base.defaults)) as Draft);
    setNotice(t('restoredHint'));
  };

  const changedCount = meta?.changed.length ?? 0;

  return (
    <div style={{ padding: '18px 22px 40px', maxWidth: 1120 }}>
      <div className="page-header" style={{ marginBottom: 14 }}>
        <div className="page-header-row" style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div className="page-eyebrow">{t('eyebrow')}</div>
            <h1 className="page-title">{t('title')}</h1>
            <div className="page-subtitle">{t('subtitle')}</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 7, flexShrink: 0 }}>
            <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => void load()}>
              {t('reload')}
            </button>
            <button
              className="btn btn-outline btn-sm"
              type="button"
              disabled={busy || !draft}
              onClick={() => void runPreview()}
            >
              {busy ? t('working') : t('preview')}
            </button>
            <button className="btn btn-primary btn-sm" type="button" disabled={busy || !draft} onClick={() => void save()}>
              {t('save')}
            </button>
          </div>
        </div>
      </div>

      {/* 🔴 影响面提示：改这里 = 改以后每个转档学生填什么 */}
      <div style={warnStyle}>{t('impactWarn')}</div>

      {err ? <div style={{ ...bannerStyle, borderColor: 'var(--danger)', color: 'var(--danger)' }}>{err}</div> : null}
      {notice ? <div style={{ ...bannerStyle, borderColor: 'var(--accent)', color: 'var(--accent)' }}>{notice}</div> : null}
      {loading ? <div style={panelStyle}>{t('loading')}</div> : null}

      {!loading && meta && draft ? (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <span className="chip chip-active">{changedCount ? t('customized', { n: changedCount }) : t('allDefault')}</span>
            {dirty ? <span className="chip">{t('unsaved')}</span> : null}
            <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={restoreDefault}>
              {t('restoreDefault')}
            </button>
          </div>

          {/* 配置里引用了档案选项里没有的值 —— 必须标红，否则界面上那栏会显示成"没值" */}
          {meta.invalid.length ? (
            <div style={{ ...bannerStyle, borderColor: 'var(--danger)', background: 'var(--danger-muted)' }}>
              <div className="notice-title">{t('invalidTitle')}</div>
              <div className="notice-detail">{meta.invalid.join('；')}</div>
            </div>
          ) : null}

          {/* 优先配这几条：出现次数最多的未配取值 */}
          {meta.topUnmapped.length ? (
            <div style={{ ...bannerStyle, borderColor: 'var(--gold)', background: 'var(--gold-muted)' }}>
              <div className="notice-title">{t('topUnmappedTitle')}</div>
              <div className="notice-detail">
                {meta.topUnmapped
                  .map((u) => `${labelIndexOf(meta, u.key)}「${u.from}」${u.count} 条`)
                  .join(' · ')}
              </div>
            </div>
          ) : null}

          {meta.fields.map((f) => (
            <FieldCard
              key={f.key}
              field={f}
              draft={draft}
              base={base}
              t={t as TFn}
              busy={busy}
              newFrom={newFrom[f.key] ?? ''}
              onNewFrom={(v) => setNewFrom((s) => ({ ...s, [f.key]: v }))}
              onAdd={() => addEntry(f.key)}
              onSet={(from, to) => setEntry(f.key, from, to)}
              onFallback={(v) => setFallback(f.key, v)}
            />
          ))}

          {meta.changed.length ? (
            <div style={{ ...panelStyle, marginTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{t('changedTitle')}</div>
              <div className="muted" style={{ fontSize: 11.5 }}>
                {meta.changed.join(' · ')}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function labelIndexOf(meta: WeilingMappingResult, key: string): string {
  return meta.fields.find((f) => f.key === key)?.weilingLabel ?? key;
}

function FieldCard(props: {
  field: WeilingMappingFieldView;
  draft: Draft;
  base: WeilingMappingResult | null;
  t: TFn;
  busy: boolean;
  newFrom: string;
  onNewFrom: (v: string) => void;
  onAdd: () => void;
  onSet: (from: string, to: string) => void;
  onFallback: (v: string) => void;
}) {
  const { field: f, draft, t } = props;
  const map = (draft[f.key as keyof Draft] ?? {}) as unknown as Record<string, string>;
  const baseField = props.base?.fields.find((x) => x.key === f.key);
  const pct = f.total ? Math.round((f.mapped / f.total) * 100) : 0;
  const unmappedSet = new Set(f.unmapped);

  return (
    <div style={{ ...panelStyle, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          {f.weilingLabel} <span className="muted" style={{ fontWeight: 400 }}>→</span> {f.archiveField}
        </div>
        <span className="chip chip-active">
          {t('coverage', { n: pct })}（{f.mapped}/{f.total}）
        </span>
        {f.unmapped.length ? <span className="chip">{t('unmappedCount', { n: f.unmapped.length })}</span> : null}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 3, lineHeight: 1.6 }}>
        {f.hint}
        <br />
        {t('sourceNote')}
        {f.weilingSource}
      </div>

      {/* 兜底 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{t('fallback')}</span>
        <select
          value={f.fallback || NO_MAP}
          disabled={props.busy}
          onChange={(e) => props.onFallback(e.target.value)}
          style={selectStyle}
        >
          <option value={NO_MAP}>{t('noFallback')}</option>
          {f.archiveOptions.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 11 }}>
          {t('fallbackHint')}
        </span>
      </div>

      {/* 逐条映射 */}
      <div style={{ marginTop: 9, borderTop: '1px solid var(--border)' }}>
        {f.entries.length ? (
          f.entries.map((e) => {
            const cur = Object.prototype.hasOwnProperty.call(map, e.from) ? (map[e.from] ?? '') : '';
            const changed = baseField ? baseField.entries.find((b) => b.from === e.from)?.to !== cur : false;
            return (
              <div key={e.from} style={entryRow}>
                <div style={{ minWidth: 0, flex: '1 1 240px', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={changed ? changedName : nameStyle} title={e.from}>
                    {e.from}
                  </span>
                  <span className="muted" style={{ fontSize: 11, flexShrink: 0 }}>
                    {e.count ? t('count', { n: e.count }) : t('notInData')}
                  </span>
                  {unmappedSet.has(e.from) ? <span style={warnChip}>{t('unmapped')}</span> : null}
                </div>
                <select
                  value={cur === '' && !Object.prototype.hasOwnProperty.call(map, e.from) ? '' : cur === '' ? NO_MAP : cur}
                  disabled={props.busy}
                  onChange={(ev) => props.onSet(e.from, ev.target.value)}
                  style={selectStyle}
                >
                  <option value="">{t('unset')}</option>
                  <option value={NO_MAP}>{t('explicitNone')}</option>
                  {f.archiveOptions.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>
            );
          })
        ) : (
          <div className="muted" style={{ fontSize: 11.5, padding: '8px 0' }}>
            {t('noValues')}
          </div>
        )}
      </div>

      {/* 手工补一条：卫瓴那边还没出现、但知道以后会有的取值 */}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          value={props.newFrom}
          disabled={props.busy}
          placeholder={t('addPlaceholder')}
          onChange={(e) => props.onNewFrom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') props.onAdd();
          }}
          style={inputStyle}
        />
        <button className="btn btn-ghost btn-sm" type="button" disabled={props.busy || !props.newFrom.trim()} onClick={props.onAdd}>
          {t('add')}
        </button>
      </div>
    </div>
  );
}

const panelStyle: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '14px 16px',
  boxShadow: '0 1px 2px rgba(23,74,69,.08)',
};
const warnStyle: CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderLeft: '3px solid var(--gold)',
  borderRadius: 8,
  padding: '9px 12px',
  fontSize: 12,
  color: 'var(--fg-secondary)',
  marginBottom: 10,
  lineHeight: 1.6,
};
const bannerStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '8px 12px',
  fontSize: 12.5,
  marginBottom: 10,
};
const entryRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 0',
  borderBottom: '1px solid var(--border)',
};
const nameStyle: CSSProperties = { fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const changedName: CSSProperties = { ...nameStyle, fontWeight: 700, color: 'var(--accent)' };
const selectStyle: CSSProperties = {
  fontSize: 12,
  padding: '4px 6px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--fg)',
  flexShrink: 0,
};
const inputStyle: CSSProperties = {
  fontSize: 12,
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--fg)',
  flex: '1 1 200px',
  maxWidth: 320,
};
const warnChip: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  color: 'var(--danger)',
  background: 'var(--danger-muted)',
  borderRadius: 4,
  padding: '1px 5px',
  flexShrink: 0,
};
