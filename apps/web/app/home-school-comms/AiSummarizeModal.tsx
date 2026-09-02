'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api } from '../../lib/api';

interface Attachment {
  file_token: string;
  name: string;
}

interface AiSummarizeModalProps {
  recordId: string;
  recordName?: string;
  /** 区分数据来源表：家校沟通 / 日常跟进 */
  kind?: 'home-school-comms' | 'daily-followups';
  onClose: () => void;
  onSuccess: () => void;
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--overlay)',
  zIndex: 60,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: '6vh 16px',
  overflowY: 'auto',
};

const modalStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  width: 'min(640px, 100%)',
  boxShadow: 'var(--shadow-modal)',
};

const sectionStyle: React.CSSProperties = {
  padding: '16px 22px',
  borderBottom: '1px solid var(--border)',
};

export default function AiSummarizeModal({ recordId, recordName, kind = 'home-school-comms', onClose, onSuccess }: AiSummarizeModalProps) {
  const t = useTranslations('homeSchool');
  const [loading, setLoading] = useState(false);
  const [preparing, setPreparing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [currentDetail, setCurrentDetail] = useState('');
  const [currentSummary, setCurrentSummary] = useState('');
  const [content, setContent] = useState('');
  const [overwriteDetail, setOverwriteDetail] = useState(false);
  const [overwriteSummary, setOverwriteSummary] = useState(false);

  const prepare = kind === 'daily-followups' ? api.dailyFollowupAiPrepare : api.aiSummarizePrepare;
  const syncAttachment = kind === 'daily-followups' ? api.dailyFollowupAiSyncAttachment : api.aiSummarizeSyncAttachment;
  const mergeAllApi = kind === 'daily-followups' ? api.dailyFollowupAiMergeAll : api.aiSummarizeMergeAll;

  useEffect(() => {
    let alive = true;
    prepare(recordId)
      .then((res) => {
        if (!alive) return;
        setAttachments(res.attachments || []);
        setCurrentDetail(res.currentDetail || '');
        setCurrentSummary(res.currentSummary || '');
        setContent(res.content || '');
        setOverwriteDetail(!res.currentDetail?.trim());
        setOverwriteSummary(!res.currentSummary?.trim());
        setPreparing(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : '加载失败');
        setPreparing(false);
      });
    return () => {
      alive = false;
    };
  }, [recordId]);

  const hasSource = attachments.length > 0 || content.trim().length > 0;
  const hasDetail = currentDetail.trim().length > 0;
  const hasSummary = currentSummary.trim().length > 0;

  async function syncOne(fileToken: string, name: string) {
    setLoading(true);
    setError(null);
    try {
      await syncAttachment(recordId, fileToken, overwriteDetail);
      onSuccess();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : `同步「${name}」失败`);
    } finally {
      setLoading(false);
    }
  }

  async function mergeAll() {
    setLoading(true);
    setError(null);
    try {
      await mergeAllApi(recordId, overwriteDetail, overwriteSummary);
      onSuccess();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '合并生成失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '18px 22px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <h3 style={{ margin: 0, fontSize: 'var(--font-lg)', fontWeight: 700 }}>
            AI 总结 · {recordName || recordId}
          </h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={loading}>
            ×
          </button>
        </div>

        {error && <p className="msg-error" style={{ margin: '12px 22px 0' }}>{error}</p>}

        {preparing ? (
          <div style={{ padding: '32px 22px', textAlign: 'center', color: 'var(--fg-tertiary)' }}>{t('preparing')}</div>
        ) : (
          <>
            {(hasDetail || hasSummary) && (
              <div style={sectionStyle}>
                <div style={{ fontWeight: 600, marginBottom: 12 }}>{t('existingContent')}</div>
                {hasDetail && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)', marginBottom: 6 }}>
                      沟通明细（MD 对话记录）已有内容
                    </div>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginRight: 20, cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="detailAction"
                        checked={overwriteDetail}
                        onChange={() => setOverwriteDetail(true)}
                      />
                      覆盖沟通明细
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="detailAction"
                        checked={!overwriteDetail}
                        onChange={() => setOverwriteDetail(false)}
                      />
                      忽略沟通明细
                    </label>
                  </div>
                )}
                {hasSummary && (
                  <div>
                    <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)', marginBottom: 6 }}>
                      沟通总结（报告）已有内容
                    </div>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginRight: 20, cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="summaryAction"
                        checked={overwriteSummary}
                        onChange={() => setOverwriteSummary(true)}
                      />
                      覆盖沟通总结
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="summaryAction"
                        checked={!overwriteSummary}
                        onChange={() => setOverwriteSummary(false)}
                      />
                      忽略沟通总结
                    </label>
                  </div>
                )}
              </div>
            )}

            <div style={sectionStyle}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ fontWeight: 600 }}>{t('attachmentList')}</div>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={loading || !hasSource}
                  onClick={mergeAll}
                >
                  {loading ? t('processing') : t('mergeAll')}
                </button>
              </div>

              {!hasSource ? (
                <div style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)' }}>
                  该记录没有可读取的附件或沟通内容，无法生成总结。
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {attachments.map((a) => (
                    <div
                      key={a.file_token}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: 'var(--bg-hover)',
                      }}
                    >
                      <span style={{ fontSize: 'var(--font-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {a.name}
                      </span>
                      <button
                        className="btn btn-outline btn-sm"
                        disabled={loading}
                        onClick={() => syncOne(a.file_token, a.name)}
                      >
                        同步
                      </button>
                    </div>
                  ))}
                  {content.trim() && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: 'var(--bg-hover)',
                      }}
                    >
                      <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>
                        沟通内容（文本）
                      </span>
                      <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>{t('autoIncludedOnMerge')}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 10,
                padding: '16px 22px',
                borderTop: '1px solid var(--border)',
              }}
            >
              <button className="btn btn-ghost" onClick={onClose} disabled={loading}>
                取消
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
