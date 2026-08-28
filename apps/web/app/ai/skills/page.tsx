'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import type { Skill } from './SkillForm';

type Tool = { name: string; description: string };
type SkillRow = Tool & Skill;

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="filter-select" ref={ref}>
      <button type="button" className="filter-select-trigger" onClick={() => setOpen(!open)}>
        <span>{label}{value ? `：${value}` : ''}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="filter-select-dropdown">
          <div className={`filter-select-opt${!value ? ' active' : ''}`} onClick={() => { onChange(''); setOpen(false); }}>全部</div>
          {options.map((o) => (
            <div key={o} className={`filter-select-opt${o === value ? ' active' : ''}`} onClick={() => { onChange(o); setOpen(false); }}>{o}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AiSkillsPage() {
  const [all, setAll] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [docFilter, setDocFilter] = useState('');

  useEffect(() => {
    Promise.all([api.aiTools(), api.aiListSkills()])
      .then(([toolData, skillData]) => {
        const skills = new Map((skillData as Skill[]).map((skill) => [skill.name, skill]));
        setAll((toolData as Tool[]).map((tool) => ({ ...tool, ...(skills.get(tool.name) || { name: tool.name }) })) as SkillRow[]);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const rows = all.filter((row) => {
    if (q) {
      const hay = [row.name, row.note || '', row.description || '', (row.tags || []).join(' ')].join(' ').toLowerCase();
      if (!hay.includes(q.toLowerCase().trim())) return false;
    }
    if (docFilter === '已维护' && !row.hasMarkdown) return false;
    if (docFilter === '未维护' && row.hasMarkdown) return false;
    return true;
  });

  return (
    <div className="page">
      <div className="page-header page-header-row">
        <div>
          <div className="page-eyebrow">AI / SKILLS</div>
          <h1 className="page-title">技能</h1>
          <p className="page-subtitle">为内置工具维护标签、说明和 SKILL.md 文档。</p>
        </div>
        <div className="page-actions">
          <Link href="/ai/skills/new" className="btn btn-primary">＋ 新增技能配置</Link>
        </div>
      </div>

      <div className="filter-bar">
        <form className="search-bar" style={{ flex: 1, minWidth: 200, maxWidth: 360 }} onSubmit={(e) => e.preventDefault()}>
          <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
          <input placeholder="搜索技能名称 / 说明 / 标签" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="submit">查询</button>
        </form>
        <FilterSelect label="文档状态" value={docFilter} onChange={setDocFilter} options={['已维护', '未维护']} />
        {(q || docFilter) && <button className="btn btn-ghost btn-sm" onClick={() => { setQ(''); setDocFilter(''); }}>重置</button>}
      </div>

      {error && <p className="msg-error" style={{ marginBottom: 16 }}>{error}</p>}
      {loading ? (
        <div className="empty-state">加载中…</div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>技能 / 工具</th>
                <th>一句话说明</th>
                <th>描述</th>
                <th>标签</th>
                <th>文档</th>
                <th style={{ width: '120px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--fg-tertiary)' }}>
                    {all.length === 0 ? '暂无可配置技能' : '没有匹配的技能'}
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.name}>
                  <td><strong>{row.name}</strong></td>
                  <td>{row.note || '—'}</td>
                  <td>{row.description || '—'}</td>
                  <td>{row.tags?.length ? row.tags.join(' · ') : '—'}</td>
                  <td><span className={`status-dot ${row.hasMarkdown ? 'status-on' : 'status-off'}`}>{row.hasMarkdown ? '已维护' : '未维护'}</span></td>
                  <td><Link href={`/ai/skills/${encodeURIComponent(row.name)}/edit`} className="btn btn-outline btn-sm">编辑</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
