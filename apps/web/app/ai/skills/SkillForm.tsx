'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

type Tool = { name: string; description: string };
export type Skill = { name: string; note?: string; tags?: string[]; description?: string; markdown?: string; hasMarkdown?: boolean };

export function SkillForm({ initial, onDone }: { initial?: Skill; onDone: () => void }) {
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
      setError('请选择要配置的内置工具');
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
        <legend className="form-legend">技能信息</legend>
        <div className="form-grid">
          <label className="form-label">
            <span className="form-label-text">内置工具 *</span>
            <select className="form-input" value={name} disabled={!!initial} onChange={(e) => selectTool(e.target.value)}>
              <option value="">请选择</option>
              {tools.map((tool) => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
            </select>
          </label>
          <label className="form-label">
            <span className="form-label-text">一句话说明</span>
            <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <label className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">标签（逗号分隔）</span>
            <input className="form-input" value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <label className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">描述</span>
            <textarea className="form-input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">SKILL.md 文档（Markdown）</span>
            <textarea className="form-input" rows={14} style={{ fontFamily: 'monospace' }} value={markdown} onChange={(e) => setMarkdown(e.target.value)} />
          </label>
        </div>
      </fieldset>
      {error && <p className="msg-error">{error}</p>}
      <div style={{ display: 'flex', gap: 10 }}><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button><button type="button" className="btn btn-ghost" onClick={onDone}>取消</button></div>
    </form>
  );
}
