'use client';

import { useEffect, useMemo, useState } from 'react';
import type { RoleDef } from '@acms/contracts';
import { api } from '../lib/api';
import { useTl } from '../lib/useTl';
import { LEVEL_OPTS, STATUS_OPTS, TEACHER_TYPE_FALLBACK } from '../app/users/constants';

interface UserFormProps {
  /** 编辑行数据；新建时为 null */
  row: Record<string, unknown> | null;
  /** 保存成功后回调（关闭表单并刷新列表） */
  onDone: () => void;
}

function asText(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => String(x ?? '')).join('、');
  return String(v);
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? '')).filter(Boolean);
  if (typeof v === 'string' && v) return [v];
  return [];
}

/**
 * 用户管理新增/编辑表单（左右分栏）。
 *
 * 左：基本信息；右：系统角色勾选列表。
 * ⚠️ 角色选项必须动态取自 GET /role-management，不能写死常量——
 * 否则角色管理里新建的角色在这里看不到（历史上 ROLE_OPTS 硬编码就是此 bug）。
 */
export default function UserForm({ row, onDone }: UserFormProps) {
  const tl = useTl();
  const [roles, setRoles] = useState<RoleDef[] | null>(null);
  const [dicts, setDicts] = useState<Record<string, string[]>>({});
  const [form, setForm] = useState<Record<string, string | string[]>>({});
  const [kw, setKw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // 角色定义 + 字典（教师类型/校区）
  useEffect(() => {
    let alive = true;
    api
      .getRoleManagement()
      .then((d) => { if (alive) setRoles(d?.roles ?? []); })
      .catch(() => { if (alive) setRoles([]); });
    api
      .dictionaries()
      .then((d) => { if (alive) setDicts(d ?? {}); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // 用行数据初始化表单
  useEffect(() => {
    setForm({
      姓名: asText(row?.['姓名']),
      '飞书 Open ID': asText(row?.['飞书 Open ID']),
      教师类型: asText(row?.['教师类型']),
      数据密级上限: asText(row?.['数据密级上限']),
      默认校区: asText(row?.['默认校区']),
      账号状态: asText(row?.['账号状态']) || '启用',
      系统角色: asList(row?.['系统角色']),
    });
  }, [row]);

  // 把存储值（可能是 key，也可能是改名前的旧 label）统一归一到当前 key
  const normalize = (v: string): string => {
    const r = (roles ?? []).find((x) => x.key === v || (x.label ?? '') === v);
    return r ? r.key : v;
  };
  const selected = useMemo(() => asList(form['系统角色']).map(normalize), [form, roles]);
  const filtered = useMemo(() => {
    const all = roles ?? [];
    const k = kw.trim().toLowerCase();
    if (!k) return all;
    return all.filter((r) => String(r.label ?? r.key ?? '').toLowerCase().includes(k));
  }, [roles, kw]);

  // 存 key 而非 label：改名后 key 不变，已授权用户立即显示新名；不会因存了改名后的 label 被鉴权剔除
  const toggle = (key: string, on: boolean) => {
    setForm((f) => {
      const cur = asList(f['系统角色']).map(normalize);
      return { ...f, 系统角色: on ? (cur.includes(key) ? cur : [...cur, key]) : cur.filter((x) => x !== key) };
    });
  };

  const teacherTypes = dicts['教师类型']?.length ? dicts['教师类型'] : TEACHER_TYPE_FALLBACK;
  const campuses = dicts['校区'] ?? [];

  async function submit() {
    if (!String(form['姓名'] ?? '').trim()) {
      setErr(tl('请填写姓名'));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const payload: Record<string, unknown> = {
        姓名: form['姓名'],
        教师类型: form['教师类型'],
        数据密级上限: form['数据密级上限'],
        默认校区: form['默认校区'],
        账号状态: form['账号状态'],
        系统角色: asList(form['系统角色']).map(normalize),
      };
      // 飞书 Open ID 不在表单里编辑；仅编辑态原样带出，新建留空则不提交
      const openId = String(form['飞书 Open ID'] ?? '').trim();
      if (openId) payload['飞书 Open ID'] = openId;

      if (row?.id != null) await api.updateUser(String(row.id), payload);
      else await api.createUser(payload);
      onDone();
    } catch (e) {
      setErr((e as Error).message || tl('保存失败'));
    } finally {
      setBusy(false);
    }
  }

  const card: React.CSSProperties = {
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '16px 18px',
    background: 'var(--bg-elevated)',
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 'var(--font-xs)',
    color: 'var(--fg-tertiary)',
    marginBottom: 4,
  };

  return (
    <div>
      <style>{`
        .user-form-grid{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:16px;align-items:start}
        @media(max-width:900px){.user-form-grid{grid-template-columns:minmax(0,1fr)}}
        .user-role-row{display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid var(--border);cursor:pointer}
        .user-role-row:hover{background:var(--bg-subtle)}
        .user-role-name{font-size:var(--font-sm);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .user-role-sub{font-size:var(--font-xs);color:var(--fg-tertiary)}
        .user-role-badge{font-size:var(--font-xs);color:var(--fg-tertiary);border:1px solid var(--border);border-radius:4px;padding:0 5px}
        .user-form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
      `}</style>

      {err && <p className="msg-error">{err}</p>}

      <div className="user-form-grid">
        {/* 左：基本信息 */}
        <div style={card}>
          <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500, marginBottom: 14 }}>{tl('基本信息')}</div>

          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>{tl('姓名')} <span style={{ color: 'var(--fg-error)' }}>*</span></div>
            <input
              className="form-input"
              value={String(form['姓名'] ?? '')}
              onChange={(e) => setForm((f) => ({ ...f, 姓名: e.target.value }))}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>{tl('飞书 Open ID')}（{tl('只读')}）</div>
            <input
              className="form-input"
              value={String(form['飞书 Open ID'] ?? '')}
              readOnly
              style={{ background: 'var(--bg-subtle)', opacity: 1 }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 12, marginBottom: 12 }}>
            <div>
              <div style={labelStyle}>{tl('教师类型')}</div>
              <select
                className="form-input"
                value={String(form['教师类型'] ?? '')}
                onChange={(e) => setForm((f) => ({ ...f, 教师类型: e.target.value }))}
              >
                <option value="">{tl('未填写')}</option>
                {teacherTypes.map((o) => <option key={o} value={o}>{tl(o)}</option>)}
              </select>
            </div>
            <div>
              <div style={labelStyle}>{tl('数据密级')}</div>
              <select
                className="form-input"
                value={String(form['数据密级上限'] ?? '')}
                onChange={(e) => setForm((f) => ({ ...f, 数据密级上限: e.target.value }))}
              >
                <option value="">{tl('未填写')}</option>
                {LEVEL_OPTS.map((o) => <option key={o} value={o}>{tl(o)}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 12 }}>
            <div>
              <div style={labelStyle}>{tl('校区')}</div>
              <select
                className="form-input"
                value={String(form['默认校区'] ?? '')}
                onChange={(e) => setForm((f) => ({ ...f, 默认校区: e.target.value }))}
              >
                <option value="">{tl('未填写')}</option>
                {campuses.map((o) => <option key={o} value={o}>{tl(o)}</option>)}
              </select>
            </div>
            <div>
              <div style={labelStyle}>{tl('状态')}</div>
              <select
                className="form-input"
                value={String(form['账号状态'] ?? '')}
                onChange={(e) => setForm((f) => ({ ...f, 账号状态: e.target.value }))}
              >
                <option value="">{tl('未填写')}</option>
                {STATUS_OPTS.map((o) => <option key={o} value={o}>{tl(o)}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* 右：系统角色 */}
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500 }}>{tl('系统角色')}</div>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
              {tl('已选')} {selected.length} / {(roles ?? []).length}
            </div>
          </div>

          <input
            className="form-input"
            placeholder={tl('搜索角色')}
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            style={{ marginBottom: 8 }}
          />

          <div style={{ display: 'flex', gap: 10, fontSize: 'var(--font-xs)', marginBottom: 8 }}>
            <span
              style={{ color: 'var(--accent)', cursor: 'pointer' }}
              onClick={() => setForm((f) => ({ ...f, 系统角色: filtered.map((r) => String(r.key ?? '')) }))}
            >
              {tl('全选')}
            </span>
            <span style={{ color: 'var(--fg-tertiary)', cursor: 'pointer' }} onClick={() => setForm((f) => ({ ...f, 系统角色: [] }))}>
              {tl('清空')}
            </span>
          </div>

          <div style={{ maxHeight: 330, overflowY: 'auto', borderTop: '1px solid var(--border)' }}>
            {roles === null && (
              <div style={{ padding: 10, fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{tl('加载中')}…</div>
            )}
            {roles !== null && filtered.length === 0 && (
              <div style={{ padding: 10, fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{tl('无匹配角色')}</div>
            )}
            {filtered.map((r) => {
              const key = String(r.key ?? '');
              const label = String(r.label ?? r.key ?? '');
              const on = selected.includes(key);
              return (
                <label
                  key={key}
                  className="user-role-row"
                  style={on ? { background: 'var(--accent-soft)' } : undefined}
                >
                  <input type="checkbox" checked={on} onChange={(e) => toggle(key, e.target.checked)} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="user-role-name">
                      {tl(label)}
                      {r.protected ? <span className="user-role-badge">{tl('内置')}</span> : null}
                    </span>
                    <span className="user-role-sub" style={{ display: 'block' }}>
                      {Array.isArray(r.permissions) ? r.permissions.length : 0} {tl('项权限')} · {r.maxDataLevel}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)', fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
            {tl('已选')}：{selected.length ? selected.map((s) => { const r = (roles ?? []).find((x) => x.key === s); return tl(r?.label ?? r?.key ?? s); }).join('、') : tl('未选择')}
          </div>
        </div>
      </div>

      <div className="user-form-actions">
        <button className="btn btn-ghost" onClick={onDone} disabled={busy}>{tl('取消')}</button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
          {busy ? tl('保存中') : tl('保存')}
        </button>
      </div>
    </div>
  );
}
