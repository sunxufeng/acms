'use client';

import { useEffect, useMemo, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

/**
 * AI 路由 · 上游代理。
 *
 * 上游 API（OpenAI / Anthropic / Gemini）在国内多数直连不通，需要从代理出去。
 * 账号在上游表单里选一个代理即可；网关请求时会走 HTTP 代理隧道（https 目标是 CONNECT + TLS）。
 *
 * 字段含义：
 *  - 密码同样是加密存储，列表只回显掩码
 *  - 「到期时间」只作提醒，不会自动停用；到期提醒天数用于列表高亮
 *  - 「备用代理」是留的扩展位：主代理不可用时切过去（本期仅登记，切换需手工确认）
 */
function buildColumns(proxyOptions: { value: string; label: string }[]): CrudColumn[] {
  return [
    { key: '名称', label: '名称', width: '140px', form: true, required: true, filter: true, filterType: 'text', listOrder: 1 },
    {
      key: '协议',
      label: '协议',
      width: '90px',
      form: true,
      type: 'select',
      dictKey: '代理协议',
      filter: true,
      filterOptions: ['http', 'https', 'socks5'],
      listOrder: 2,
      hint: 'socks5 暂不支持（网关会明确报错，避免静默直连暴露真实 IP）',
      render: (v) => {
        const s = String(v ?? '');
        const warn = s === 'socks5';
        return (
          <span style={{ fontSize: 'var(--font-xs)', color: warn ? '#b3261e' : 'var(--fg-secondary)' }}>
            {s || '—'}
            {warn ? '（不支持）' : ''}
          </span>
        );
      },
    },
    {
      key: '主机',
      label: '主机:端口',
      width: '200px',
      form: true,
      required: true,
      render: (_v, row) => (
        <span style={{ fontSize: 'var(--font-xs)' }}>
          {String(row['主机'] ?? '')}:{String(row['端口'] ?? '')}
        </span>
      ),
    },
    {
      key: '状态',
      label: '状态',
      width: '80px',
      form: true,
      type: 'select',
      dictKey: '代理状态',
      filter: true,
      filterOptions: ['启用', '停用'],
      listOrder: 5,
    },
    {
      key: '到期时间',
      label: '到期时间',
      width: '130px',
      render: (v, row) => {
        const n = Number(v ?? 0);
        if (!n) return <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-xs)' }}>长期</span>;
        const warnDays = Number(row['到期提醒天数'] ?? 7);
        const leftDays = Math.floor((n - Date.now()) / 86_400_000);
        const soon = leftDays <= warnDays;
        const d = new Date(n);
        const p = (x: number) => String(x).padStart(2, '0');
        return (
          <span style={{ fontSize: 'var(--font-xs)', color: leftDays < 0 ? '#b3261e' : soon ? '#7a5c10' : 'var(--fg-secondary)' }}>
            {`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`}
            {leftDays < 0 ? '（已过期）' : soon ? `（剩 ${leftDays} 天）` : ''}
          </span>
        );
      },
    },
    {
      key: '端口',
      label: '端口',
      list: false,
      form: true,
      type: 'number',
      required: true,
    },
    { key: '用户名', label: '用户名', list: false, form: true, type: 'text' },
    {
      key: '密码',
      label: '密码',
      list: false,
      form: true,
      type: 'password',
      hint: '加密存储；编辑时留空或保持 ****** 表示不修改',
    },
    { key: '到期提醒天数', label: '到期提醒天数', list: false, form: true, type: 'number', hint: '列表里提前多少天开始标黄' },
    {
      key: '备用代理',
      label: '备用代理',
      list: false,
      form: true,
      type: 'link',
      linkOptions: proxyOptions,
      hint: '主代理不可用时的手工切换目标（本期仅登记）',
    },
    { key: '备注', label: '备注', list: false, form: true, type: 'textarea' },
  ];
}

export default function AiProxiesPage() {
  const [proxies, setProxies] = useState<{ value: string; label: string }[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .listAiProxies({ pageSize: '200' })
      .then((p) => {
        if (!alive) return;
        setProxies((p.items ?? []).map((x) => ({ value: String(x.id ?? ''), label: String(x['名称'] ?? '') })));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const columns = useMemo(() => buildColumns(proxies), [proxies]);

  return (
    <CrudPage
      title="AI 路由 · 上游代理"
      subtitle="国内直连不通时，给上游账号挂一个代理；网关请求会走 HTTP 代理隧道（https 为 CONNECT + TLS）"
      search={{ placeholder: '搜索代理名称…' }}
      columns={columns}
      moduleKey="aiProxies"
      statusField="状态"
      inlineEdit
      standaloneForm
      api={{
        list: (p) => api.listAiProxies(p),
        create: (d) => api.createAiProxy(d),
        update: (id, d) => api.updateAiProxy(id, d),
        archive: (id) => api.deleteAiProxy(id),
      }}
    />
  );
}
