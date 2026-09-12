'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import {
  EnrollmentTrend,
  EmptyReport,
  GradeFlow,
  ProfileCompleteness,
  StudentOverview,
  distinct,
  val,
  type Row,
} from '../../components/reports/panels';
import { ActivityPanel } from '../../components/reports/activity';
import { NotesPanel } from '../../components/reports/notes';
import { WeilingPanel } from '../../components/reports/weiling';

interface ReportDef {
  key: string;
  label: string;
  desc: string;
  dims?: string;
  source?: string;
  href?: string;
  ready: boolean;
  /**
   * 查询条件分组：进报表后顶部显示哪一组公共筛选条件。
   * - 'students'：学生类报表共用（校区 / 当前年级 / 入学年份 / 是否新生）
   * - 'time'：时间类报表共用（起止日期 + 快捷区间）
   * 列表页不显示任何筛选条件（2026-09-11 调整）。
   */
  group?: 'students' | 'time' | 'weiling';
}

/** 报表清单：ready=true 的已有数据支撑，false 的等对应业务表录入后自动出图 */
const REPORTS: ReportDef[] = [
  { key: 'overview', label: '学生结构概览', desc: '在校人数、性别比、新生占比等核心指标', dims: '年级 · 性别 · 入学年份', ready: true, group: 'students' },
  { key: 'gradeFlow', label: '年级升级流向', desc: '入学年级与当前年级对比，看学生升级流动', dims: '条形图 · 变化表', ready: true, group: 'students' },
  { key: 'trend', label: '入学趋势', desc: '按入学年份/学期看招生规模变化', dims: '柱状图 · 导出', ready: true, group: 'students' },
  { key: 'completeness', label: '档案完整度', desc: '按字段统计缺失率，定位待补录的字段与学生', dims: '缺失排行 · 导出', ready: true, group: 'students' },
  {
    key: 'weiling',
    label: '招生分析',
    desc: '卫瓴线索多维度分析：阶段 / 归属人 / 渠道 / 活动 / 漏斗 / 趋势',
    dims: '8 个分析区块 · 支持下钻',
    ready: true,
    group: 'weiling',
  },
  { key: 'notes', label: '笔记统计', desc: '按人统计某段时间新增多少笔记、转了多少次', dims: '按人 · 来源 · 模块 · 趋势', ready: true, group: 'time' },
{ key: 'activity', label: '活跃时段', desc: '按人统计什么时间登录、什么时间有操作', dims: '人 × 小时热力 · 趋势', ready: true, group: 'time' },
  { key: 'attendance', label: '考勤分析', desc: '出勤率、迟到/请假/缺勤次数排行与趋势', source: '考勤记录表', ready: false, href: '/student-attendances' },
  { key: 'grades', label: '学业成绩', desc: '按学科/学期统计均分、及格率、等级分布', source: '学业成绩表', ready: false, href: '/grades' },
  { key: 'comms', label: '家校沟通', desc: '沟通次数、闭环率、超期未闭环预警', source: '家校沟通表', ready: false, href: '/home-school-comms' },
  { key: 'evaluation', label: '阶段评价', desc: '评价等级分布、按周期变化趋势', source: '阶段评价表', ready: false, href: '/stage-evaluations' },
];

const FILTER_KEYS = ['校区', '当前年级', '入学年份', '是否是新生'] as const;

function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function ReportsPage() {
  const tl = useTl();
  const [all, setAll] = useState<Row[] | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  // 时间类报表（笔记统计 / 活跃时段）共用的查询条件
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(todayISO());
  const [active, setActive] = useState<string | null>(null);

  // 报表专用接口（权限点 report:read）：后端完成翻页与脱敏投影，前端一次取全量
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.listReportStudents();
        if (alive) setAll((res.items ?? []) as Row[]);
      } catch {
        if (alive) setAll([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const rows = useMemo(() => {
    const src = all ?? [];
    return src.filter((r) =>
      FILTER_KEYS.every((k) => !filters[k] || val(r, k) === filters[k]),
    );
  }, [all, filters]);

  const total = all?.length ?? 0;
  const activeReport = REPORTS.find((r) => r.key === active) ?? null;

  const selectStyle: React.CSSProperties = { minWidth: 130, fontSize: 'var(--font-sm)' };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        {active ? (
          <button
            className="btn btn-icon"
            title={tl('返回')}
            aria-label={tl('返回')}
            onClick={() => setActive(null)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        ) : null}
        <div>
          <div className="page-eyebrow">REPORTS{activeReport ? ` / ${activeReport.key}` : ''}</div>
          <h1 className="page-title">{activeReport ? tl(activeReport.label) : tl('报表管理')}</h1>
        </div>
      </div>
      <p style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', margin: '0 0 1rem' }}>
        {activeReport ? tl(activeReport.desc) : `${tl('学生维度统计报表')} · ${REPORTS.filter((r) => r.ready).length} ${tl('张可用')}`}
      </p>

      {/* 查询条件：只在进入具体报表后显示（列表页不显示），按报表分组共用同一套条件 */}
      {activeReport?.group === 'students' ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: '1.25rem' }}>
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{tl('查询条件')}</span>
          {FILTER_KEYS.map((k) => (
            <select
              key={k}
              className="form-input"
              style={selectStyle}
              value={filters[k] ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, [k]: e.target.value }))}
            >
              <option value="">{`${tl(k)}：${tl('全部')}`}</option>
              {distinct(all ?? [], k).map((o) => (
                <option key={o} value={o}>{tl(o)}</option>
              ))}
            </select>
          ))}
          <button className="btn btn-outline" onClick={() => setFilters({})}>{tl('重置')}</button>
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
            {tl('筛选后')} {rows.length} / {total} {tl('人')}
          </span>
        </div>
      ) : null}

      {activeReport?.group === 'time' ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: '1.25rem' }}>
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{tl('查询条件')}</span>
          <input type="date" className="form-input" style={selectStyle} value={from} onChange={(e) => setFrom(e.target.value)} />
          <span style={{ color: 'var(--fg-tertiary)' }}>至</span>
          <input type="date" className="form-input" style={selectStyle} value={to} onChange={(e) => setTo(e.target.value)} />
          <button className="btn btn-ghost" onClick={() => { setFrom(daysAgo(6)); setTo(todayISO()); }}>{tl('近 7 天')}</button>
          <button className="btn btn-ghost" onClick={() => { setFrom(daysAgo(29)); setTo(todayISO()); }}>{tl('近 30 天')}</button>
          <button className="btn btn-ghost" onClick={() => { setFrom(daysAgo(89)); setTo(todayISO()); }}>{tl('近 90 天')}</button>
        </div>
      ) : null}

      {all === null ? (
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>{tl('加载中')}…</div>
      ) : activeReport ? (
        /* 报表详情 */
        <div>
          {active === 'overview' ? <StudentOverview rows={rows} /> : null}
          {active === 'gradeFlow' ? <GradeFlow rows={rows} /> : null}
          {active === 'trend' ? <EnrollmentTrend rows={rows} /> : null}
          {active === 'completeness' ? <ProfileCompleteness rows={rows} /> : null}
          {active === 'weiling' ? <WeilingPanel /> : null}
          {active === 'notes' ? <NotesPanel from={from} to={to} /> : null}
          {active === 'activity' ? <ActivityPanel from={from} to={to} /> : null}
          {!activeReport.ready ? (
            <EmptyReport name={tl(activeReport.label)} source={tl(activeReport.source ?? '')} href={activeReport.href} />
          ) : null}
        </div>
      ) : (
        /* 报表卡片网格 */
        <>
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', marginBottom: 8 }}>
            {tl('可出报表')}（{REPORTS.filter((r) => r.ready).length}）
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12, marginBottom: '1.5rem' }}>
            {REPORTS.filter((r) => r.ready).map((r) => (
              <div
                key={r.key}
                onClick={() => setActive(r.key)}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '14px 16px',
                  background: 'var(--bg-elevated)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                  <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500 }}>{tl(r.label)}</div>
                  <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{total}</span>
                </div>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', minHeight: 32 }}>{tl(r.desc)}</div>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', opacity: 0.8 }}>{tl(r.dims ?? '')}</div>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', marginBottom: 8 }}>
            {tl('待业务数据录入')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
            {REPORTS.filter((r) => !r.ready).map((r) => (
              <div
                key={r.key}
                onClick={() => setActive(r.key)}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '14px 16px',
                  background: 'var(--bg-subtle)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                  <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500 }}>{tl(r.label)}</div>
                  <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>0 {tl('条')}</span>
                </div>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', minHeight: 32 }}>{tl(r.desc)}</div>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', opacity: 0.8 }}>{tl(r.source ?? '')}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
