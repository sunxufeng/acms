'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import { usePermissions } from '../../lib/permissions';
// 查询条件下的下拉统一走全站组件（2026-09-22 第二批）：这里原本手写「标签：全部」来模仿统一长相
import { FilterSelect } from '../../components/FilterSelect';
import { modulePermission, REPORT_MODULE_KEYS, type ReportKey } from '@acms/contracts';
import {
  EnrollmentTrend,
  EmptyReport,
  GradeFlow,
  ProfileCompleteness,
  StudentOverview,
  distinct,
  val,
  type Drill,
  type Row,
} from '../../components/reports/panels';
import { ActivityPanel } from '../../components/reports/activity';
import { NotesPanel } from '../../components/reports/notes';
import { UsagePanel } from '../../components/reports/usage';
import { WeilingPanel } from '../../components/reports/weiling';
import { DedupPanel } from '../../components/reports/dedup';
import { AttendancePanel } from '../../components/reports/attendance';
import { ExamDistPanel, ExamGpaPanel } from '../../components/reports/exam';

interface ReportDef {
  key: string;
  label: string;
  desc: string;
  dims?: string;
  source?: string;
  href?: string;
  ready: boolean;
  /**
   * 查看这份报表所需的权限点（2026-09-19 起**每张报表一个**）。
   *
   * 为什么要有它：报表管理原先只有一个 `module:reports:read`，
   * 于是「能看学生结构概览」的人必然也能看成绩排名、考勤、活跃时段 —— 角色里区分不了。
   * 现在按报表授权：**角色里没勾这份报表的人，卡片根本不出现**（后端接口同样会 403，
   * 前端藏起来不算数 —— 接口可以直连）。
   *
   * 值来自 contracts 的 `REPORT_MODULE_KEYS`（单一真源），别在这里手写权限点字符串。
   * 三个「待业务数据录入」的占位卡指向别的模块页面，按**目标模块**的读权限显示。
   */
  perm?: string;
  /**
   * 查询条件分组：进报表后顶部显示哪一组公共筛选条件。
   * - 'students'：学生类报表共用（校区 / 当前年级 / 入学年份 / 是否新生）
   * - 'time'：时间类报表共用（起止日期 + 快捷区间）
   * 列表页不显示任何筛选条件（2026-09-11 调整）。
   */
  group?: 'students' | 'time' | 'weiling';
}

/** 报表权限点（`module:reportXxx:read`）—— 从 contracts 派生，避免与后端漂移 */
const R = (k: ReportKey) => modulePermission(REPORT_MODULE_KEYS[k], 'read');

/** 报表清单：ready=true 的已有数据支撑，false 的等对应业务表录入后自动出图 */
const REPORTS: ReportDef[] = [
  { key: 'overview', perm: R('overview'), label: '学生结构概览', desc: '在校人数、性别比、新生占比等核心指标', dims: '年级 · 性别 · 入学年份', ready: true, group: 'students' },
  { key: 'gradeFlow', perm: R('gradeFlow'), label: '年级升级流向', desc: '入学年级与当前年级对比，看学生升级流动', dims: '条形图 · 变化表', ready: true, group: 'students' },
  { key: 'trend', perm: R('trend'), label: '入学趋势', desc: '按入学年份/学期看招生规模变化', dims: '柱状图 · 导出', ready: true, group: 'students' },
  { key: 'completeness', perm: R('completeness'), label: '档案完整度', desc: '按字段统计缺失率，定位待补录的字段与学生', dims: '缺失排行 · 导出', ready: true, group: 'students' },
  {
    key: 'weiling', perm: R('weiling'),
    label: '招生分析',
    desc: '卫瓴线索多维度分析：阶段 / 归属人 / 渠道 / 活动 / 漏斗 / 趋势',
    dims: '8 个分析区块 · 支持下钻',
    ready: true,
    group: 'weiling',
  },
  {
    // 不设 group：本报表自带筛选栏（置信等级 / 渠道 / 归属人），
    // 不需要学生类或时间类的公共查询条件。
    key: 'dedup', perm: R('dedup'),
    label: '联系人去重',
    desc: '疑似同一个人的多条联系人记录：按置信度分组 + 列出证据 + 标注建议保留，可导出清单去卫瓴合并',
    dims: '分组 · 证据 · 导出 CSV',
    ready: true,
  },
  { key: 'notes', perm: R('notes'), label: '笔记统计', desc: '按人统计某段时间新增多少笔记、转了多少次', dims: '按人 · 来源 · 模块 · 趋势', ready: true, group: 'time' },
  {
    key: 'usage', perm: R('usage'),
    label: '使用统计',
    desc: '谁在用、用了多少：学生记录 / 招生跟进 / 我的笔记 / 系统操作 / 会议纪要 五个模块的用量汇总',
    dims: '按人 × 维度矩阵 · 跨 5 个模块',
    ready: true,
    group: 'time',
  },
{ key: 'activity', perm: R('activity'), label: '活跃时段', desc: '按人统计什么时间登录、什么时间有操作', dims: '人 × 小时热力 · 趋势', ready: true, group: 'time' },
  {
    // 不设 group：本报表自带筛选栏（起止日期 / 班级 / 年级），
    // 公共的「学生类」条件（校区/入学年份…）对它无意义。
    key: 'attendance', perm: R('attendance'),
    label: '考勤分析',
    desc: '出勤率、迟到/请假/缺勤次数排行与趋势；只统计已通过终态、计入统计的考勤记录',
    dims: '班级 · 年级 · 学生排行 · 按日/周趋势',
    ready: true,
  },
  {
    // 不设 group：本报表自带筛选栏（批次 / 班级 / 科目）。
    // 公共的「学生类」条件（校区 / 入学年份）对成绩报表无意义 —— 成绩是按批次看的。
    key: 'examDist', perm: R('examDist'),
    label: '考试成绩分布',
    desc: '按批次 × 班级 × 科目看均分、中位数、及格率、达标率与等级 / 分数段分布',
    dims: '分数段 · 等级 · 按科目 · 前/后 10 名',
    ready: true,
  },
  {
    key: 'examGpa', perm: R('examGpa'),
    label: 'GPA 与班级排名',
    desc: '按学生聚合加权 / 不加权 GPA，给出总排名与班内排名、GPA 分布',
    dims: '排名榜 · GPA 分布',
    ready: true,
  },
  { key: 'grades', perm: 'module:grades:read', label: '学业成绩', desc: '按学科/学期统计均分、及格率、等级分布', source: '学业成绩表', ready: false, href: '/grades' },
  { key: 'comms', perm: 'module:studentRecords:read', label: '家校沟通', desc: '沟通次数、闭环率、超期未闭环预警', source: '学生记录表（类型=家校沟通）', ready: false, href: '/student-records?type=' + encodeURIComponent('家校沟通') },
  { key: 'evaluation', perm: 'module:stageEvaluations:read', label: '阶段评价', desc: '评价等级分布、按周期变化趋势', source: '阶段评价表', ready: false, href: '/stage-evaluations' },
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
  /**
   * 报表清单按**角色权限**过滤（2026-09-19）：角色里没勾这份报表的，卡片根本不出现。
   *
   * ⚠️ 只是「不显示」，真正的门控在服务端（`ReportsService` 每个接口按报表权限点判定）
   * —— 前端藏起来不算数，接口可以直连。
   */
  const perms = usePermissions();
  const visibleReports = useMemo(
    () => REPORTS.filter((r) => !r.perm || perms.includes(r.perm)),
    [perms],
  );
  const router = useRouter();
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
  const activeReport = visibleReports.find((r) => r.key === active) ?? null;

  /**
   * 下钻到学生列表（报表里凡是有「人数」的地方都能点进去看名单）。
   * 必须带上报表当前的查询条件，否则列表会显示全部学生 —— 报表里的数字是
   * 「筛选后的这批人」，下钻也该是同一批。
   */
  const drill: Drill = (extra) => {
    const merged: Record<string, string> = {};
    for (const k of FILTER_KEYS) if (filters[k]) merged[k] = filters[k];
    for (const [k, v] of Object.entries(extra)) if (v) merged[k] = v;
    router.push(`/students?${new URLSearchParams(merged).toString()}`);
  };

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
        {activeReport ? tl(activeReport.desc) : `${tl('学生维度统计报表')} · ${visibleReports.filter((r) => r.ready).length} ${tl('张可用')}`}
      </p>

      {/* 查询条件：只在进入具体报表后显示（列表页不显示），按报表分组共用同一套条件 */}
      {activeReport?.group === 'students' ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: '1.25rem' }}>
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{tl('查询条件')}</span>
          {FILTER_KEYS.map((k) => (
            <FilterSelect
              key={k}
              label={tl(k)}
              value={filters[k] ?? ''}
              onChange={(v) => setFilters((f) => ({ ...f, [k]: v }))}
              options={distinct(all ?? [], k)}
            />
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
      ) : visibleReports.length === 0 ? (
        /**
         * 一张报表权限都没有时的空态。
         *
         * 为什么要专门写：报表改成**按报表授权**后，「进入报表管理」与「能看到某张报表」
         * 是两件事（前者是 `module:reports:read`）。管理员若只勾了菜单、没勾任何报表，
         * 页面就会**空白且没有任何解释** —— 那看起来像系统坏了。
         */
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '18px 20px',
            background: 'var(--bg-subtle)',
            fontSize: 'var(--font-sm)',
            color: 'var(--fg-secondary)',
            lineHeight: 1.7,
          }}
        >
          <div style={{ fontWeight: 500, marginBottom: 6 }}>{tl('暂无可用报表')}</div>
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
            {tl('报表已改为按报表授权：请联系系统管理员，在「角色管理」里为你的角色勾选需要的报表。')}
          </div>
        </div>
      ) : activeReport ? (
        /* 报表详情 */
        <div>
          {active === 'overview' ? <StudentOverview rows={rows} drill={drill} /> : null}
          {active === 'gradeFlow' ? <GradeFlow rows={rows} drill={drill} /> : null}
          {active === 'trend' ? <EnrollmentTrend rows={rows} drill={drill} /> : null}
          {active === 'completeness' ? <ProfileCompleteness rows={rows} /> : null}
          {active === 'weiling' ? <WeilingPanel /> : null}
          {active === 'dedup' ? <DedupPanel /> : null}
          {active === 'notes' ? <NotesPanel from={from} to={to} /> : null}
          {active === 'usage' ? <UsagePanel from={from} to={to} /> : null}
          {active === 'activity' ? <ActivityPanel from={from} to={to} /> : null}
          {active === 'examDist' ? <ExamDistPanel /> : null}
          {active === 'examGpa' ? <ExamGpaPanel /> : null}
          {active === 'attendance' ? <AttendancePanel /> : null}
          {!activeReport.ready ? (
            <EmptyReport name={tl(activeReport.label)} source={tl(activeReport.source ?? '')} href={activeReport.href} />
          ) : null}
        </div>
      ) : (
        /* 报表卡片网格 */
        <>
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', marginBottom: 8 }}>
            {tl('可出报表')}（{visibleReports.filter((r) => r.ready).length}）
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12, marginBottom: '1.5rem' }}>
            {visibleReports.filter((r) => r.ready).map((r) => (
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
            {visibleReports.filter((r) => !r.ready).map((r) => (
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
