'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

/**
 * AI 路由 · API 密钥。
 *
 * 密钥是发给使用方的凭证：库里只存 SHA-256 哈希（记录 id 就是哈希），
 * **明文只在代发时显示一次**，之后谁（包括管理员）都查不回来 —— 丢了只能重新发。
 * 因此这一页是「只读列表 + 代发 + 吊销」，没有常规的新建/编辑。
 */
const COLUMNS: CrudColumn[] = [
  {
    key: '密钥前缀',
    label: '密钥前缀',
    width: '180px',
    filter: true,
    filterType: 'text',
    listOrder: 1,
    render: (v) => (
      <code style={{ fontSize: 'var(--font-xs)', background: 'var(--bg-subtle)', padding: '1px 5px', borderRadius: 4 }}>
        {String(v ?? '—')}…
      </code>
    ),
  },
  { key: '名称', label: '名称', width: '140px', listOrder: 2 },
  {
    key: '所属用户',
    label: '使用者',
    width: '120px',
    render: (v) => <span style={{ fontSize: 'var(--font-sm)' }}>{String(v ?? '—')}</span>,
  },
  { key: '所属分组', label: '分组', width: '120px' },
  {
    key: '状态',
    label: '状态',
    width: '90px',
    filter: true,
    filterOptions: ['启用', '停用', '已过期', '已吊销'],
    render: (v) => {
      const s = String(v ?? '');
      const color = s === '启用' ? '#2c6b45' : s === '停用' ? '#7a5c10' : '#b3261e';
      return <span style={{ fontSize: 'var(--font-xs)', color }}>{s || '—'}</span>;
    },
  },
  {
    key: '配额USD',
    label: '额度（已用 / 总额）',
    width: '150px',
    render: (v, row) => {
      const quota = Number(v ?? 0);
      const used = Number(row['已用额度USD'] ?? 0);
      return (
        <span style={{ fontSize: 'var(--font-xs)' }}>
          ${used.toFixed(4)} / {quota > 0 ? `$${quota.toFixed(2)}` : '不限'}
        </span>
      );
    },
  },
  {
    key: '过期时间',
    label: '过期时间',
    width: '140px',
    render: (v) => {
      const n = Number(v ?? 0);
      if (!n) return <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-xs)' }}>长期</span>;
      const d = new Date(n);
      const p = (x: number) => String(x).padStart(2, '0');
      return (
        <span style={{ fontSize: 'var(--font-xs)' }}>
          {`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`}
        </span>
      );
    },
  },
  {
    key: '最后使用时间',
    label: '最后使用',
    width: '140px',
    render: (v) => {
      const n = Number(v ?? 0);
      if (!n) return <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-xs)' }}>从未</span>;
      const d = new Date(n);
      const p = (x: number) => String(x).padStart(2, '0');
      return (
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
          {`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`}
        </span>
      );
    },
  },
];

export default function AiApiKeysPage() {
  const [minting, setMinting] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [groups, setGroups] = useState<{ value: string; label: string }[]>([]);
  const [users, setUsers] = useState<{ value: string; label: string }[]>([]);

  useEffect(() => {
    let alive = true;
    Promise.all([api.listAiRouteGroups({ pageSize: '200' }), api.listUserDirectory()])
      .then(([g, u]) => {
        if (!alive) return;
        setGroups((g.items ?? []).map((x) => ({ value: String(x.id ?? ''), label: String(x['名称'] ?? '') })));
        setUsers((u ?? []).map((x) => ({ value: String(x.openId ?? ''), label: String(x.name ?? '') })));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const revoke = useCallback(async (row: Record<string, unknown>) => {
    if (!window.confirm(`确认吊销密钥「${String(row['名称'] ?? row['密钥前缀'] ?? '')}」？吊销后立即失效，不可恢复。`)) return;
    try {
      await api.revokeAiApiKey(String(row.id ?? ''));
      setMsg('已吊销');
    } catch (e) {
      setMsg(`吊销失败：${(e as Error).message}`);
    }
  }, []);

  const columns = useMemo(
    () =>
      COLUMNS.map((c) => (c.key === '状态' ? { ...c, filter: true } : c)),
    [],
  );

  return (
    <>
      <CrudPage
        title="AI 路由 · API 密钥"
        subtitle="发给使用方的密钥。明文只在代发时显示一次，库里只存哈希 —— 丢了只能重新发"
        search={{ placeholder: '搜索名称 / 密钥前缀…' }}
        columns={columns}
        moduleKey="aiApiKeys"
        statusField="状态"
        // 只隐藏「新建」（新建必须走代发弹窗）；已有的密钥允许改名称/额度/有效期，
        // 所以不能整页 readonly —— 否则行内的「吊销」按钮不会渲染。
        hideCreate
        extraActions={[{ label: '代发密钥', run: () => setMinting(true) }]}
        rowExtraActions={[{ label: '吊销', run: (row) => revoke(row) }]}
        api={{ list: (p) => api.listAiApiKeys(p) }}
      />

      {msg ? (
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)', marginBottom: 8 }}>{msg}</div>
      ) : null}

      {minting ? (
        <MintDialog
          groups={groups}
          users={users}
          onClose={() => setMinting(false)}
          onDone={(plain) => {
            setMinting(false);
            setCreated(plain);
          }}
        />
      ) : null}

      {created ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--overlay)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 70,
            padding: 16,
          }}
        >
          <div
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 20,
              width: 'min(560px, 100%)',
            }}
          >
            <div style={{ fontSize: 'var(--font-md)', fontWeight: 600, marginBottom: 10 }}>密钥已生成（请复制保存）</div>
            <div
              style={{
                background: '#fff7e6',
                border: '1px solid #f0d9a8',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 'var(--font-xs)',
                color: '#7a5c10',
                marginBottom: 12,
              }}
            >
              ⚠️ 该密钥明文仅显示这一次，关闭后不可再查。
            </div>
            <code
              style={{
                display: 'block',
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 12,
                fontSize: 'var(--font-xs)',
                wordBreak: 'break-all',
              }}
            >
              {created}
            </code>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(created).then(() => setMsg('已复制'));
                  setCreated(null);
                }}
              >
                复制并关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** 代发密钥弹窗：使用者 / 分组 / IP 白名单 / 额度 / 有效期 */
function MintDialog({
  groups,
  users,
  onClose,
  onDone,
}: {
  groups: { value: string; label: string }[];
  users: { value: string; label: string }[];
  onClose: () => void;
  onDone: (plain: string) => void;
}) {
  const [name, setName] = useState('');
  const [userId, setUserId] = useState('');
  const [groupId, setGroupId] = useState(groups[0]?.value ?? '');
  const [ips, setIps] = useState('');
  const [quota, setQuota] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!groupId) {
      setErr('请选择所属分组');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const r = await api.mintAiApiKey({
        name,
        userId,
        groupId,
        ipWhitelist: ips.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
        quotaUsd: Number(quota || 0),
        expiresAt: expires ? new Date(`${expires.slice(0, 10)}T23:59:59`).getTime() : 0,
      });
      onDone(r.key);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: '110px 1fr', gap: 10, alignItems: 'center', marginBottom: 10 };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--overlay)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 70,
        padding: 16,
      }}
    >
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 20,
          width: 'min(560px, 100%)',
        }}
      >
        <div style={{ fontSize: 'var(--font-md)', fontWeight: 600, marginBottom: 14 }}>代发 API 密钥</div>
        <div style={row}>
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>名称</span>
          <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 张三-AI助手" />
        </div>
        <div style={row}>
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>使用者</span>
          <select className="form-input" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">（不指定）</option>
            {users.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
        </div>
        <div style={row}>
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>所属分组 *</span>
          <select className="form-input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">请选择</option>
            {groups.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
        <div style={row}>
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>IP 白名单</span>
          <input className="form-input" value={ips} onChange={(e) => setIps(e.target.value)} placeholder="留空=不限，多个用逗号分隔" />
        </div>
        <div style={row}>
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>额度 USD</span>
          <input className="form-input" value={quota} onChange={(e) => setQuota(e.target.value)} placeholder="留空或 0 = 不限制" />
        </div>
        <div style={row}>
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>有效期</span>
          <input className="form-input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} placeholder="留空=长期" />
        </div>
        {err ? <div style={{ color: 'var(--fg-error)', fontSize: 'var(--font-xs)', marginBottom: 8 }}>{err}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button className="btn btn-outline btn-sm" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submit()}>
            {busy ? '生成中…' : '代发密钥'}
          </button>
        </div>
      </div>
    </div>
  );
}
