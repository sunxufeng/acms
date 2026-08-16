'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, type Page, type StudentRecord } from '../../lib/api';

const STATUS_OPTIONS = ['在校', '毕业', '离校'];
const LEVEL_OPTIONS = ['L1', 'L2', 'L3', 'L4'];

const COLS = [
  { key: '学生编号', label: '编号' },
  { key: '学生姓名', label: '姓名' },
  { key: '性别', label: '性别' },
  { key: '班级', label: '班级' },
  { key: '校区', label: '校区' },
  { key: '当前状态', label: '状态' },
  { key: '数据密级', label: '密级' },
  { key: '更新时间', label: '更新时间' },
];

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

export default function StudentsPage() {
  const [items, setItems] = useState<StudentRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [pageToken, setPageToken] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [campus, setCampus] = useState('');
  const [level, setLevel] = useState('');

  const load = useCallback(
    async (token?: string, append = false) => {
      setLoading(true);
      setError('');
      try {
        const params: Record<string, string> = {};
        if (q) params.q = q;
        if (status) params.当前状态 = status;
        if (campus) params.校区 = campus;
        if (level) params.数据密级 = level;
        if (token) params.pageToken = token;
        const data: Page<StudentRecord> = await api.listStudents(params);
        setItems((prev) => (append ? [...prev, ...data.items] : data.items));
        setTotal(data.total);
        setHasMore(data.hasMore);
        setPageToken(data.pageToken);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [q, status, campus, level],
  );

  useEffect(() => {
    setItems([]);
    load(undefined, false);
  }, [q, status, campus, level, load]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setItems([]);
    load(undefined, false);
  };

  const handleArchive = async (id: string) => {
    if (!confirm('确认归档该学生？')) return;
    await api.archiveStudent(id);
    load(undefined, false);
  };

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.h1}>学生管理</h1>
        <a href="/students/new" style={styles.newBtn}>
          + 新增学生
        </a>
      </header>

      <form style={styles.filters} onSubmit={handleSearch}>
        <input
          style={styles.input}
          placeholder="搜索姓名"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select style={styles.input} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          style={styles.input}
          placeholder="校区"
          value={campus}
          onChange={(e) => setCampus(e.target.value)}
        />
        <select style={styles.input} value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">全部密级</option>
          {LEVEL_OPTIONS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <button type="submit" style={styles.searchBtn}>
          查询
        </button>
        <button
          type="button"
          style={styles.resetBtn}
          onClick={() => {
            setQ('');
            setStatus('');
            setCampus('');
            setLevel('');
          }}
        >
          重置
        </button>
      </form>

      {error && <p style={styles.error}>加载失败：{error}</p>}
      {loading && <p style={styles.muted}>加载中…</p>}

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} style={styles.th}>
                  {c.label}
                </th>
              ))}
              <th style={styles.th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id} style={styles.tr}>
                {COLS.map((c) => (
                  <td key={c.key} style={styles.td}>
                    {str(s[c.key]) || '—'}
                  </td>
                ))}
                <td style={styles.td}>
                  <a href={`/students/${s.id}`} style={styles.link}>
                    查看
                  </a>
                  <button style={styles.linkBtn} onClick={() => handleArchive(s.id)}>
                    归档
                  </button>
                </td>
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={COLS.length + 1} style={styles.empty}>
                  暂无学生数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <footer style={styles.footer}>
        <span style={styles.muted}>共 {total} 条</span>
        {hasMore && (
          <button style={styles.searchBtn} onClick={() => pageToken && load(pageToken, true)}>
            加载更多
          </button>
        )}
        <button style={styles.resetBtn} onClick={() => api.exportStudents({ q, 当前状态: status, 校区: campus, 数据密级: level }).then((csv) => {
          const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'students.csv';
          a.click();
        })}>
          导出 CSV
        </button>
      </footer>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 1100, margin: '0 auto', padding: '32px 24px' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 },
  h1: { fontSize: 22, fontWeight: 700 },
  newBtn: {
    background: 'var(--brand)', color: '#fff', padding: '8px 16px', borderRadius: 8,
    textDecoration: 'none', fontSize: 14, fontWeight: 600,
  },
  filters: { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 },
  input: {
    padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 14, minWidth: 140,
  },
  searchBtn: {
    padding: '8px 18px', border: 'none', borderRadius: 8, background: 'var(--brand)',
    color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  resetBtn: {
    padding: '8px 18px', border: '1px solid var(--border)', borderRadius: 8, background: '#fff',
    color: 'var(--muted)', fontSize: 14, cursor: 'pointer',
  },
  error: { color: '#dc2626', marginBottom: 12 },
  muted: { color: 'var(--muted)' },
  tableWrap: { overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 10 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  th: {
    textAlign: 'left', padding: '12px 14px', background: '#fafbfc',
    borderBottom: '1px solid var(--border)', fontWeight: 600, color: 'var(--muted)',
  },
  tr: { borderBottom: '1px solid var(--border)' },
  td: { padding: '12px 14px' },
  link: { color: 'var(--brand)', textDecoration: 'none', marginRight: 12 },
  linkBtn: {
    border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', padding: 0, fontSize: 14,
  },
  empty: { padding: '40px', textAlign: 'center', color: 'var(--muted)' },
  footer: { display: 'flex', alignItems: 'center', gap: 16, marginTop: 16 },
};
