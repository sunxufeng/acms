'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../lib/api';
import Markdown from '../../components/Markdown';
import FloatingAIPanel from '../../components/FloatingAIPanel';
import Combobox from '../../components/Combobox';
import { useTranslations } from 'next-intl';

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
  'source-followups': { time: '跟进时间', owner: '跟进负责人', theme: '沟通主题' },
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
    { key: '活动开始日期', label: '开始时间', width: '120px' },
    { key: '活动结束日期', label: '结束时间', width: '120px' },
    { key: '活动名称', label: '活动', width: '180px' },
    { key: '活动类型', label: '类型', width: '100px' },
    { key: '参与情况', label: '参与', width: '90px' },
    { key: '活动表现', label: '表现', width: '90px' },
  ],
  'stage-evaluations': [
    { key: '评价日期', label: '评价日期', width: '120px' },
    { key: '评价周期', label: '周期', width: '100px' },
    { key: '评价等级', label: '等级', width: '90px' },
    { key: '评价完整度', label: '完整度', width: '100px' },
  ],
  'alumni-followups': [
    { key: '跟进时间', label: '跟进时间', width: '120px' },
    { key: '跟进方式', label: '方式', width: '90px' },
    { key: '跟进状态', label: '状态', width: '100px' },
    { key: '当前去向类型', label: '去向', width: '120px' },
  ],
  'idp-plans': [
    { key: '学期', label: '学期', width: '100px' },
    { key: '导师', label: '导师', width: '100px' },
    { key: '状态', label: '状态', width: '100px' },
    { key: '制定日期', label: '制定日期', width: '120px' },
    { key: '展示方式', label: '展示方式', width: '100px' },
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

  const tl = useTranslations('labels');  const [students, setStudents] = useState<StudentHit[]>([]);
  const [selected, setSelected] = useState<StudentHit | null>(null);
  const [data, setData] = useState<{ student: Record<string, unknown>; sections: Section[] } | null>(null);
  const [loadingStudents, setLoadingStudents] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [popup, setPopup] = useState<{ title: string; content: string } | null>(null);
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [dimensionOptions, setDimensionOptions] = useState<string[]>([]);
  const [selectedDimensions, setSelectedDimensions] = useState<string[]>([]);

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

  // 加载字典：学生维度选项（顺序即下拉展示顺序）
  useEffect(() => {
    api
      .dictionaries()
      .then((d) => setDimensionOptions((d as Record<string, string[]>)['学生维度'] ?? []))
      .catch(() => setDimensionOptions([]));
  }, []);

  // 从列表页「学生」超链接带过来的 ?sid= （学生记录 id 或姓名），自动选中并直接加载全景（无需再点查询）
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
      load360(match.id); // 自动加载该学生全景（默认全部维度、全部时间段）
    }
  }, [students]);

  async function load360(studentId: string, from?: string, to?: string, sections?: string[]) {
    const student = students.find((s) => s.id === studentId) ?? null;
    setSelected(student);
    setData(null);
    setError(null);
    if (!student) return;

    setLoading(true);
    try {
      const d = await api.student360(student.id, { from, to, sections });
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }

  // 仅切换学生（清空旧报告，不自动加载；需点「查询」）
  function selectStudent(studentId: string) {
    const student = students.find((s) => s.id === studentId) ?? null;
    setSelected(student);
    setData(null);
    setError(null);
  }

  // 点「查询」按钮才加载（学生 + 维度 + 日期 选好后再查）
  function handleQuery() {
    if (!selected) return;
    load360(selected.id, dateFrom, dateTo, selectedDimensions);
  }

  // 已移除「时间段变化自动重新加载」逻辑：改为点击查询按钮触发，避免边选边出、卡顿


  const totalRecords = data ? data.sections.reduce((n, s) => n + s.items.length, 0) : 0;

  const mainBody = (
    <>
      <div className="page-header page-header-row">
        <div>
          <h1 className="page-title">{tl('学生全景')}</h1>
          <p className="page-subtitle">{tl('以单个学生为中心，汇总其全生命周期记录（M1 学生域）')}</p>
        </div>
      </div>

      {/* 学生选择器 + 时间段筛选 + 维度筛选 + 查询 */}
      <div className="filter-bar">
        <label className="form-label" style={{ width: 'min(420px, 100%)' }}>
          <span className="form-label-text">{tl('选择学生')}</span>
          <Combobox
            value={selected?.id ?? ''}
            onChange={(v) => selectStudent(v)}
            options={students.map((student) => {
              const name = str(student.学生姓名) || '(无名)';
              const englishName = str(student.英文名);
              return { value: student.id, label: englishName ? `${name} / ${englishName}` : name };
            })}
            placeholder={loadingStudents ? '学生列表加载中…' : '输入学生姓名筛选…'}
          />
        </label>
        <label className="form-label" style={{ width: '160px' }}>
          <span className="form-label-text">{tl('开始日期')}</span>
          <input
            type="date"
            className="form-input"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </label>
        <label className="form-label" style={{ width: '160px' }}>
          <span className="form-label-text">{tl('结束日期')}</span>
          <input
            type="date"
            className="form-input"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </label>
        <button type="button" className="btn btn-primary" onClick={handleQuery} disabled={!selected || loading}>
          {loading ? '查询中…' : '查询'}
        </button>
        {selected && (
          <span className="badge">
            已选：{str(selected.学生姓名)}{str(selected.英文名) ? ` / ${str(selected.英文名)}` : ''}
          </span>
        )}
      </div>

      {/* 学生维度筛选（多选 chips，来源字典「学生维度」；未选表示展示全部维度） */}
      <div className="filter-bar" style={{ flexWrap: 'wrap', gap: 8, marginTop: -6 }}>
        <span className="form-label-text" style={{ alignSelf: 'center' }}>{tl('学生维度')}</span>
        {dimensionOptions.map((dim) => {
          const active = selectedDimensions.includes(dim);
          return (
            <button
              type="button"
              key={dim}
              className={`chip ${active ? 'chip-active' : ''}`}
              onClick={() =>
                setSelectedDimensions((prev) =>
                  prev.includes(dim) ? prev.filter((d) => d !== dim) : [...prev, dim],
                )
              }
            >
              {dim}
            </button>
          );
        })}
        {dimensionOptions.length === 0 && <span className="muted">{tl('（字典「学生维度」加载中或为空）')}</span>}
        {selectedDimensions.length > 0 && (
          <button
            type="button"
            className="link-btn"
            onClick={() => setSelectedDimensions([])}
            title={tl('清空已选维度，恢复全部维度')}
          >
            清空
          </button>
        )}
        {selectedDimensions.length === 0 && <span className="muted" style={{ alignSelf: 'center' }}>{tl('未选维度将展示全部')}</span>}
      </div>

      {loading && <div className="empty-state">{tl('加载中…')}</div>}
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
              <span>{tl('条关联记录')}</span>
            </div>
          </div>

          {/* 各生命周期分段 */}
          {data.sections.map((sec) => {
  const tl = useTranslations('labels');
            const comm = COMM_MODULES[sec.key];
            if (comm) {
              return (
                <div className="section" key={sec.key}>
                  <div className="section-head">
                    <h2>{sec.label}</h2>
                    <span className="badge">{sec.items.length}</span>
                  </div>
                  {sec.items.length === 0 ? (
                    <div className="empty-state">{tl('暂无记录')}</div>
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th style={{ width: '130px' }}>{tl('时间')}</th>
                            <th style={{ width: '120px' }}>{tl('负责人')}</th>
                            <th style={{ width: '180px' }}>{tl('活动主题')}</th>
                            <th>{tl('沟通明细')}</th>
                            <th>{tl('沟通总结')}</th>
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
                                  <button type="button" className="link-btn" onClick={() => setPopup({ title: `${sec.label} · ${tl('沟通明细')}`, content: str(it['沟通明细']) })}>
                                    查看
                                  </button>
                                ) : (
                                  <span className="muted">—</span>
                                )}
                              </td>
                              <td>
                                {str(it['沟通总结']) ? (
                                  <button type="button" className="link-btn" onClick={() => setPopup({ title: `${sec.label} · ${tl('沟通总结')}`, content: str(it['沟通总结']) })}>
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
                  <div className="empty-state">{tl('暂无记录')}</div>
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
        <div className="empty-state">{tl('请选择一名学生，查看其招生、考勤、成绩、实践、家校、评价与校友的全景记录。')}</div>
      )}
    </>
  );

  return (
    <div className="crud-page">
      {mainBody}

      {typeof document !== 'undefined' &&
        createPortal(
          <DetailModal title={popup?.title ?? ''} content={popup?.content ?? ''} onClose={() => setPopup(null)} />,
          document.body,
        )}

      {/* 悬浮「AI」：可拖拽，点击展开对话框，复用通用 FloatingAIPanel */}
      <FloatingAIPanel
        context={buildStudentContext(data?.student ?? (selected as unknown as Record<string, unknown>), data?.sections ?? [])}
        resetKey={`${selected?.id ?? 'none'}-${data ? totalRecords : 'empty'}`}
        disabled={!selected}
        disabledHint="请先选择学生"
        label="AI"
        title="AI"
        subject={str(data?.student?.学生姓名) || str(selected?.学生姓名) || '未选学生'}
        storageKey="student360-analysis-dialog"
        placeholder={tl('输入与学生相关的问题，Enter 发送…')}
      />

    </div>
  );
}

function buildStudentContext(student: Record<string, unknown> | undefined, sections: Section[]): string {
  if (!student) return '（未选择学生）';
  const lines: string[] = [];
  lines.push('你是 ACMS 学生全景智能分析助手。请基于以下学生信息回答用户问题，若信息不足请明确说明。');
  lines.push('');
  lines.push('【学生基本信息】');
  lines.push(`- 姓名：${str(student.学生姓名) || '未知'}`);
  lines.push(`- 学生编号：${str(student.学生编号) || '—'}`);
  lines.push(`- 当前状态：${str(student.当前状态) || '—'}`);
  lines.push(`- 校区：${str(student.校区) || '—'}`);
  lines.push(`- 入学年级：${str(student.入学年级) || '—'}`);
  lines.push(`- 班级：${str(student.班级) || '—'}`);
  lines.push(`- 当前学段：${str(student.当前学段) || '—'}`);
  lines.push(`- 英文名：${str(student.英文名) || '—'}`);
  lines.push('');

  const total = sections.reduce((n, s) => n + s.items.length, 0);
  lines.push(`【全生命周期记录】（共 ${total} 条）`);
  for (const sec of sections) {
    if (sec.items.length === 0) {
      lines.push(`- ${sec.label}：无记录`);
      continue;
    }
    lines.push(`- ${sec.label}：${sec.items.length} 条`);
    const recent = sec.items.slice(0, 3);
    for (const it of recent) {
      const comm = COMM_MODULES[sec.key];
      if (comm) {
        const parts = [
          `时间：${str(it[comm.time]) || '—'}`,
          `负责人：${str(it[comm.owner]) || '—'}`,
          `主题：${str(it[comm.theme]) || '—'}`,
        ];
        lines.push(`  · ${parts.join(' | ')}`);
        const detail = str(it['沟通明细']);
        const summary = str(it['沟通总结']);
        if (summary) lines.push(`    沟通总结：${summary.slice(0, 160)}${summary.length > 160 ? '...' : ''}`);
        else if (detail) lines.push(`    沟通明细：${detail.slice(0, 160)}${detail.length > 160 ? '...' : ''}`);
      } else {
        const cols = SECTION_COLUMNS[sec.key] ?? [];
        const parts = cols.slice(0, 4).map((c) => `${c.label}：${str(it[c.key]) || '—'}`);
        lines.push(`  · ${parts.join(' | ')}`);
      }
    }
  }
  return lines.join('\n');
}


function DetailModal({ title, content, onClose }: { title: string; content: string; onClose: () => void }) {
  const tl = useTranslations('labels');
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
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>{tl('关闭')}</button>
        </div>
      </div>
    </div>
  );
}
