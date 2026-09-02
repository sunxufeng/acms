'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTl } from '../lib/useTl';
import { api } from '../lib/api';

const METHOD_OPTS = ['线下', '线上', '混合'];
const STATUS_OPTS = ['待确认', '已确认', '已完成', '已取消', '已调课'];

interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'date' | 'select' | 'textarea';
  required?: boolean;
  options?: string[];
  placeholder?: string;
}

const FIELDS: FieldDef[] = [
  { key: '课次名称', label: '课次名称', type: 'text', required: true },
  { key: '教学班文本', label: '教学班', type: 'text' },
  { key: '授课教师文本', label: '授课教师', type: 'text' },
  { key: '场地文本', label: '场地', type: 'text' },
  { key: '课次日期', label: '课次日期', type: 'date' },
  { key: '开始时间', label: '开始时间', type: 'text', placeholder: 'HH:mm' },
  { key: '结束时间', label: '结束时间', type: 'text', placeholder: 'HH:mm' },
  { key: '授课方式', label: '授课方式', type: 'select', options: METHOD_OPTS },
  { key: '课次状态', label: '课次状态', type: 'select', options: STATUS_OPTS },
];

export function SessionForm({
  initial,
  onSubmit,
}: {
  initial?: Record<string, unknown>;
  onSubmit: (data: Record<string, unknown>) => void;
}) {
  const tl = useTl();
  const t = useTranslations('academic');
  const tc = useTranslations('common');
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of FIELDS) {
      const raw = initial?.[f.key];
      if (f.key === '课次状态') {
        v[f.key] = raw ? String(raw) : initial ? '' : '待确认';
      } else {
        v[f.key] = raw ? String(raw) : '';
      }
    }
    return v;
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const setField = (key: string, val: string) => setValues((p) => ({ ...p, [key]: val }));

  const buildData = (): Record<string, unknown> => {
    const data: Record<string, unknown> = {};
    for (const f of FIELDS) {
      const val = values[f.key];
      if (f.type === 'select') {
        if (val) data[f.key] = val;
      } else if (val && val.trim()) {
        data[f.key] = val.trim();
      }
    }
    return data;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!values['课次名称']?.trim()) {
      setErr('请填写课次名称');
      return;
    }
    const data = buildData();
    setSaving(true);
    setErr('');
    try {
      if (initial?.id) {
        await api.updateSession(String(initial.id), data);
      } else {
        await api.createSession(data);
      }
      onSubmit(data);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <fieldset className="form-fieldset">
        <legend className="form-legend">{t('legendSessionInfo')}</legend>
        <div className="form-grid">
          {FIELDS.map((f) => (
            <label key={f.key} className="form-label">
              <span className="form-label-text">
                {f.label}
                {f.required && <span style={{ color: 'var(--danger)' }}> *</span>}
              </span>
              {f.type === 'select' ? (
                <select
                  className="form-input"
                  value={values[f.key]}
                  onChange={(e) => setField(f.key, e.target.value)}
                >
                  <option value="">（未填）</option>
                  {f.options?.map((o) => (
                    <option key={o} value={o}>{tl(o)}</option>
                  ))}
                </select>
              ) : f.type === 'textarea' ? (
                <textarea
                  className="form-input"
                  rows={3}
                  value={values[f.key]}
                  placeholder={f.placeholder}
                  onChange={(e) => setField(f.key, e.target.value)}
                />
              ) : (
                <input
                  className="form-input"
                  type={f.type === 'date' ? 'date' : 'text'}
                  value={values[f.key]}
                  placeholder={f.placeholder}
                  onChange={(e) => setField(f.key, e.target.value)}
                />
              )}
            </label>
          ))}
        </div>
      </fieldset>

      {err && <p className="msg-error">{err}</p>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 8 }}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? tc('saving') : tc('save')}
        </button>
      </div>
    </form>
  );
}
