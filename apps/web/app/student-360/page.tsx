'use client';

import { useEffect, useRef, useState, type MouseEventHandler } from 'react';
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

type Msg = { role: 'user' | 'assistant' | 'system'; content: string };
type DialogRect = { x: number; y: number; width: number; height: number };

const DIALOG_STORAGE_KEY = 'student360-analysis-dialog';
function defaultDialogRect(): DialogRect {
  if (typeof window === 'undefined') return { x: 0, y: 80, width: 560, height: 640 };
  const width = 560;
  const height = Math.min(640, window.innerHeight - 120);
  return {
    x: Math.max(20, window.innerWidth - width - 20),
    y: 80,
    width,
    height,
  };
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
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogRect>({ x: 0, y: 80, width: 560, height: 640 });
  const [dlgDragging, setDlgDragging] = useState(false);
  const [dlgResizing, setDlgResizing] = useState(false);
  const dlgDragStart = useRef({ x: 0, y: 0, startX: 0, startY: 0 });
  const dlgResizeStart = useRef({ x: 0, y: 0, startW: 0, startH: 0 });

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

  // 恢复上次悬浮窗位置/大小（若用户调整过窗口尺寸导致越界则自动拉回）
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(DIALOG_STORAGE_KEY);
      if (!raw) {
        setDialog(defaultDialogRect());
        return;
      }
      const saved: DialogRect = JSON.parse(raw);
      const maxW = window.innerWidth - 40;
      const maxH = window.innerHeight - 80;
      const width = Math.max(360, Math.min(saved.width || 560, maxW));
      const height = Math.max(300, Math.min(saved.height || 640, maxH));
      const x = Math.max(20, Math.min(saved.x || 0, window.innerWidth - width - 20));
      const y = Math.max(20, Math.min(saved.y || 80, window.innerHeight - height - 20));
      setDialog({ x, y, width, height });
    } catch {
      setDialog(defaultDialogRect());
    }
  }, []);

  // 保存悬浮窗位置/大小
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(DIALOG_STORAGE_KEY, JSON.stringify(dialog));
  }, [dialog]);

  // 智能分析打开时拉回到可视区（避免上次记录的位置超屏）
  useEffect(() => {
    if (!analysisOpen || typeof window === 'undefined') return;
    setDialog((d) => {
      const maxW = window.innerWidth - 40;
      const maxH = window.innerHeight - 80;
      const width = Math.max(360, Math.min(d.width, maxW));
      const height = Math.max(300, Math.min(d.height, maxH));
      const x = Math.max(20, Math.min(d.x, window.innerWidth - width - 20));
      const y = Math.max(20, Math.min(d.y, window.innerHeight - height - 20));
      return { x, y, width, height };
    });
  }, [analysisOpen]);

  // 拖动悬浮窗标题栏
  useEffect(() => {
    if (!dlgDragging) return;
    function onMove(e: MouseEvent) {
      const dx = e.clientX - dlgDragStart.current.x;
      const dy = e.clientY - dlgDragStart.current.y;
      setDialog((d) => {
        const nextX = dlgDragStart.current.startX + dx;
        const nextY = dlgDragStart.current.startY + dy;
        return {
          ...d,
          x: Math.max(0, Math.min(nextX, window.innerWidth - d.width)),
          y: Math.max(0, Math.min(nextY, window.innerHeight - d.height)),
        };
      });
    }
    function onUp() {
      setDlgDragging(false);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dlgDragging]);

  // 拖拽右下角改变悬浮窗大小
  useEffect(() => {
    if (!dlgResizing) return;
    function onMove(e: MouseEvent) {
      const dx = e.clientX - dlgResizeStart.current.x;
      const dy = e.clientY - dlgResizeStart.current.y;
      setDialog((d) => {
        const maxW = window.innerWidth - d.x - 20;
        const maxH = window.innerHeight - d.y - 20;
        return {
          ...d,
          width: Math.max(360, Math.min(dlgResizeStart.current.startW + dx, maxW)),
          height: Math.max(300, Math.min(dlgResizeStart.current.startH + dy, maxH)),
        };
      });
    }
    function onUp() {
      setDlgResizing(false);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dlgResizing]);

  const totalRecords = data ? data.sections.reduce((n, s) => n + s.items.length, 0) : 0;

  const mainBody = (
    <>
      <div className="page-header page-header-row">
        <div>
          <h1 className="page-title">学生全景</h1>
          <p className="page-subtitle">以单个学生为中心，汇总其全生命周期记录（M1 学生域）</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!selected}
          title={selected ? '打开智能分析面板' : '请先选择学生'}
          onClick={() => setAnalysisOpen((v) => !v)}
        >
          {analysisOpen ? '关闭分析' : '智能分析'}
        </button>
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

      {analysisOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              left: dialog.x,
              top: dialog.y,
              width: dialog.width,
              height: dialog.height,
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
              zIndex: 2000,
              overflow: 'hidden',
            }}
          >
            <SmartAnalysisPanel
              student={data?.student}
              sections={data?.sections ?? []}
              onClose={() => setAnalysisOpen(false)}
              onHeaderMouseDown={(e) => {
                dlgDragStart.current = {
                  x: e.clientX,
                  y: e.clientY,
                  startX: dialog.x,
                  startY: dialog.y,
                };
                setDlgDragging(true);
              }}
            />
            {/* 右下角缩放手柄 */}
            <div
              onMouseDown={(e) => {
                e.preventDefault();
                dlgResizeStart.current = {
                  x: e.clientX,
                  y: e.clientY,
                  startW: dialog.width,
                  startH: dialog.height,
                };
                setDlgResizing(true);
              }}
              title="拖拽缩放对话框"
              style={{
                position: 'absolute',
                right: 0,
                bottom: 0,
                width: 18,
                height: 18,
                cursor: 'nwse-resize',
                background:
                  'linear-gradient(135deg, transparent 50%, var(--border) 50%, var(--border) 60%, transparent 60%, transparent 70%, var(--border) 70%, var(--border) 80%, transparent 80%, transparent 90%, var(--border) 90%, var(--border) 100%)',
              }}
            />
          </div>,
          document.body,
        )}
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

function SmartAnalysisPanel({
  student,
  sections,
  onClose,
  onHeaderMouseDown,
}: {
  student?: Record<string, unknown>;
  sections: Section[];
  onClose: () => void;
  onHeaderMouseDown?: MouseEventHandler<HTMLDivElement>;
}) {
  const [agents, setAgents] = useState<{ id: string; name: string; provider?: string; model?: string }[]>([]);
  const [agentId, setAgentId] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.aiListAgents().then((list) => setAgents((list as { id: string; name: string; provider?: string; model?: string }[]) || [])).catch(() => null);
  }, []);

  useEffect(() => {
    const ctx = buildStudentContext(student, sections);
    setMessages([{ role: 'system', content: ctx }]);
    setSessionId(null);
    setInput('');
  }, [student, sections]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || sending || !student) return;
    setInput('');
    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setSending(true);

    let sid = sessionId;
    if (!sid) {
      try {
        const r = await api.aiCreateConversation({ title: `学生分析 · ${str(student.学生姓名) || '未命名'}` });
        sid = r.id;
        setSessionId(sid);
      } catch {
        // 会话创建失败时继续用临时 history，不阻塞对话
      }
    }

    try {
      const r = await api.aiChat({ message: text, sessionId: sid ?? undefined, agentId: agentId || undefined, history: messages });
      setMessages([...next, { role: 'assistant', content: r.content }]);
      if (r.sessionId && !sessionId) setSessionId(r.sessionId);
    } catch (e) {
      setMessages([...next, { role: 'assistant', content: `⚠️ ${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      setSending(false);
    }
  }

  const studentName = str(student?.学生姓名) || '未选学生';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div
        onMouseDown={onHeaderMouseDown}
        style={{
          flexShrink: 0,
          padding: '14px 18px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          cursor: onHeaderMouseDown ? 'move' : 'default',
          userSelect: 'none',
        }}
      >
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>智能分析</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>当前学生：{studentName}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '6px 10px',
              fontSize: 13,
            }}
          >
            <option value="">个人默认配置</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}（{a.provider || '—'}{a.model ? ` · ${a.model}` : ''}）
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} title="关闭智能分析">×</button>
        </div>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.length <= 1 && (
          <div style={{ color: 'var(--text-muted)', margin: 'auto', textAlign: 'center', maxWidth: 360 }}>
            已加载「{studentName}」的全景摘要，可询问学习情况、考勤趋势、家校沟通总结、招生意向等任何问题。
          </div>
        )}
        {messages.map((m, i) => {
          if (m.role === 'system') return null;
          return (
            <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div
                style={{
                  maxWidth: '86%',
                  background: m.role === 'user' ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: m.role === 'user' ? '#fff' : 'var(--text)',
                  padding: '10px 14px',
                  borderRadius: 12,
                  fontSize: 14,
                  lineHeight: 1.6,
                }}
              >
                <Markdown>{m.content}</Markdown>
              </div>
            </div>
          );
        })}
        {sending && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>思考中…</div>}
      </div>

      <div style={{ flexShrink: 0, borderTop: '1px solid var(--border)', padding: 12, display: 'flex', gap: 8 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="输入与学生相关的问题，Enter 发送…"
          disabled={!student || sending}
          style={{
            flex: 1,
            resize: 'none',
            height: 44,
            background: 'var(--bg-tertiary)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 10,
            fontSize: 14,
          }}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!student || sending || !input.trim()}
          onClick={send}
        >
          {sending ? '发送中' : '发送'}
        </button>
      </div>
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
