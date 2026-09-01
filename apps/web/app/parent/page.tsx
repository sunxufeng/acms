'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import MobileBindCard from '../../components/MobileBindCard';

const API = '/api/v1';

/** 家长 H5 专用请求：带 cookie、不触发 api.ts 的 401→/login 跳转 */
async function preq(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    const e = new Error('UNAUTHENTICATED') as Error & { code?: string };
    e.code = 'UNAUTHENTICATED';
    throw e;
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const t = await res.text();
      const b = JSON.parse(t);
      msg = b?.error?.message || b?.message || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

function fmt(v: unknown): string {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.join('、');
  return String(v);
}

export default function ParentPage() {
  const t = useTranslations('bind');
  const [stage, setStage] = useState<'checking' | 'bind' | 'dashboard'>('checking');
  const [bindErr, setBindErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [attendances, setAttendances] = useState<Record<string, unknown>[]>([]);
  const [attLoading, setAttLoading] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [contact, setContact] = useState('');
  const [fbMsg, setFbMsg] = useState('');
  // 用布尔状态区分成功/失败，替代原先「fbMsg 里是否含『已提交』」的中文子串判断
  const [fbOk, setFbOk] = useState(false);
  const [fbBusy, setFbBusy] = useState(false);

  useEffect(() => {
    preq('/auth/me')
      .then((me) => {
        if (me?.roles?.includes('parent')) setStage('dashboard');
        else setStage('bind');
      })
      .catch(() => setStage('bind'));
  }, []);

  useEffect(() => {
    if (stage === 'dashboard') loadAttendances();
  }, [stage]);

  async function loadAttendances() {
    setAttLoading(true);
    try {
      const r = await preq('/parent/attendances');
      setAttendances(r.items || []);
    } catch {
      setAttendances([]);
    } finally {
      setAttLoading(false);
    }
  }

  async function doBind(studentNo: string, name: string) {
    setBusy(true);
    setBindErr('');
    try {
      await preq('/parent/auth/bind', {
        method: 'POST',
        body: JSON.stringify({ studentNo, name }),
      });
      setStage('dashboard');
    } catch (e) {
      setBindErr((e as Error).message || t('bindFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function doFeedback() {
    if (!feedback.trim()) {
      setFbOk(false);
      setFbMsg(t('feedbackRequired'));
      return;
    }
    setFbBusy(true);
    setFbMsg('');
    try {
      await preq('/parent/feedback', {
        method: 'POST',
        body: JSON.stringify({ content: feedback, contact: contact || undefined }),
      });
      setFbOk(true);
      setFbMsg(t('submitted'));
      setFeedback('');
      setContact('');
    } catch (e) {
      setFbOk(false);
      setFbMsg((e as Error).message || t('submitFailed'));
    } finally {
      setFbBusy(false);
    }
  }

  if (stage === 'checking') {
    return (
      <div className="mobile-page">
        <div className="card mobile-card">
          <p className="muted">{t('loading')}</p>
        </div>
      </div>
    );
  }

  if (stage === 'bind') {
    return (
      <MobileBindCard
        title={t('parentBindTitle')}
        description={t('parentBindDesc')}
        submitLabel={t('bind')}
        busyLabel={t('binding')}
        busy={busy}
        error={bindErr}
        onSubmit={doBind}
      />
    );
  }

  return (
    <div className="mobile-page">
      <div className="card mobile-card">
        <h1 className="mobile-title">{t('attendanceTitle')}</h1>
        {attLoading && <p className="muted">{t('loading')}</p>}
        {!attLoading && attendances.length === 0 && <p className="muted">{t('noAttendance')}</p>}
        {attendances.map((a, i) => (
          <div key={i} className="mobile-row">
            {/* 考勤日期 / 方向 / 考勤状态 / 签到方式 / 校区 / 签到距离(米) 是飞书列名，属数据键，不做 i18n */}
            <div className="mobile-row-title">
              {fmt(a['考勤日期'])} · {fmt(a['方向'])}
            </div>
            <div className="muted">
              {t('status')} {fmt(a['考勤状态'])} · {t('method')} {fmt(a['签到方式'])} · {t('campus')} {fmt(a['校区'])}
              {a['签到距离(米)'] != null ? ` · ${fmt(a['签到距离(米)'])} ${t('meters')}` : ''}
            </div>
          </div>
        ))}
        <div className="mobile-actions">
          <button type="button" className="btn btn-outline mobile-btn" onClick={loadAttendances}>
            {t('refresh')}
          </button>
        </div>
      </div>

      <div className="card mobile-card">
        <h1 className="mobile-title">{t('feedbackTitle')}</h1>
        <input
          className="form-input mobile-field"
          placeholder={t('contactPlaceholder')}
          value={contact}
          onChange={(e) => setContact(e.target.value)}
        />
        <textarea
          className="form-input mobile-field mobile-textarea"
          placeholder={t('feedbackPlaceholder')}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        {fbMsg && <p className={fbOk ? 'msg-success' : 'msg-error'}>{fbMsg}</p>}
        <button type="button" className="btn btn-primary mobile-btn" onClick={doFeedback} disabled={fbBusy}>
          {fbBusy ? t('submitting') : t('submit')}
        </button>
      </div>
    </div>
  );
}
