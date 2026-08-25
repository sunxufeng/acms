'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../lib/api';
import MarkdownField from '../MarkdownField';

interface Att { file_token: string; name: string }

function toLocal(v: string): string { return v.trim() ? v.replace(' ', 'T') : ''; }
function attachmentFiles(v: unknown): Att[] {
  if (Array.isArray(v)) return v as Att[];
  if (typeof v === 'string' && v.trim()) {
    try { const p = JSON.parse(v); if (Array.isArray(p)) return p as Att[]; } catch { /* ignore */ }
  }
  return [];
}

const EMPTY = { 沟通日期: '', 沟通人: '', 沟通内容: '', help: '', 原始文档: [] as Att[] };

export default function CommunicationForm({ commId }: { commId?: string }) {
  const params = useParams<{ id: string }>();
  const planId = params.id;
  const router = useRouter();

  const [form, setForm] = useState<{ 沟通日期: string; 沟通人: string; 沟通内容: string; help: string; 原始文档: Att[] }>(EMPTY);
  const [loading, setLoading] = useState(Boolean(commId));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!commId) return;
    setLoading(true);
    try {
      const c = await api.getIdpCommunication(commId);
      setForm({
        沟通日期: typeof c['沟通日期'] === 'string' ? c['沟通日期'] : '',
        沟通人: typeof c['沟通人'] === 'string' ? c['沟通人'] : '',
        沟通内容: typeof c['沟通内容'] === 'string' ? c['沟通内容'] : '',
        help: typeof c['需要的帮助/下一步计划'] === 'string' ? c['需要的帮助/下一步计划'] : '',
        原始文档: attachmentFiles(c['原始文档']),
      });
    } catch (e) { setError(e instanceof Error ? e.message : '加载失败'); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [commId]);

  async function onUpload(file: File) {
    setUploading(true); setError(null);
    try { const res = await api.uploadFile(file); setForm((f) => ({ ...f, 原始文档: [...f.原始文档, { file_token: res.file_token, name: res.name }] })); }
    catch (e) { setError(e instanceof Error ? e.message : '上传失败'); }
    finally { setUploading(false); }
  }

  async function submit() {
    setSaving(true); setError(null);
    const payload = {
      关联IDP方案: planId,
      沟通日期: form.沟通日期 || undefined,
      沟通人: form.沟通人 || undefined,
      沟通内容: form.沟通内容 || undefined,
      '需要的帮助/下一步计划': form.help || undefined,
      原始文档: form.原始文档.length ? JSON.stringify(form.原始文档) : undefined,
    };
    try {
      if (commId) await api.updateIdpCommunication(commId, payload);
      else await api.createIdpCommunication(payload);
      router.push(`/idp-plans/${planId}/communications`);
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setSaving(false); }
  }

  return (
    <div className="page">
      <div className="page-header page-header-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-lg)' }}>
          <Link href={`/idp-plans/${planId}/communications`} className="btn btn-icon" title="返回沟通记录">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
          </Link>
          <div>
            <div className="page-eyebrow">IDP / COMMUNICATION</div>
            <h1 className="page-title">{commId ? '编辑沟通记录' : '新增沟通记录'}</h1>
            <p className="page-subtitle">沟通内容 / 需要的帮助·下一步计划 支持 Markdown（MD · 浏览 · MD导入）</p>
          </div>
        </div>
      </div>

      {error && <p className="msg-error">{error}</p>}
      {loading ? <div className="empty-state">加载中…</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <fieldset className="form-fieldset">
            <legend className="form-legend">沟通信息</legend>
            <div className="form-grid">
              <div className="form-label"><span className="form-label-text">沟通日期</span>
                <input type="date" className="form-input" value={form.沟通日期} onChange={(e) => setForm((f) => ({ ...f, 沟通日期: e.target.value }))} />
              </div>
              <div className="form-label"><span className="form-label-text">沟通人</span>
                <input className="form-input" value={form.沟通人} onChange={(e) => setForm((f) => ({ ...f, 沟通人: e.target.value }))} />
              </div>
            </div>
          </fieldset>

          <fieldset className="form-fieldset">
            <legend className="form-legend">沟通明细（MD 对话记录）</legend>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-label">
                <span className="form-label-text">沟通内容</span>
                <MarkdownField value={form.沟通内容} onChange={(v) => setForm((f) => ({ ...f, 沟通内容: v }))} />
              </div>
              <div className="form-label">
                <span className="form-label-text">需要的帮助 / 下一步计划</span>
                <MarkdownField value={form.help} onChange={(v) => setForm((f) => ({ ...f, help: v }))} />
              </div>
            </div>
          </fieldset>

          <fieldset className="form-fieldset">
            <legend className="form-legend">原始文档</legend>
            <input type="file" disabled={uploading} onChange={(e) => { const fl = e.target.files?.[0]; if (fl) onUpload(fl); e.target.value = ''; }} />
            {uploading && <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>上传中…</span>}
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {form.原始文档.map((a, i) => (
                <div key={a.file_token ?? i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-sm)' }}>
                  <a href={`/api/v1/files/${a.file_token}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{a.name}</a>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm((f) => ({ ...f, 原始文档: f.原始文档.filter((_, j) => j !== i) }))}>移除</button>
                </div>
              ))}
            </div>
          </fieldset>

          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
            <button className="btn btn-ghost" onClick={() => router.push(`/idp-plans/${planId}/communications`)}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
