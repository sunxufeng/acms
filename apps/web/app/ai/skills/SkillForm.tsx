'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslations } from 'next-intl';
import { api } from '../../../lib/api';

type Tool = { name: string; description: string };
export type Skill = { name: string; note?: string; tags?: string[]; description?: string; markdown?: string; hasMarkdown?: boolean };

export function SkillForm({ initial, onDone }: { initial?: Skill; onDone: () => void }) {
  const t = useTranslations('ai.skills');
  const [tools, setTools] = useState<Tool[]>([]);
  const [name, setName] = useState(initial?.name || '');
  const [note, setNote] = useState(initial?.note || '');
  const [tags, setTags] = useState((initial?.tags || []).join(', '));
  const [description, setDescription] = useState(initial?.description || '');
  const [markdown, setMarkdown] = useState(initial?.markdown || '');
  const [mdTab, setMdTab] = useState<'edit' | 'preview'>('edit');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.aiTools().then((data) => setTools(data as Tool[])).catch((e) => setError((e as Error).message));
  }, []);

  function selectTool(toolName: string) {
    setName(toolName);
    const tool = tools.find((item) => item.name === toolName);
    if (tool && !description) setDescription(tool.description);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name) {
      setError(t('errSelectTool'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.aiSaveSkill(name, {
        note: note.trim(),
        tags: tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
        description: description.trim(),
        markdown,
      });
      onDone();
    } catch (e2) {
      setError((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function handleMdImport() {
    fileInputRef.current?.click();
  }

  function onMdFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      if (text) setMarkdown(text);
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  return (
    <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <fieldset className="form-fieldset">
        <legend className="form-legend">{t('legend')}</legend>
        <div className="form-grid">
          <label className="form-label">
            <span className="form-label-text">{t('builtinTool')}</span>
            <select className="form-input" value={name} disabled={!!initial} onChange={(e) => selectTool(e.target.value)}>
              <option value="">{t('toolPlaceholder')}</option>
              {tools.map((tool) => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
            </select>
          </label>
          <label className="form-label">
            <span className="form-label-text">{t('note')}</span>
            <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <label className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">{t('tags')}</span>
            <input className="form-input" value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <label className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">{t('description')}</span>
            <textarea className="form-input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="form-label" style={{ gridColumn: '1 / -1' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() => setMdTab('edit')}
                  style={{
                    padding: '4px 18px',
                    borderRadius: 20,
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: mdTab === 'edit' ? 600 : 400,
                    color: mdTab === 'edit' ? '#fff' : '#666',
                    background: mdTab === 'edit' ? '#10b981' : '#f0f0f0',
                    transition: 'all 0.15s',
                  }}
                >{t('mdEdit')}</button>
                <button
                  type="button"
                  onClick={() => setMdTab('preview')}
                  style={{
                    padding: '4px 18px',
                    borderRadius: 20,
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: mdTab === 'preview' ? 600 : 400,
                    color: mdTab === 'preview' ? '#fff' : '#666',
                    background: mdTab === 'preview' ? '#10b981' : '#f0f0f0',
                    transition: 'all 0.15s',
                  }}
                >{t('mdPreview')}</button>
              </div>
              <button
                type="button"
                onClick={handleMdImport}
                style={{
                  padding: '4px 14px',
                  borderRadius: 20,
                  border: '1px solid #d1d5db',
                  cursor: 'pointer',
                  fontSize: 12,
                  color: '#374151',
                  background: '#fff',
                }}
              >{t('mdImport')}</button>
            </div>
            <input ref={fileInputRef} type="file" accept=".md,.txt,.markdown" style={{ display: 'none' }} onChange={onMdFileChange} />
            {mdTab === 'edit' ? (
              <textarea className="form-input" rows={14} style={{ fontFamily: 'monospace' }} value={markdown} onChange={(e) => setMarkdown(e.target.value)} />
            ) : (
              <div className="form-input" style={{
                minHeight: 280,
                maxHeight: 500,
                overflowY: 'auto',
                padding: '12px 16px',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                lineHeight: 1.7,
                fontSize: 14,
                color: '#1f2937',
                background: '#fafafa',
                wordBreak: 'break-word',
              }}>
                {markdown ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {markdown}
                  </ReactMarkdown>
                ) : (
                  <span style={{ color: '#9ca3af' }}>{t('mdEmpty')}</span>
                )}
              </div>
            )}
          </label>
        </div>
      </fieldset>
      {error && <p className="msg-error">{error}</p>}
      <div style={{ display: 'flex', gap: 10 }}><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('saving') : t('save')}</button><button type="button" className="btn btn-ghost" onClick={onDone}>{t('cancel')}</button></div>
    </form>
  );
}
