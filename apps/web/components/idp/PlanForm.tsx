'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../lib/api';
import BalanceWheel, { type WheelDim } from './BalanceWheel';
import Combobox from '../Combobox';

// ── 数据结构 ───────────────────────────────
interface Goal { title: string; areas: string; importance: number; urgency: number; meaning: number; measures: string[]; note: string }
interface Phase { no: string; node: string; result: string }
interface Att { file_token: string; name: string }

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}
function attachmentFiles(v: unknown): Att[] {
  if (Array.isArray(v)) return v as Att[];
  if (typeof v === 'string' && v.trim()) {
    try { const p = JSON.parse(v); if (Array.isArray(p)) return p as Att[]; } catch { /* ignore */ }
  }
  return [];
}
function parseJSON<T>(v: unknown, fallback: T): T {
  if (typeof v === 'string' && v.trim()) {
    try { const p = JSON.parse(v); if (p) return p as T; } catch { /* ignore */ }
  }
  return fallback;
}
function normalizeGoals(list: Goal[]): Goal[] {
  return list.map((g) => ({
    ...g,
    areas: Array.isArray(g.areas) ? g.areas.join('、') : (g.areas ?? ''),
  }));
}

const DEFAULT_FORM: Record<string, unknown> = {
  关联学生: '', 学期: '', 导师: '', 状态: '草稿',
  展示方式: '', 展示内容: '', 展示亮点: '', 邀请人员: '',
  学生确认时间: '', 导师确认时间: '',
  制定日期: new Date().toISOString().slice(0, 10),
};

// ── 星级评分 ───────────────────────────────
function Stars({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <span style={{ display: 'inline-flex', gap: 2 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} onClick={() => onChange(n)}
          style={{ cursor: 'pointer', fontSize: 18, color: n <= value ? '#f5a623' : 'var(--border)' }}>★</span>
      ))}
    </span>
  );
}

// ── 多选项 chips ───────────────────────────────
function Chips({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <label key={o} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999, border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-soft)' : 'transparent', fontSize: 'var(--font-sm)', cursor: 'pointer' }}>
            <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? [...value, o] : value.filter((x) => x !== o))} />
            {o}
          </label>
        );
      })}
    </div>
  );
}

export default function PlanForm({ planId }: { planId?: string }) {
  const router = useRouter();
  const isEdit = Boolean(planId);
  const [dicts, setDicts] = useState<Record<string, string[]>>({});
  const [students, setStudents] = useState<{ value: string; label: string }[]>([]);
  const [mentors, setMentors] = useState<{ value: string; label: string }[]>([]);
  const [form, setForm] = useState<Record<string, unknown>>({ ...DEFAULT_FORM });
  const [wheel, setWheel] = useState<WheelDim[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [att, setAtt] = useState<Att[]>([]);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const dimensions = dicts['IDP维度'] ?? [];
  const areas = dicts['IDP目标领域'] ?? [];
  const measures = dicts['IDP衡量方式'] ?? [];

  useEffect(() => {
    api.dictionaries().then((d) => setDicts(d ?? {})).catch(() => {});
  }, []);

  useEffect(() => {
    const all: { id: string; name: string; englishName: string }[] = [];
    const fetchPage = async (token?: string): Promise<void> => {
      const p = await api.listStudents({ pageSize: '100', pageToken: token });
      for (const s of p.items) {
        const name = String(s['学生姓名'] ?? '');
        const id = String((s as { id?: string }).id ?? '');
        if (name && id) all.push({ id, name, englishName: String(s['英文名'] ?? '') });
      }
      if (p.hasMore && p.pageToken) await fetchPage(p.pageToken);
    };
    fetchPage().then(() => {
      const seen = new Set<string>();
      const opts = all.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
        .map((s) => ({ value: s.name, label: s.englishName ? `${s.name} / ${s.englishName}` : s.name }));
      setStudents(opts);
    }).catch(() => {});
  }, []);

  // 导师候选项：来自用户管理（用户「姓名」字段），可输入筛选。
  useEffect(() => {
    const collected: string[] = [];
    const fetchPage = async (token?: string): Promise<void> => {
      const p = await api.listUsers({ pageSize: '100', pageToken: token });
      for (const u of p.items) {
        const name = String(u['姓名'] ?? '');
        if (name) collected.push(name);
      }
      if (p.hasMore && p.pageToken) await fetchPage(p.pageToken);
    };
    fetchPage()
      .then(() => setMentors(Array.from(new Set(collected)).sort((a, b) => a.localeCompare(b, 'zh-CN')).map((n) => ({ value: n, label: n }))))
      .catch(() => {});
  }, []);

  // 维度字典就绪后，初始化平衡轮（编辑模式已有数据则不覆盖）
  useEffect(() => {
    if (dimensions.length === 0) return;
    setWheel((prev) => (prev.length ? prev : dimensions.map((d) => ({ dim: d, current: 0, expected: 0 }))));
  }, [dimensions]);

  useEffect(() => {
    if (!planId) return;
    setLoading(true);
    api.getIdpPlan(planId).then((p) => {
      setForm({
        关联学生: str(p['关联学生']),
        学期: str(p['学期']),
        导师: str(p['导师']),
        状态: str(p['状态']) || '草稿',
        展示方式: str(p['展示方式']),
        展示内容: str(p['展示内容']),
        展示亮点: str(p['展示亮点']),
        邀请人员: str(p['邀请人员']),
        学生确认时间: str(p['学生确认时间']),
        导师确认时间: str(p['导师确认时间']),
        制定日期: str(p['制定日期']),
      });
      setWheel(parseJSON<WheelDim[]>(p['人生平衡轮'], dimensions.map((d) => ({ dim: d, current: 0, expected: 0 }))));
      setGoals(normalizeGoals(parseJSON<Goal[]>(p['目标列表'], [])));
      setPhases(parseJSON<Phase[]>(p['阶段成果'], []));
      setAtt(attachmentFiles(p['原始文档']));
    }).catch((e) => setError(e instanceof Error ? e.message : '加载失败')).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

  function set(key: string, v: unknown) { setForm((f) => ({ ...f, [key]: v })); }

  async function onUpload(file: File) {
    setUploading(true); setError(null);
    try {
      const res = await api.uploadFile(file);
      setAtt((a) => [...a, { file_token: res.file_token, name: res.name }]);
    } catch (e) { setError(e instanceof Error ? e.message : '上传失败'); }
    finally { setUploading(false); }
  }

  async function submit() {
    setSaving(true); setError(null);
    const payload = {
      ...form,
      人生平衡轮: JSON.stringify(wheel),
      目标列表: JSON.stringify(goals),
      阶段成果: JSON.stringify(phases),
      原始文档: att.length ? JSON.stringify(att) : undefined,
    };
    try {
      if (planId) await api.updateIdpPlan(planId, payload);
      else await api.createIdpPlan(payload);
      router.push('/idp-plans');
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally { setSaving(false); }
  }

  const field = (key: string, node: ReactNode) => (
    <div className="form-label">
      <span className="form-label-text">{key}</span>
      {node}
    </div>
  );

  if (loading) return <div className="empty-state">加载中…</div>;

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-lg)' }}>
            <Link href="/idp-plans" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
            </Link>
            <div>
              <div className="page-eyebrow">IDP / {isEdit ? 'EDIT' : 'CREATE'}</div>
              <h1 className="page-title">{isEdit ? '编辑 IDP 方案' : '新建 IDP 方案'}</h1>
              <p className="page-subtitle">一个学生同一学期仅可创建一个 IDP 方案</p>
            </div>
          </div>
        </div>
      </div>

      {error && <p className="msg-error">{error}</p>}

      <fieldset className="form-fieldset">
        <legend className="form-legend">基本信息</legend>
        <div className="form-grid">
          {field('关联学生 *', (
            <Combobox value={str(form['关联学生'])} onChange={(v) => set('关联学生', v)} options={students} placeholder="输入或选择学生姓名" />
          ))}
          {field('学期 *', (
            <select className="form-input" value={str(form['学期'])} onChange={(e) => set('学期', e.target.value)}>
              <option value="">（未选）</option>
              {(dicts['学期'] ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ))}
          {field('导师', <Combobox value={str(form['导师'])} onChange={(v) => set('导师', v)} options={mentors} placeholder="输入或选择导师姓名" allowFreeText />)} 
          {field('状态', (
            <select className="form-input" value={str(form['状态'])} onChange={(e) => set('状态', e.target.value)}>
              {(dicts['IDP状态'] ?? ['草稿', '待确认', '已确认', '已关闭']).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ))}
          {field('制定日期', <input type="date" className="form-input" value={str(form['制定日期'])} onChange={(e) => set('制定日期', e.target.value)} />)}
        </div>
      </fieldset>

      <fieldset className="form-fieldset">
        <legend className="form-legend">人生平衡轮（当前值 vs 期望値）</legend>
        <BalanceWheel dims={wheel} onChange={setWheel} />
      </fieldset>

      <fieldset className="form-fieldset">
        <legend className="form-legend">目标制定与行动计划（目标1/2/3）</legend>
        {goals.map((g, gi) => (
          <div key={gi} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <strong>目标 {gi + 1}</strong>
              <button type="button" className="btn btn-danger btn-sm" onClick={() => setGoals(goals.filter((_, i) => i !== gi))}>删除目标</button>
            </div>
            <div className="form-grid">
              {field('目标标题', <input className="form-input" value={g.title} onChange={(e) => { const n = [...goals]; n[gi] = { ...n[gi], title: e.target.value }; setGoals(n); }} />)}
              {field('提升领域', (
                <select className="form-input" value={g.areas} onChange={(e) => { const n = [...goals]; n[gi] = { ...n[gi], areas: e.target.value }; setGoals(n); }}>
                  <option value="">（未选）</option>
                  {areas.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 10 }}>
              <div><div style={{ fontSize: 'var(--font-sm)', marginBottom: 4 }}>重要性</div><Stars value={g.importance} onChange={(v) => { const n = [...goals]; n[gi] = { ...n[gi], importance: v }; setGoals(n); }} /></div>
              <div><div style={{ fontSize: 'var(--font-sm)', marginBottom: 4 }}>紧急程度</div><Stars value={g.urgency} onChange={(v) => { const n = [...goals]; n[gi] = { ...n[gi], urgency: v }; setGoals(n); }} /></div>
              <div><div style={{ fontSize: 'var(--font-sm)', marginBottom: 4 }}>意义</div><Stars value={g.meaning} onChange={(v) => { const n = [...goals]; n[gi] = { ...n[gi], meaning: v }; setGoals(n); }} /></div>
            </div>
            <div style={{ marginTop: 10 }}>{field('衡量方式', <Chips options={measures} value={g.measures} onChange={(v) => { const n = [...goals]; n[gi] = { ...n[gi], measures: v }; setGoals(n); }} />)}</div>
            <div style={{ marginTop: 10 }}>{field('其他说明', <textarea className="form-input" rows={2} value={g.note} onChange={(e) => { const n = [...goals]; n[gi] = { ...n[gi], note: e.target.value }; setGoals(n); }} />)}</div>
          </div>
        ))}
        <button type="button" className="btn btn-outline" onClick={() => setGoals([...goals, { title: '', areas: '', importance: 0, urgency: 0, meaning: 0, measures: [], note: '' }])}>
          + 添加目标
        </button>
      </fieldset>

      <fieldset className="form-fieldset">
        <legend className="form-legend">阶段性预期成果</legend>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th style={{ width: 80 }}>序号</th><th>时间节点</th><th>预期成果</th><th style={{ width: 80 }}>操作</th></tr></thead>
            <tbody>
              {phases.map((p, pi) => (
                <tr key={pi}>
                  <td><input className="form-input" value={p.no} onChange={(e) => { const n = [...phases]; n[pi] = { ...n[pi], no: e.target.value }; setPhases(n); }} /></td>
                  <td><input className="form-input" value={p.node} onChange={(e) => { const n = [...phases]; n[pi] = { ...n[pi], node: e.target.value }; setPhases(n); }} /></td>
                  <td><input className="form-input" value={p.result} onChange={(e) => { const n = [...phases]; n[pi] = { ...n[pi], result: e.target.value }; setPhases(n); }} /></td>
                  <td><button type="button" className="btn btn-danger btn-sm" onClick={() => setPhases(phases.filter((_, i) => i !== pi))}>删除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="btn btn-outline" style={{ marginTop: 10 }} onClick={() => setPhases([...phases, { no: String(phases.length + 1), node: '', result: '' }])}>
          + 添加阶段
        </button>
      </fieldset>

      <fieldset className="form-fieldset">
        <legend className="form-legend">IDP 个人展示路演计划</legend>
        <div className="form-grid">
          {field('展示方式', (
            <select className="form-input" value={str(form['展示方式'])} onChange={(e) => set('展示方式', e.target.value)}>
              <option value="">（未选）</option>
              {(dicts['IDP展示方式'] ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ))}
          {field('邀请参与人员', <input className="form-input" value={str(form['邀请人员'])} onChange={(e) => set('邀请人员', e.target.value)} />)}
          {field('展示内容', <textarea className="form-input" rows={2} value={str(form['展示内容'])} onChange={(e) => set('展示内容', e.target.value)} />)}
          {field('展示亮点', <textarea className="form-input" rows={2} value={str(form['展示亮点'])} onChange={(e) => set('展示亮点', e.target.value)} />)}
        </div>
      </fieldset>

      <fieldset className="form-fieldset">
        <legend className="form-legend">确认（以时间替代电子签名）</legend>
        <div className="form-grid">
          {field('学生确认时间', <input type="datetime-local" className="form-input" value={toLocal(str(form['学生确认时间']))} onChange={(e) => set('学生确认时间', e.target.value)} />)}
          {field('导师确认时间', <input type="datetime-local" className="form-input" value={toLocal(str(form['导师确认时间']))} onChange={(e) => set('导师确认时间', e.target.value)} />)}
        </div>
      </fieldset>

      <fieldset className="form-fieldset">
        <legend className="form-legend">原始文档（学生填写的 docx 附件，备查）</legend>
        <input type="file" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} disabled={uploading} />
        {uploading && <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>上传中…</span>}
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {att.map((a, i) => (
            <div key={a.file_token ?? i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-sm)' }}>
              <a href={`/api/v1/files/${a.file_token}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{a.name}</a>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAtt(att.filter((_, j) => j !== i))}>移除</button>
            </div>
          ))}
        </div>
      </fieldset>

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        <button className="btn btn-ghost" onClick={() => router.push('/idp-plans')}>取消</button>
      </div>
    </div>
  );
}

function toLocal(v: string): string {
  const s = v.trim();
  if (!s) return '';
  return s.replace(' ', 'T');
}
