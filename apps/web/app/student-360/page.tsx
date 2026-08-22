'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../lib/api';
import Markdown from '../../components/Markdown';

interface StudentHit {
  id: string;
  学生姓名?: string;
  英文名?: string;
  学生编号?: string;
  当前状态?: string;
  校区?: string;
  入学年级?: string;
  班级?: string;
}

interface Section {
  key: string;
  label: string;
  items: Record<string, unknown>[];
}

// 沟通类模块：统一以「时间 / 负责人 / 活动主题 / 沟通明细 / 沟通总结」列表展示，
// 其中 沟通明细、沟通总结 以超链接呈现，点击弹出框查看完整内容。
const COMM_MODULES: Record<string, { time: string; owner: string; theme: string }> = {
  'source-followups': { time: '跟进日期', owner: '跟进负责人', theme: '沟通主题' },
  'home-school-comms': { time: '沟通时间', owner: '沟通人', theme: '沟通主题' },
  'daily-followups': { time: '沟通时间', owner: '沟通人', theme: '沟通主题' },
};

const SECTION_COLUMNS: Record<string, { key: string; label: string; width?: string }[]> = {
  'student-attendances': [
    { key: '考勤日期', label: '考勤日期', width: '120px' },
    { key: '考勤状态', label: '考勤状态', width: '100px' },
    { key: '时段', label: '时段', width: '90px' },
    { key: '学年', label: '学年', width: '110px' },
    { key: '班级', label: '班级', width: '110px' },
  ],
  grades: [
    { key: '考核日期', label: '考核日期', width: '120px' },
    { key: '学科', label: '学科', width: '90px' },
    { key: '考核名称', label: '考核', width: '180px' },
    { key: '成绩', label: '成绩', width: '80px' },
    { key: '满分', label: '满分', width: '80px' },
    { key: '成绩等级', label: '等级', width: '80px' },
    { key: '学年', label: '学年', width: '110px' },
    { key: '课程', label: '课程', width: '120px' },
  ],
  'practice-activities': [
    { key: '活动编号', label: '编号', width: '110px' },
    { key: '活动名称', label: '活动', width: '180px' },
    { key: '活动开始日期', label: '开始日期', width: '120px' },
    { key: '活动类型', label: '类型', width: '100px' },
    { key: '参与情况', label: '参与', width: '90px' },
    { key: '活动表现', label: '表现', width: '90px' },
  ],
  'stage-evaluations': [
    { key: '评价编号', label: '编号', width: '110px' },
    { key: '评价周期', label: '周期', width: '100px' },
    { key: '评价等级', label: '等级', width: '90px' },
    { key: '评价完整度', label: '完整度', width: '100px' },
    { key: '评价日期', label: '评价日期', width: '120px' },
  ],
  'alumni-followups': [
    { key: '跟进编号', label: '编号', width: '110px' },
    { key: '跟进时间', label: '跟进时间', width: '120px' },
    { key: '跟进方式', label: '方式', width: '90px' },
    { key: '跟进状态', label: '状态', width: '100px' },
    { key: '当前去向类型', label: '去向', width: '120px' },
  ],
};

function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (x?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

export default function Student360Page() {
  const [students, setStudents] = useState<StudentHit[]>([]);
  const [selected, setSelected] = useState<StudentHit | null>(null);
  const [data, setData] = useState<{ student: Record<string, unknown>; sections: Section[] } | null>(null);
  const [loadingStudents, setLoadingStudents] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [popup, setPopup] = useState<{ title: string; content: string } | null>(null);
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');

  useEffect(() => {
    let alive = true;
    const all: StudentHit[] = [];

    async function loadStudents(pageToken?: string): Promise<void> {
      const res = await api.listStudents({ pageSize: '100', pageToken });
      all.push(...((res.items ?? []) as StudentHit[]));
      if (res.hasMore && res.pageToken) await loadStudents(res.pageToken);
    }

    loadStudents()
      .then(() => {
        if (!alive) return;
        setStudents(all.sort((a, b) => str(a.学生姓名).localeCompare(str(b.学生姓名), 'zh-CN')));
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : '学生列表加载失败');
      })
      .finally(() => {
        if (alive) setLoadingStudents(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  // 从列表页「学生」超链接带过来的 ?sid= （学生记录 id 或姓名），自动选中并加载其全景
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (didAutoSelect.current || students.length === 0) return;
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    const sid = params.get('sid');
    if (!sid) {
      didAutoSelect.current = true;
      return;
    }
    const match = students.find((s) => s.id === sid) || students.find((s) => str(s.学生姓名) === sid);
    if (match) {
      didAutoSelect.current = true;
      selectStudent(match.id);
    }
  }, [students]);

  async function load360(studentId: string, from?: string, to?: string) {
    const student = students.find((s) => s.id === studentId) ?? null;
    setSelected(student);
    setData(null);
    setError(null);
    if (!student) return;

    setLoading(true);
    try {
      const d = await api.student360(student.id, { from, to });
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }

  function selectStudent(studentId: string) {
    load360(studentId, dateFrom, dateTo);
  }

  // 时间段变化时自动重新加载
  useEffect(() => {
    if (selected) {
      load360(selected.id, dateFrom, dateTo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo]);

  const totalRecords = data ? data.sections.reduce((n, s) => n + s.items.length, 0) : 0;

  return (
    <div className="crud-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">学生全景</h1>
          <p className="page-subtitle">以单个学生为中心，汇总其全生命周期记录（M1 学生域）</p>
        </div>
      </div>

      {/* 学生选择器 + 时间段筛选 */}
      <div className="filter-bar">
        <label className="form-label" style={{ width: 'min(420px, 100%)' }}>
          <span className="form-label-text">选择学生</span>
          <select
            className="form-input"
            value={selected?.id ?? ''}
            onChange={(e) => selectStudent(e.target.value)}
            disabled={loadingStudents}
          >
            <option value="">{loadingStudents ? '学生列表加载中…' : '请选择学生'}</option>
            {students.map((student) => {
              const name = str(student.学生姓名) || '(无名)';
              const englishName = str(student.英文名);
              return (
                <option key={student.id} value={student.id}>
                  {englishName ? `${name} / ${englishName}` : name}
                </option>
              );
            })}
          </select>
        </label>
        <label className="form-label" style={{ width: '160px' }}>
          <span className="form-label-text">开始日期</span>
          <input
            type="date"
            className="form-input"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </label>
        <label className="form-label" style={{ width: '160px' }}>
          <span className="form-label-text">结束日期</span>
          <input
            type="date"
            className="form-input"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </label>
        {selected && (
          <span className="badge">
            已选：{str(selected.学生姓名)}{str(selected.英文名) ? ` / ${str(selected.英文名)}` : ''}
          </span>
        )}
      </div>

      {loading && <div className="empty-state">加载中…</div>}
      {error && <div className="empty-state" style={{ color: 'var(--danger)' }}>错误：{error}</div>}

      {selected && data && !loading && (
        <>
          {/* 学生头卡 */}
          <div className="student-head">
            <div className="sh-avatar">{str(data.student.学生姓名).charAt(0) || '?'}</div>
            <div className="sh-info">
              <div className="sh-name">
                {str(data.student.学生姓名) || '(无名)'}
                <span className="badge">{str(data.student.当前状态) || '未知状态'}</span>
              </div>
              <div className="sh-sub">
                {[data.student.学生编号, data.student.校区, data.student.入学年级, data.student.班级, data.student.当前学段]
                  .map(str)
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <div className="sh-stat">
              <strong>{totalRecords}</strong>
              <span>条关联记录</span>
            </div>
          </div>

          {/* 各生命周期分段 */}
          {data.sections.map((sec) => {
            const comm = COMM_MODULES[sec.key];
            if (comm) {
              return (
                <div className="section" key={sec.key}>
                  <div className="section-head">
                    <h2>{sec.label}</h2>
                    <span className="badge">{sec.items.length}</span>
                  </div>
                  {sec.items.length === 0 ? (
                    <div className="empty-state">暂无记录</div>
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th style={{ width: '130px' }}>时间</th>
                            <th style={{ width: '120px' }}>负责人</th>
                            <th style={{ width: '180px' }}>活动主题</th>
                            <th>沟通明细</th>
                            <th>沟通总结</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sec.items.map((it) => (
                            <tr key={String(it.id)}>
                              <td>{str(it[comm.time]) || <span className="muted">—</span>}</td>
                              <td>{str(it[comm.owner]) || <span className="muted">—</span>}</td>
                              <td>{str(it[comm.theme]) || <span className="muted">—</span>}</td>
                              <td>
                                {str(it['沟通明细']) ? (
                                  <button type="button" className="link-btn" onClick={() => setPopup({ title: `${sec.label} · 沟通明细`, content: str(it['沟通明细']) })}>
                                    查看
                                  </button>
                                ) : (
                                  <span className="muted">—</span>
                                )}
                              </td>
                              <td>
                                {str(it['沟通总结']) ? (
                                  <button type="button" className="link-btn" onClick={() => setPopup({ title: `${sec.label} · 沟通总结`, content: str(it['沟通总结']) })}>
                                    查看
                                  </button>
                                ) : (
                                  <span className="muted">—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            }
            const cols = SECTION_COLUMNS[sec.key] ?? [];
            return (
              <div className="section" key={sec.key}>
                <div className="section-head">
                  <h2>{sec.label}</h2>
                  <span className="badge">{sec.items.length}</span>
                </div>
                {sec.items.length === 0 ? (
                  <div className="empty-state">暂无记录</div>
                ) : (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          {cols.map((c) => (
                            <th key={c.key} style={c.width ? { width: c.width } : undefined}>
                              {c.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sec.items.map((it) => (
                          <tr key={String(it.id)}>
                            {cols.map((c) => (
                              <td key={c.key}>{str(it[c.key]) || <span className="muted">—</span>}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {!selected && !loading && (
        <div className="empty-state">请选择一名学生，查看其招生、考勤、成绩、实践、家校、评价与校友的全景记录。</div>
      )}

      {typeof document !== 'undefined' &&
        createPortal(
          <DetailModal title={popup?.title ?? ''} content={popup?.content ?? ''} onClose={() => setPopup(null)} />,
          document.body,
        )}
    </div>
  );
}

function DetailModal({ title, content, onClose }: { title: string; content: string; onClose: () => void }) {
  if (!title && !content) return null;
  const isMarkdown = /(^|\n)(#{1,4}\s|[-*]\s+\S|\d+\.\s+\S|>|\*\*\*|---|```|\[[^\]]+\]\(https?:\/\/)/.test(content);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="detail-modal-head">
          <h3 className="detail-modal-title">{title}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>×</button>
        </div>
        <div className="detail-modal-body">
          {content ? (
            isMarkdown ? <Markdown>{content}</Markdown> : <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{content}</p>
          ) : (
            '（无内容）'
          )}
        </div>
        <div className="detail-modal-foot">
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
