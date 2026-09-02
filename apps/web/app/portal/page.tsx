'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import { useTranslations } from 'next-intl';

type Tab = 'profile' | 'schedule' | 'grades' | 'teachers' | 'attendance';

const TABS: { key: Tab; label: string }[] = [
  { key: 'profile', label: '本人档案' },
  { key: 'schedule', label: '周课表' },
  { key: 'grades', label: '成绩' },
  { key: 'teachers', label: '授课教师' },
  { key: 'attendance', label: '考勤' },
];

const PROFILE_FIELDS = [
  '学生姓名', '学籍号', '当前学段', '入学年级', '当前年级', '校区', '当前状态',
  '性别', '出生日期', '入学日期', '预计毕业日期', '国籍或地区', '民族', '证件号码（脱敏）',
  '学生手机号', '学生邮箱', '现居住地址', '健康风险摘要', '数据密级',
];

function val(v: unknown): string {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

export default function PortalPage() {
  const t = useTranslations('common');
  const tp = useTranslations('portal');
  const tl = useTl();
  const [tab, setTab] = useState<Tab>('profile');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<{ name: string } | null>(null);
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  const [schedule, setSchedule] = useState<Record<string, unknown>[]>([]);
  const [grades, setGrades] = useState<Record<string, unknown>[]>([]);
  const [teachers, setTeachers] = useState<Record<string, unknown>[]>([]);
  const [attendances, setAttendances] = useState<Record<string, unknown>[]>([]);
  const [signing, setSigning] = useState(false);
  const [signToast, setSignToast] = useState<string | null>(null);

  useEffect(() => {
    api.me().then((m) => setMe(m as { name: string })).catch(() => {});
  }, []);

  useEffect(() => { void load(tab); }, [tab]);

  async function logout() {
    try {
      await api.studentLogout();
    } catch {
      /* 忽略错误，直接跳转 */
    }
    window.location.href = '/student-login';
  }

  async function load(t: Tab) {
    setLoading(true);
    setError(null);
    try {
      if (t === 'profile') setProfile(await api.portalMe() as Record<string, unknown>);
      else if (t === 'schedule') setSchedule((await api.portalSchedule()).items);
      else if (t === 'grades') setGrades((await api.portalGrades()).items);
      else if (t === 'teachers') setTeachers((await api.portalTeachers()).items);
      else if (t === 'attendance') setAttendances((await api.portalAttendances()).items);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '加载失败';
      setError(msg.includes('FORBIDDEN') || msg.includes('未关联') ? tp('notLinkedToStudent') : msg);
    } finally {
      setLoading(false);
    }
  }

  /** 一键打卡：优先 GPS，失败则按 WiFi 方式（浏览器无法读取 WiFi，记录异常待教师标记） */
  async function handleSign() {
    setSigning(true);
    setSignToast(null);
    try {
      const pos = await new Promise<GeolocationPosition | null>((resolve) => {
        if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (p) => resolve(p),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 8000 },
        );
      });
      const data = pos
        ? { mode: 'gps' as const, gps: `${pos.coords.latitude},${pos.coords.longitude}` }
        : { mode: 'wifi' as const };
      const res = await api.portalSign(data);
      if (res.duplicated) {
        setSignToast(`${tp('alreadySignedToday')}${res.direction === '到达' ? tp('arrived') : tp('left')}${tp('noNeedRepeat')}`);
      } else {
        const status = res.passed ? tp('signSuccessInFence') : tp('signRecordedOutFence');
        setSignToast(tp('signResult', { dir: res.direction === '到达' ? tp('arrived') : tp('left'), status }));
      }
      if (tab === 'attendance') void load('attendance');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '打卡失败';
      setSignToast(tp('signFailed', { msg }));
    } finally {
      setSigning(false);
      setTimeout(() => setSignToast(null), 4000);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tp('pageTitle')}</h1>
          <p className="page-subtitle">{tp('pageSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {me?.name && <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>{me.name}</span>}
          <button className="btn btn-primary" style={{ borderRadius: 999 }} onClick={handleSign} disabled={signing}>
            {signing ? tp('signing') : tp('signNow')}
          </button>
          <button className="filter-select-trigger" style={{ borderRadius: 999 }} onClick={logout}>
            退出
          </button>
        </div>
      </div>

      <div className="filter-bar" style={{ marginBottom: 'var(--space-md)' }}>
        {TABS.map((t) => (
          <button key={t.key} className={`filter-select-trigger${tab === t.key ? ' active' : ''}`}
            style={{ borderRadius: 999, border: `1px solid ${tab === t.key ? 'var(--accent)' : 'var(--border)'}`, background: tab === t.key ? 'var(--accent-soft)' : 'transparent' }}
            onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {signToast && <div className="toast">{signToast}</div>}
      {error && <p className="msg-error">{error}</p>}
      {loading && <div className="empty-state"><div className="empty-state-text">{t('loading')}</div></div>}

      {!loading && !error && tab === 'profile' && profile && (
        <div className="data-table-wrap" style={{ padding: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '14px 28px' }}>
            {PROFILE_FIELDS.map((f) => (
              <div key={f} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{f}</span>
                <span style={{ fontWeight: 500 }}>{val(profile[f])}</span>
              </div>
            ))}
          </div>
          {!!profile['摘要'] && (
            <div style={{ marginTop: 18 }}>
              <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{t('summary')}</span>
              <p style={{ margin: '4px 0 0', lineHeight: 1.6 }}>{val(profile['摘要'])}</p>
            </div>
          )}
        </div>
      )}

      {!loading && !error && tab === 'schedule' && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>{tl('日期')}</th><th>{tl('时间')}</th><th>{tl('课次')}</th><th>{tl('教学班')}</th><th>{tl('授课教师')}</th><th>{tl('场地')}</th><th>{tl('方式')}</th><th>{tl('状态')}</th></tr></thead>
            <tbody>
              {schedule.map((s) => (
                <tr key={String(s.id)}>
                  <td>{val(s['课次日期'])}</td>
                  <td>{val(s['开始时间'])}~{val(s['结束时间'])}</td>
                  <td>{val(s['课次名称'])}</td>
                  <td>{val(s['教学班'] || s['教学班文本'])}</td>
                  <td>{val(s['主讲教师'] || s['授课教师文本'])}</td>
                  <td>{val(s['场地文本'])}</td>
                  <td>{val(s['授课方式'])}</td>
                  <td><span className="status-dot">{val(s['课次状态'])}</span></td>
                </tr>
              ))}
              {schedule.length === 0 && <tr><td colSpan={8}><div className="empty-state"><div className="empty-state-text">{tp('emptySchedule')}</div></div></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !error && tab === 'grades' && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>{tl('学科')}</th><th>{tl('学期')}</th><th>{tl('考核类型')}</th><th>{tl('成绩')}</th><th>{tl('等级')}</th><th>{tl('任课教师')}</th><th>{tl('评语')}</th></tr></thead>
            <tbody>
              {grades.map((g, i) => (
                <tr key={i}>
                  <td>{val(g['学科'])}</td>
                  <td>{val(g['学期'])}</td>
                  <td>{val(g['考核类型'])}</td>
                  <td>{val(g['成绩'])}</td>
                  <td>{val(g['成绩等级'])}</td>
                  <td>{val(g['任课教师'])}</td>
                  <td>{val(g['教师评语'])}</td>
                </tr>
              ))}
              {grades.length === 0 && <tr><td colSpan={7}><div className="empty-state"><div className="empty-state-text">{tp('emptyGrades')}</div></div></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !error && tab === 'teachers' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {teachers.map((t) => (
            <div key={String(t.id)} style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 14, padding: 18 }}>
              <div style={{ fontWeight: 700, fontSize: 'var(--font-lg)' }}>{val(t['教师姓名'])}</div>
              <div style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)', margin: '2px 0 10px' }}>
                {[val(t['教师类别']), val(t['主要学科']), val(t['所属部门'])].filter((x) => x && x !== '—').join(' · ')}
              </div>
              <p style={{ margin: 0, fontSize: 'var(--font-sm)', lineHeight: 1.6, color: 'var(--fg-secondary)' }}>{val(t['简介'])}</p>
            </div>
          ))}
          {teachers.length === 0 && <div className="empty-state"><div className="empty-state-text">{tp('emptyTeachers')}</div></div>}
        </div>
      )}

      {!loading && !error && tab === 'attendance' && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>{tl('考勤日期')}</th><th>{tl('方向')}</th><th>{tl('状态')}</th><th>{tl('方式')}</th><th>{tl('校区')}</th><th>{tl('到校时间')}</th><th>{tl('离校时间')}</th><th>{tp('distanceMeters')}</th><th>{tp('result')}</th></tr></thead>
            <tbody>
              {attendances.map((a) => (
                <tr key={String(a.id)}>
                  <td>{val(a['考勤日期'])}</td>
                  <td>{val(a['方向'])}</td>
                  <td>{val(a['考勤状态'])}</td>
                  <td>{val(a['签到方式'])}</td>
                  <td>{val(a['校区'])}</td>
                  <td>{val(a['到校时间'])}</td>
                  <td>{val(a['离校时间'])}</td>
                  <td>{val(a['签到距离'])}</td>
                  <td>{val(a['考勤结果'])}</td>
                </tr>
              ))}
              {attendances.length === 0 && <tr><td colSpan={9}><div className="empty-state"><div className="empty-state-text">{tp('emptyAttendance')}</div></div></td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
