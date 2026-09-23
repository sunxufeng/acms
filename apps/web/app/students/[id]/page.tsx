'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, type StudentRecord } from '../../../lib/api';
import { StudentForm } from '../../../components/StudentForm';
import { NotePanel } from '../../../components/NotePanel';
import { formatDate } from '../../../lib/date';
import { fmtAttachmentSize, parseMailAttachments } from '../../../lib/mailAttachments';
import { humanizeError } from '../../../lib/errMsg';
import { useTranslations } from 'next-intl';

/** 「相关邮件」最多直接列几封，其余折进「查看全部」（有的学生往来几十封，全铺开会把页面撑爆） */
const MAX_VISIBLE_MAILS = 6;
/** 每封邮件最多列几个附件名，其余用「还有 N 个」折叠 */
const MAX_VISIBLE_ATTS = 3;

/** 发送时间 → 时间戳（仅用于排序；解析不了按 0 处理，排到最后） */
function mailTs(v: unknown): number {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : 0;
}

export default function StudentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations('students');
  const tc = useTranslations('common');
  const id = String(params.id);
  const [student, setStudent] = useState<StudentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true); setError('');
    api
      .getStudent(id)
      .then((data) => setStudent(data))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [id]);

  /**
   * 该生相关邮件。
   *
   * 🔴 筛选**必须**用 `关联学生__has=<学生记录 id>`，不能写 `关联学生=<id>`（2026-09-23 修）：
   *    「关联学生」是飞书**单向关联字段（type=18）**，服务端对它的等值/contains 一律无效
   *    ⇒ 恒 0 条。生产实测同一封邮件：等值筛 **0 条** / `__has` 筛 **2 条**。
   *    这个区块因此长期显示「暂无关联邮件」，而邮件其实早就在归档里挂好了学生。
   *    `__has` 走内存匹配，认 `关联学生__link` 数组里的 record id（见 generic-crud 的 `__has` 分支）。
   *
   * 拉回来后按**发送时间倒序**：服务端默认排序不保证按时间，而这里要看最新的几封。
   */
  const [mails, setMails] = useState<Record<string, unknown>[]>([]);
  const [mailsLoading, setMailsLoading] = useState(true);
  const [busyAtt, setBusyAtt] = useState<string | null>(null);

  useEffect(() => {
    setMailsLoading(true);
    api
      .listMailArchive({ '关联学生__has': id, pageSize: '100' })
      .then((d) =>
        setMails([...(d.items ?? [])].sort((a, b) => mailTs(b['发送时间']) - mailTs(a['发送时间']))),
      )
      .catch(() => setMails([]))
      .finally(() => setMailsLoading(false));
  }, [id]);

  /** 附件下载：换取临时链接后新窗口打开（与邮件归档详情页同一接口、同一权限口径） */
  const downloadAtt = useCallback(
    async (recordId: string, fileToken: string) => {
      setBusyAtt(fileToken);
      try {
        const { url } = await api.getMailAttachmentUrl(recordId, fileToken);
        window.open(url, '_blank', 'noopener,noreferrer');
      } catch (e) {
        alert(t('mailAttachmentFailed', { msg: humanizeError(e) }));
      } finally {
        setBusyAtt(null);
      }
    },
    [t],
  );

  if (loading) return <div className="empty-state" style={{ minHeight: '50vh' }}><div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /></div>;
  if (error) return <div className="page-header"><p className="msg-error">加载失败：{error}</p></div>;
  if (!student) return <div className="page-header"><p style={{ color: 'var(--fg-tertiary)' }}>{t('notFound')}</p></div>;

  const name = String(student['学生姓名'] ?? '—');
  const code = String(student['学生编号'] ?? '');
  /** 归档页的「关联」列筛选是按**姓名**模糊匹配（`related` 参数），作为「看全部」入口够用 */
  const archiveHref = `/mail-archive?related=${encodeURIComponent(name)}`;

  return (
    <div>
      {/* ── Header ───────────────── */}
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-lg)' }}>
            <Link href="/students" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6"/></svg>
            </Link>
            <div>
              <div className="page-eyebrow">STUDENT / {code || id.slice(0, 6)}</div>
              <h1 className="page-title">学生档案 · {name}</h1>
              <p className="page-subtitle">{code ? t('codeLabel', { code }) : ''}</p>
            </div>
          </div>
          <div className="page-actions">
            <button className="btn btn-primary btn-sm" onClick={() => router.push(`/students/${id}/edit`)}>{tc('edit')}</button>
          </div>
        </div>
      </div>

      {/* ── Read-only form (same layout as 新建) ── */}
      <StudentForm initial={student} readOnly onSubmit={() => {}} />

      {/* ── 相关邮件 ──
          每封显示：方向 / 主题（可点进详情）/ 发送时间（年月日）/ 发件人 / 附件（文件名可点直接下载）。 */}
      <section style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>
            {mails.length > 0 ? t('relatedMailsCount', { count: mails.length }) : t('relatedMails')}
          </h2>
          {mails.length > 0 ? (
            <Link href={archiveHref} style={{ fontSize: 13, color: 'var(--accent)', whiteSpace: 'nowrap' }}>
              {t('viewAllInArchive')} →
            </Link>
          ) : null}
        </div>

        {mailsLoading ? (
          <p style={{ color: 'var(--fg-tertiary)' }}>{t('mailsLoading')}</p>
        ) : mails.length === 0 ? (
          <p style={{ color: 'var(--fg-tertiary)' }}>{t('noRelatedMails')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {mails.slice(0, MAX_VISIBLE_MAILS).map((m) => {
              const mid = String(m.id);
              const atts = parseMailAttachments(m['附件信息']);
              const attFailed = String(m['附件失败原因'] ?? '').trim();
              const isSent = String(m['邮件方向']) === '发件';
              return (
                <div
                  key={mid}
                  style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      className="badge"
                      style={{
                        flexShrink: 0,
                        background: isSent ? 'var(--success-muted)' : 'var(--accent-muted)',
                        color: isSent ? 'var(--success)' : 'var(--accent)',
                      }}
                    >
                      {String(m['邮件方向'] ?? '—')}
                    </span>
                    <Link
                      href={`/mail-archive/${mid}`}
                      style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg)', fontWeight: 500 }}
                    >
                      {String(m['主题'] ?? t('noSubject'))}
                    </Link>
                    <span style={{ color: 'var(--fg-tertiary)', fontSize: 12, flexShrink: 0 }}>
                      {formatDate(m['发送时间'])}
                    </span>
                  </div>

                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--fg-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t('mailFrom')}：{String(m['发件人'] ?? '—')}
                  </div>

                  {atts.length > 0 || attFailed ? (
                    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12 }}>
                      <span style={{ color: 'var(--fg-secondary)', flexShrink: 0 }}>
                        {atts.length > 0 ? t('mailAttachments', { count: atts.length }) : t('mailAttachmentsFailed')}
                      </span>
                      {atts.slice(0, MAX_VISIBLE_ATTS).map((a) => (
                        <button
                          key={a.file_token}
                          type="button"
                          className="link-btn"
                          disabled={busyAtt === a.file_token}
                          title={`${a.name}${a.size ? ` (${fmtAttachmentSize(a.size)})` : ''}`}
                          onClick={() => void downloadAtt(mid, a.file_token)}
                          style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {a.name}
                        </button>
                      ))}
                      {atts.length > MAX_VISIBLE_ATTS ? (
                        <span style={{ color: 'var(--fg-tertiary)' }}>
                          {t('mailAttachmentsMore', { count: atts.length - MAX_VISIBLE_ATTS })}
                        </span>
                      ) : null}
                      {attFailed ? (
                        <span style={{ color: '#c0392b' }} title={attFailed}>
                          {t('mailAttachmentsFailedHint')}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}

            {mails.length > MAX_VISIBLE_MAILS ? (
              <Link href={archiveHref} style={{ fontSize: 13, color: 'var(--accent)' }}>
                {t('mailMoreInArchive', { count: mails.length - MAX_VISIBLE_MAILS })}
              </Link>
            ) : null}
          </div>
        )}
      </section>

      {/* ── 关联笔记（得到大脑） ───────────
          传 `studentId` 即「聚合模式」：把该生**所有路径**关联到的笔记列出来并标出来源
          （本人直接关联 + 各类学生记录的 + 招生跟进的）。
          只传 entityType/entityId 的话只查「实体类型=学生档案」——生产实测那种关联 0 条，
          于是这个面板长期显示「暂无关联笔记」，而笔记其实挂在学生记录上。 */}
      <NotePanel entityType="学生档案" entityId={id} entityName={name} studentId={id} />
    </div>
  );
}
