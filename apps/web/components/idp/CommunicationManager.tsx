'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';

interface Comm { id: string; 沟通日期?: unknown; 沟通人?: unknown; 沟通内容?: unknown; 需要的帮助_下一步计划?: unknown; 原始文档?: unknown }

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}
function commContent(v: unknown): string {
  if (typeof v === 'string') return v;
  return '';
}

export default function CommunicationManager({ planId }: { planId: string }) {
  const [items, setItems] = useState<Comm[]>([]);
  const [loading, setLoading] = useState(true);
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

  async function remove(row: Comm) {
    if (!confirm('确认删除该沟通记录？')) return;
    try { await api.archiveIdpCommunication(String(row.id)); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : '删除失败'); }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--font-lg)' }}>沟通记录</h2>
        <Link className="btn btn-primary btn-sm" href={`/idp-plans/${planId}/communications/new`}>+ 新增沟通</Link>
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
                    <td style={{ whiteSpace: 'pre-wrap', maxWidth: 480 }}>{commContent(it.沟通内容) || '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <Link className="btn btn-ghost btn-sm" href={`/idp-plans/${planId}/communications/${String(it.id)}/edit`}>编辑</Link>
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
    </div>
  );
}
