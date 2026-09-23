'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/date';
import { fmtAttachmentSize, parseMailAttachments } from '../lib/mailAttachments';
import { humanizeError } from '../lib/errMsg';
import { Modal } from './Modal';

/**
 * 邮件详情弹窗（2026-09-24，供「我的跟进」展开区点击邮件标题用）。
 *
 * 展示：主题 / 发件人 / 收件人 / 抄送 / 发送时间 / 正文 / 附件（点击即换取下载链接）。
 * 附件解析与体积格式化复用 `lib/mailAttachments`（与邮件归档列表、学生档案同一份）。
 *
 * ⚠️ 正文按**纯文本**渲染（与邮件归档详情页一致）：邮件正文是上游 IMAP 抓下来的原样文本，
 *    直接当 Markdown 渲染会把 `*` `#` 这类字符吃掉或变形。
 */
export default function MailDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations('myFollowups');
  const tm = useTranslations('mailArchive');
  const [rec, setRec] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [fail, setFail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setFail('');
    api
      .getRecord('/mail-archive', id)
      .then(setRec)
      .catch((e) => setFail(String((e as Error)?.message ?? e)))
      .finally(() => setLoading(false));
  }, [id]);

  const download = useCallback(
    async (token: string) => {
      setBusy(token);
      try {
        const { url } = await api.getMailAttachmentUrl(id, token);
        window.open(url, '_blank', 'noopener,noreferrer');
      } catch (e) {
        alert(t('mailAttachmentFailed', { msg: humanizeError(e) }));
      } finally {
        setBusy(null);
      }
    },
    [id, t],
  );

  const atts = parseMailAttachments(rec?.['附件信息']);
  const attFailed = String(rec?.['附件失败原因'] ?? '').trim();
  const body = String(rec?.['正文'] ?? tm('noBody'));

  const Row = ({ label, value }: { label: string; value: unknown }) =>
    value ? (
      <div style={{ display: 'flex', gap: 10, fontSize: 12.5, padding: '3px 0' }}>
        <span style={{ width: 64, color: 'var(--fg-secondary)', flexShrink: 0 }}>{label}</span>
        <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-all', color: 'var(--fg)' }}>{String(value)}</span>
      </div>
    ) : null;

  return (
    <Modal
      title={String(rec?.['主题'] ?? tm('noSubject'))}
      onClose={onClose}
      width={820}
      footer={
        <Link href={`/mail-archive/${id}`} className="btn btn-outline btn-sm" onClick={onClose}>
          {t('openFullPage')} →
        </Link>
      }
    >
      {loading ? (
        <p style={{ color: 'var(--fg-tertiary)' }}>{t('loading')}</p>
      ) : fail ? (
        <p className="msg-error">{t('loadFailed', { msg: fail })}</p>
      ) : (
        <>
          <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid var(--border)' }}>
            <Row label={t('mailDirection')} value={rec?.['邮件方向']} />
            <Row label={t('mailFrom')} value={rec?.['发件人']} />
            <Row label={t('mailTo')} value={rec?.['收件人']} />
            <Row label={t('mailCc')} value={rec?.['抄送']} />
            <Row label={t('mailTime')} value={rec?.['发送时间'] ? formatDateTime(rec['发送时间']) : ''} />
            <Row label={t('mailAccount')} value={rec?.['归属账户']} />
          </div>

          <div
            style={{
              maxHeight: '46vh',
              overflowY: 'auto',
              padding: 12,
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--bg)',
              fontSize: 13,
              lineHeight: 1.65,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {body}
          </div>

          {atts.length > 0 || attFailed ? (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                {t('attachmentsTitle', { count: atts.length })}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {atts.map((a) => (
                  <button
                    key={a.file_token}
                    type="button"
                    className="link-btn"
                    disabled={busy === a.file_token}
                    onClick={() => void download(a.file_token)}
                    style={{ textAlign: 'left', fontSize: 12.5 }}
                  >
                    {a.name}
                    {a.size ? <span style={{ color: 'var(--fg-tertiary)' }}>（{fmtAttachmentSize(a.size)}）</span> : null}
                  </button>
                ))}
                {attFailed ? (
                  <span style={{ fontSize: 11.5, color: '#c0392b' }}>{t('mailAttachmentsFailedHint')}</span>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      )}
    </Modal>
  );
}
