'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { api, type MyIdpComms } from '../lib/api';
import NotePanel from './NotePanel';

/**
 * IDP 沟通抽屉（老师端与管理员端共用）。
 *
 * ## 沟通记录**不是**独立表
 *
 * 它就是「学生记录」里 `记录类型=IDP沟通` 的那批 ⇒
 *   · 读：`GET /my-idp/comms`（服务端按本配置的学年学期区间过滤）
 *   · 写：`POST /student-records`（**复用学生记录的完整能力**：附件、录音、AI 总结、
 *         关联笔记、闭环状态……所以峰哥要的「学生记录里已关联的 IDP 记录自动出现在这里」
 *         天生成立 —— 本来就是一个池子，不存在"同步"问题）
 *   · 「手动再添加笔记里的 IDP 记录」= 下面每条的「关联笔记」面板（`NotePanel`），
 *     它与学生记录详情页用的是**同一个组件**（标签 + 映射表双写机制已具备）。
 *
 * ⚠️ 附件字段名是「沟通附件清单」（**可写**）。学生记录 meta 的 `readonly` 里那条是
 *    「沟通附件」（少一个字，是另一个字段）—— 别搞混，写进 readonly 的会被静默丢弃。
 */
export interface IdpCommTarget {
  configId: string;
  configName: string;
  studentId: string;
  studentName: string;
  cls: string;
  /** 归档批次：只读（不给新建） */
  archived: boolean;
  /** 当前登录人姓名（新建时填「沟通人」） */
  meName?: string;
}

/** 附件条目形态：与学生记录「沟通附件清单」的存储一致（CrudPage 也按这个结构读） */
interface Attach {
  file_token: string;
  name: string;
  size?: number;
}

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'baseline',
  padding: '10px 0',
  borderTop: '1px solid var(--border)',
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本机当前时间 → `YYYY-MM-DDTHH:mm`（datetime 表单格式） */
function nowLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function IdpCommDrawer({
  target,
  onClose,
  onSaved,
}: {
  target: IdpCommTarget;
  onClose: () => void;
  /** 新建成功后的回调（父页面用它刷新沟通次数） */
  onSaved?: () => void;
}) {
  const t = useTranslations('myIdp');
  const [data, setData] = useState<MyIdpComms | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [openForm, setOpenForm] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 展开「关联笔记」面板的记录 id（一次只开一个，避免十几个面板同时拉数据） */
  const [noteFor, setNoteFor] = useState('');

  // 新建表单
  const [subject, setSubject] = useState('');
  const [when, setWhen] = useState(nowLocal);
  const [summary, setSummary] = useState('');
  const [detail, setDetail] = useState('');
  const [atts, setAtts] = useState<Attach[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      setData(await api.myIdpComms(target.configId, target.studentId));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [target.configId, target.studentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setErr('');
    try {
      const added: Attach[] = [];
      for (const f of Array.from(files)) {
        const r = await api.uploadFile(f);
        added.push({ file_token: r.file_token, name: r.name });
      }
      setAtts((cur) => [...cur, ...added]);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submit = async () => {
    if (!subject.trim() && !summary.trim()) {
      setErr(t('needSubjectOrSummary'));
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await api.createStudentRecord({
        记录类型: 'IDP沟通',
        // 「关联学生编号」在 meta 的 readonly 里 ⇒ 显式传也会被过滤；靠 linkBackfill
        // 按姓名回填（见 lifecycle.meta 的 linkBackfill 注释）
        关联学生: target.studentName,
        沟通主题: subject.trim(),
        沟通时间: when,
        沟通总结: summary,
        沟通明细: detail,
        沟通附件清单: atts,
        沟通人: target.meName ?? '',
      });
      setSubject('');
      setSummary('');
      setDetail('');
      setAtts([]);
      setWhen(nowLocal());
      setOpenForm(false);
      await load();
      onSaved?.();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const count = data?.rows.length ?? 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="detail-modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(820px, 100%)' }}>
        <div className="detail-modal-head">
          <div>
            <h3 className="detail-modal-title">
              {target.studentName}
              {target.cls ? <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>{target.cls}</span> : null}
            </h3>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
              {target.configName}
              {data?.rangeText ? ` · ${t('rangeIs', { range: data.rangeText })}` : ''}
              {` · ${t('commCountIs', { n: count })}`}
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('close')}
          </button>
        </div>

        <div className="detail-modal-body" style={{ whiteSpace: 'normal' }}>
          {data && !data.rangeOk ? (
            <div className="notice notice-warn" style={{ marginBottom: 10 }}>
              {t('rangeBad')}
            </div>
          ) : null}
          {data && data.noTime > 0 ? (
            <div className="notice" style={{ marginBottom: 10 }}>
              {t('noTimeWarn', { n: data.noTime })}
            </div>
          ) : null}
          {err ? (
            <div className="notice notice-error" style={{ marginBottom: 10 }}>
              {err}
            </div>
          ) : null}

          {/* ── 新建一次沟通：走学生记录的 create（附件/录音/AI 总结全都共用现成能力） ── */}
          {target.archived ? (
            <div className="muted" style={{ marginBottom: 10, fontSize: 12.5 }}>
              {t('archivedReadonly')}
            </div>
          ) : openForm ? (
            <div className="card" style={{ padding: 12, marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  className="form-input"
                  style={{ flex: '1 1 240px' }}
                  placeholder={t('fSubject')}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
                <input
                  className="form-input"
                  style={{ width: 190 }}
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                />
              </div>
              <textarea
                className="form-input"
                style={{ marginTop: 8, minHeight: 64 }}
                placeholder={t('fSummary')}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
              <textarea
                className="form-input"
                style={{ marginTop: 8, minHeight: 90 }}
                placeholder={t('fDetail')}
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
              />
              {/* 附件：上传后写进「沟通附件清单」（与 CrudPage 的 attachment 字段同结构） */}
              <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  {uploading ? t('uploading') : t('uploadAttachment')}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => void pickFiles(e.target.files)}
                />
                {atts.map((a) => (
                  <span key={a.file_token} className="tag">
                    {a.name}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setAtts((cur) => cur.filter((x) => x.file_token !== a.file_token))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={() => void submit()}>
                  {saving ? t('saving') : t('save')}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpenForm(false)}>
                  {t('cancel')}
                </button>
                <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
                  {t('fullFormHint')}
                </span>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              style={{ marginBottom: 12 }}
              onClick={() => setOpenForm(true)}
            >
              ＋ {t('addComm')}
            </button>
          )}

          {/* ── 时间线（就是学生记录里那批，按本配置学年学期过滤） ── */}
          {loading ? (
            <div className="muted">{t('loading')}</div>
          ) : count === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">🗒️</div>
              <div className="empty-state-text">{t('noComm')}</div>
            </div>
          ) : (
            <div>
              {(data?.rows ?? []).map((r) => (
                <div key={r.id} style={rowStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{r.subject || t('noSubject')}</div>
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                      {fmtTime(r.time)}
                      {r.person ? ` · ${r.person}` : ''}
                      {r.attachments ? ` · 📎 ${r.attachments}` : ''}
                      {r.status ? ` · ${r.status}` : ''}
                    </div>
                    {r.summary ? (
                      <div style={{ fontSize: 13, marginTop: 4, color: 'var(--fg-secondary)' }}>
                        {r.summary.length > 120 ? `${r.summary.slice(0, 120)}…` : r.summary}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {/* 「手动再添加笔记里的 IDP 记录」：与详情页同一个面板（标签 + 映射表双写） */}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setNoteFor((cur) => (cur === r.id ? '' : r.id))}
                    >
                      {t('notes')}
                    </button>
                    <a className="btn btn-ghost btn-sm" href={`/student-records/${r.id}`} target="_blank" rel="noreferrer">
                      {t('open')}
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}

          {noteFor ? (
            <div style={{ marginTop: 12 }}>
              <NotePanel entityType="IDP沟通" entityId={noteFor} entityName={target.studentName} />
            </div>
          ) : null}
        </div>

        <div className="detail-modal-foot">
          <span className="muted" style={{ marginRight: 'auto', fontSize: 12 }}>
            {t('footerHint')}
          </span>
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  );
}
