'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  api,
  type AttendanceBucketRow,
  type AttendanceReportPayload,
  type AttendanceStudentRow,
  type AttendanceTrendPoint,
} from '../../lib/api';
import { useTl } from '../../lib/useTl';
import { ColumnChart, EmptyData, MetricCard, MetricRow, Panel, SimpleTable } from './charts';

/**
 * 考勤分析报表（/reports 第 8 张）。
 *
 * 口径的唯一真源在后端 `apps/api/src/reports/attendance-rate.ts`：
 *   · 只统计**已通过终态**的考勤记录 → 未审核的记录单独计数，不进分子分母；
 *   · 「计入统计=否」的考勤码整条排除；
 *   · 方向=在校 计「实到」，不在校 计「未出勤」（语义范围=离校 记请假，其余记缺勤）。
 * 页面底部的「口径说明」必须与它一致，改口径时两处一起改。
 *
 * 空数据（考勤记录表 0 行）时返回 0 值结构 + 空态提示，不报错、不白屏。
 */

/** 下钻到考勤列表时继承的筛选参数（列表侧 CrudPage 认这几类） */
const DRILL_DATE_FROM = 'from';
const DRILL_DATE_TO = 'to';
/** 按学生下钻：考勤列表的「关联学生编号」是 link 字段，用 `__has` 成员匹配才筛得到 */
const DRILL_STUDENT = '关联学生编号__has';

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

function pct(v: number): string {
  return `${v}%`;
}

export function AttendancePanel() {
  const tl = useTl();
  const router = useRouter();

  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(todayISO());
  const [cls, setCls] = useState('');
  const [grade, setGrade] = useState('');

  const [data, setData] = useState<AttendanceReportPayload | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.reportAttendance({ from, to, class: cls || undefined, grade: grade || undefined });
      setData(res);
      setErr('');
    } catch (e) {
      setErr((e as Error).message || tl('加载失败'));
    } finally {
      setLoading(false);
    }
  }, [from, to, cls, grade, tl]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 下钻：带当前报表条件跳到「学生考勤」列表看名单。
   * 只在该桶**恰好对应一个可等值筛选的值**时才给链接 —— 列表侧是多条件与关系、
   * 每个字段只能等值筛一个值，多值桶（如「实到」含出勤/迟到/早退）筛不出来，
   * 宁可不给链接，也不给一个数字对不上的链接。
   */
  const drill = useCallback(
    (extra: Record<string, string>) => {
      const q: Record<string, string> = {};
      if (from) q[DRILL_DATE_FROM] = from;
      if (to) q[DRILL_DATE_TO] = to;
      for (const [k, v] of Object.entries(extra)) if (v) q[k] = v;
      router.push(`/student-attendances?${new URLSearchParams(q).toString()}`);
    },
    [from, to, router],
  );

  /** 单值桶 → 可下钻（返回 undefined 表示不给链接） */
  const singleDrill = useCallback(
    (values: string[] | undefined, extraKey = '考勤结果'): (() => void) | undefined => {
      if (!values || values.length !== 1) return undefined;
      const v = values[0] as string;
      return () => drill({ [extraKey]: v });
    },
    [drill],
  );

  const s = data?.summary;
  const maxDay = useMemo(() => {
    const days = data?.byDay ?? [];
    if (!days.length) return [];
    // 日趋势最多画最近 60 天，避免长区间把柱子挤成线
    return days.slice(-60);
  }, [data]);

  const classRows = useMemo(
    () => (data?.byClass ?? []).map(bucketRow),
    [data],
  );
  const gradeRows = useMemo(
    () => (data?.byGrade ?? []).map(bucketRow),
    [data],
  );
  const studentRows = useMemo(
    () =>
      (data?.byStudent ?? []).map((r: AttendanceStudentRow) => [
        r.studentName || tl('未标注'),
        r.grade || tl('未标注'),
        r.cls || tl('未标注'),
        r.expected,
        r.present,
        r.expected > 0 ? pct(r.rate) : '—',
        r.absent,
        r.late,
        r.leave,
      ]),
    [data, tl],
  );

  const tableHead = [
    tl('应出勤人次'),
    tl('实到'),
    tl('出勤率'),
    tl('迟到'),
    tl('请假'),
    tl('缺勤'),
    tl('异常'),
  ];

  /** 学生排行表头与上面 7 列不同（少了「异常」，多了学生三列），单列一份 */
  const studentHead = [
    tl('学生'),
    tl('年级'),
    tl('班级'),
    tl('应出勤人次'),
    tl('实到'),
    tl('出勤率'),
    tl('缺勤'),
    tl('迟到'),
    tl('请假'),
  ];

  const notCountedCodes = (data?.codes ?? []).filter((c) => !c.counted);

  return (
    <div>
      {/* 筛选栏：本报表自带条件，所以 REPORTS 里不设 group（不显示公共筛选） */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' }}>
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{tl('查询条件')}</span>
        <input type="date" className="form-input" style={{ minWidth: 130, fontSize: 'var(--font-sm)' }} value={from} onChange={(e) => setFrom(e.target.value)} />
        <span style={{ color: 'var(--fg-tertiary)' }}>{tl('至')}</span>
        <input type="date" className="form-input" style={{ minWidth: 130, fontSize: 'var(--font-sm)' }} value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn btn-ghost" onClick={() => { setFrom(daysAgo(6)); setTo(todayISO()); }}>{tl('近 7 天')}</button>
        <button className="btn btn-ghost" onClick={() => { setFrom(daysAgo(29)); setTo(todayISO()); }}>{tl('近 30 天')}</button>
        <button className="btn btn-ghost" onClick={() => { setFrom(daysAgo(89)); setTo(todayISO()); }}>{tl('近 90 天')}</button>
        <select className="form-input" style={{ minWidth: 130, fontSize: 'var(--font-sm)' }} value={cls} onChange={(e) => setCls(e.target.value)}>
          <option value="">{`${tl('班级')}：${tl('全部')}`}</option>
          {(data?.options.classes ?? []).map((o) => (
            <option key={o} value={o}>{tl(o)}</option>
          ))}
        </select>
        <select className="form-input" style={{ minWidth: 130, fontSize: 'var(--font-sm)' }} value={grade} onChange={(e) => setGrade(e.target.value)}>
          <option value="">{`${tl('当前年级')}：${tl('全部')}`}</option>
          {(data?.options.grades ?? []).map((o) => (
            <option key={o} value={o}>{tl(o)}</option>
          ))}
        </select>
        <button className="btn btn-outline" onClick={() => { setFrom(daysAgo(29)); setTo(todayISO()); setCls(''); setGrade(''); }}>
          {tl('重置')}
        </button>
        {loading ? <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{tl('加载中')}…</span> : null}
      </div>

      {err ? <div style={{ color: 'var(--fg-error)', fontSize: 'var(--font-sm)', marginBottom: '1rem' }}>{err}</div> : null}

      {!data ? (
        <div style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)' }}>{tl('加载中')}…</div>
      ) : (
        <>
          {/* 未审核提示：未审核/已驳回的记录不进分子分母，必须显式告诉用户，否则会以为数字算少了 */}
          {s && (s.pending > 0 || s.rejected > 0 || data.truncated) ? (
            <div
              style={{
                fontSize: 'var(--font-xs)',
                color: 'var(--fg-secondary)',
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '8px 12px',
                marginBottom: '1rem',
                lineHeight: 1.7,
              }}
            >
              {s.pending > 0 ? `${s.pending} ${tl('条待审核未计入出勤率')}` : ''}
              {s.pending > 0 && s.rejected > 0 ? ' · ' : ''}
              {s.rejected > 0 ? `${s.rejected} ${tl('条已驳回未计入出勤率')}` : ''}
              {data.truncated ? ` · ${tl('考勤记录超过统计上限，本次只统计了前 3 万条')}` : ''}
            </div>
          ) : null}

          {s && s.total === 0 ? (
            <EmptyData
              title={tl('所选条件下暂无考勤记录')}
              hint={tl('考勤记录来自学生打卡与教师补录；有记录后这里会自动出图')}
              href="/student-attendances"
            />
          ) : null}

          {s && s.total > 0 ? (
            <>
              <MetricRow>
                <MetricCard label={tl('应出勤人次')} value={s.expected} hint={tl('只统计已通过终态且计入统计的记录')} />
                <MetricCard
                  label={tl('实到')}
                  value={s.present}
                  sub={singleDrill(data.bucketValues.present) ? tl('查看名单') : undefined}
                  onClick={singleDrill(data.bucketValues.present)}
                />
                <MetricCard label={tl('出勤率')} value={pct(s.rate)} hint={tl('实到 ÷ 应出勤人次')} />
                <MetricCard
                  label={tl('迟到')}
                  value={s.late}
                  sub={singleDrill(data.bucketValues.late) ? tl('查看名单') : undefined}
                  onClick={singleDrill(data.bucketValues.late)}
                />
                <MetricCard
                  label={tl('请假')}
                  value={s.leave}
                  sub={singleDrill(data.bucketValues.leave) ? tl('查看名单') : undefined}
                  onClick={singleDrill(data.bucketValues.leave)}
                />
                <MetricCard
                  label={tl('缺勤')}
                  value={s.absent}
                  sub={singleDrill(data.bucketValues.absent) ? tl('查看名单') : undefined}
                  onClick={singleDrill(data.bucketValues.absent)}
                />
                <MetricCard label={tl('早退')} value={s.earlyLeave} />
                <MetricCard label={tl('异常')} value={s.abnormal} hint={tl('考勤状态=异常的记录数')} />
                <MetricCard
                  label={tl('待审核')}
                  value={s.pending}
                  sub={s.pending > 0 && s.pendingUnlabeled === 0 ? tl('查看名单') : undefined}
                  onClick={
                    s.pending > 0 && s.pendingUnlabeled === 0
                      ? () => drill({ 审核状态: '待审核' })
                      : undefined
                  }
                  hint={s.pendingUnlabeled > 0 ? tl('含未标注审核状态的记录，未标注的不支持下钻') : undefined}
                />
                {s.rejected > 0 ? (
                  <MetricCard
                    label={tl('已驳回')}
                    value={s.rejected}
                    sub={tl('查看名单')}
                    onClick={() => drill({ 审核状态: '已驳回' })}
                  />
                ) : null}
                {s.excluded + s.unknownCode > 0 ? (
                  <MetricCard label={tl('未计入')} value={s.excluded + s.unknownCode} hint={tl('计入统计=否 的考勤码，或码表认不出口径的记录')} />
                ) : null}
              </MetricRow>

              <Panel title={tl('按班级')}>
                {classRows.length > 0 ? (
                  <SimpleTable head={[tl('班级'), ...tableHead]} rows={classRows} />
                ) : (
                  <div className="muted" style={{ fontSize: 'var(--font-sm)' }}>{tl('所选条件下没有记录')}</div>
                )}
              </Panel>

              <Panel title={tl('按年级')}>
                {gradeRows.length > 0 ? (
                  <SimpleTable head={[tl('年级'), ...tableHead]} rows={gradeRows} />
                ) : (
                  <div className="muted" style={{ fontSize: 'var(--font-sm)' }}>{tl('所选条件下没有记录')}</div>
                )}
              </Panel>

              <Panel
                title={tl('学生排行（缺勤 / 迟到）')}
                extra={<span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{tl('点击学生姓名查看他的考勤记录')}</span>}
              >
                {studentRows.length > 0 ? (
                  <SimpleTable
                    head={studentHead}
                    rows={studentRows}
                    clickableCols={[0]}
                    onCellClick={(rowIndex) => {
                      const sid = (data.byStudent[rowIndex] ?? null)?.studentId;
                      if (sid) drill({ [DRILL_STUDENT]: sid });
                    }}
                  />
                ) : (
                  <div className="muted" style={{ fontSize: 'var(--font-sm)' }}>{tl('所选条件下没有缺勤或迟到记录')}</div>
                )}
              </Panel>

              <Panel title={tl('出勤率趋势（按日）')}>
                {maxDay.length > 0 ? (
                  <>
                    <ColumnChart
                      data={maxDay.map((d: AttendanceTrendPoint) => ({ label: d.key.slice(5), value: d.rate }))}
                      height={140}
                    />
                    <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 8 }}>
                      {tl('柱高为当日出勤率（%）；当天没有记录则不显示')}
                    </div>
                  </>
                ) : (
                  <div className="muted" style={{ fontSize: 'var(--font-sm)' }}>{tl('所选条件下没有记录')}</div>
                )}
              </Panel>

              <Panel title={tl('按周')}>
                {(data.byWeek ?? []).length > 0 ? (
                  <SimpleTable
                    head={[tl('周起始日'), ...tableHead]}
                    rows={data.byWeek.map((w: AttendanceTrendPoint) => [
                      w.key,
                      w.expected,
                      w.present,
                      w.expected > 0 ? pct(w.rate) : '—',
                      w.late,
                      w.leave,
                      w.absent,
                      w.abnormal,
                    ])}
                  />
                ) : (
                  <div className="muted" style={{ fontSize: 'var(--font-sm)' }}>{tl('所选条件下没有记录')}</div>
                )}
              </Panel>
            </>
          ) : null}

          {/* 口径说明：照 acms-new-report 的约定，把判据 / 排除规则 / 已知缺口写清 */}
          <div
            style={{
              fontSize: 'var(--font-xs)',
              color: 'var(--fg-tertiary)',
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '10px 12px',
              lineHeight: 1.8,
            }}
          >
            <b>{tl('口径说明')}</b>：{tl('出勤率 = 实到 ÷ 应出勤人次，只统计「已通过」终态的考勤记录；')}
            {tl('待审核 / 已驳回的记录单独计数，不进分子分母。')}
            {tl('应出勤人次与实到由考勤码表配置驱动：方向=在校 计实到，方向=不在校 计未出勤；')}
            {tl('语义范围=在校-迟到 计迟到、=离校-提前 计早退、=离校 计请假，其余不在校记为缺勤；')}
            {tl('计入统计=否 的考勤码（如校内活动）整条排除在分子分母之外。')}
            {tl('异常 = 考勤状态为「异常」的记录数，与上述口径正交。')}
            {notCountedCodes.length > 0
              ? `${tl('当前不计入统计的码：')}${notCountedCodes.map((c) => tl(c.name)).join('、')}。`
              : ''}
            {(data?.codes ?? []).every((c) => c.source === '默认')
              ? `${tl('考勤码表当前为空，出勤率按内置默认码（出勤/迟到/早退/事假/病假/缺勤/校内活动）计算 —— 配好考勤码后以码表为准。')}`
              : ''}
          </div>
        </>
      )}
    </div>
  );
}

/** 班级 / 年级 分组行 → 表格行 */
function bucketRow(r: AttendanceBucketRow): (string | number)[] {
  return [
    r.key,
    r.expected,
    r.present,
    r.expected > 0 ? pct(r.rate) : '—',
    r.late,
    r.leave,
    r.absent,
    r.abnormal,
  ];
}
