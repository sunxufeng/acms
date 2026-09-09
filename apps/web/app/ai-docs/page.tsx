'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import ReactMarkdown from 'react-markdown';

interface AiDoc {
  id: string;
  title: string;
  content: string;
  ownerOpenId: string | null;
  refTable: string | null;
  refRecord: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function AiDocsPage() {
  const tl = useTl();
  const [docs, setDocs] = useState<AiDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<AiDoc | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  const flash = (m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(''), 2500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = (await api.aiDocs.list()) as AiDoc[];
      setDocs(list);
    } catch (e) {
      setError((e as Error).message || tl('加载失败'));
    } finally {
      setLoading(false);
    }
  }, [tl]);

  useEffect(() => {
    load();
  }, [load]);

  const open = (doc: AiDoc) => {
    setSelected(doc);
    setEditing(false);
    setTitle(doc.title);
    setContent(doc.content);
  };

  const newDoc = () => {
    setSelected(null);
    setEditing(true);
    setTitle('');
    setContent('');
  };

  const save = async () => {
    setSaving(true);
    try {
      if (selected) {
        await api.aiDocs.update(selected.id, { title, content });
        flash(tl('已保存'));
      } else {
        const r = await api.aiDocs.create({ title, content });
        flash(`已创建（${r.id}）`);
      }
      await load();
      if (selected) setSelected({ ...selected, title, content });
      else setEditing(false);
    } catch (e) {
      flash(`保存失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(tl('确认删除该文档？'))) return;
    try {
      await api.aiDocs.remove(id);
      flash(tl('已删除'));
      setSelected(null);
      await load();
    } catch (e) {
      flash(`删除失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="page-content">
      <style>{`
        .ai-docs-layout { display: flex; gap: 16px; margin-top: 16px; }
        .ai-docs-list { width: 280px; flex: 0 0 280px; display: flex; flex-direction: column; gap: 8px; max-height: 72vh; overflow: auto; }
        .ai-doc-item { text-align: left; padding: 10px 12px; border: 1px solid var(--border, #e5e7eb); border-radius: 8px; background: var(--bg-elevated, #fff); cursor: pointer; }
        .ai-doc-item.is-active { border-color: var(--accent, #0F2E2B); background: #f3f6f6; }
        .ai-doc-item-title { font-weight: 600; }
        .ai-doc-item-meta { font-size: 12px; color: var(--fg-tertiary, #888); margin-top: 2px; }
        .ai-docs-main { flex: 1; min-width: 0; }
        .ai-docs-toolbar { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
        .ai-docs-editor { width: 100%; min-height: 60vh; padding: 12px; border: 1px solid var(--border, #e5e7eb); border-radius: 8px; font-family: monospace; font-size: 14px; }
        .ai-docs-preview { padding: 12px; border: 1px solid var(--border, #e5e7eb); border-radius: 8px; min-height: 60vh; overflow: auto; }
      `}</style>
      <div className="page-header">
        <div>
          <div className="eyebrow">{tl('智能助手 / AI 文档')}</div>
          <h1 className="page-title">{tl('AI 文档')}</h1>
          <p className="page-subtitle">
            AI 生成的文档（Markdown）保存在 ACMS 内部（PostgreSQL），可在本页查看与编辑，不再写入飞书云文档。
          </p>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-primary" onClick={newDoc}>
            {tl('新建文档')}
          </button>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
      {error && <div className="empty-state empty-state--error">{error}</div>}

      <div className="ai-docs-layout">
        <div className="ai-docs-list">
          {loading && <div className="empty-state">{tl('加载中…')}</div>}
          {!loading && !docs.length && <div className="empty-state">暂无文档</div>}
          {docs.map((d) => (
            <button
              key={d.id}
              className={`ai-doc-item ${selected?.id === d.id ? 'is-active' : ''}`}
              onClick={() => open(d)}
            >
              <div className="ai-doc-item-title">{d.title}</div>
              <div className="ai-doc-item-meta">{new Date(d.updatedAt).toLocaleString()}</div>
            </button>
          ))}
        </div>

        <div className="ai-docs-main">
          {selected || editing ? (
            <>
              <div className="ai-docs-toolbar">
                <input
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={tl('文档标题')}
                  style={{ flex: 1 }}
                />
                {selected && (
                  <button className="btn btn-outline" onClick={() => setEditing((v) => !v)}>
                    {editing ? tl('取消') : tl('编辑')}
                  </button>
                )}
                <button className="btn btn-primary" onClick={save} disabled={saving}>
                  {saving ? tl('保存中…') : tl('保存')}
                </button>
                {selected && (
                  <button className="btn btn-danger" onClick={() => remove(selected.id)}>
                    {tl('删除')}
                  </button>
                )}
              </div>
              {editing ? (
                <textarea
                  className="ai-docs-editor"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="# 支持 Markdown"
                />
              ) : (
                <div className="ai-docs-preview markdown-body">
                  <ReactMarkdown>{content || '*（空文档）*'}</ReactMarkdown>
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">选择左侧文档查看，或点击「新建文档」。</div>
          )}
        </div>
      </div>
    </div>
  );
}
