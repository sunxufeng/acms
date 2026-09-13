'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import CrudPage from '../../components/CrudPage';
import type { CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS } from './columns';

export default function WeilingContactsPage() {
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [status, setStatus] = useState<{ lastSyncAt: number; count: number } | null>(null);
  const [pgMsg, setPgMsg] = useState('');
  const [pgRunning, setPgRunning] = useState(false);
  const [rcMsg, setRcMsg] = useState('');
  const [rcRunning, setRcRunning] = useState(false);
  const [lostMsg, setLostMsg] = useState('');
  const [lostRunning, setLostRunning] = useState(false);
  const [lostProgress, setLostProgress] = useState<{ scanned: number; total: number } | null>(null);
  const [options, setOptions] = useState<Record<string, string[]>>({});
  /**
   * 报表下钻进来的隐藏条件（没有对应筛选控件，用户看不到就会以为「筛选没生效」）。
   * 这里把读数显示出来，并提供一键清除。
   */
  const [drillChips, setDrillChips] = useState<{ label: string; value: string }[]>([]);
  const DRILL_LABELS: Record<string, string> = {
    来源组件: '来源组件',
    follower: '跟进人',
    最近跟进时间_from: '最近跟进起',
    最近跟进时间_to: '最近跟进止',
    dim: '自定义字段',
    dimval: '字段值',
    // KPI 卡片下钻带上来的条件
    创建时间_from: '创建时间起',
    创建时间_to: '创建时间止',
    关联学生__notempty: '已匹配在校生',
    关联学生__empty: '未匹配在校生',
    跟进次数__gt: '有跟进记录',
  };
  /** chip 的展示值：`__notempty` / `__empty` / `__gt` 这类是标记位，写出来反而让人困惑 */
  const chipValue = (k: string, v: string): string => {
    if (/__(notempty|empty)$/.test(k)) return '';
    if (k === '跟进次数__gt') return '≥1 次';
    return v;
  };
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const chips: { label: string; value: string }[] = [];
    for (const [k, label] of Object.entries(DRILL_LABELS)) {
      const v = qs.get(k);
      if (v) chips.push({ label, value: chipValue(k, v) });
    }
    setDrillChips(chips);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.weilingSyncStatus();
      setStatus({ lastSyncAt: s.lastSyncAt, count: s.count });
    } catch {
      /* 未授权时静默 */
    }
  }, []);

  /**
   * 筛选下拉选项：由后端按本地联系人表的**实际取值** distinct 出
   * 「客户阶段 / 来源渠道 / 归属人」，并用字段描述里的枚举顺序排序
   * （潜在客户 → 适龄 → 面访 → 面试 → 成交）。
   *
   * ⚠️ 历史坑（2026-09-13 用户反馈「下拉显示的是数字」）：
   *   原先阶段/渠道用 `weilingFields()` 的枚举，但那套 options 的结构是
   *   `{ label: '数字编码', value: '中文名' }` —— 取 `label` 就把数字渲染进了下拉框；
   *   而「归属人」是从列表前 4 页凑 distinct，联系人 3500+ 条时覆盖不全。
   *   ⇒ 现在统一走后端接口，取值与表里一致（选了就能筛出数据）。
   */
  useEffect(() => {
    void api
      .weilingContactFilterOptions()
      .then((opts) => setOptions(opts ?? {}))
      .catch(() => undefined);
    void loadStatus();
  }, [loadStatus]);

  const columns: CrudColumn[] = useMemo(
    () =>
      COLUMNS.map((c) => (options[c.key]?.length ? { ...c, filterOptions: options[c.key] } : c)),
    [options],
  );

  const sync = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const r = await api.weilingSync(true);
      setSyncMsg(r.ok ? `已同步 ${r.count} 条联系人` : `同步失败：${r.message ?? '未知原因'}`);
      if (r.ok) {
        await loadStatus();
        // 刷新列表：CrudPage 内部自管数据，这里用一次路由外的轻量手段 —— 重新取选项并强制重渲染
        window.location.reload();
      }
    } catch (e) {
      setSyncMsg(`同步失败：${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  const syncProgress = async () => {
    setPgRunning(true);
    setPgMsg('已在后台开始同步（约需十几分钟），可稍后刷新查看');
    try {
      const r = await api.syncWeilingProgress(true);
      if (!r.ok) setPgMsg(`启动失败：${r.message ?? ''}`);
    } catch (e) {
      setPgMsg(`启动失败：${(e as Error).message}`);
    } finally {
      setPgRunning(false);
    }
  };

  /**
   * 重算「跟进次数」。
   *
   * 该字段是跟进记录同步时写回的**缓存快照**，会与跟进记录表漂移 ——
   * 症状是「联系人详情里明明有跟进记录，列表却显示 —」，报表的「被跟进线索」也对不上。
   * 这里按跟进记录表为准全量重算，只写不一致的行，不访问上游。
   */
  const recountFollows = async () => {
    setRcRunning(true);
    setRcMsg('');
    try {
      const r = await api.recountWeilingFollows();
      setRcMsg(`已重算：扫描 ${r.scanned} 条，修正 ${r.fixed} 条`);
    } catch (e) {
      setRcMsg(`重算失败：${(e as Error).message}`);
    } finally {
      setRcRunning(false);
    }
  };

  /**
   * 流失状态同步：走的是卫瓴**客户**接口（联系人接口不返回这个字段），
   * 逐个联系人查，约 5 分钟。后台跑，这里只负责启动 + 轮询进度。
   */
  const syncLost = async () => {
    setLostRunning(true);
    setLostMsg('');
    setLostProgress({ scanned: 0, total: 0 });
    try {
      const r = await api.syncWeilingLost();
      if (!r.ok) {
        setLostMsg(`启动失败：${r.message ?? ''}`);
        setLostRunning(false);
        return;
      }
      // 轮询进度（与跟进记录同步同一套做法）
      for (let i = 0; i < 240; i += 1) {
        await new Promise((res) => setTimeout(res, 3000));
        const s = await api.weilingSyncStatus();
        const l = s.lost;
        if (!l) continue;
        setLostProgress({ scanned: l.scanned, total: l.total });
        if (!l.running) {
          setLostMsg(`完成：已流失 ${l.lost}、未流失 ${l.kept}${l.skipped ? `、查不到 ${l.skipped}` : ''}${l.error ? `（${l.error}）` : ''}`);
          setLostRunning(false);
          setLostProgress(null);
          return;
        }
      }
      setLostMsg('仍在后台进行中，稍后刷新查看');
      setLostRunning(false);
      setLostProgress(null);
    } catch (e) {
      setLostMsg(`启动失败：${(e as Error).message}`);
      setLostRunning(false);
      setLostProgress(null);
    }
  };

  const lastSyncText = status?.lastSyncAt
    ? new Date(status.lastSyncAt).toLocaleString('zh-CN', { hour12: false })
    : '从未同步';

  return (
    <div>
      {/* 同步条：数据来自卫瓴，需明确告知新鲜度 */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
          marginBottom: '1rem',
          padding: '10px 14px',
          background: 'var(--bg-subtle, #faf9f6)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          fontSize: 'var(--font-sm)',
          color: 'var(--fg-secondary)',
        }}
      >
        <span>数据来源：卫瓴 SCRM（只读，不可修改）</span>
        <span style={{ color: 'var(--fg-tertiary)' }}>最后同步：{lastSyncText}</span>
        {status?.count ? <span style={{ color: 'var(--fg-tertiary)' }}>共 {status.count} 条</span> : null}
        <button
          className="btn btn-outline btn-sm"
          disabled={pgRunning}
          onClick={() => void syncProgress()}
        >
          {pgRunning ? '同步中…' : '同步跟进记录'}
        </button>
        <button className="btn btn-outline btn-sm" disabled={rcRunning} onClick={() => void recountFollows()}>
          {rcRunning ? '重算中…' : '重算跟进次数'}
        </button>
        <button className="btn btn-outline btn-sm" disabled={lostRunning} onClick={() => void syncLost()}>
          {lostRunning
            ? `同步流失状态 ${lostProgress?.total ? `${lostProgress.scanned}/${lostProgress.total}` : '…'}`
            : '同步流失状态'}
        </button>
        <button className="btn btn-primary btn-sm" disabled={syncing} onClick={() => void sync()} style={{ marginLeft: 'auto' }}>
          {syncing ? '同步中…' : '立即同步'}
        </button>
        {syncMsg ? (
          <span style={{ color: syncMsg.includes('失败') ? 'var(--fg-error)' : 'var(--fg-secondary)' }}>{syncMsg}</span>
        ) : null}
        {pgMsg ? (
          <span style={{ color: pgMsg.includes('失败') ? 'var(--fg-error)' : 'var(--fg-secondary)' }}>{pgMsg}</span>
        ) : null}
        {rcMsg ? (
          <span style={{ color: rcMsg.includes('失败') ? 'var(--fg-error)' : 'var(--fg-secondary)' }}>{rcMsg}</span>
        ) : null}
        {lostMsg ? (
          <span style={{ color: lostMsg.includes('失败') ? 'var(--fg-error)' : 'var(--fg-secondary)' }}>{lostMsg}</span>
        ) : null}
      </div>

      {drillChips.length > 0 ? (
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            marginBottom: '0.75rem',
            padding: '8px 12px',
            background: 'var(--bg-subtle, #faf9f6)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            fontSize: 'var(--font-sm)',
            color: 'var(--fg-secondary)',
          }}
        >
          <span style={{ color: 'var(--fg-tertiary)' }}>来自报表的下钻条件：</span>
          {drillChips.map((c) => (
            <span
              key={c.label}
              style={{ padding: '2px 8px', borderRadius: 8, background: 'var(--bg-hover)', fontSize: 'var(--font-xs)' }}
            >
              {c.label}：{c.value}
            </span>
          ))}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              // 直接整页刷新：CrudPage 的筛选状态也要一起清掉
              window.location.assign('/weiling-contacts');
            }}
          >
            清除
          </button>
        </div>
      ) : null}

      <CrudPage
        title="联系人管理"
        subtitle="卫瓴 SCRM 联系人（只读副本，按天自动同步）"
        search={{ placeholder: '搜索姓名 / 手机号 / 企业…' }}
        columns={columns}
        moduleKey="weilingContacts"
        // 只读：数据来自卫瓴，这里不提供任何写入能力
        readonly
        hideCreate
        // 只读列表没有行内动作，「操作」列只剩一个空单元格，白占 150px
        hideActions
        // 「疑似关联学生」是按姓名匹配出来的（不是 link），显式声明后
        // CrudPage 会注入 __studentEnglish，让该列显示「中文名 / 英文名」
        studentNameKeys={['关联学生']}
        detailHref={(id) => `/weiling-contacts/${id}`}
        rangeFilters={[{ key: 'createTime', label: '创建时间', fromParam: 'from', toParam: 'to' }]}
        // 报表下钻用的隐藏条件：没有筛选控件，但必须透传给列表接口
        //  · 关联学生__notempty  —— 「已匹配在校生」下钻（关联学生非空）
        //  · 跟进次数__gt=0     —— 「跟进记录」下钻（被跟进过的联系人）
        //  · 创建时间_from/_to  —— 「本月新增」下钻（与顶部 from/to 的 rangeField 是两回事：
        //                          顶部筛选作用于「创建时间」，这里也是，两者 AND 生效）
        passthroughParams={[
          '来源组件',
          'dim',
          'dimval',
          'follower',
          '最近跟进时间_from',
          '最近跟进时间_to',
          '关联学生__notempty',
          '关联学生__empty',
          '跟进次数__gt',
          '创建时间_from',
          '创建时间_to',
        ]}

        api={{
          list: (p) => api.listWeilingContacts(p),
        }}
      />
    </div>
  );
}
