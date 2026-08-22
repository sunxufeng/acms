'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api as apiClient, type Page } from '../lib/api';
import MarkdownField from './MarkdownField';

export type CrudFieldType = 'text' | 'textarea' | 'number' | 'date' | 'datetime' | 'select' | 'multiselect' | 'person' | 'student' | 'parent' | 'attachment' | 'markdown';

export interface CrudColumn {
  key: string;
  label: string;
  width?: string;
  render?: (v: unknown, row: Record<string, unknown>) => React.ReactNode;
  filter?: boolean;
  /** 列筛选控件类型：select=下拉(默认) / text=文本模糊输入 */
  filterType?: 'select' | 'text';
  /** 筛选提交到后端的查询参数名（默认用 key，如审计页操作人→actor） */
  filterParam?: string;
  filterOptions?: string[];
  form?: boolean;
  /** 是否在列表表格中显示（默认 true；设为 false 仅保留在表单中，例如敏感列） */
  list?: boolean;
  /** 列表列排序权重（升序）；未设置的列排在已设置列之后，并保持原有相对顺序 */
  listOrder?: number;
  type?: CrudFieldType;
  options?: string[];
  /** 候选项来自字典表（优先于 options；options 作为离线兜底） */
  dictKey?: string;
  required?: boolean;
  /** 联动来源字段 key（如 parent 类型从 student 类型所选学生的父亲/母亲取候选） */
  dependsOn?: string;
  /** 点击该列单元格时打开当前记录的编辑/详情表单（而非导航到其它页面） */
  openRecord?: boolean;
}

/** 时间范围筛选（如审计日志按操作时间区间过滤） */
export interface RangeFilter {
  key: string;
  label: string;
  fromParam: string;
  toParam: string;
}

export interface CrudApi {
  list: (params: Record<string, string | undefined>) => Promise<Page<Record<string, unknown>>>;
  create: (data: Record<string, unknown>) => Promise<unknown>;
  update: (id: string, data: Record<string, unknown>) => Promise<unknown>;
  archive: (id: string) => Promise<unknown>;
  transition?: (id: string, to: string) => Promise<unknown>;
}

export interface CrudPageProps {
  title: string;
  subtitle?: string;
  columns: CrudColumn[];
  api: CrudApi;
  statusField?: string;
  transitions?: Record<string, string[]>;
  statusClass?: (s: string) => string;
  extraActions?: { label: string; run: (reload: () => void) => void | Promise<void> }[];
  /** 只读模式：隐藏新建/编辑/删除按钮与弹窗（用于审计日志等仅查看的表） */
  readonly?: boolean;
  /** 时间范围筛选（起止日期） */
  rangeFilters?: RangeFilter[];
  /** 全局关键字搜索框：发送 q 参数，由后端 searchField 决定检索字段（支持关联字段跨表解析后模糊匹配） */
  search?: { placeholder: string };
  /** 新建/编辑使用页内表单（非弹出框） */
  inlineEdit?: boolean;
  /** 新建/编辑时使用独立页面风格，隐藏列表页标题、操作与筛选区 */
  standaloneForm?: boolean;
  /** 每页记录数（默认 5，参考学生列表页） */
  pageSize?: number;
  /** 额外链接按钮（如「排课与课次」跳转预检页），渲染为 <Link> */
  extraLinks?: { label: string; href: string }[];
  /** 新建改为跳转到独立页面（而非页内表单/弹窗）。设置后「新建」按钮渲染为 <Link> */
  createHref?: string;
  /** 编辑改为跳转到独立页面：行 id → href。设置后每行「编辑」按钮渲染为 <Link> */
  editHref?: (id: string) => string;
  /** 点击 openRecord 列（如学生姓名）时跳转到只读详情页（行 id → href），而非打开编辑表单 */
  detailHref?: (id: string) => string;
  /** 行级自定义操作按钮（如「AI 总结」）。run(row, reload) 执行后刷新列表；前端仅在非只读模式渲染 */
  rowExtraActions?: { label: string; run: (row: Record<string, unknown>, reload: () => void) => void | Promise<void> }[];
}

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

/** 将存储值（"YYYY-MM-DD" 或 "YYYY-MM-DD HH:mm"）转为 <input type="datetime-local"> 所需的 "YYYY-MM-DDTHH:mm" */
function toDateTimeLocal(v: unknown): string {
  const s = str(v).trim();
  if (!s) return '';
  const t = s.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t + 'T00:00';
  return t;
}

/** 附件字段值：可能为数组（表单态）或 JSON 字符串（飞书存储态） */
function attachmentFiles(v: unknown): { file_token: string; name: string }[] {
  if (Array.isArray(v)) return v as { file_token: string; name: string }[];
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p as { file_token: string; name: string }[];
    } catch {
      /* ignore */
    }
  }
  return [];
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  options: string[];
}) {
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

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(8,12,20,0.62)', zIndex: 50,
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto',
};
const modalStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 14,
  width: 'min(880px, 100%)', boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
};
const rowActions: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' };

export default function CrudPage({ title, subtitle, columns, api, statusField, transitions, statusClass, extraActions, readonly, rangeFilters, search, inlineEdit, standaloneForm, pageSize, extraLinks, createHref, editHref, detailHref, rowExtraActions }: CrudPageProps) {
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const PAGE_SIZE = pageSize ?? 5;
  const [page, setPage] = useState(1);
  const tokenStack = useRef<(string | undefined)[]>([]); // tokenStack[i] = 拉取第 i+1 页所需的 pageToken
  const fallbackRef = useRef<Record<string, unknown>[] | null>(null); // 后端一次性返回全部时的前端切片兜底
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<null | { mode: 'create' | 'edit'; row?: Record<string, unknown> }>(null);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txMenu, setTxMenu] = useState<string | null>(null);
  const [dicts, setDicts] = useState<Record<string, string[]>>({});
  /** 行级自定义操作的加载态：key = `${rowId}:${label}` */
  const [rowActionBusy, setRowActionBusy] = useState<string | null>(null);

  const router = useRouter();

  const filterCols = columns.filter((c) => c.filter);
  const formCols = columns.filter((c) => c.form);
  const listCols = columns
    .filter((c) => c.list !== false)
    .sort((a, b) => (a.listOrder ?? Infinity) - (b.listOrder ?? Infinity));
  const showingInlineForm = Boolean(inlineEdit && editing);
  const showingStandaloneForm = Boolean(standaloneForm && editing);

  // 用 ref 持有最新的 api / filters / rangeFilters，避免 load 因这些依赖变化而反复重建，
  // 否则每次渲染都会重新触发拉取 -> 页面（尤其按姓名搜索时）不停刷新闪烁。
  const apiRef = useRef(api); apiRef.current = api;
  const filtersRef = useRef(filters); filtersRef.current = filters;
  const rangeRef = useRef(rangeFilters); rangeRef.current = rangeFilters;

  const buildParams = useCallback(
    (token?: string): Record<string, string | undefined> => {
      const f = filtersRef.current;
      const params: Record<string, string | undefined> = { pageSize: String(PAGE_SIZE) };
      for (const c of columns.filter((x) => x.filter)) {
        const v = f[c.filterParam ?? c.key];
        if (v) params[c.filterParam ?? c.key] = v;
      }
      for (const rf of rangeRef.current ?? []) {
        if (f[rf.fromParam]) params[rf.fromParam] = f[rf.fromParam];
        if (f[rf.toParam]) params[rf.toParam] = f[rf.toParam];
      }
      if (f.q) params.q = f.q;
      if (token) params.pageToken = token;
      return params;
    },
    [PAGE_SIZE],
  );

  /** 拉取指定页（token 已知时直接拉；拉取后用返回 token 续填下一页游标） */
  const fetchPage = useCallback(
    async (target: number, token?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiRef.current.list(buildParams(token));
        setTotal(res.total);
        // 后端若一次性返回超过一页（如审计日志深度筛选），改为前端切片分页
        if (!res.pageToken && res.items.length > PAGE_SIZE) {
          fallbackRef.current = res.items;
          setItems(res.items.slice(0, PAGE_SIZE));
        } else {
          fallbackRef.current = null;
          setItems(res.items);
          tokenStack.current[target] = res.pageToken; // 第 target 页之后的游标
        }
        setPage(target);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        setLoading(false);
      }
    },
    [buildParams],
  );

  /** 跳转到目标页：若游标未知则向前逐页补全（不渲染中间页），再拉取目标页 */
  const goToPage = useCallback(
    async (target: number) => {
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      target = Math.min(Math.max(target, 1), totalPages);
      if (fallbackRef.current) {
        setItems(fallbackRef.current.slice((target - 1) * PAGE_SIZE, target * PAGE_SIZE));
        setPage(target);
        return;
      }
      if (target - 1 < tokenStack.current.length) {
        await fetchPage(target, tokenStack.current[target - 1]);
        return;
      }
      for (let p = tokenStack.current.length; p < target; p++) {
        const data = await apiRef.current.list(buildParams(tokenStack.current[p - 1]));
        tokenStack.current[p] = data.pageToken;
      }
      await fetchPage(target, tokenStack.current[target - 1]);
    },
    [total, PAGE_SIZE, fetchPage, buildParams],
  );

  /** 重置分页并从第 1 页重新加载（筛选/搜索变化、增删改后调用） */
  const reload = useCallback(() => {
    tokenStack.current = [];
    fallbackRef.current = null;
    fetchPage(1, undefined);
  }, [fetchPage]);

  useEffect(() => { reload(); }, [filters, reload]);

  // 字典表候选项（供带 dictKey 的字段使用），加载前用字段自带 options 兜底
  useEffect(() => {
    if (!columns.some((c) => c.dictKey)) return;
    let alive = true;
    apiClient.dictionaries().then((d) => { if (alive) setDicts(d ?? {}); }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns]);

  // 人员字段（person）候选项：从用户管理读取姓名列表（供内部对接人等下拉选择）
  const [userNames, setUserNames] = useState<string[]>([]);
  useEffect(() => {
    if (!columns.some((c) => c.type === 'person')) return;
    let alive = true;
    const collected: string[] = [];
    const fetchPage = async (token?: string): Promise<void> => {
      const params: Record<string, string | undefined> = { pageSize: '100' };
      if (token) params.pageToken = token;
      const p = await apiClient.listUsers(params);
      for (const u of p.items) {
        const name = String(u['姓名'] ?? '');
        if (name) collected.push(name);
      }
      if (p.hasMore && p.pageToken) await fetchPage(p.pageToken);
    };
    fetchPage()
      .then(() => { if (alive) setUserNames(Array.from(new Set(collected))); })
      .catch(() => {});
    return () => { alive = false; };
  }, [columns]);

  // 学生字段（student / parent 联动）候选项：从学生档案读取「学生姓名 → 父亲姓名 / 母亲姓名」
  const [studentOptions, setStudentOptions] = useState<{ value: string; label: string }[]>([]);
  const [studentMap, setStudentMap] = useState<Record<string, { father: string; mother: string }>>({});
  useEffect(() => {
    if (!columns.some((c) => c.type === 'student' || c.type === 'parent')) return;
    let alive = true;
    const collected: { name: string; englishName: string; father: string; mother: string }[] = [];
    const fetchPage = async (token?: string): Promise<void> => {
      const params: Record<string, string | undefined> = { pageSize: '100' };
      if (token) params.pageToken = token;
      const p = await apiClient.listStudents(params);
      for (const s of p.items) {
        const name = String(s['学生姓名'] ?? '');
        if (name) collected.push({
          name,
          englishName: String(s['英文名'] ?? ''),
          father: String(s['父亲姓名'] ?? ''),
          mother: String(s['母亲姓名'] ?? ''),
        });
      }
      if (p.hasMore && p.pageToken) await fetchPage(p.pageToken);
    };
    fetchPage()
      .then(() => {
        if (!alive) return;
        const map: Record<string, { father: string; mother: string }> = {};
        for (const s of collected) map[s.name] = { father: s.father, mother: s.mother };
        setStudentMap(map);
        const seen = new Set<string>();
        setStudentOptions(
          collected
            .filter((s) => {
              if (seen.has(s.name)) return false;
              seen.add(s.name);
              return true;
            })
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
            .map((s) => ({ value: s.name, label: s.englishName ? `${s.name} / ${s.englishName}` : s.name })),
        );
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [columns]);

  /** 字段有效候选项：优先字典，其次字段 options */
  const optionsFor = (c: CrudColumn): string[] =>
    c.dictKey ? (dicts[c.dictKey] ?? c.options ?? []) : (c.options ?? []);

  function openCreate() {
    const init: Record<string, unknown> = {};
    for (const c of formCols) init[c.key] = c.type === 'multiselect' || c.type === 'attachment' ? [] : '';
    setForm(init);
    setEditing({ mode: 'create' });
    setError(null);
  }

  function openEdit(row: Record<string, unknown>) {
    const init: Record<string, unknown> = {};
    for (const c of formCols) {
      if (c.type === 'attachment') init[c.key] = attachmentFiles(row[c.key]);
      else if (c.type === 'multiselect')
        init[c.key] = (Array.isArray(row[c.key]) ? row[c.key] : str(row[c.key]).split('、').filter(Boolean));
      else init[c.key] = row[c.key] ?? '';
    }
    setForm(init);
    setEditing({ mode: 'edit', row });
    setError(null);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const c of formCols) {
        const v = form[c.key];
        if (c.type === 'multiselect') payload[c.key] = Array.isArray(v) ? v : [];
        else if (c.type === 'attachment') payload[c.key] = Array.isArray(v) && (v as unknown[]).length ? JSON.stringify(v) : undefined;
        else if (c.type === 'number') payload[c.key] = v === '' || v == null ? undefined : Number(v);
        else payload[c.key] = v === '' ? undefined : v;
      }
      if (editing?.mode === 'create') await api.create(payload);
      else if (editing?.row) await api.update(String(editing.row.id), payload);
      setEditing(null);
      await reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(row: Record<string, unknown>) {
    if (!confirm(`确认删除「${str(row[columns[0]?.key ?? 'id'])}」？此操作不可撤销。`)) return;
    try {
      await api.archive(String(row.id));
      await reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  }

  async function doTransition(row: Record<string, unknown>, to: string) {
    if (!api.transition) return;
    try {
      await api.transition(String(row.id), to);
      setTxMenu(null);
      await reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '状态变更失败');
    }
  }

  async function runRowAction(row: Record<string, unknown>, action: { label: string; run: (row: Record<string, unknown>, reload: () => void) => void | Promise<void> }) {
    const key = `${String(row.id)}:${action.label}`;
    if (rowActionBusy) return;
    setRowActionBusy(key);
    setError(null);
    try {
      await action.run(row, () => reload());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : `${action.label} 失败`);
    } finally {
      setRowActionBusy(null);
    }
  }

  const formFields = (
    <div className="form-grid">
      {formCols.map((c) => (
        <div key={c.key} className="form-label" style={c.type === 'textarea' || c.type === 'markdown' ? { gridColumn: '1 / -1' } : undefined}>
          <span className="form-label-text">{c.label}{c.required && <span style={{ color: 'var(--danger)' }}> *</span>}</span>
          {c.type === 'textarea' ? (
            <textarea className="form-input" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} rows={3} />
          ) : c.type === 'markdown' ? (
            <MarkdownField value={str(form[c.key])} onChange={(v) => setForm((f) => ({ ...f, [c.key]: v }))} height={300} />
          ) : c.type === 'select' ? (
            <select className="form-input" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))}>
              <option value="">（未填）</option>
              {optionsFor(c).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : c.type === 'multiselect' ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {optionsFor(c).map((o) => {
                const arr = Array.isArray(form[c.key]) ? (form[c.key] as string[]) : [];
                const on = arr.includes(o);
                return (
                  <label key={o} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 999, border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-soft)' : 'transparent', fontSize: 'var(--font-sm)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.checked ? [...arr, o] : arr.filter((x) => x !== o) }))} />
                    {o}
                  </label>
                );
              })}
            </div>
          ) : c.type === 'number' ? (
            <input className="form-input" type="number" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} />
          ) : c.type === 'person' ? (
            <select className="form-input" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))}>
              <option value="">（未填）</option>
              {userNames.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : c.type === 'student' ? (
            <select className="form-input" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))}>
              <option value="">（未选）</option>
              {studentOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : c.type === 'parent' ? (
            (() => {
              const dep = form[c.dependsOn ?? ''] as string;
              const sm = studentMap[dep] ?? { father: '', mother: '' };
              const opts = [sm.father, sm.mother].filter(Boolean);
              const listId = `parent-opt-${c.key}`;
              return (
                <>
                  <input className="form-input" list={listId} value={str(form[c.key])} placeholder="从下拉选择或手工录入" onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} />
                  <datalist id={listId}>{opts.map((o) => <option key={o} value={o} />)}</datalist>
                </>
              );
            })()
          ) : c.type === 'attachment' ? (
            <div>
              <input type="file" onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  const res = await apiClient.uploadFile(file);
                  setForm((f) => ({ ...f, [c.key]: [...(Array.isArray(f[c.key]) ? (f[c.key] as { file_token: string; name: string }[]) : []), { file_token: res.file_token, name: res.name }] }));
                } catch (err) {
                  setError(err instanceof Error ? err.message : '上传失败');
                } finally {
                  e.target.value = '';
                }
              }} />
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(Array.isArray(form[c.key]) ? (form[c.key] as { file_token: string; name: string }[]) : []).map((a, i) => (
                  <div key={a.file_token ?? i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-sm)' }}>
                    <a href={`/api/v1/files/${a.file_token}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{a.name}</a>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm((f) => ({ ...f, [c.key]: (Array.isArray(f[c.key]) ? (f[c.key] as { file_token: string; name: string }[]) : []).filter((_, j) => j !== i) }))}>移除</button>
                  </div>
                ))}
              </div>
            </div>
          ) : c.type === 'date' ? (
            <input className="form-input" type="date" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} />
          ) : c.type === 'datetime' ? (
            <input className="form-input" type="datetime-local" value={toDateTimeLocal(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} />
          ) : (
            <input className="form-input" type="text" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} />
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className="page">
      {!showingStandaloneForm && (
        <div className="page-header page-header-row">
          <div>
            <h1 className="page-title">{title}</h1>
            {subtitle && <p className="page-subtitle">{subtitle}</p>}
          </div>
          <div className="page-actions">
            {extraActions?.map((a) => (
              <button key={a.label} className="btn btn-outline" disabled={loading}
                onClick={() => a.run(() => reload())}>{a.label}</button>
            ))}
            {extraLinks?.map((l) => (
              <Link key={l.href} href={l.href} className="btn btn-outline">{l.label}</Link>
            ))}
            {createHref ? (
              <Link href={createHref} className="btn btn-primary">+ 新建</Link>
            ) : (
              <button className="btn btn-primary" onClick={openCreate} disabled={loading || readonly}>+ 新建</button>
            )}
          </div>
        </div>
      )}

      {!showingStandaloneForm && (filterCols.length > 0 || (rangeFilters ?? []).length > 0 || search) && (
        <div className="filter-bar">
          {search && (
            <form
              className="search-bar"
              style={{ flex: 1, minWidth: 200, maxWidth: 360 }}
              onSubmit={(e) => { e.preventDefault(); reload(); }}
            >
              <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
              <input
                placeholder={search.placeholder}
                value={filters.q ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
              />
              <button type="submit">查询</button>
            </form>
          )}
          {filterCols.map((c) =>
            c.filterType === 'text' ? (
              <input
                key={c.key}
                className="form-input"
                style={{ width: 160 }}
                placeholder={`筛选${c.label}`}
                value={filters[c.filterParam ?? c.key] ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, [c.filterParam ?? c.key]: e.target.value }))}
              />
            ) : (
              <FilterSelect key={c.key} label={c.label} value={filters[c.key] ?? ''}
                onChange={(v) => setFilters((f) => ({ ...f, [c.key]: v }))}
                options={c.filterOptions ?? (c.dictKey ? (dicts[c.dictKey] ?? c.options ?? []) : (c.options ?? []))} />
            ),
          )}
          {(rangeFilters ?? []).map((rf) => (
            <span key={rf.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>{rf.label}</span>
              <input className="form-input" type="date" style={{ width: 150 }}
                value={filters[rf.fromParam] ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, [rf.fromParam]: e.target.value }))} />
              <span style={{ color: 'var(--fg-tertiary)' }}>~</span>
              <input className="form-input" type="date" style={{ width: 150 }}
                value={filters[rf.toParam] ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, [rf.toParam]: e.target.value }))} />
            </span>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={() => setFilters({})}>重置</button>
        </div>
      )}

      {showingInlineForm && editing && (
        <div className="crud-inline-form">
          <div className="crud-inline-form-head">
            {showingStandaloneForm ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
                <button className="btn btn-icon" title="返回列表" aria-label="返回列表" onClick={() => setEditing(null)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
                </button>
                <div>
                  <div className="page-eyebrow">{editing.mode === 'create' ? 'CREATE' : 'EDIT'} / {title}</div>
                  <h1 className="page-title">{editing.mode === 'create' ? `新建${title}` : `编辑${title}`}</h1>
                </div>
              </div>
            ) : (
              <>
                <h3 className="crud-inline-form-title">{editing.mode === 'create' ? `新建${title}` : `编辑${title}`}</h3>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>×</button>
              </>
            )}
          </div>
          {error && <p className="msg-error">{error}</p>}
          <fieldset className="form-fieldset">
            <legend className="form-legend">{title}信息</legend>
            {formFields}
          </fieldset>
          <div className="crud-inline-form-actions">
            <button className="btn btn-ghost" onClick={() => setEditing(null)}>取消</button>
            <button className="btn btn-primary" onClick={submit} disabled={submitting}>{submitting ? '保存中…' : '保存'}</button>
          </div>
        </div>
      )}

      {error && <p className="msg-error">{error}</p>}

      {!(inlineEdit && editing) && (
      <>{/* 编辑/新建（inline）时不显示列表，避免表单下方仍展示整张用户表 */}
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {listCols.map((c) => <th key={c.key} style={c.width ? { width: c.width } : undefined}>{c.label}</th>)}
              <th style={{ width: '150px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => {
              const st = statusField ? str(row[statusField]) : '';
              const allowed = transitions && st ? transitions[st] ?? [] : [];
              return (
                <tr key={String(row.id)}>
                  {listCols.map((c) => (
                    <td
                      key={c.key}
                      onClick={c.openRecord ? () => (detailHref ? router.push(detailHref(String(row.id))) : openEdit(row)) : undefined}
                      style={c.openRecord ? { cursor: 'pointer' } : undefined}
                    >
                      {statusField === c.key && st
                        ? <span className={`status-dot ${statusClass ? statusClass(st) : ''}`}>{st}</span>
                        : c.type === 'attachment'
                          ? (() => {
                            const files = attachmentFiles(row[c.key]);
                            if (!files.length) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
                            return (
                              <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
                                {files.map((a, i) => (
                                  <a key={a.file_token ?? i} href={`/api/v1/files/${a.file_token}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{a.name}</a>
                                ))}
                              </span>
                            );
                          })()
                          : (c.render ? c.render(row[c.key], row) : str(row[c.key]))}
                    </td>
                  ))}
                  <td>
                    <div style={rowActions}>
                      {!readonly && editHref ? (
                        <Link href={editHref(String(row.id))} className="btn btn-ghost btn-sm">编辑</Link>
                      ) : !readonly && (
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(row)}>编辑</button>
                      )}
                      {!readonly && api.transition && allowed.length > 0 && (
                        <div style={{ position: 'relative' }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => setTxMenu(txMenu === String(row.id) ? null : String(row.id))}>状态▾</button>
                          {txMenu === String(row.id) && (
                            <div style={{ position: 'absolute', top: '110%', right: 0, zIndex: 20, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 6, minWidth: 120, boxShadow: '0 10px 30px rgba(0,0,0,0.35)' }}>
                              {allowed.map((to) => (
                                <div key={to} onClick={() => doTransition(row, to)}
                                  style={{ padding: '7px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 'var(--font-sm)' }}
                                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>{to}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {!readonly && rowExtraActions?.map((a) => {
                        const busyKey = `${String(row.id)}:${a.label}`;
                        return (
                          <button
                            key={a.label}
                            className="btn btn-ghost btn-sm"
                            disabled={Boolean(rowActionBusy) || loading}
                            onClick={() => runRowAction(row, a)}
                          >
                            {rowActionBusy === busyKey ? `${a.label}…` : a.label}
                          </button>
                        );
                      })}
                      {!readonly && <button className="btn btn-danger btn-sm" onClick={() => remove(row)}>删除</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
            {items.length === 0 && !loading && (
              <tr><td colSpan={listCols.length + 1}>
                <div className="empty-state"><div className="empty-state-text">暂无数据</div></div>
              </td></tr>
            )}
          </tbody>
        </table>
        {loading && <div className="empty-state"><div className="empty-state-text">加载中…</div></div>}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'var(--space-md)', paddingTop: 'var(--space-md)', borderTop: '1px solid var(--border)', flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>共 {total} 条</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button className="btn btn-outline btn-sm" disabled={page <= 1 || loading} onClick={() => goToPage(page - 1)}>上一页</button>
          {(() => {
            const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
            const startP = Math.max(1, page - 2);
            const endP = Math.min(totalPages, page + 2);
            const pageNumbers: number[] = [];
            for (let i = startP; i <= endP; i++) pageNumbers.push(i);
            return pageNumbers.map((p) => (
              <button key={p} className={`btn btn-sm ${p === page ? 'btn-primary' : 'btn-outline'}`} disabled={loading} onClick={() => goToPage(p)}>{p}</button>
            ));
          })()}
          <button className="btn btn-outline btn-sm" disabled={page >= Math.ceil(total / PAGE_SIZE) || loading} onClick={() => goToPage(page + 1)}>下一页</button>
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', marginLeft: 8 }}>第 {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页</span>
        </div>
      </div>
      </>)}

      {!inlineEdit && editing && (
        <div style={overlayStyle} onClick={() => setEditing(null)}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderBottom: '1px solid var(--border)' }}>
              <h3 style={{ margin: 0, fontSize: 'var(--font-lg)', fontWeight: 700 }}>{editing.mode === 'create' ? `新建${title}` : `编辑${title}`}</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>×</button>
            </div>
            <div style={{ padding: '20px 22px', maxHeight: '64vh', overflowY: 'auto' }}>
              {error && <p className="msg-error">{error}</p>}
              <fieldset className="form-fieldset">
                <legend className="form-legend">{title}信息</legend>
                {formFields}
              </fieldset>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '16px 22px', borderTop: '1px solid var(--border)' }}>
              <button className="btn btn-ghost" onClick={() => setEditing(null)}>取消</button>
              <button className="btn btn-primary" onClick={submit} disabled={submitting}>{submitting ? '保存中…' : '保存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
