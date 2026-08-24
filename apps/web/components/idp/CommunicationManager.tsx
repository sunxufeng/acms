'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

interface Comm { id: string; 沟通日期?: unknown; 沟通人?: unknown; 沟通内容?: unknown; 需要的帮助_下一步计划?: unknown; 原始文档?: unknown }
interface Att { file_token: string; name: string }

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}
function attachmentFiles(v: unknown): Att[] {
  if (Array.isArray(v)) return v as Att[];
  if (typeof v === 'string' && v.trim()) {
    try { const p = JSON.parse(v); if (Array.isArray(p)) return p as Att[]; } catch { /* ignore */ }
  }
  return [];
}
function toLocal(v: string): string { return v.trim() ? v.replace(' ', 'T') : ''; }

const EMPTY = { 沟通日期: '', 沟通人: '', 沟通内容: '', 需要的帮助_下一步计划: '', 原始文档: [] as Att[] };

export default function CommunicationManager({ planId }: { planId: string }) {
  const [items, setItems] = useState<Comm[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<null | { mode: 'create' | 'edit'; row?: Comm }>(null);
  const [form, setForm] = useState<{ 沟通日期: string; 沟通人: string; 沟通内容: string; 需要的帮助_下一步计划: string; 原始文档: Att[] }>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await api.listIdpCommunications({ 关联IDP方案: planId });
      setItems((res.items ?? []) as unknown as Comm[]);
    } catch (e) { setError(e instanceof Error ? e.message : '加载失败'); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [planId]);

  function openCreate() { setForm(EMPTY); setEditing({ mode: 'create' }); setError(null); }
  function openEdit(row: Comm) {
    setForm({
      沟通日期: str(row.沟通日期),
      沟通人: str(row.沟通人),
      沟通内容: str(row.沟通内容),
      需要的帮助_下一步计划: str(row.需要的帮助_下一步计划),
      原始文档: attachmentFiles(row.原始文档),
    });
    setEditing({ mode: 'edit', row });
    setError(null);
  }

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
      需要的帮助_下一步计划: form.需要的帮助_下一步计划 || undefined,
      原始文档: form.原始文档.length ? JSON.stringify(form.原始文档) : undefined,
    };
    try {
      if (editing?.mode === 'edit' && editing.row) await api.updateIdpCommunication(String(editing.row.id), payload);
      else await api.createIdpCommunication(payload);
      setEditing(null);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setSaving(false); }
  }

  async function remove(row: Comm) {
    if (!confirm('确认删除该沟通记录？')) return;
    try { await api.archiveIdpCommunication(String(row.id)); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : '删除失败'); }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--font-lg)' }}>沟通记录</h2>
        <button className="btn btn-primary btn-sm" onClick={openCreate} disabled={Boolean(editing)}>+ 新增沟通</button>
      </div>

      {error && <p className="msg-error">{error}</p>}

      {loading ? <div className="empty-state">加载中…</div> : (
        items.length === 0 ? <div className="empty-state">暂无沟通记录</div> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th style={{ width: 130 }}>沟通日期</th><th style={{ width: 100 }}>沟通人</th><th>沟通内容</th><th style={{ width: 140 }}>操作</th></tr></thead>
              <tbody>
                {items.map((it) => (
                  <tr key={String(it.id)}>
                    <td>{str(it.沟通日期) || '—'}</td>
                    <td>{str(it.沟通人) || '—'}</td>
                    <td style={{ whiteSpace: 'pre-wrap', maxWidth: 480 }}>{str(it.沟通内容) || '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(it)}>编辑</button>
                        <button className="btn btn-danger btn-sm" onClick={() => remove(it)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {editing && (
        <div className="crud-inline-form" style={{ marginTop: 16 }}>
          <div className="crud-inline-form-head"><h3 className="crud-inline-form-title">{editing.mode === 'create' ? '新增沟通记录' : '编辑沟通记录'}</h3></div>
          <fieldset className="form-fieldset">
            <legend className="form-legend">沟通信息</legend>
            <div className="form-grid">
              <div className="form-label"><span className="form-label-text">沟通日期</span>
                <input type="date" className="form-input" value={form.沟通日期} onChange={(e) => setForm((f) => ({ ...f, 沟通日期: e.target.value }))} />
              </div>
              <div className="form-label"><span className="form-label-text">沟通人</span>
                <input className="form-input" value={form.沟通人} onChange={(e) => setForm((f) => ({ ...f, 沟通人: e.target.value }))} />
              </div>
              <div className="form-label" style={{ gridColumn: '1 / -1' }}><span className="form-label-text">沟通内容</span>
                <textarea className="form-input" rows={3} value={form.沟通内容} onChange={(e) => setForm((f) => ({ ...f, 沟通内容: e.target.value }))} />
              </div>
              <div className="form-label" style={{ gridColumn: '1 / -1' }}><span className="form-label-text">需要的帮助 / 下一步计划</span>
                <textarea className="form-input" rows={3} value={form.需要的帮助_下一步计划} onChange={(e) => setForm((f) => ({ ...f, 需要的帮助_下一步计划: e.target.value }))} />
              </div>
              <div className="form-label" style={{ gridColumn: '1 / -1' }}><span className="form-label-text">原始文档</span>
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
              </div>
            </div>
          </fieldset>
          <div className="crud-inline-form-actions">
            <button className="btn btn-ghost" onClick={() => setEditing(null)}>取消</button>
            <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
