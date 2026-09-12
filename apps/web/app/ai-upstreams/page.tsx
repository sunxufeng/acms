'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import {
  CardPicker,
  GroupPicker,
  ModelMapField,
  ModelWhitelistField,
  QuotaBar,
  TempRuleField,
} from '../../components/ai-route/fields';
import { api } from '../../lib/api';

/**
 * AI 路由 · 上游账号。
 *
 * 存放各家厂商的**真实账号**：凭证落库前 AES-256-GCM 加密，列表/详情/导出一律只回显掩码
 * `******`；要看明文必须点「查看凭证」（单独鉴权 + 记操作日志）。
 * 编辑时凭证留空/保持掩码 = 不修改，这是 secret-cipher 的约定。
 *
 * 列表侧能力对齐 sub2api 的账号管理台：
 *   批量操作（跨页多选 + 启停调度 / 重置状态 / 改额度 / 删除）、
 *   按平台 / 类型 / 状态 / 调度状态 / 分组筛选、列显示设置、自动刷新、行内调度开关、
 *   行级运维动作（测试连接 / 查看统计 / 复制账号 / 重置状态 / 查看凭证）。
 *
 * ⚠️ columns 数组**顺序即表单字段顺序**（列表顺序由 listOrder 单独控制），
 * 所以这里按表单分区把「有 form 的字段」连续排列，分区表头才不会来回跳。
 * 同一字段若既要列表展示又要表单编辑、且两边控件形态不同，会声明成两条（表单那条 list:false）。
 */

function fmt(ms: unknown): string {
  const n = Number(ms ?? 0);
  if (!n) return '—';
  const d = new Date(n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 过期时间：日期选择 + 「1 个月 / 1 年」快捷（对齐 sub2api） */
function ExpiryField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const toInput = (v: unknown): string => {
    const n = Number(v ?? 0);
    if (!n) return '';
    const d = new Date(n);
    const p = (x: number) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const addMonths = (m: number) => {
    const d = new Date();
    d.setMonth(d.getMonth() + m);
    onChange(d.getTime());
  };
  return (
    <div>
      <input
        className="form-input"
        type="date"
        value={toInput(value)}
        onChange={(e) => onChange(e.target.value ? new Date(`${e.target.value}T23:59:59`).getTime() : 0)}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => addMonths(1)}>1 个月</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => addMonths(12)}>1 年</button>
        {Number(value ?? 0) ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(0)}>清空</button>
        ) : null}
      </div>
    </div>
  );
}

const PLATFORMS = ['Anthropic', 'OpenAI', 'Gemini', 'Antigravity', 'Grok', 'Kimi', 'Zhipu GLM', 'DeepSeek', 'MiniMax', 'OpenCode', '自定义'];
const PLATFORM_HINT: Record<string, string> = {
  Anthropic: 'Claude 系', OpenAI: 'GPT 系', Gemini: 'Google Gemini', Antigravity: 'Google 内部通道',
  Grok: 'xAI', Kimi: '月之暗面', 'Zhipu GLM': '智谱', DeepSeek: '深度求索',
  MiniMax: '稀宇', OpenCode: '编程专用', 自定义: '自建 / 兼容端点',
};
const ACCOUNT_TYPES = ['OAuth', 'API Key', '无'];
const ACCOUNT_TYPE_HINT: Record<string, string> = {
  OAuth: '订阅型账号，走官方授权', 'API Key': '控制台密钥', 无: '端点不需要鉴权',
};

function buildColumns(opts: {
  groupOptions: { value: string; label: string }[];
  groupRich: { id: string; name: string; rate: number; count: number }[];
  groupNames: string[];
  proxyOptions: { value: string; label: string }[];
  routeModels: string[];
}): CrudColumn[] {
  const { groupOptions, groupRich, groupNames, proxyOptions, routeModels } = opts;
  const S = { base: '基本信息', conn: '接入配置', model: '模型限制', sched: '调度与额度', run: '运行状态' };

  return [
    // ── 基本信息 ──────────────────────────────────────────────────
    {
      key: '名称', label: '账号名称', width: '150px', listOrder: 1,
      form: true, required: true, section: S.base, filter: true, filterType: 'text',
    },
    {
      key: '供应商', label: '平台', width: '110px', listOrder: 3,
      form: true, required: true, section: S.base, filter: true, filterOptions: PLATFORMS,
      renderField: ({ value, onChange }) => (
        <CardPicker value={String(value ?? '')} onChange={onChange} options={PLATFORMS} subtitleOf={(o) => PLATFORM_HINT[o] ?? ''} />
      ),
      render: (v) => (
        <span style={{ fontSize: 'var(--font-xs)', padding: '1px 6px', borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent)', whiteSpace: 'nowrap' }}>
          {String(v ?? '—')}
        </span>
      ),
    },
    {
      key: '鉴权方式', label: '账号类型', width: '100px', listOrder: 4,
      form: true, section: S.base, filter: true, filterOptions: ACCOUNT_TYPES,
      renderField: ({ value, onChange }) => (
        <CardPicker value={String(value ?? '')} onChange={onChange} options={ACCOUNT_TYPES} columns={3} subtitleOf={(o) => ACCOUNT_TYPE_HINT[o] ?? ''} />
      ),
      render: (v) => <span style={{ fontSize: 'var(--font-xs)' }}>{String(v ?? '—')}</span>,
    },
    {
      key: '状态', label: '状态', width: '70px', listOrder: 6,
      form: true, type: 'select', dictKey: 'AI路由状态', section: S.base, filter: true, filterOptions: ['启用', '停用'],
    },
    {
      key: '所属分组', label: '所属分组', width: '160px', listOrder: 9,
      form: true, type: 'link', linkMulti: true, linkOptions: groupOptions, section: S.base,
      // 自带倍率与账号数的复选组（比通用 link 复选多两列判断依据）
      renderField: ({ value, onChange }) => (
        <GroupPicker
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={onChange}
          options={groupRich}
        />
      ),
      // 多值字段没法等值筛选：走 `字段__has=值` 的成员包含（后端 listDeep 处理）
      filter: true, filterParam: '所属分组__has', filterOptions: groupNames,
      render: (v) => {
        const list = Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[、,，]/).filter(Boolean);
        if (!list.length) return <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-xs)' }}>未分组</span>;
        return <span style={{ fontSize: 'var(--font-xs)' }}>{list.join('、')}</span>;
      },
    },
    {
      key: '备注', label: '备注', width: '160px', listOrder: 23,
      form: true, type: 'textarea', section: S.base, fieldHeight: 70,
      render: (v) => <span style={{ fontSize: 'var(--font-xs)' }}>{String(v ?? '—')}</span>,
    },

    // ── 接入配置 ──────────────────────────────────────────────────
    {
      key: 'BaseURL', label: 'Base URL', form: true, required: true, section: S.conn,
      hint: '上游的 API 根地址，如 https://api.openai.com/v1。转发时会拼上 /chat/completions 等路径',
    },
    {
      key: '凭证', label: '凭证（JSON）', form: true, type: 'textarea', section: S.conn,
      hint: '填 JSON，如 {"apiKey":"sk-xxx"}。列表只回显掩码；留空或保持 ****** 表示不修改',
    },
    {
      key: '上游ID头名', label: '上游ID头名', form: true, section: S.conn,
      hint: '上游在响应头里回传请求标识的头名（如 x-request-id），会记进用量明细的「上游请求ID」便于排障；留空不记录',
    },
    {
      key: '代理', label: '代理（填表）', form: true, type: 'link', linkOptions: proxyOptions, section: S.conn, list: false,
      hint: '国内直连不通时选一个代理；留空表示直连',
    },

    // ── 模型限制 ──────────────────────────────────────────────────
    {
      key: '模型白名单', label: '模型白名单', form: true, section: S.model, list: false,
      hint: '配了之后只有命中的逻辑模型才允许走这个账号（支持结尾 * 通配）；留空 = 不限制',
      renderField: ({ value, onChange, form, row }) => {
        // 新建时用表单里正在填的凭证去探测；编辑时表单里的凭证是掩码 ******，
        // 传 upstreamId 让后端用库里存好的凭证（不必要求用户重填一遍密钥）。
        let cred: Record<string, string> = {};
        try {
          const raw = String(form['凭证'] ?? '').trim();
          if (raw.startsWith('{')) cred = JSON.parse(raw) as Record<string, string>;
        } catch {
          cred = {};
        }
        return (
          <ModelWhitelistField
            value={Array.isArray(value) ? (value as string[]) : []}
            onChange={onChange}
            provider={String(form['供应商'] ?? 'OpenAI')}
            baseUrl={String(form['BaseURL'] ?? '')}
            credential={cred}
            upstreamId={row?.id ? String(row.id) : undefined}
            suggestions={routeModels}
          />
        );
      },
    },
    {
      key: '模型映射', label: '模型映射', form: true, section: S.model, list: false,
      renderField: ({ value, onChange }) => (
        <ModelMapField value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />
      ),
    },
    {
      key: '可用模型', label: '可用模型', form: true, type: 'tags', tagOptions: routeModels, section: S.model, list: false,
      hint: '仅用于展示与备注（真正约束调度的是上面的「模型白名单」）。回车添加',
    },

    // ── 调度与额度 ────────────────────────────────────────────────
    {
      key: '可调度', label: '可调度', width: '70px', listOrder: 7,
      form: true, type: 'select', dictKey: '是否可调度', section: S.sched,
      // 行内开关：列表上直接停调 / 恢复，不必进编辑页
      inlineSwitch: { onValue: '是', offValue: '否', onHint: '点击停止调度', offHint: '点击恢复调度' },
      render: (v) => <span style={{ fontSize: 'var(--font-xs)' }}>{String(v ?? '是')}</span>,
    },
    { key: '并发上限', label: '并发上限', form: true, type: 'number', section: S.sched, list: false, hint: '该账号同时处理多少请求；0 = 不限。满了就换下一个账号，不排队' },
    { key: '负载因子', label: '负载因子', form: true, type: 'number', section: S.sched, list: false, hint: '用于算负载率，留空则用并发上限；调大 = 允许更多并发' },
    { key: '优先级', label: '优先级（填表）', form: true, type: 'number', section: S.sched, list: false, hint: '数值越小越优先使用；同优先级内按负载率与随机排序' },
    { key: '权重', label: '权重（填表）', form: true, type: 'number', section: S.sched, list: false, hint: '同优先级账号之间的抽样权重（保留字段）' },
    { key: '账号成本倍率', label: '账号成本倍率', form: true, type: 'number', section: S.sched, list: false, hint: '上游成本口径（1 = 原价）；分组开启利润控制时用它做准入比较' },
    { key: '日额度USD', label: '日额度 USD', form: true, type: 'number', section: S.sched, list: false, hint: '0 或留空 = 不限；按自然日自动归零' },
    { key: '月额度USD', label: '月额度 USD', form: true, type: 'number', section: S.sched, list: false, hint: '0 或留空 = 不限；按自然月自动归零' },
    {
      key: '过期时间', label: '过期时间', form: true, section: S.sched, list: false,
      renderField: ({ value, onChange }) => <ExpiryField value={value} onChange={onChange} />,
    },
    { key: '过期自动暂停', label: '过期自动暂停调度', form: true, type: 'select', dictKey: '是否', section: S.sched, list: false, hint: '到期后自动停止调度（默认是）' },
    {
      key: '临时不可调度规则', label: '临时不可调度规则', form: true, section: S.sched, list: false,
      renderField: ({ value, onChange }) => (
        <TempRuleField value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />
      ),
    },

    // ── 运行状态（只读）────────────────────────────────────────────
    { key: '最后失败信息', label: '最近失败信息', form: true, readonly: true, section: S.run, list: false },

    // ── 仅列表展示（不参与表单，因此不影响表单分区顺序）────────────
    {
      key: '账号ID', label: '账号ID', width: '90px', listOrder: 2,
      render: (_v, row) => (
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', fontFamily: 'var(--font-mono, monospace)' }}>
          #{String(row.id ?? '').slice(0, 8)}
        </span>
      ),
    },
    {
      key: '容量', label: '容量', width: '95px', listOrder: 5,
      render: (_v, row) => (
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', whiteSpace: 'nowrap' }}>
          并发 {Number(row['当前并发'] ?? 0)} / {Number(row['并发上限'] ?? 0) > 0 ? Number(row['并发上限']) : '不限'}
        </span>
      ),
    },
    {
      key: '调度状态', label: '调度状态', width: '110px', listOrder: 8, filter: true,
      render: (v) => {
        const s = String(v ?? '可调度');
        const color = s === '可调度' ? '#2c6b45' : s === '已停用' ? 'var(--fg-tertiary)' : s === '已标记异常' ? '#b3261e' : '#8a5a12';
        return <span style={{ fontSize: 'var(--font-xs)', color, whiteSpace: 'nowrap' }}>{s}</span>;
      },
    },
    {
      key: '账号额度', label: '账号额度', width: '190px', listOrder: 10,
      render: (_v, row) => (
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
          <QuotaBar label="日" used={Number(row['今日已用USD'] ?? 0)} limit={Number(row['日额度USD'] ?? 0)} />
          <QuotaBar label="月" used={Number(row['本月已用USD'] ?? 0)} limit={Number(row['月额度USD'] ?? 0)} />
        </span>
      ),
    },
    {
      key: '今日统计', label: '今日', width: '140px', listOrder: 11,
      render: (_v, row) => {
        const calls = Number(row['今日调用数'] ?? 0);
        if (!calls) return <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>—</span>;
        return (
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)', whiteSpace: 'nowrap' }}>
            {calls} 次 · {Number(row['今日Token'] ?? 0)} tok
          </span>
        );
      },
    },
    {
      key: '白名单数', label: '白名单', width: '80px', listOrder: 12,
      render: (_v, row) => {
        const n = Array.isArray(row['模型白名单']) ? (row['模型白名单'] as unknown[]).length : 0;
        return <span style={{ fontSize: 'var(--font-xs)', color: n ? 'var(--fg-secondary)' : 'var(--fg-tertiary)' }}>{n ? `${n} 个` : '不限'}</span>;
      },
    },
    {
      key: '映射数', label: '映射', width: '70px', listOrder: 13,
      render: (_v, row) => {
        const n = Array.isArray(row['模型映射']) ? (row['模型映射'] as unknown[]).length : 0;
        return <span style={{ fontSize: 'var(--font-xs)', color: n ? 'var(--fg-secondary)' : 'var(--fg-tertiary)' }}>{n ? `${n} 条` : '—'}</span>;
      },
    },
    { key: '代理', label: '代理', width: '100px', listOrder: 14, render: (v) => <span style={{ fontSize: 'var(--font-xs)' }}>{String(v ?? '') || '直连'}</span> },
    { key: '权重', label: '权重', width: '60px', listOrder: 15 },
    { key: '优先级', label: '优先级', width: '70px', listOrder: 16 },
    {
      key: '账号成本倍率', label: '账号倍率', width: '80px', listOrder: 17,
      render: (v) => <span style={{ fontSize: 'var(--font-xs)' }}>{v == null || v === '' ? '1' : String(v)}</span>,
    },
    {
      key: '过期时间', label: '过期时间', width: '150px', listOrder: 18,
      render: (v) => {
        const n = Number(v ?? 0);
        if (!n) return <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>—</span>;
        const expired = Date.now() > n;
        return (
          <span style={{ fontSize: 'var(--font-xs)', color: expired ? '#b3261e' : 'var(--fg-secondary)', whiteSpace: 'nowrap' }}>
            {fmt(n)}{expired ? ' 已过期' : ''}
          </span>
        );
      },
    },
    { key: '最近使用时间', label: '最近使用', width: '140px', listOrder: 19, render: (v) => <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{fmt(v)}</span> },
    { key: '最后检查时间', label: '最后体检', width: '140px', listOrder: 20, render: (v) => <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{fmt(v)}</span> },
    {
      key: '健康状态', label: '健康', width: '70px', listOrder: 21,
      render: (v) => {
        const s = String(v ?? '正常');
        const color = s === '正常' ? '#2c6b45' : s === '降级' ? '#8a5a12' : '#b3261e';
        return <span style={{ fontSize: 'var(--font-xs)', color }}>{s}</span>;
      },
    },
    { key: '最近失败原因', label: '最近失败原因', width: '200px', listOrder: 22, render: (_v, row) => <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{String(row['最后失败信息'] ?? '—')}</span> },
  ];
}

export default function AiUpstreamsPage() {
  const [groups, setGroups] = useState<{ value: string; label: string }[]>([]);
  const [groupRich, setGroupRich] = useState<{ id: string; name: string; rate: number; count: number }[]>([]);
  const [proxies, setProxies] = useState<{ value: string; label: string }[]>([]);
  const [routeModels, setRouteModels] = useState<string[]>([]);
  const [secret, setSecret] = useState<{ name: string; text: string } | null>(null);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.aiUpstreamStats>> | null>(null);
  const [msg, setMsg] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.listAiRouteGroups({ pageSize: '200' }),
      api.listAiProxies({ pageSize: '200' }),
      api.listAiModelRoutes({ pageSize: '500' }),
      // 只为统计「每个分组下有几个账号」——内部账号数量很小，一次拉全量最省事
      api.listAiUpstreams({ pageSize: '500' }),
    ])
      .then(([p, px, mr, ups]) => {
        if (!alive) return;
        const gs = (p.items ?? []).map((g) => ({
          id: String(g.id ?? ''),
          name: String(g['名称'] ?? ''),
          rate: Number(g['价格倍率'] ?? 1) || 1,
        }));
        const counts = new Map<string, number>();
        for (const u of ups.items ?? []) {
          const ids = u['所属分组__link'];
          const list = Array.isArray(ids) ? ids.map(String) : [];
          for (const id of list) counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        setGroups(gs.map((g) => ({ value: g.id, label: g.name })));
        setGroupRich(gs.map((g) => ({ ...g, count: counts.get(g.id) ?? 0 })));
        setProxies((px.items ?? []).map((x) => ({ value: String(x.id ?? ''), label: String(x['名称'] ?? '') })));
        // 「模型路由」里已用的逻辑模型交给白名单选择器当候选 —— 白名单通常就从它们里挑
        setRouteModels(Array.from(new Set((mr.items ?? []).map((r) => String(r['逻辑模型'] ?? '')).filter(Boolean))));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const columns = useMemo(
    () =>
      buildColumns({
        groupOptions: groups,
        groupRich,
        groupNames: groups.map((g) => g.label),
        proxyOptions: proxies,
        routeModels,
      }),
    [groups, groupRich, proxies, routeModels],
  );

  /** 重置调度状态：清掉限流/过载/临时摘除冷却（key 恢复额度、凭证修好后用） */
  const resetState = useCallback(async (row: Record<string, unknown>, reload: () => void) => {
    if (!window.confirm(`确认重置「${String(row['名称'] ?? '')}」的调度状态？将清除限流/过载/临时摘除冷却与失败计数。`)) return;
    try {
      await api.resetAiUpstreamState(String(row.id ?? ''));
      setMsg('已重置调度状态');
    } catch (e) {
      setMsg(`重置失败：${(e as Error).message}`);
    }
    reload();
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

  /** 单账号测试连接：比全量体检更精准 —— 只探这一个号，并回写健康状态 */
  const testOne = useCallback(async (row: Record<string, unknown>, reload: () => void) => {
    setMsg(`正在测试「${String(row['名称'] ?? '')}」…`);
    try {
      const r = await api.testAiUpstream(String(row.id ?? ''));
      setMsg(
        r.ok
          ? `「${String(row['名称'] ?? '')}」连接正常：HTTP ${r.status}，${r.latencyMs}ms，取到 ${r.modelCount} 个模型`
          : `「${String(row['名称'] ?? '')}」连接失败：${r.error || `HTTP ${r.status}`}`,
      );
    } catch (e) {
      setMsg(`测试失败：${(e as Error).message}`);
    }
    reload();
  }, []);

  const showStats = useCallback(async (row: Record<string, unknown>) => {
    try {
      setStats(await api.aiUpstreamStats(String(row.id ?? '')));
    } catch (e) {
      setMsg(`读取统计失败：${(e as Error).message}`);
    }
  }, []);

  const duplicate = useCallback(async (row: Record<string, unknown>, reload: () => void) => {
    if (!window.confirm(`确认复制「${String(row['名称'] ?? '')}」？新账号会带上同样的凭证与配置（额度与运行状态会清空）。`)) return;
    try {
      const r = await api.duplicateAiUpstream(String(row.id ?? ''));
      setMsg(`已复制为「${r.name}」`);
    } catch (e) {
      setMsg(`复制失败：${(e as Error).message}`);
    }
    reload();
  }, []);

  const runHealthCheck = useCallback(async (reload: () => void) => {
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
    reload();
  }, []);

  /** 批量动作：把选中行交给后端一次处理 */
  const doBulk = useCallback(
    async (action: string, rows: Record<string, unknown>[], patch: Record<string, unknown> = {}) => {
      const ids = rows.map((r) => String(r.id ?? '')).filter(Boolean);
      try {
        const r = await api.bulkAiUpstream(action, ids, patch);
        setMsg(`批量操作：${r.message}`);
      } catch (e) {
        setMsg(`批量操作失败：${(e as Error).message}`);
      }
    },
    [],
  );

  /** 额度批改需要先问一个数（window.prompt 够用，不值得为此加一个弹窗组件） */
  const askNumber = (title: string): number | null => {
    const v = window.prompt(title, '0');
    if (v === null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      setMsg('额度必须是不小于 0 的数字');
      return null;
    }
    return n;
  };

  const bulkActions = useMemo(
    () => [
      { label: '启用调度', run: (rows: Record<string, unknown>[]) => doBulk('enable-schedule', rows) },
      { label: '停止调度', run: (rows: Record<string, unknown>[]) => doBulk('disable-schedule', rows) },
      { label: '重置状态', run: (rows: Record<string, unknown>[]) => doBulk('reset-state', rows) },
      {
        label: '设日额度',
        run: (rows: Record<string, unknown>[]) => {
          const n = askNumber('把选中账号的「日额度 USD」设为多少？（0 = 不限）');
          return n === null ? undefined : doBulk('patch', rows, { 日额度USD: n });
        },
      },
      {
        label: '设月额度',
        run: (rows: Record<string, unknown>[]) => {
          const n = askNumber('把选中账号的「月额度 USD」设为多少？（0 = 不限）');
          return n === null ? undefined : doBulk('patch', rows, { 月额度USD: n });
        },
      },
      {
        label: '删除',
        danger: true,
        confirm: '确认删除选中的 {n} 个上游账号？此操作不可撤销。',
        run: (rows: Record<string, unknown>[]) => doBulk('delete', rows),
      },
    ],
    [doBulk],
  );

  /** 行内「可调度」开关：写完刷新，状态与「调度状态」都由后端重算 */
  const toggleSchedule = useCallback(async (row: Record<string, unknown>, next: string) => {
    try {
      await api.updateAiUpstream(String(row.id ?? ''), { 可调度: next });
      setMsg(`「${String(row['名称'] ?? '')}」已${next === '是' ? '恢复调度' : '停止调度'}`);
    } catch (e) {
      setMsg(`切换失败：${(e as Error).message}`);
    }
  }, []);

  return (
    <>
      {msg ? (
        <div style={{ fontSize: 'var(--font-xs)', color: /失败|异常/.test(msg) ? 'var(--fg-error)' : 'var(--fg-secondary)', marginBottom: 8 }}>
          {msg}
        </div>
      ) : null}
      <CrudPage
        title="AI 路由 · 上游账号"
        subtitle="各家厂商的真实账号与密钥（加密存储，列表只回显掩码）"
        search={{ placeholder: '搜索账号名称 / BaseURL / 备注…' }}
        columns={columns}
        moduleKey="aiUpstreams"
        statusField="状态"
        inlineEdit
        standaloneForm
        selection
        columnSettings
        autoRefresh={[10, 30, 60]}
        onInlineSwitch={(row, next) => toggleSchedule(row, next)}
        rowExtraActions={[
          { label: '测试连接', run: (row, reload) => testOne(row, reload) },
          { label: '查看统计', run: (row) => showStats(row) },
          { label: '查看凭证', run: (row) => showSecret(row) },
          { label: '复制账号', run: (row, reload) => duplicate(row, reload) },
          { label: '重置状态', run: (row, reload) => resetState(row, reload) },
        ]}
        bulkActions={bulkActions}
        extraActions={[{ label: checking ? '体检中…' : '立即体检', run: (reload) => runHealthCheck(reload) }]}
        api={{
          list: (p) => api.listAiUpstreams(p),
          create: (d) => api.createAiUpstream(d),
          update: (id, d) => api.updateAiUpstream(id, d),
          archive: (id) => api.deleteAiUpstream(id),
        }}
      />

      {secret ? (
        <div
          style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 16 }}
          onClick={() => setSecret(null)}
        >
          <div
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, width: 'min(560px, 100%)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, marginBottom: 8 }}>上游凭证（明文） · {secret.name}</div>
            <pre style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, maxHeight: 320, overflow: 'auto', fontSize: 'var(--font-xs)' }}>
              {secret.text}
            </pre>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 8 }}>
              ⚠️ 查看明文会写入操作日志；请勿复制到聊天工具或截图中。
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button className="btn btn-primary btn-sm" onClick={() => setSecret(null)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}

      {stats ? (
        <div
          style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 16 }}
          onClick={() => setStats(null)}
        >
          <div
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, width: 'min(680px, 100%)', maxHeight: '80vh', overflow: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, marginBottom: 12 }}>用量统计 · {stats.name}</div>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>时间窗</th><th>调用次数</th><th>Token</th><th>成本 USD</th></tr>
                </thead>
                <tbody>
                  {stats.windows.map((w) => (
                    <tr key={w.label}>
                      <td>{w.label}</td>
                      <td>{w.calls}</td>
                      <td>{w.tokens}</td>
                      <td>${w.costUsd.toFixed(6)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {stats.byModel.length ? (
              <>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', margin: '14px 0 6px' }}>
                  按上游模型（最多 20 条）
                </div>
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr><th>上游模型</th><th>调用次数</th><th>Token</th><th>成本 USD</th></tr>
                    </thead>
                    <tbody>
                      {stats.byModel.map((m) => (
                        <tr key={m.model}>
                          <td style={{ fontSize: 'var(--font-xs)' }}>{m.model}</td>
                          <td>{m.calls}</td>
                          <td>{m.tokens}</td>
                          <td>${m.costUsd.toFixed(6)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>这个账号还没有调用流水。</div>
            )}
            {stats.lastError ? (
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-error)', marginTop: 10 }}>最近失败：{stats.lastError}</div>
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn btn-primary btn-sm" onClick={() => setStats(null)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
