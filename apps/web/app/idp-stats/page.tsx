'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { api, type IdpStatsResp, type IdpStatsStudent, type IdpStatsTeacher } from '../../lib/api';
import { idpStudentLabel } from '@acms/contracts';
import GetnoteNoteModal from '../../components/GetnoteNoteModal';

/**
 * IDP 统计（2026-09-29 新增，峰哥需求）。
 *
 * ## 这页回答什么
 *
 * 「某个 IDP 老师名下的学生，这个月谈了几次、隔了多久、每条沟通对应哪篇笔记 / 哪个附件」。
 * 结构照峰哥给的样例：老师 → 名下学生（共 N / 本月沟通 M）→ 每个学生（次数 / 最近一次 / 相隔）
 * → 每条沟通（日期 / 主题 / 笔记 / 附件）。
 *
 * ## 权限（两段，别混）
 *
 * - **能不能进这页** = `module:idpStats:read`（独立权限点，与「我的 IDP」各一个开关；
 *   抬 v6 时从 `module:meetingMinutes:read` 继承给 11 个教职工角色）。
 * - **能看多少** = 后端按 `module:idpPlans:read`（系统管理员 / 院级管理）决定 `seeAll`：
 *   `seeAll=false` 时接口只返回**我自己**那一组，前端不额外过滤（判据只有后端一份）。
 *
 * ## 两个显示口径（都与后端同一份纯函数，别在这里重算）
 *
 * - 「相隔 N 天」= 与上一次沟通的**自然日**差（本月不足 2 次时不显示）；
 *   「距今 N 天」= 最近一次距今天的自然日差。两个都显示 —— 峰哥样例里"只沟通 1 次也有相隔"
 *   说明他可能指的是后者，让他自己挑。
 * - 「代谈」：沟通人 ≠ 该生 IDP 老师时，那条记录后面打一个小标签 —— 记录仍算在**学生的 IDP 老师**名下
 *  （因为这是"老师名下学生"的统计）。
 */
export default function IdpStatsPage() {
  const t = useTranslations('idpStats');
  const [data, setData] = useState<IdpStatsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [month, setMonth] = useState('');
  const [sort, setSort] = useState<'comms' | 'notTalked' | 'name'>('comms');
  const [q, setQ] = useState('');
  /** 展开了明细的学生（key = 老师 openId + 学生 key） */
  const [openStu, setOpenStu] = useState<Set<string>>(new Set());
  /** 收起的老师卡（**默认全部展开**：本月有沟通的通常只有几位，直接看重点） */
  const [closed, setClosed] = useState<Set<string>>(new Set());
  /** 笔记详情弹窗 */
  const [noteId, setNoteId] = useState('');

  const load = useCallback(async (m?: string) => {
    setLoading(true);
    setErr('');
    try {
      const r = await api.idpStats(m ? { month: m } : undefined);
      setData(r);
      // 月份下拉的候选由后端给（有记录的月份 + 当前月），第一次拿到后落到本状态
      if (!m) setMonth(r.month);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const switchMonth = (m: string) => {
    setMonth(m);
    setOpenStu(new Set());
    void load(m);
  };

  const stuKey = (teacherOpenId: string, s: IdpStatsStudent) =>
    `${teacherOpenId}::${s.studentId || `name:${s.studentName}`}`;

  const toggleStu = (k: string, force?: boolean) => {
    setOpenStu((cur) => {
      const next = new Set(cur);
      const on = force ?? !next.has(k);
      if (on) next.add(k);
      else next.delete(k);
      return next;
    });
  };

  const toggleCard = (openId: string) => {
    setClosed((cur) => {
      const next = new Set(cur);
      if (next.has(openId)) next.delete(openId);
      else next.add(openId);
      return next;
    });
  };

  /** 排序 + 关键字筛选都在前端做（数据量小；后端只负责取数与权限） */
  const teachers = useMemo(() => {
    const list = (data?.teachers ?? []).slice();
    const kw = q.trim();
    const filtered = kw
      ? list
          .map((tt) => ({
            ...tt,
            students: tt.students.filter(
              (s) => s.studentName.includes(kw) || s.nameEn.includes(kw) || s.cls.includes(kw),
            ),
            notTalked: tt.notTalked.filter(
              (s) => s.studentName.includes(kw) || s.cls.includes(kw),
            ),
          }))
          .filter((tt) => tt.name.includes(kw) || tt.students.length || tt.notTalked.length)
      : list;
    const sorted = filtered.slice();
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    else if (sort === 'notTalked')
      sorted.sort((a, b) => b.notTalked.length - a.notTalked.length || b.comms - a.comms);
    else sorted.sort((a, b) => b.comms - a.comms || a.name.localeCompare(b.name, 'zh-CN'));
    return sorted;
  }, [data, q, sort]);

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <div className="page-eyebrow">IDP</div>
            <h1 className="page-title">{t('title')}</h1>
            <p className="page-subtitle">{t('subtitle')}</p>
          </div>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={!teachers.length}
            onClick={() => exportCsv(teachers, data?.month ?? '')}
          >
            {t('export')}
          </button>
        </div>
      </div>

      {/* 筛选 */}
      <div style={filtersStyle}>
        <label style={labelStyle}>{t('yearTerm')}</label>
        <span className="form-input" style={{ ...inputStyle, cursor: 'default', background: 'var(--bg-subtle)' }}>
          {data?.config ? `${data.config.yearName} ${data.config.term}`.trim() || data.config.name : '—'}
        </span>
        <label style={labelStyle}>{t('month')}</label>
        <select className="form-input" style={inputStyle} value={month} onChange={(e) => switchMonth(e.target.value)}>
          {(data?.months ?? []).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <label style={labelStyle}>{t('sort')}</label>
        <select
          className="form-input"
          style={inputStyle}
          value={sort}
          onChange={(e) => setSort(e.target.value as 'comms' | 'notTalked' | 'name')}
        >
          <option value="comms">{t('sortByComms')}</option>
          <option value="notTalked">{t('sortByNotTalked')}</option>
          <option value="name">{t('sortByName')}</option>
        </select>
        <input
          className="form-input"
          style={{ ...inputStyle, width: 190, marginLeft: 'auto' }}
          placeholder={t('search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {/* 口径提示 */}
      <div className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
        {t('monthHint')}
        {data?.rangeOk ? ` · ${t('rangeIs', { range: data.rangeText })}` : ''}
        {data && !data.rangeOk ? '' : ''}
        {!data?.seeAll ? ` · ${t('seeMineHint')}` : ''}
      </div>
      {data && !data.rangeOk ? (
        <div className="notice notice-warn" style={{ marginBottom: 10, fontSize: 12.5 }}>{t('rangeBad')}</div>
      ) : null}

      {/* 概览 */}
      {data ? (
        <div style={ovWrapStyle}>
          <Ov k={t('ovTeachers')} v={data.overview.teachers} unit={t('unitPeople')} />
          <Ov k={t('ovStudents')} v={data.overview.students} unit={t('unitPeople')} />
          <Ov k={t('ovTalked')} v={data.overview.talkedStudents} unit={`${t('unitPeople')} / ${data.overview.comms} ${t('unitTimes')}`} />
          <Ov k={t('ovNotTalked')} v={data.overview.notTalked} unit={t('unitPeople')} danger />
        </div>
      ) : null}

      {loading ? (
        <div className="dept-loading">{t('loading')}</div>
      ) : err ? (
        <div className="notice notice-error">
          {t('errLoad')}：{err}
        </div>
      ) : !data || !teachers.length ? (
        <div className="empty-state">
          <div className="empty-state-icon">🧭</div>
          <div className="empty-state-text">{t('empty')}</div>
        </div>
      ) : (
        <>
          {teachers.map((tt) => (
            <TeacherCard
              key={tt.openId}
              tt={tt}
              t={t}
              open={!closed.has(tt.openId)}
              onToggle={() => toggleCard(tt.openId)}
              stuOpen={openStu}
              stuKeyOf={stuKey}
              onToggleStu={toggleStu}
              onOpenNote={setNoteId}
            />
          ))}
          {/* 没分配老师的学生：统计之外，但必须让管理员看见（否则总数对不上） */}
          {(data.unassigned?.length ?? 0) > 0 ? (
            <div style={unassignedStyle}>
              {t('unassignedLine', { n: data.unassigned.length })}
              {data.unassigned.map((s) => `${s.studentName}（${s.cls || '—'}）`).join('、')}
            </div>
          ) : null}
        </>
      )}

      {/* 笔记详情：复用「我的笔记」那一份公用弹窗（与「我的 IDP」同一个组件） */}
      <GetnoteNoteModal noteId={noteId} onClose={() => setNoteId('')} />
    </div>
  );
}

type T = ReturnType<typeof useTranslations>;

function TeacherCard({
  tt,
  t,
  open,
  onToggle,
  stuOpen,
  stuKeyOf,
  onToggleStu,
  onOpenNote,
}: {
  tt: IdpStatsTeacher;
  t: T;
  open: boolean;
  onToggle: () => void;
  stuOpen: Set<string>;
  stuKeyOf: (openId: string, s: IdpStatsStudent) => string;
  onToggleStu: (k: string, force?: boolean) => void;
  onOpenNote: (id: string) => void;
}) {
  return (
    <div className="card" style={{ marginBottom: 12, padding: 0 }}>
      <button type="button" onClick={onToggle} style={headStyle}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>{open ? '▾' : '▸'}</span>
          <span style={{ fontWeight: 700 }}>{tt.name}</span>
          <span className="muted" style={{ fontSize: 12.5 }}>{t('studentsN', { n: tt.studentCount })}</span>
        </span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {tt.comms > 0 ? (
            <span style={pillOk}>{t('talkedN', { students: tt.talked, comms: tt.comms })}</span>
          ) : (
            <span style={pillZero}>{t('noTalkThisMonth')}</span>
          )}
          {tt.notTalked.length ? <span style={pillWarn}>{t('notTalkedN', { n: tt.notTalked.length })}</span> : null}
          {tt.coveringCount ? <span style={pillCover}>{t('coveringN', { n: tt.coveringCount })}</span> : null}
          {tt.lastAt ? <span className="muted" style={{ fontSize: 12 }}>{t('lastAtN', { date: fmtDay(tt.lastAt) })}</span> : null}
        </span>
      </button>

      {open ? (
        <div style={{ padding: '4px 14px 12px' }}>
          {tt.students.map((s) => {
            const k = stuKeyOf(tt.openId, s);
            const expanded = stuOpen.has(k);
            return (
              <div key={k}>
                <button type="button" onClick={() => onToggleStu(k)} style={srowStyle}>
                  <span style={{ fontSize: 11, color: 'var(--fg-tertiary)', width: 10 }}>
                    {expanded ? '▾' : '▸'}
                  </span>
                  <span style={{ fontWeight: 600, minWidth: 120 }}>
                    {idpStudentLabel(s.studentName, s.nameEn)}
                  </span>
                  <span className="muted" style={{ fontSize: 12.5, minWidth: 70 }}>{s.cls || '—'}</span>
                  <span style={{ fontSize: 12.5, color: 'var(--fg-secondary)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span>{t('timesN', { n: s.count })}</span>
                    <span>{t('lastShort', { date: fmtDay(s.lastAt) })}</span>
                    {s.gapDays != null ? <span>{t('gapShort', { n: s.gapDays })}</span> : null}
                    {s.daysAgo != null ? <span className="muted">{t('daysAgoShort', { n: s.daysAgo })}</span> : null}
                  </span>
                </button>

                {expanded ? (
                  <div style={sdetailStyle}>
                    <div style={{ fontSize: 12.5, color: 'var(--fg-secondary)', marginBottom: 8 }}>
                      <b style={{ color: 'var(--fg)' }}>{idpStudentLabel(s.studentName, s.nameEn)}</b>
                      {'：'}
                      {t('detailHead', { count: s.count, last: fmtDay(s.lastAt) })}{' '}
                      {s.gapDays != null ? <b>{t('gapDaysN', { n: s.gapDays })}</b> : <span className="muted">{t('gapNone')}</span>}
                      {s.daysAgo != null ? <span className="muted">{` · ${t('daysAgoShort', { n: s.daysAgo })}`}</span> : null}
                    </div>
                    {s.rows.map((r) => (
                      <div key={r.id} style={recStyle}>
                        <span style={{ ...dateStyle, fontVariantNumeric: 'tabular-nums' }}>{fmtMin(r.time)}</span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          {r.subject || '（无主题）'}
                          {/* 沟通人 ≠ 该生 IDP 老师 ⇒ 这条是「代谈」，记录仍算在该生名下（他老师的那张卡里） */}
                          {r.person && tt.name && r.person !== tt.name ? (
                            <span style={{ ...tagByOther, marginLeft: 6 }}>{t('byOtherTag', { name: r.person })}</span>
                          ) : null}
                        </span>
                        <span style={{ display: 'flex', gap: 10, fontSize: 12, color: 'var(--fg-tertiary)', whiteSpace: 'nowrap' }}>
                          {r.notes.length ? (
                            r.notes.map((n) => (
                              <button
                                key={n.noteId}
                                type="button"
                                className="btn btn-ghost btn-sm"
                                style={{ padding: '1px 6px', fontSize: 12 }}
                                title={t('openNote')}
                                onClick={() => onOpenNote(n.noteId)}
                              >
                                🔗 {n.title}
                              </button>
                            ))
                          ) : (
                            <span>{t('noNotes')}</span>
                          )}
                          {r.files.length ? (
                            <span>
                              {r.files.map((f) => (
                                <a
                                  key={f.file_token}
                                  href={`/api/v1/files/${encodeURIComponent(f.file_token)}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  style={{ color: 'var(--accent)', marginRight: 6 }}
                                >
                                  📎 {f.name || f.file_token}
                                </a>
                              ))}
                            </span>
                          ) : (
                            <span>{t('noFiles')}</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}

          {/* 本月未沟通的学生：这页最有用的信息之一（谁还没谈） */}
          {tt.notTalked.length ? (
            <div style={notYetStyle}>
              {t('notTalkedLine', { n: tt.notTalked.length })}
              {tt.notTalked.map((s) => `${s.studentName}（${s.cls || '—'}）`).join('、')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Ov({ k, v, unit, danger }: { k: string; v: number; unit?: string; danger?: boolean }) {
  return (
    <div style={ovStyle}>
      <div className="muted" style={{ fontSize: 12 }}>{k}</div>
      <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-.3px', color: danger ? '#9B2B2E' : undefined }}>
        {v}
        {unit ? <small style={{ fontSize: 12.5, fontWeight: 400, color: 'var(--fg-tertiary)', marginLeft: 4 }}>{unit}</small> : null}
      </div>
    </div>
  );
}

/** 导出当前视图（老师 × 学生 × 记录三层铺平）—— 便于线下核对/汇报 */
function exportCsv(teachers: IdpStatsTeacher[], month: string) {
  const head = ['老师', '学生', '班级', '本月次数', '最近一次', '两次相隔(天)', '距今(天)', '沟通日期', '沟通主题', '沟通人', '笔记', '附件'];
  const lines = [head.join(',')];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  for (const tt of teachers) {
    for (const s of tt.students) {
      for (const r of s.rows) {
        lines.push(
          [
            tt.name,
            s.studentName,
            s.cls,
            s.count,
            fmtDay(s.lastAt),
            s.gapDays ?? '',
            s.daysAgo ?? '',
            fmtMin(r.time),
            r.subject,
            r.person,
            r.notes.map((n) => n.title).join(' / '),
            r.files.map((f) => f.name || f.file_token).join(' / '),
          ]
            .map(esc)
            .join(','),
        );
      }
    }
    for (const s of tt.notTalked) {
      lines.push([tt.name, s.studentName, s.cls, 0, '', '', '', '', '（本月未沟通）', '', '', ''].map(esc).join(','));
    }
  }
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `IDP统计-${month || 'all'}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function fmtDay(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtMin(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const filtersStyle: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 8px' };
const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--fg-secondary)', marginLeft: 4 };
const inputStyle: CSSProperties = { padding: '6px 10px', fontSize: 13, width: 150 };
const ovWrapStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 10, margin: '0 0 14px' };
const ovStyle: CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '11px 14px' };
const headStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
  width: '100%', padding: '11px 14px', background: 'transparent', border: 'none',
  cursor: 'pointer', textAlign: 'left', color: 'var(--fg)',
};
const srowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 6px',
  borderTop: '1px solid var(--border)', background: 'transparent', border: 'none',
  cursor: 'pointer', textAlign: 'left', color: 'var(--fg)',
};
const sdetailStyle: CSSProperties = {
  margin: '2px 0 6px 18px', padding: '10px 12px', background: 'var(--bg-subtle)',
  border: '1px solid var(--border)', borderLeft: '3px solid var(--accent)', borderRadius: 'var(--radius-md)',
};
const recStyle: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 9, padding: '6px 0', borderTop: '1px dashed var(--border)', fontSize: 13 };
const dateStyle: CSSProperties = { minWidth: 100, fontSize: 12.5, color: 'var(--fg-secondary)' };
const notYetStyle: CSSProperties = {
  marginTop: 8, padding: '8px 11px', background: '#FBF7F0', border: '1px dashed #E3D6BC',
  borderRadius: 'var(--radius-sm)', fontSize: 12.5, color: '#6B5410', lineHeight: 1.7,
};
const unassignedStyle: CSSProperties = { ...notYetStyle, background: '#FFF8E1', borderColor: '#F0DFA8' };
const pillBase: CSSProperties = { fontSize: 11.5, padding: '1px 8px', borderRadius: 999, border: '1px solid var(--border)' };
const pillOk: CSSProperties = { ...pillBase, background: 'var(--accent-muted)', borderColor: 'rgba(14,155,142,.3)', color: 'var(--accent)', fontWeight: 600 };
const pillWarn: CSSProperties = { ...pillBase, background: 'rgba(184,134,11,.12)', borderColor: '#EBD9A0', color: '#6B5410' };
const pillZero: CSSProperties = { ...pillBase, background: 'rgba(229,72,77,.12)', borderColor: 'rgba(229,72,77,.28)', color: '#9B2B2E' };
const pillCover: CSSProperties = { ...pillBase, background: 'var(--bg-subtle)', color: 'var(--fg-secondary)' };
const tagByOther: CSSProperties = { fontSize: 11, padding: '0 6px', borderRadius: 999, background: 'rgba(184,134,11,.12)', border: '1px solid #EBD9A0', color: '#6B5410' };
