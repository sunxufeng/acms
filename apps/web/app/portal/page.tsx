'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

type Tab = 'profile' | 'schedule' | 'grades' | 'teachers';

const TABS: { key: Tab; label: string }[] = [
  { key: 'profile', label: '本人档案' },
  { key: 'schedule', label: '周课表' },
  { key: 'grades', label: '成绩' },
  { key: 'teachers', label: '授课教师' },
];

const PROFILE_FIELDS = [
  '学生姓名', '学籍号', '当前学段', '当前年级', '班级', '校区', '当前状态',
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
  const [tab, setTab] = useState<Tab>('profile');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  const [schedule, setSchedule] = useState<Record<string, unknown>[]>([]);
  const [grades, setGrades] = useState<Record<string, unknown>[]>([]);
  const [teachers, setTeachers] = useState<Record<string, unknown>[]>([]);

  useEffect(() => { void load(tab); }, [tab]);

  async function load(t: Tab) {
    setLoading(true);
    setError(null);
    try {
      if (t === 'profile') setProfile(await api.portalMe() as Record<string, unknown>);
      else if (t === 'schedule') setSchedule((await api.portalSchedule()).items);
      else if (t === 'grades') setGrades((await api.portalGrades()).items);
      else if (t === 'teachers') setTeachers((await api.portalTeachers()).items);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '加载失败';
      setError(msg.includes('FORBIDDEN') || msg.includes('未关联') ? '当前登录账号未关联到学生档案，无法访问自助门户。' : msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">学生自助门户</h1>
          <p className="page-subtitle">本人档案、周课表、成绩与授课教师（仅可查看本人数据）</p>
        </div>
      </div>

      <div className="filter-bar" style={{ marginBottom: 'var(--space-md)' }}>
        {TABS.map((t) => (
          <button key={t.key} className={`filter-select-trigger${tab === t.key ? ' active' : ''}`}
            style={{ borderRadius: 999, border: `1px solid ${tab === t.key ? 'var(--accent)' : 'var(--border)'}`, background: tab === t.key ? 'var(--accent-soft)' : 'transparent' }}
            onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {error && <p className="msg-error">{error}</p>}
      {loading && <div className="empty-state"><div className="empty-state-text">加载中…</div></div>}

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
              <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>摘要</span>
              <p style={{ margin: '4px 0 0', lineHeight: 1.6 }}>{val(profile['摘要'])}</p>
            </div>
          )}
        </div>
      )}

      {!loading && !error && tab === 'schedule' && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>日期</th><th>时间</th><th>课次</th><th>教学班</th><th>授课教师</th><th>场地</th><th>方式</th><th>状态</th></tr></thead>
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
              {schedule.length === 0 && <tr><td colSpan={8}><div className="empty-state"><div className="empty-state-text">暂无课表</div></div></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !error && tab === 'grades' && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>学科</th><th>学期</th><th>考核类型</th><th>成绩</th><th>等级</th><th>任课教师</th><th>评语</th></tr></thead>
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
              {grades.length === 0 && <tr><td colSpan={7}><div className="empty-state"><div className="empty-state-text">暂无成绩</div></div></td></tr>}
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
          {teachers.length === 0 && <div className="empty-state"><div className="empty-state-text">暂无授课教师</div></div>}
        </div>
      )}
    </div>
  );
}
