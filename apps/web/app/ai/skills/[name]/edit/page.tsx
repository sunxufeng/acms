'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '../../../../../lib/api';
import { SkillForm, type Skill } from '../../SkillForm';

export default function EditSkillPage() {
  const name = decodeURIComponent(String(useParams().name));
  const router = useRouter();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.aiGetSkill(name), api.aiTools()]).then(([data, tools]) => {
      const tool = (tools as { name: string; description: string }[]).find((item) => item.name === name);
      setSkill(data ? data as Skill : { name, description: tool?.description || '' });
    }).catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
  }, [name]);

  if (loading) return <div className="empty-state" style={{ minHeight: '50vh' }}>加载中…</div>;
  if (error || !skill) return <div className="page-header"><p className="msg-error">加载失败：{error || '未找到'}</p><Link href="/ai/skills" className="btn btn-outline btn-sm" style={{ marginTop: 12 }}>返回列表</Link></div>;

  return <div><div className="page-header"><div className="page-header-row"><div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}><Link href="/ai/skills" className="btn btn-icon" title="返回列表"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg></Link><div><div className="page-eyebrow">EDIT / 技能</div><h1 className="page-title">编辑技能：{name}</h1></div></div></div></div><SkillForm initial={skill} onDone={() => router.push('/ai/skills')} /></div>;
}
