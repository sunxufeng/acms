'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import type { Skill } from './SkillForm';

type Tool = { name: string; description: string };

type SkillRow = Tool & Skill;

export default function AiSkillsPage() {
  const [rows, setRows] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.aiTools(), api.aiListSkills()])
      .then(([toolData, skillData]) => {
        const skills = new Map((skillData as Skill[]).map((skill) => [skill.name, skill]));
        setRows((toolData as Tool[]).map((tool) => ({ ...tool, ...(skills.get(tool.name) || { name: tool.name }) })) as SkillRow[]);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="page-header"><div className="page-header-row"><div><div className="page-eyebrow">AI / SKILLS</div><h1 className="page-title">技能</h1><p className="page-subtitle">为内置工具维护标签、说明和 SKILL.md 文档。</p></div><Link href="/ai/skills/new" className="btn btn-primary">＋ 新增技能配置</Link></div></div>
      {error && <p className="msg-error" style={{ marginBottom: 16 }}>{error}</p>}
      {loading ? <div className="empty-state">加载中…</div> : (
        <div className="data-table-wrap"><table className="data-table"><thead><tr><th>技能 / 工具</th><th>一句话说明</th><th>描述</th><th>标签</th><th>文档</th><th>操作</th></tr></thead><tbody>
          {rows.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--fg-tertiary)' }}>暂无可配置技能</td></tr>}
          {rows.map((row) => <tr key={row.name}><td><strong>{row.name}</strong></td><td>{row.note || '—'}</td><td>{row.description || '—'}</td><td>{row.tags?.length ? row.tags.join(' · ') : '—'}</td><td><span className={`status-dot ${row.hasMarkdown ? 'status-on' : 'status-off'}`}>{row.hasMarkdown ? '已维护' : '未维护'}</span></td><td><Link href={`/ai/skills/${encodeURIComponent(row.name)}/edit`} className="btn btn-outline btn-sm">编辑</Link></td></tr>)}
        </tbody></table></div>
      )}
    </div>
  );
}
