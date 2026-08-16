'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api, type StudentRecord } from '../../../lib/api';
import { StudentForm } from '../../../components/StudentForm';

function str(v: unknown): string {
  if (v == null) return '—';
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、') : '—';
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '—');
  return String(v);
}

const FIELD_LABELS: Record<string, string> = {
  '学生姓名': '姓名', '性别': '性别', '出生日期': '出生日期', '姓名拼音': '拼音',
  '英文名': '英文名', '曾用名': '曾用名', '国籍或地区': '国籍/地区', '民族': '民族',
  '籍贯': '籍贯', '户籍类型': '户籍类型', '政治面貌': '政治面貌',
  '当前状态': '当前状态', '班级': '班级', '校区': '校区', '当前学段': '学段',
  '当前年级': '年级', '入学类型': '入学类型', '入学日期': '入学日期',
  '预计毕业日期': '预计毕业', '毕业日期': '毕业日期', '离校原因': '离校原因',
  '学籍号（脱敏）': '学籍号', '毕业学校': '毕业学校', '专业学科': '专业学科',
  '就读方式': '就读方式', '数据密级': '数据密级', '档案完整度': '档案完整度',
  '最近核验日期': '核验日期', '证件号码（脱敏）': '证件号码', '学生手机号': '手机号',
  '学生邮箱': '邮箱', '现居住地址': '居住地址', '通讯地址': '通讯地址',
  '邮政编码': '邮编', '学生微信号': '微信号', '飞书 Open ID': '飞书 Open ID',
  '学生标签': '标签', '备注': '备注', '健康风险摘要': '健康风险',
  '特殊支持摘要': '特殊支持', '宿舍信息': '宿舍信息',
  '来源渠道': '来源渠道', '生源跟进状态': '跟进状态', '招生负责老师': '招生负责老师',
  '班主任': '班主任', '数据负责人': '数据负责人', '通知状态': '通知状态',
};

// Fields to show in the "identity card" area (top-left)
const IDENTITY_FIELDS = ['学生姓名', '学生编号', '性别', '当前状态', '班级', '校区'];

export default function StudentDetailPage() {
  const params = useParams();
  const id = String(params.id);
  const [student, setStudent] = useState<StudentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await api.getStudent(id);
      setStudent(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (data: Record<string, unknown>) => {
    setSubmitting(true); setMsg('');
    try {
      await api.updateStudent(id, data);
      setMsg('已保存'); setEditing(false); load();
    } catch (e) {
      setMsg('保存失败：' + (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleArchive = async () => {
    if (!confirm('确认将该学生状态改为「离校」？')) return;
    await api.archiveStudent(id); load();
  };

  const handleRestore = async () => {
    await api.restoreStudent(id); load();
  };

  if (loading) return <div className="empty-state" style={{ minHeight: '50vh' }}><div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /></div>;
  if (error) return <div className="page-header"><p className="msg-error">加载失败：{error}</p></div>;
  if (!student) return <div className="page-header"><p style={{ color: 'var(--fg-tertiary)' }}>未找到</p></div>;

  const name = str(student['学生姓名']);
  const status = str(student['当前状态']);
  const level = str(student['数据密级']);

  return (
    <div>
      {/* ── Header ─────────────────────────── */}
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <Link href="/students" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6"/></svg>
            </Link>
            <div>
              <div className="page-eyebrow">STUDENT DETAIL / #{str(student['学生编号']) || id.slice(0, 6)}</div>
              <h1 className="page-title">{name}</h1>
            </div>
          </div>
          <div className="page-actions">
            {!editing && (
              <>
                {status === '离校' ? (
                  <button className="btn btn-outline btn-sm" onClick={handleRestore}>恢复在校</button>
                ) : (
                  <button className="btn btn-danger btn-sm" onClick={handleArchive}>归档(离校)</button>
                )}
                <button className="btn btn-primary btn-sm" onClick={() => setEditing(true)}>编辑</button>
              </>
            )}
          </div>
        </div>
      </div>

      {msg && <p className={msg.startsWith('保存失败') ? 'msg-error' : 'msg-success'}>{msg}</p>}

      {/* ── Content ─────────────────────────── */}
      {editing ? (
        <StudentForm initial={student} onSubmit={handleSave} submitting={submitting} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 'var(--space-lg)' }}>
          {/* Identity card */}
          <div className="form-fieldset">
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
              <span className={`avatar-dot avatar-teal`} style={{ width: 52, height: 52, fontSize: 22 }}>{name.charAt(0)}</span>
              <div>
                <div style={{ fontSize: 'var(--font-xl)', fontWeight: 700 }}>{name}</div>
                <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>#{str(student['学生编号']) || '—'}</div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {IDENTITY_FIELDS.filter(k => k !== '学生姓名').map((k) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>{FIELD_LABELS[k] || k}</span>
                  <span style={{ fontWeight: 600, fontSize: 'var(--font-sm)' }}>
                    {k === '当前状态' ? (
                      <span className={`status-dot ${statusClass(status)}`}>{status || '—'}</span>
                    ) : k === '数据密级' ? (
                      <span className={`badge ${badgeClass(level)}`}>{level || '—'}</span>
                    ) : (
                      str(student[k]) || '—'
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Detail fields grid */}
          <div className="detail-grid">
            {Object.entries(student)
              .filter(([k]) => k !== 'id' && !IDENTITY_FIELDS.includes(k))
              .map(([k, v]) => (
                <div key={k} className="detail-card">
                  <div className="detail-key">{FIELD_LABELS[k] || k}</div>
                  <div className="detail-val">{str(v)}</div>
                </div>
              ))
            }
          </div>
        </div>
      )}
    </div>
  );
}

function statusClass(s: string): string {
  if (s === '在校') return 'status-active';
  if (s === '毕业') return 'status-graduated';
  if (s === '离校') return 'status-left';
  return '';
}
function badgeClass(l: string): string {
  if (l === 'L1') return 'badge-l1'; if (l === 'L2') return 'badge-l2';
  if (l === 'L3') return 'badge-l3'; return 'badge-l4';
}
