'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

/**
 * AI 路由 · 上游账号。
 *
 * 存放各家厂商的**真实密钥**：落库前 AES-256-GCM 加密，列表/详情/导出一律只回显掩码
 * `******`；要看明文必须点「查看凭证」（单独鉴权 + 记操作日志）。
 * 编辑时凭证留空/保持掩码 = 不修改，这是 secret-cipher 的约定。
 */
function buildColumns(
  groupOptions: { value: string; label: string }[],
  proxyOptions: { value: string; label: string }[],
): CrudColumn[] {
  return [
    { key: '名称', label: '账号名称', width: '150px', form: true, required: true, filter: true, filterType: 'text', listOrder: 1 },
    {
      key: '供应商',
      label: '供应商',
      width: '100px',
      form: true,
      type: 'select',
      dictKey: '上游供应商',
      filter: true,
      filterOptions: ['OpenAI', 'Anthropic', 'Gemini', '自定义'],
      listOrder: 2,
      render: (v) => (
        <span
          style={{
            fontSize: 'var(--font-xs)',
            padding: '1px 6px',
            borderRadius: 8,
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
          }}
        >
          {String(v ?? '—')}
        </span>
      ),
    },
    {
      key: 'BaseURL',
      label: 'Base URL',
      width: '220px',
      form: true,
      required: true,
      render: (v) => (
        <span style={{ fontSize: 'var(--font-xs)', wordBreak: 'break-all' }}>{String(v ?? '—')}</span>
      ),
    },
    {
      key: '所属分组',
      label: '所属分组',
      width: '170px',
      form: true,
      // 一个账号可同时服务多个分组（对齐 sub2api 的多对多）
      type: 'link',
      linkMulti: true,
      linkOptions: groupOptions,
      render: (v) => {
        const list = Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[、,，]/).filter(Boolean);
        if (!list.length) return <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-xs)' }}>未分组</span>;
        return <span style={{ fontSize: 'var(--font-xs)' }}>{list.join('、')}</span>;
      },
    },
    {
      key: '状态',
      label: '状态',
      width: '80px',
      form: true,
      type: 'select',
      dictKey: 'AI路由状态',
      filter: true,
      filterOptions: ['启用', '停用'],
      listOrder: 5,
    },
    {
      key: '健康状态',
      label: '健康',
      width: '80px',
      // 由定时体检写入（每 10 分钟探测 /models）；连续失败 3 次转「异常」后不再分配流量
      render: (v) => {
        const s = String(v ?? '正常');
        const color = s === '正常' ? '#2c6b45' : s === '降级' ? '#7a5c10' : '#b3261e';
        return <span style={{ fontSize: 'var(--font-xs)', color }}>{s}</span>;
      },
    },
    {
      key: '调度',
      label: '调度',
      width: '150px',
      // 三类冷却都是「到期自动恢复」，这里显示还剩多久（不用人工解锁）
      render: (_v, row) => {
        const now = Date.now();
        if (String(row['状态'] ?? '') !== '启用') return <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>已停用</span>;
        if (String(row['可调度'] ?? '是') !== '是') return <span style={{ fontSize: 'var(--font-xs)', color: '#7a5c10' }}>手动停调</span>;
        const exp = Number(row['过期时间'] ?? 0);
        if (exp && now > exp && String(row['过期自动暂停'] ?? '是') === '是')
          return <span style={{ fontSize: 'var(--font-xs)', color: '#b3261e' }}>已过期</span>;
        const cooling: [string, number][] = [
          ['限流', Number(row['限流解除时间'] ?? 0)],
          ['过载', Number(row['过载解除时间'] ?? 0)],
          ['临时摘除', Number(row['临时不可调度解除时间'] ?? 0)],
        ];
        const hit = cooling.find(([, at]) => at && now < at);
        if (hit) {
          const left = Math.ceil((hit[1] - now) / 1000);
          return (
            <span style={{ fontSize: 'var(--font-xs)', color: '#7a5c10' }} title={String(row['临时不可调度原因'] ?? '')}>
              {hit[0]}冷却 {left > 60 ? `${Math.ceil(left / 60)} 分` : `${left} 秒`}
            </span>
          );
        }
        if (String(row['健康状态'] ?? '') === '异常') return <span style={{ fontSize: 'var(--font-xs)', color: '#b3261e' }}>已标记异常</span>;
        return <span style={{ fontSize: 'var(--font-xs)', color: '#2c6b45' }}>可调度</span>;
      },
    },
    { key: '权重', label: '权重', width: '70px', form: true, type: 'number' },
    { key: '优先级', label: '优先级', width: '80px', form: true, type: 'number' },
    {
      key: '最后检查时间',
      label: '最后体检',
      width: '140px',
      render: (v) => {
        const n = Number(v ?? 0);
        if (!n) return <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-xs)' }}>未体检</span>;
        const d = new Date(n);
        const p = (x: number) => String(x).padStart(2, '0');
        return (
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
            {`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`}
          </span>
        );
      },
    },
    // ── 表单字段（列表不显示）──
    {
      key: '凭证',
      label: '凭证（JSON）',
      list: false,
      form: true,
      type: 'textarea',
      // 编辑时留空或保持 ****** 表示不修改
      hint: '填 JSON，如 {"apiKey":"sk-xxx"}。列表只回显掩码，明文仅此处可写',
    },
    { key: '可用模型', label: '可用模型', list: false, form: true, type: 'tags' },
    {
      key: '代理',
      label: '代理',
      list: false,
      form: true,
      type: 'link',
      linkOptions: proxyOptions,
      hint: '国内直连不通时选一个代理；留空表示直连',
    },
    { key: '账号成本倍率', label: '账号成本倍率', list: false, form: true, type: 'number', hint: '上游成本口径（1 = 原价）；分组开启利润控制时用它做准入比较' },
    { key: '并发上限', label: '并发上限', list: false, form: true, type: 'number', hint: '该账号同时处理多少请求；0 = 不限。满了就换下一个账号，不排队' },
    { key: '负载因子', label: '负载因子', list: false, form: true, type: 'number', hint: '用于算负载率，留空则用并发上限；调大 = 允许更多并发' },
    { key: '可调度', label: '可调度', list: false, form: true, type: 'select', dictKey: '是否可调度', hint: '关掉后该账号不再被调度（等价于临时下线，不影响已配置信息）' },
    { key: '过期时间', label: '过期时间', list: false, form: true, type: 'date' },
    { key: '过期自动暂停', label: '过期自动暂停', list: false, form: true, type: 'select', dictKey: '是否', hint: '到期后自动停止调度（默认是）' },
    { key: '临时不可调度解除时间', label: '临时摘除至', list: false, form: true, type: 'datetime', readonly: true },
    { key: '当前并发', label: '当前并发', width: '80px', render: (v) => <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{Number(v ?? 0)}</span> },
    { key: '鉴权方式', label: '鉴权方式', list: false, form: true, type: 'select', dictKey: '鉴权方式' },
    { key: '最后失败信息', label: '最近失败原因', width: '220px', render: (v) => <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{String(v ?? '—')}</span> },
  ];
}

export default function AiUpstreamsPage() {
  const [groups, setGroups] = useState<{ value: string; label: string }[]>([]);
  const [proxies, setProxies] = useState<{ value: string; label: string }[]>([]);
  const [secret, setSecret] = useState<{ name: string; text: string } | null>(null);
  const [msg, setMsg] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([api.listAiRouteGroups({ pageSize: '200' }), api.listAiProxies({ pageSize: '200' })])
      .then(([p, px]) => {
        if (!alive) return;
        setGroups((p.items ?? []).map((g) => ({ value: String(g.id ?? ''), label: String(g['名称'] ?? '') })));
        setProxies((px.items ?? []).map((x) => ({ value: String(x.id ?? ''), label: String(x['名称'] ?? '') })));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const columns = useMemo(() => buildColumns(groups, proxies), [groups, proxies]);

  /** 重置调度状态：清掉限流/过载/临时摘除冷却（key 恢复额度、凭证修好后用） */
  const resetState = useCallback(async (row: Record<string, unknown>) => {
    if (!window.confirm(`确认重置「${String(row['名称'] ?? '')}」的调度状态？将清除限流/过载/临时摘除冷却与失败计数。`)) return;
    try {
      await api.resetAiUpstreamState(String(row.id ?? ''));
      setMsg('已重置调度状态');
    } catch (e) {
      setMsg(`重置失败：${(e as Error).message}`);
    }
  }, []);

  /** 查看凭证明文：列表里永远只有掩码，这里是唯一入口，后端会记操作日志 */
  const showSecret = useCallback(async (row: Record<string, unknown>) => {
    setSecret({ name: String(row['名称'] ?? ''), text: '读取中…' });
    try {
      const r = await api.revealAiUpstreamSecret(String(row.id ?? ''));
      setSecret({
        name: String(row['名称'] ?? ''),
        text: Object.keys(r.credential ?? {}).length ? JSON.stringify(r.credential, null, 2) : '（未配置凭证）',
      });
    } catch (e) {
      setSecret({ name: String(row['名称'] ?? ''), text: `读取失败：${(e as Error).message}` });
    }
  }, []);

  const runHealthCheck = useCallback(async () => {
    setChecking(true);
    setMsg('');
    try {
      const r = await api.aiUpstreamHealthCheck();
      setMsg(`体检完成：正常 ${r.ok} / 异常 ${r.bad}（共 ${r.checked} 个启用上游）`);
    } catch (e) {
      setMsg(`体检失败：${(e as Error).message}`);
    } finally {
      setChecking(false);
    }
  }, []);

  return (
    <>
      {msg ? (
        <div style={{ fontSize: 'var(--font-xs)', color: msg.includes('失败') ? 'var(--fg-error)' : 'var(--fg-secondary)', marginBottom: 8 }}>
          {msg}
        </div>
      ) : null}
      <CrudPage
        title="AI 路由 · 上游账号"
        subtitle="各家厂商的真实账号与密钥（加密存储，列表只回显掩码）"
        search={{ placeholder: '搜索账号名称 / BaseURL…' }}
        columns={columns}
        moduleKey="aiUpstreams"
        statusField="状态"
        inlineEdit
        standaloneForm
        rowExtraActions={[
          { label: '查看凭证', run: (row) => showSecret(row) },
          { label: '重置状态', run: (row) => resetState(row) },
        ]}
        extraActions={[
          { label: checking ? '体检中…' : '立即体检', run: () => runHealthCheck() },
        ]}
        api={{
          list: (p) => api.listAiUpstreams(p),
          create: (d) => api.createAiUpstream(d),
          update: (id, d) => api.updateAiUpstream(id, d),
          archive: (id) => api.deleteAiUpstream(id),
        }}
      />

      {secret ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--overlay)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 60,
            padding: 16,
          }}
          onClick={() => setSecret(null)}
        >
          <div
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 20,
              width: 'min(560px, 100%)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, marginBottom: 8 }}>
              上游凭证（明文） · {secret.name}
            </div>
            <pre
              style={{
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 12,
                maxHeight: 320,
                overflow: 'auto',
                fontSize: 'var(--font-xs)',
              }}
            >
              {secret.text}
            </pre>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 8 }}>
              ⚠️ 查看明文会写入操作日志；请勿复制到聊天工具或截图中。
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button className="btn btn-primary btn-sm" onClick={() => setSecret(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
