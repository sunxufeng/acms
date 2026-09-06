'use client';

import { useEffect, useMemo, useState } from 'react';
import type { NoteConvertTarget } from '@acms/contracts';
import { api } from '../../lib/api';
import { fieldsForMenu } from '../../lib/moduleFields';
import { useTl } from '../../lib/useTl';
import { useTranslations } from 'next-intl';

/** 手工新增一行（用于登记还没进菜单的新功能） */
function emptyTarget(): NoteConvertTarget {
  return {
    key: `note_conv_${Date.now()}`,
    label: '新功能',
    enLabel: '',
    href: '/',
    enabled: false,
    summaryField: '',
    rawField: '',
    order: 9999,
    custom: true,
  };
}

export default function NoteConvertPage() {
  const tl = useTl();
  const ts = useTranslations('settings');
  const tc = useTranslations('common');
  const tnc = useTranslations('noteConvert');

  const [items, setItems] = useState<NoteConvertTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [q, setQ] = useState('');
  const [onlyEnabled, setOnlyEnabled] = useState(false);

  useEffect(() => {
    api
      .getNoteConvert()
      .then((d) => {
        if (Array.isArray(d?.items)) setItems(d.items);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  /** 列表顺序：已启用的排在前面（管理员最关心），其余按 order */
  const view = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return items
      .filter((it) => {
        if (onlyEnabled && !it.enabled) return false;
        if (!kw) return true;
        return [it.label, it.enLabel ?? '', it.href, it.summaryField, it.rawField]
          .join(' ')
          .toLowerCase()
          .includes(kw);
      })
      .slice()
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return (a.order ?? 0) - (b.order ?? 0);
      });
  }, [items, q, onlyEnabled]);

  /** 按 view 里的下标找到 items 里的真实下标再改（view 是过滤+排序后的） */
  function updateView(idxInView: number, patch: Partial<NoteConvertTarget>) {
    const target = view[idxInView];
    if (!target) return;
    setItems((prev) => prev.map((it) => (it.key === target.key ? { ...it, ...patch } : it)));
  }

  function removeView(idxInView: number) {
    const target = view[idxInView];
    if (!target) return;
    if (!confirm(tnc('confirmDelete'))) return;
    setItems((prev) => prev.filter((it) => it.key !== target.key));
  }

  async function handleSave() {
    setSaving(true);
    setToast(null);
    try {
      // 按当前列表顺序重排 order，保证候选弹窗里的顺序可预期
      const normalized = items.map((it, i) => ({ ...it, order: (i + 1) * 10 }));
      await api.updateNoteConvert({ items: normalized });
      setItems(normalized);
      setToast({ ok: true, text: tnc('saveSuccess') });
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      setToast({
        ok: false,
        text: tnc('saveFailed', { msg: err instanceof Error ? err.message : ts('unknownError') }),
      });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div style={{ padding: 40, color: 'var(--fg-secondary)' }}>{tl('加载中…')}</div>;
  }

  const enabledCount = items.filter((i) => i.enabled).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div className="page-title">{tl('转换配置')}</div>
          <div className="page-subtitle">{tnc('subtitle')}</div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => setItems((prev) => [...prev, emptyTarget()])}
          >
            + {tnc('addTarget')}
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? tc('saving') : ts('saveMenu')}
          </button>
        </div>
      </div>

      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <input
            className="input"
            placeholder={tnc('searchPlaceholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          <label
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={onlyEnabled}
              onChange={(e) => setOnlyEnabled(e.target.checked)}
            />
            {tnc('onlyEnabled')}
          </label>
          <span style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>
            {tnc('countHint', { enabled: enabledCount, total: items.length })}
          </span>
          {toast && (
            <span
              style={{
                fontSize: 12,
                color: toast.ok ? 'var(--success)' : 'var(--fg-error)',
                marginLeft: 'auto',
              }}
            >
              {toast.text}
            </span>
          )}
        </div>

        <div style={{ overflowX: 'auto', maxHeight: '64vh' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: 'var(--fg-secondary)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 120 }}>{tl('菜单名')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 130 }}>{tl('英文名')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 150 }}>{tl('菜单路径')}</th>
                <th style={{ textAlign: 'center', padding: '8px 10px', width: 90 }}>{tnc('enabled')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 150 }}>
                  {tnc('summaryField')}
                </th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 150 }}>
                  {tnc('rawField')}
                </th>
                <th style={{ textAlign: 'center', padding: '8px 10px', width: 70 }}>{tl('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {view.map((it, idx) => {
                const cands = fieldsForMenu(it.key);
                return (
                  <tr key={it.key} style={{ borderBottom: '1px solid var(--border)' }}>
                    {/* 菜单自带项的名称/英文名/路径只读：后端读取时会以菜单配置为准同步，改了也会被覆盖 */}
                    <td style={{ padding: '6px 10px' }}>
                      {it.custom ? (
                        <input
                          className="form-input"
                          value={it.label}
                          onChange={(e) => updateView(idx, { label: e.target.value })}
                        />
                      ) : (
                        <span style={{ fontWeight: it.enabled ? 700 : 400 }}>{it.label}</span>
                      )}
                    </td>
                    <td style={{ padding: '6px 10px' }}>
                      {it.custom ? (
                        <input
                          className="form-input"
                          value={it.enLabel ?? ''}
                          onChange={(e) => updateView(idx, { enLabel: e.target.value })}
                        />
                      ) : (
                        <span style={{ color: 'var(--fg-tertiary)' }}>{it.enLabel || '—'}</span>
                      )}
                    </td>
                    <td style={{ padding: '6px 10px' }}>
                      {it.custom ? (
                        <input
                          className="form-input"
                          value={it.href}
                          onChange={(e) => updateView(idx, { href: e.target.value })}
                        />
                      ) : (
                        <span style={{ color: 'var(--fg-tertiary)', fontFamily: 'monospace', fontSize: 12 }}>
                          {it.href}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={it.enabled}
                        onChange={(e) => updateView(idx, { enabled: e.target.checked })}
                        aria-label={tnc('enabled')}
                      />
                    </td>
                    <FieldCell
                      id={`${it.key}-summary`}
                      value={it.summaryField}
                      candidates={cands}
                      placeholder={tnc('notSet')}
                      onChange={(v) => updateView(idx, { summaryField: v })}
                    />
                    <FieldCell
                      id={`${it.key}-raw`}
                      value={it.rawField}
                      candidates={cands}
                      placeholder={tnc('notSet')}
                      onChange={(v) => updateView(idx, { rawField: v })}
                    />
                    <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => removeView(idx)}
                        title={tl('删除')}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
              {view.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--fg-tertiary)' }}>
                    {q || onlyEnabled ? tnc('noMatch') : tnc('empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/**
 * 字段单元格：有候选字段时用 datalist 提供下拉建议，同时**允许自由输入**
 * （应对注册表没覆盖到的新模块）；没有候选时自动降级为普通文本框。
 * 比纯下拉更灵活，也比纯手填更不容易写错字段名。
 */
function FieldCell({
  id,
  value,
  candidates,
  placeholder,
  onChange,
}: {
  id: string;
  value: string;
  candidates: string[];
  placeholder: string;
  onChange: (v: string) => void;
}) {
  const listId = `fld-${id}`;
  return (
    <td style={{ padding: '6px 10px' }}>
      <input
        className="form-input"
        list={listId}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {candidates.length > 0 && (
        <datalist id={listId}>
          {candidates.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      )}
    </td>
  );
}
