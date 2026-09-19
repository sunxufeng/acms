'use client';

import { useCallback, useEffect, useState } from 'react';
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

type Child = { id: string; 姓名: string; 学号: string; 校区: string };
type Tab = 'attendance' | 'grades' | 'homework' | 'comms' | 'feedback';

/**
 * 家长 H5 端（2026-09-19，issue #2 落地）。
 *
 * 四件事的落点：
 *  1. **多子女切换**：绑定手机号后，同一家长名下可绑多个孩子；
 *     顶部出现子女切换条（只有一个孩子时不显示，避免多一个无意义控件）。
 *  2. **自助查询**：考勤 / 成绩 / 作业 / 沟通记录四个页签。
 *  3. **可见性**：四个查询全部由服务端按「家长可见 + 完成闸门」过滤
 *     （学生可见的成绩、未过闸门的成绩、教师内部跟进记录都不会返回）。
 *     ⇒ 家长看到的比老师少是**正常**的，不是加载失败；页面上也不再做二次过滤。
 *  4. 反馈仍然写回「家校沟通」记录（三合一后带记录类型，老师那边能看见）。
 */
export default function ParentPage() {
  const t = useTranslations('bind');
  const [stage, setStage] = useState<'checking' | 'bind' | 'dashboard' | 'addChild'>('checking');
  const [bindErr, setBindErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [children, setChildren] = useState<Child[]>([]);
  const [currentId, setCurrentId] = useState('');
  const [multi, setMulti] = useState(false);
  const [tab, setTab] = useState<Tab>('attendance');

  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [listLoading, setListLoading] = useState(false);

  const [feedback, setFeedback] = useState('');
  const [contact, setContact] = useState('');
  const [fbMsg, setFbMsg] = useState('');
  // 用布尔状态区分成功/失败，替代「fbMsg 里是否含『已提交』」的中文子串判断
  const [fbOk, setFbOk] = useState(false);
  const [fbBusy, setFbBusy] = useState(false);

  useEffect(() => {
    preq('/auth/me')
      .then((me) => {
        if (me?.roles?.includes('parent')) {
          setStage('dashboard');
          void loadChildren();
        } else setStage('bind');
      })
      .catch(() => setStage('bind'));
  }, []);

  /** 子女列表：拿到 current 后用服务端给的「当前子女」对齐，避免前端猜 */
  const loadChildren = useCallback(async () => {
    try {
      const r = await preq('/parent/children');
      setChildren(r?.items ?? []);
      setMulti(Boolean(r?.multi));
      setCurrentId(String(r?.current ?? ''));
    } catch {
      setChildren([]);
      setMulti(false);
    }
  }, []);

  /** 四个页签走同一批端点，只有路径不同 */
  const PATH: Record<Exclude<Tab, 'feedback'>, string> = {
    attendance: '/parent/attendances',
    grades: '/parent/grades',
    homework: '/parent/homework',
    comms: '/parent/comms',
  };

  const loadList = useCallback(async (which: Tab) => {
    if (which === 'feedback') return;
    setListLoading(true);
    try {
      const r = await preq(PATH[which]);
      setRows(r?.items ?? []);
    } catch {
      setRows([]);
    } finally {
      setListLoading(false);
    }
  }, []);

  // 切页签 / 切子女都要重新拉（切子女后服务端按新 studentId 返回，前端不做本地过滤）
  useEffect(() => {
    if (stage === 'dashboard') void loadList(tab);
  }, [stage, tab, currentId, loadList]);

  async function doBind(studentNo: string, name: string, phone?: string) {
    setBusy(true);
    setBindErr('');
    try {
      await preq('/parent/auth/bind', {
        method: 'POST',
        body: JSON.stringify({ studentNo, name, phone }),
      });
      await loadChildren();
      setStage('dashboard');
      setTab('attendance');
    } catch (e) {
      setBindErr((e as Error).message || t('bindFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function doSwitch(id: string) {
    if (id === currentId) return;
    try {
      await preq('/parent/children/switch', { method: 'POST', body: JSON.stringify({ studentId: id }) });
      setCurrentId(id);
      // 页签数据由上面的 effect 重新拉取（currentId 变了）
    } catch (e) {
      setBindErr((e as Error).message || t('bindFailed'));
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
        showPhone
        onSubmit={doBind}
      />
    );
  }

  if (stage === 'addChild') {
    return (
      <MobileBindCard
        title={t('addChildTitle')}
        description={t('addChildDesc')}
        submitLabel={t('bind')}
        busyLabel={t('binding')}
        busy={busy}
        error={bindErr}
        showPhone
        onSubmit={doBind}
      >
        <button type="button" className="btn btn-outline mobile-btn" onClick={() => setStage('dashboard')}>
          {t('back')}
        </button>
      </MobileBindCard>
    );
  }

  const cur = children.find((c) => c.id === currentId);
  const TABS: { key: Tab; label: string }[] = [
    { key: 'attendance', label: t('tabAttendance') },
    { key: 'grades', label: t('tabGrades') },
    { key: 'homework', label: t('tabHomework') },
    { key: 'comms', label: t('tabComms') },
    { key: 'feedback', label: t('tabFeedback') },
  ];

  return (
    <div className="mobile-page">
      <div className="card mobile-card">
        {/* 当前子女：把「现在看的是哪个孩子」写在最上面 —— 多子女时最关键的信息 */}
        <h1 className="mobile-title">{cur ? `${cur.姓名}` : t('parentTitle')}</h1>
        {cur && <p className="mobile-desc">{`${t('studentNo')} ${fmt(cur.学号)}${cur.校区 ? ` · ${cur.校区}` : ''}`}</p>}

        {multi && (
          <div className="mobile-actions" style={{ flexWrap: 'wrap' }}>
            {children.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`btn mobile-btn ${c.id === currentId ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => doSwitch(c.id)}
              >
                {c.姓名}
              </button>
            ))}
            <button type="button" className="btn btn-outline mobile-btn" onClick={() => setStage('addChild')}>
              {t('addChild')}
            </button>
          </div>
        )}
        {!multi && (
          <button type="button" className="btn btn-outline mobile-btn" onClick={() => setStage('addChild')}>
            {t('addChild')}
          </button>
        )}

        <div className="mobile-actions" style={{ flexWrap: 'wrap' }}>
          {TABS.map((x) => (
            <button
              key={x.key}
              type="button"
              className={`btn mobile-btn ${tab === x.key ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setTab(x.key)}
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>

      {tab !== 'feedback' && (
        <div className="card mobile-card">
          {listLoading && <p className="muted">{t('loading')}</p>}
          {!listLoading && rows.length === 0 && (
            <p className="muted">
              {tab === 'attendance' && t('noAttendance')}
              {tab === 'grades' && t('noGrades')}
              {tab === 'homework' && t('noHomework')}
              {tab === 'comms' && t('noComms')}
            </p>
          )}

          {!listLoading &&
            tab === 'attendance' &&
            rows.map((a, i) => (
              <div key={i} className="mobile-row">
                {/* 飞书列名属数据键，不做 i18n */}
                <div className="mobile-row-title">
                  {fmt(a['考勤日期'])} · {fmt(a['方向'])}
                </div>
                <div className="muted">
                  {t('status')} {fmt(a['考勤状态'])} · {t('method')} {fmt(a['签到方式'])} · {t('campus')}{' '}
                  {fmt(a['校区'])}
                </div>
              </div>
            ))}

          {!listLoading &&
            tab === 'grades' &&
            rows.map((g, i) => (
              <div key={i} className="mobile-row">
                <div className="mobile-row-title">
                  {fmt(g['列名称'])}
                  {g['科目'] ? ` · ${fmt(g['科目'])}` : ''}
                </div>
                <div className="muted">
                  {fmt(g['考核日期'])} · {t('score')} {fmt(g['得分'])}
                  {g['满分'] ? `/${fmt(g['满分'])}` : ''}
                  {g['等级'] ? ` · ${t('level')} ${fmt(g['等级'])}` : ''}
                  {g['考核类型'] ? ` · ${fmt(g['考核类型'])}` : ''}
                </div>
                {g['评语'] ? <div className="muted">{fmt(g['评语'])}</div> : null}
              </div>
            ))}

          {!listLoading &&
            tab === 'homework' &&
            rows.map((h, i) => (
              <div key={i} className="mobile-row">
                <div className="mobile-row-title">
                  {fmt(h['课题'])}
                  {h['备课日期'] ? ` · ${fmt(h['备课日期'])}` : ''}
                </div>
                <div className="muted">{fmt(h['作业布置'])}</div>
              </div>
            ))}

          {!listLoading &&
            tab === 'comms' &&
            rows.map((c, i) => (
              <div key={i} className="mobile-row">
                <div className="mobile-row-title">
                  {fmt(c['沟通时间'])} · {fmt(c['沟通主题'])}
                </div>
                <div className="muted">
                  {fmt(c['沟通人'])}
                  {c['闭环状态'] ? ` · ${fmt(c['闭环状态'])}` : ''}
                </div>
                {c['沟通总结'] ? <div className="muted">{fmt(c['沟通总结'])}</div> : null}
              </div>
            ))}

          <div className="mobile-actions">
            <button
              type="button"
              className="btn btn-outline mobile-btn"
              onClick={() => void loadList(tab)}
              disabled={listLoading}
            >
              {t('refresh')}
            </button>
          </div>
        </div>
      )}

      {tab === 'feedback' && (
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
      )}
    </div>
  );
}
