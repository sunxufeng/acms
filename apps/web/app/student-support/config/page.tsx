'use client';

/**
 * 信号规则配置页（`/student-support/config`，2026-09-30 v11）。
 *
 * 峰哥：「信号体系在哪里配置，有配置页面么？如果没有，在系统后台增加一个配置页面」
 *
 * ## 这一页在改什么
 *
 * 改的是**看板的判据本身**：七条信号的启用开关 · 六个阈值 · 问题词表 · 强词表。
 * 影响面是**全站每个人的看板**（一个宽词就能让半个学校上板）⇒ 权限点独立、
 * 默认只有系统管理员持有（`legacyRead: null`，不随版本迁移发放）。
 *
 * ## 🔴 为什么必须有「试算」
 *
 * 调阈值/加词是**高风险且不可直觉判断**的操作（本次调参实测：宽词表命中 56% → 收紧 27%）。
 * 所以本页不让人"盲存"：点「试算」会用**服务端同一份判据**跑一遍全站，
 * 并排给出「改前 / 改后」各条信号的命中人数与上板总人数，看清了再存。
 * ⚠️ 试算**不在前端估算** —— 前端估算必然与线上不一致（套件里记着"我的复算与线上差 5 倍"那次）。
 *
 * ## 文案来源
 *
 * 界面上的说明文字（每条信号的 hint、每个阈值的 hint）**由 contracts 带出来**
 * （`signals[].hint` / `numberFields[].hint`），本页不另抄一份 ——
 * 那些说明里写着"为什么默认是 3""实测命中 56%"这类背景，两处各写必然漂移。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import {
  SUPPORT_PROBLEM_TYPES,
  type SupportConfigPreview,
  type SupportConfigResult,
  type SupportSignalConfig,
  type SupportSignalKey,
} from '@acms/contracts';
import { api } from '../../../lib/api';

type Cfg = SupportSignalConfig;

export default function SupportConfigPage() {
  const t = useTranslations('supportConfig');

  const [meta, setMeta] = useState<SupportConfigResult | null>(null);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  /** 强词用**原始文本**存（否则一边打字一边被过滤，看起来像"词打不进去"） */
  const [strongRaw, setStrongRaw] = useState('');
  const [preview, setPreview] = useState<SupportConfigPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);

  /** 文本 → 词表（每行一个词；去空行、去重） */
  const parseLines = useCallback(
    (s: string): string[] => {
      const out: string[] = [];
      for (const raw of s.split('\n')) {
        const w = raw.trim();
        if (w && !out.includes(w)) out.push(w);
      }
      return out;
    },
    [],
  );

  const apply = useCallback(
    (r: SupportConfigResult) => {
      setMeta(r);
      setCfg(r.config);
      setStrongRaw(r.config.strongWords.join('\n'));
      setDirty(false);
    },
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await api.studentSupportConfig();
      apply(r);
      const p = await api.studentSupportConfigPreview(r.config);
      setPreview(p);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 当前草稿（提交给后端的一整份配置） */
  const draft = useMemo<Cfg | null>(
    () => (cfg ? { ...cfg, strongWords: parseLines(strongRaw) } : null),
    [cfg, strongRaw, parseLines],
  );

  /** 词表全集（算强词是否在词表里） */
  const wordSet = useMemo(() => {
    const s = new Set<string>();
    if (cfg) for (const ty of SUPPORT_PROBLEM_TYPES) for (const w of cfg.words[ty]) s.add(w);
    return s;
  }, [cfg]);

  /** 孤儿强词：不在任何类型词表里 ⇒ 永远匹配不上（保存时会被丢弃，这里提前告诉老师） */
  const orphanStrong = useMemo(
    () => (draft ? draft.strongWords.filter((w) => !wordSet.has(w)) : []),
    [draft, wordSet],
  );

  const patch = useCallback((p: Partial<Cfg>) => {
    setCfg((c) => (c ? { ...c, ...p } : c));
    setDirty(true);
    setNotice('');
  }, []);

  const setNum = useCallback(
    (key: keyof Cfg, v: string) => {
      const n = Math.round(Number(v));
      patch({ [key]: Number.isFinite(n) ? n : 0 } as Partial<Cfg>);
    },
    [patch],
  );

  const runPreview = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setErr('');
    try {
      setPreview(await api.studentSupportConfigPreview(draft));
      setNotice(t('previewDone'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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
      const r = await api.studentSupportConfigSave(draft);
      apply(r);
      setPreview(await api.studentSupportConfigPreview(r.config));
      setNotice(t('saved'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, apply, t]);

  const resetDefault = useCallback(() => {
    if (!meta) return;
    if (!window.confirm(t('resetConfirm'))) return;
    setCfg(meta.defaults);
    setStrongRaw(meta.defaults.strongWords.join('\n'));
    setDirty(true);
    setNotice(t('resetDone'));
  }, [meta, t]);

  const changedCount = meta?.changed.length ?? 0;

  return (
    <div style={{ padding: '18px 22px 40px', maxWidth: 1080 }}>
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
            <button className="btn btn-outline btn-sm" type="button" disabled={busy || !draft} onClick={() => void runPreview()}>
              {busy ? t('working') : t('preview')}
            </button>
            <button className="btn btn-primary btn-sm" type="button" disabled={busy || !draft} onClick={() => void save()}>
              {t('save')}
            </button>
          </div>
        </div>
      </div>

      {/* 🔴 影响面提示：改这里 = 改全站每个人的看板，必须让人看见 */}
      <div style={warnStyle}>{t('impactWarn')}</div>

      {err ? <div style={{ ...bannerStyle, borderColor: 'var(--danger)', color: 'var(--danger)' }}>{err}</div> : null}
      {notice ? <div style={{ ...bannerStyle, borderColor: 'var(--accent)', color: 'var(--accent)' }}>{notice}</div> : null}
      {loading ? <div style={panelStyle}>{t('loading')}</div> : null}

      {!loading && cfg && meta ? (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <span className="chip chip-active">
              {changedCount ? t('customized', { n: changedCount }) : t('allDefault')}
            </span>
            {dirty ? <span className="chip">{t('unsaved')}</span> : null}
          </div>

          {/* ── 一、信号开关 ── */}
          <Section title={t('secSignals')} desc={t('secSignalsDesc')}>
            {meta.signals.map((s) => (
              <div key={s.key} style={rowStyle}>
                <label style={swWrapStyle}>
                  <input
                    type="checkbox"
                    checked={cfg.enabled[s.key] !== false}
                    onChange={(e) =>
                      patch({ enabled: { ...cfg.enabled, [s.key as SupportSignalKey]: e.target.checked } })
                    }
                  />
                  <span style={{ fontWeight: 600, fontSize: 13 }}>
                    {s.icon} {s.label}
                  </span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {t('level', { lv: s.level })}
                  </span>
                </label>
                <div className="muted" style={hintStyle}>
                  {s.hint}
                </div>
                {preview ? (
                  <div style={countStyle}>
                    {t('hitCount', {
                      n: preview.bySignal.find((x) => x.key === s.key)?.count ?? 0,
                    })}
                  </div>
                ) : null}
              </div>
            ))}
          </Section>

          {/* ── 二、阈值 ── */}
          <Section title={t('secNumbers')} desc={t('secNumbersDesc')}>
            {meta.numberFields.map((f) => (
              <div key={f.key} style={rowStyle}>
                <label style={numWrapStyle}>
                  <span style={{ fontWeight: 600, fontSize: 13, width: 130, flexShrink: 0 }}>{f.label}</span>
                  <input
                    className="form-input"
                    type="number"
                    min={f.min}
                    max={f.max}
                    style={{ width: 92, flexShrink: 0 }}
                    value={String(cfg[f.key] ?? '')}
                    onChange={(e) => setNum(f.key as keyof Cfg, e.target.value)}
                  />
                  <span className="muted" style={{ fontSize: 11.5 }}>{f.unit}</span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    （{f.min} ~ {f.max}）
                  </span>
                </label>
                <div className="muted" style={hintStyle}>{f.hint}</div>
              </div>
            ))}
            {cfg.recentSilenceMinDays >= cfg.longSilenceDays ? (
              <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>
                {t('rangeConflict')}
              </div>
            ) : null}
          </Section>

          {/* ── 三、问题词表 ── */}
          <Section title={t('secWords')} desc={t('secWordsDesc', { max: meta.wordListMax })}>
            <div style={wordGridStyle}>
              {SUPPORT_PROBLEM_TYPES.map((ty) => (
                <div key={ty} style={wordCardStyle}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 5 }}>
                    <span style={{ fontWeight: 600, fontSize: 12.5 }}>{ty}</span>
                    <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }}>
                      {cfg.words[ty].length} {t('words')}
                    </span>
                  </div>
                  <textarea
                    style={taStyle}
                    spellCheck={false}
                    value={cfg.words[ty].join('\n')}
                    onChange={(e) =>
                      patch({
                        words: { ...cfg.words, [ty]: parseLines(e.target.value).slice(0, meta.wordListMax) },
                      })
                    }
                  />
                </div>
              ))}
            </div>
          </Section>

          {/* ── 四、强词 ── */}
          <Section title={t('secStrong')} desc={t('secStrongDesc')}>
            <textarea
              style={{ ...taStyle, height: 92 }}
              spellCheck={false}
              value={strongRaw}
              onChange={(e) => {
                setStrongRaw(e.target.value);
                setDirty(true);
                setNotice('');
              }}
            />
            <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
              {t('strongCount', { n: draft?.strongWords.length ?? 0, inList: draft?.strongWords.length ? draft.strongWords.filter((w) => wordSet.has(w)).length : 0 })}
            </div>
            {orphanStrong.length ? (
              <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>
                {t('orphanStrong', { words: orphanStrong.join('、') })}
              </div>
            ) : null}
          </Section>

          {/* ── 五、试算结果 ── */}
          <Section title={t('secPreview')} desc={t('secPreviewDesc')}>
            {!preview ? (
              <div className="muted" style={{ fontSize: 12 }}>{t('previewEmpty')}</div>
            ) : (
              <>
                <div style={cmpHeadStyle}>
                  <span style={{ width: 180 }} />
                  <span style={cmpCellStyle}>{t('before')}</span>
                  <span style={cmpCellStyle}>{t('after')}</span>
                </div>
                <div style={cmpRowStyle}>
                  <span style={cmpLabelStyle}>{t('onBoard')}</span>
                  <span style={cmpCellStyle}>{preview.before.onBoard}</span>
                  <span style={{ ...cmpCellStyle, fontWeight: 700 }}>{preview.onBoard}</span>
                </div>
                <div style={cmpRowStyle}>
                  <span style={cmpLabelStyle}>{t('total')}</span>
                  <span style={cmpCellStyle}>{preview.before.total}</span>
                  <span style={cmpCellStyle}>{preview.total}</span>
                </div>
                {preview.bySignal.map((x) => {
                  const b = preview.before.bySignal.find((y) => y.key === x.key)?.count ?? 0;
                  const up = x.count - b;
                  return (
                    <div key={x.key} style={cmpRowStyle}>
                      <span style={cmpLabelStyle}>{x.label}</span>
                      <span style={cmpCellStyle}>{b}</span>
                      <span style={{ ...cmpCellStyle, fontWeight: 700 }}>
                        {x.count}
                        {up ? (
                          <span style={{ color: up > 0 ? 'var(--danger)' : '#1a7f5a', fontSize: 11, marginLeft: 5 }}>
                            {up > 0 ? `+${up}` : up}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
                <div style={{ ...cmpRowStyle, borderTop: '1px solid var(--border)', marginTop: 4 }}>
                  <span style={cmpLabelStyle}>{t('byLevel')}</span>
                  <span style={cmpCellStyle} />
                  <span style={{ ...cmpCellStyle, textAlign: 'left' }}>
                    {preview.byLevel
                      .filter((g) => g.count > 0)
                      .map((g) => `${g.label} ${g.count}`)
                      .join(' · ') || '—'}
                  </span>
                </div>
              </>
            )}
          </Section>

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="btn btn-outline btn-sm" type="button" disabled={busy} onClick={resetDefault}>
              {t('resetDefault')}
            </button>
            <span className="muted" style={{ fontSize: 11.5, alignSelf: 'center' }}>{t('resetHint')}</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ───────────────────────── 子组件与样式 ─────────────────────────

function Section(props: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div style={{ ...panelStyle, marginBottom: 12 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{props.title}</div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{props.desc}</div>
      </div>
      {props.children}
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
  borderLeft: '3px solid var(--danger)',
  borderRadius: 8,
  padding: '9px 12px',
  fontSize: 12,
  color: 'var(--fg-secondary)',
  marginBottom: 10,
};
const bannerStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '8px 12px',
  fontSize: 12.5,
  marginBottom: 10,
};
const rowStyle: CSSProperties = { padding: '7px 0', borderTop: '1px solid var(--border)' };
const swWrapStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' };
const numWrapStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const hintStyle: CSSProperties = { fontSize: 11.5, marginTop: 3, lineHeight: 1.55 };
const countStyle: CSSProperties = { fontSize: 11.5, marginTop: 3, color: 'var(--accent)', fontWeight: 600 };
const wordGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))',
  gap: 8,
};
const wordCardStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '8px 9px',
  background: 'var(--bg-subtle)',
};
const taStyle: CSSProperties = {
  width: '100%',
  height: 132,
  resize: 'vertical',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11.5,
  lineHeight: 1.6,
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--fg)',
};
const cmpHeadStyle: CSSProperties = { display: 'flex', alignItems: 'center', fontSize: 11, color: 'var(--fg-tertiary)' };
const cmpRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', fontSize: 12.5, padding: '4px 0' };
const cmpLabelStyle: CSSProperties = { width: 180, color: 'var(--fg-secondary)' };
const cmpCellStyle: CSSProperties = { width: 90, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
