'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

type Tool = { name: string; description: string };
type Skill = { name: string; note: string; tags: string[]; description: string; hasMarkdown: boolean };

const field: React.CSSProperties = { width: '100%', background: 'var(--bg-tertiary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 13, marginBottom: 10 };
const label: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' };
const btn = (primary = false): React.CSSProperties => ({
  background: primary ? 'var(--accent)' : 'transparent', color: primary ? '#fff' : 'var(--text)',
  border: primary ? 'none' : '1px solid var(--border)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13,
});

export default function AiSkillsPage() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [skills, setSkills] = useState<Record<string, Skill>>({});
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<Tool | null>(null);
  const [form, setForm] = useState<{ note: string; tags: string; description: string; markdown: string }>({ note: '', tags: '', description: '', markdown: '' });
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [t, s] = await Promise.all([api.aiTools(), api.aiListSkills()]);
      setTools(t as Tool[]);
      const map: Record<string, Skill> = {};
      (s as Skill[]).forEach((sk) => { map[sk.name] = sk; });
      setSkills(map);
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  function openEdit(t: Tool) {
    const sk = skills[t.name];
    setCurrent(t);
    setForm({
      note: sk?.note || '',
      tags: (sk?.tags || []).join(', '),
      description: sk?.description || '',
      markdown: '',
    });
    // 有文档时拉取 markdown 内容
    if (sk?.hasMarkdown) {
      api.aiGetSkill(t.name).then((d) => setForm((f) => ({ ...f, markdown: (d as { markdown?: string })?.markdown || '' }))).catch(() => null);
    }
    setOpen(true);
  }

  async function save() {
    if (!current) return;
    setBusy(true);
    try {
      await api.aiSaveSkill(current.name, {
        note: form.note,
        tags: form.tags.split(',').map((x) => x.trim()).filter(Boolean),
        description: form.description,
        markdown: form.markdown,
      });
      setOpen(false);
      await load();
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 4px' }}>技能</h2>
      <small style={{ color: 'var(--text-muted)' }}>为内置工具补充说明文档（SKILL.md 类说明 + 标签 + 描述）。仅管理员可编辑。</small>

      {loading ? <div style={{ color: 'var(--text-muted)', marginTop: 12 }}>加载中…</div> :
        <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 12 }}>
          {tools.map((t) => {
            const sk = skills[t.name];
            return (
              <div key={t.name} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{t.name} {sk?.hasMarkdown ? '📄' : ''}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12, margin: '6px 0', minHeight: 32 }}>{sk?.description || t.description || '（无说明）'}</div>
                {sk?.tags?.length ? <div style={{ fontSize: 11, color: 'var(--accent)' }}>{sk.tags.join(' · ')}</div> : null}
                <div style={{ marginTop: 10 }}>
                  <button style={btn()} onClick={() => openEdit(t)}>{sk?.hasMarkdown ? '编辑说明' : '添加说明'}</button>
                </div>
              </div>
            );
          })}
        </div>}

      {open && current && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'flex-end', zIndex: 50 }} onClick={() => setOpen(false)}>
          <div style={{ width: 520, height: '100%', background: 'var(--bg-secondary)', overflowY: 'auto', padding: 20 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>编辑技能：{current.name}</h3>
              <button style={btn()} onClick={() => setOpen(false)}>关闭</button>
            </div>

            <label style={label}>一句话说明 note</label>
            <input style={field} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />

            <label style={label}>标签 tags（逗号分隔）</label>
            <input style={field} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />

            <label style={label}>描述 description</label>
            <textarea style={{ ...field, height: 60, resize: 'vertical' }} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />

            <label style={label}>SKILL.md 文档（Markdown）</label>
            <textarea style={{ ...field, height: 220, resize: 'vertical', fontFamily: 'monospace' }} value={form.markdown} onChange={(e) => setForm({ ...form, markdown: e.target.value })} />

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button style={btn(true)} disabled={busy} onClick={save}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
