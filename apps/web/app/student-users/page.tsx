'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';

interface StudentHit {
  studentNo: string;
  name: string;
  studentId: string;
  campus: string;
  hasAccount: boolean;
}

interface AccountRow {
  studentNo: string;
  name: string;
  studentId: string;
  campus: string;
  createdAt: string;
  updatedAt: string;
}

function fmt(dt?: string): string {
  if (!dt) return '-';
  try {
    return new Date(dt).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return dt;
  }
}

export default function StudentUsersPage() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [keyword, setKeyword] = useState('');
  const [hits, setHits] = useState<StudentHit[]>([]);
  const [searching, setSearching] = useState(false);

  const [modal, setModal] = useState<{ studentNo: string; name: string } | null>(null);
  const [pw, setPw] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }

  async function loadAccounts() {
    try {
      const d = await api.studentAccounts();
      if (Array.isArray(d?.items)) setAccounts(d.items);
    } catch (err) {
      showToast(`加载账号清单失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAccounts();
  }, []);

  async function handleSearch() {
    const kw = keyword.trim();
    if (!kw) {
      setHits([]);
      return;
    }
    setSearching(true);
    try {
      const d = await api.studentSearch(kw);
      setHits(Array.isArray(d?.items) ? d.items : []);
    } catch (err) {
      showToast(`检索失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setSearching(false);
    }
  }

  async function handleSavePassword() {
    if (!modal) return;
    if (pw.length < 6) {
      showToast('密码至少 6 位');
      return;
    }
    setSaving(true);
    try {
      await api.adminSetStudentPassword(modal.studentNo, pw);
      showToast(`已为 ${modal.studentNo} 设置登录密码`);
      setModal(null);
      setPw('');
      await loadAccounts();
      if (keyword.trim()) await handleSearch();
    } catch (err) {
      showToast(`设置失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div className="page-title">学生账号</div>
          <div className="page-subtitle">
            为学生设置 / 重置网页登录密码（学号登录）。密码以 scrypt 加盐哈希本地存储，与学生档案解耦。
          </div>
        </div>
        <Link href="/menu-settings" className="btn btn-outline">
          返回菜单管理
        </Link>
      </div>

      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg)' }}>检索学生并设置密码</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="input"
            placeholder="输入学号或姓名检索…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
            }}
            style={{ minWidth: 240, flex: 1 }}
          />
          <button type="button" className="btn btn-primary" onClick={handleSearch} disabled={searching}>
            {searching ? '检索中…' : '检索'}
          </button>
        </div>
        {hits.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: 'var(--fg-secondary)', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 120 }}>学号</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 100 }}>姓名</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 100 }}>校区</th>
                  <th style={{ textAlign: 'center', padding: '8px 10px', width: 100 }}>开户状态</th>
                  <th style={{ textAlign: 'center', padding: '8px 10px', width: 120 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {hits.map((h) => (
                  <tr key={h.studentId} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 10px' }}>{h.studentNo}</td>
                    <td style={{ padding: '6px 10px' }}>{h.name}</td>
                    <td style={{ padding: '6px 10px' }}>{h.campus || '-'}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: 999,
                          fontSize: 12,
                          background: h.hasAccount ? 'var(--accent-soft)' : 'transparent',
                          color: h.hasAccount ? 'var(--accent)' : 'var(--fg-tertiary)',
                          border: `1px solid ${h.hasAccount ? 'var(--accent)' : 'var(--border)'}`,
                        }}
                      >
                        {h.hasAccount ? '已开户' : '未开户'}
                      </span>
                    </td>
                    <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => setModal({ studentNo: h.studentNo, name: h.name })}
                      >
                        {h.hasAccount ? '重置密码' : '设置密码'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg)' }}>
          已开户账号清单（{accounts.length}）
        </div>
        {loading ? (
          <div style={{ color: 'var(--fg-secondary)' }}>加载中…</div>
        ) : accounts.length === 0 ? (
          <div style={{ color: 'var(--fg-secondary)' }}>暂无已开户的学生账号。</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: 'var(--fg-secondary)', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 120 }}>学号</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 100 }}>姓名</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 100 }}>校区</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 150 }}>创建时间</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 150 }}>更新时间</th>
                  <th style={{ textAlign: 'center', padding: '8px 10px', width: 120 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.studentNo} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 10px' }}>{a.studentNo}</td>
                    <td style={{ padding: '6px 10px' }}>{a.name}</td>
                    <td style={{ padding: '6px 10px' }}>{a.campus || '-'}</td>
                    <td style={{ padding: '6px 10px', color: 'var(--fg-secondary)' }}>{fmt(a.createdAt)}</td>
                    <td style={{ padding: '6px 10px', color: 'var(--fg-secondary)' }}>{fmt(a.updatedAt)}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => setModal({ studentNo: a.studentNo, name: a.name })}
                      >
                        重置密码
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <div
          onClick={() => setModal(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 20,
              width: 360,
              maxWidth: '90vw',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg)' }}>
              为 {modal.name}（{modal.studentNo}）{modal.studentNo ? '设置 / 重置' : ''}登录密码
            </div>
            <input
              className="input"
              type="text"
              placeholder="请输入新密码（至少 6 位）"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-outline" onClick={() => setModal(null)}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={handleSavePassword} disabled={saving}>
                {saving ? '保存中…' : '确认保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
