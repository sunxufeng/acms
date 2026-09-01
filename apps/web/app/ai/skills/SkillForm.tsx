'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api } from '../../../lib/api';
import MarkdownField from '../../../components/MarkdownField';

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
          <div className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">{t('mdDoc')}</span>
            <MarkdownField
              height={300}
              value={markdown}
              onChange={setMarkdown}
            />
          </div>
        </div>
      </fieldset>
      {error && <p className="msg-error">{error}</p>}
      <div style={{ display: 'flex', gap: 10 }}><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('saving') : t('save')}</button><button type="button" className="btn btn-ghost" onClick={onDone}>{t('cancel')}</button></div>
    </form>
  );
}
