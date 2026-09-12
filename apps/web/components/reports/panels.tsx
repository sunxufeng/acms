'use client';

import { useTl } from '../../lib/useTl';
import { BarRow, ColumnChart, EmptyData, MetricCard, MetricRow, Panel, SimpleTable } from './charts';

export type Row = Record<string, unknown>;

/**
 * 下钻：跳到学生列表并带上筛选条件（由 reports/page.tsx 注入，负责继承报表顶部的查询条件）。
 * 统一约定 —— 报表里凡是有「人数」的地方都能点进去看这批人是谁。
 */
export type Drill = (params: Record<string, string>) => void;

/** 分组值里代表「未填写」的占位，这类值不去定义下钻（列表没有「空值」筛选语义） */
const EMPTY_KEY = '(空)';

/** 取字段文本（多选/数组统一用「、」连接） */
export function val(r: Row, k: string): string {
  const v = r?.[k];
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => String(x ?? '')).filter(Boolean).join('、');
  return String(v);
}

/** 按字段分组计数，降序 */
export function countBy(rows: Row[], key: string): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const v = val(r, key) || '(空)';
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** 去重取值（用于筛选下拉） */
export function distinct(rows: Row[], key: string): string[] {
  return [...new Set(rows.map((r) => val(r, key)).filter(Boolean))].sort();
}

/** 前端生成 CSV 并下载（含 BOM，Excel 中文不乱码） */
export function downloadCsv(filename: string, head: string[], rows: (string | number)[][]): void {
  const esc = (v: string | number): string => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '\uFEFF' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function ExportBtn({ filename, head, rows }: { filename: string; head: string[]; rows: (string | number)[][] }) {
  const tl = useTl();
  return (
    <span
      style={{ fontSize: 'var(--font-xs)', color: 'var(--accent)', cursor: 'pointer' }}
      onClick={() => downloadCsv(filename, head, rows)}
    >
      {tl('导出 CSV')}
    </span>
  );
}

/* ── 1. 学生结构概览 ───────────────────────────── */
export function StudentOverview({ rows, drill }: { rows: Row[]; drill?: Drill }) {
  const tl = useTl();
  const total = rows.length;
  const gender = countBy(rows, '性别');
  const male = gender.find(([k]) => k === '男')?.[1] ?? 0;
  const female = gender.find(([k]) => k === '女')?.[1] ?? 0;
  const fresh = rows.filter((r) => val(r, '是否是新生') === '是').length;
  const grades = distinct(rows, '当前年级').length;
  const campus = countBy(rows, '校区');
  const maxG = Math.max(1, ...gender.map(([, c]) => c));
  const maxC = Math.max(1, ...campus.map(([, c]) => c));

  return (
    <>
      <MetricRow>
        <MetricCard
          label={tl('在校学生')}
          value={total}
          onClick={drill ? () => drill({}) : undefined}
          hint={drill ? '查看当前条件下的学生名单' : undefined}
        />
        <MetricCard label={tl('男生 / 女生')} value={male} sub={`/ ${female}`} />
        <MetricCard
          label={tl('新生占比')}
          value={total ? Math.round((fresh / total) * 100) : 0}
          sub="%"
          onClick={drill ? () => drill({ 是否是新生: '是' }) : undefined}
          hint={drill ? '查看新生名单' : undefined}
        />
        <MetricCard label={tl('年级数')} value={grades} />
      </MetricRow>

      <Panel title={tl('性别分布')}>
        {gender.map(([k, c]) => (
          <BarRow
            key={k}
            label={tl(k)}
            value={c}
            max={maxG}
            suffix={tl('人')}
            onClick={drill && k !== EMPTY_KEY ? () => drill({ 性别: k }) : undefined}
          />
        ))}
      </Panel>

      <Panel title={tl('校区分布')}>
        {campus.map(([k, c]) => (
          <BarRow
            key={k}
            label={tl(k)}
            value={c}
            max={maxC}
            suffix={tl('人')}
            onClick={drill && k !== EMPTY_KEY ? () => drill({ 校区: k }) : undefined}
          />
        ))}
      </Panel>

      {/* 六个业务维度：按当前年级 / 入学年份 / 班主任 / 招生负责老师 / 升学导师 / 当前状态 统计
          （2026-09-11 新增，都随顶部查询条件联动） */}
      {DIMENSION_PANELS.map(({ key, title }) => {
        const dist = countBy(rows, key);
        const max = Math.max(1, ...dist.map(([, c]) => c));
        return (
          <Panel key={key} title={tl(title)}>
            {dist.length === 0 ? (
              <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>{tl('暂无数据')}</div>
            ) : (
              dist.map(([k, c]) => (
                <BarRow
                  key={k}
                  label={k === EMPTY_KEY ? tl('未填写') : tl(k)}
                  value={c}
                  max={max}
                  suffix={tl('人')}
                  onClick={drill && k !== EMPTY_KEY ? () => drill({ [key]: k }) : undefined}
                />
              ))
            )}
          </Panel>
        );
      })}
    </>
  );
}

/** 学生结构概览的维度统计面板（顺序即展示顺序） */
const DIMENSION_PANELS: { key: string; title: string }[] = [
  { key: '当前年级', title: '按当前年级' },
  { key: '入学年份', title: '按入学年份' },
  { key: '班主任', title: '按班主任' },
  { key: '招生负责老师', title: '按招生负责老师' },
  { key: '升学导师', title: '按升学导师' },
  { key: '当前状态', title: '按当前状态' },
];

/* ── 2. 年级升级流向 ───────────────────────────── */
export function GradeFlow({ rows, drill }: { rows: Row[]; drill?: Drill }) {
  const tl = useTl();
  const entry = new Map(countBy(rows, '入学年级'));
  const cur = new Map(countBy(rows, '当前年级'));
  const keys = [...new Set([...entry.keys(), ...cur.keys()])].filter((k) => k !== EMPTY_KEY);
  const ordered = keys.sort((a, b) => (cur.get(b) ?? 0) - (cur.get(a) ?? 0));
  const max = Math.max(1, ...ordered.map((k) => Math.max(entry.get(k) ?? 0, cur.get(k) ?? 0)));

  const table = ordered.map((k) => {
    const e = entry.get(k) ?? 0;
    const c = cur.get(k) ?? 0;
    const d = c - e;
    return [k, e, c, d > 0 ? `+${d}` : String(d)];
  });

  return (
    <>
      <Panel title={tl('入学年级 → 当前年级')}>
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginBottom: 10 }}>
          {tl('浅色为入学时')} · {tl('深色为当前')}
          {drill ? ` · ${tl('点击查看该年级当前名单')}` : ''}
        </div>
        {ordered.map((k) => (
          <BarRow
            key={k}
            label={tl(k)}
            value={cur.get(k) ?? 0}
            compare={entry.get(k) ?? 0}
            max={max}
            onClick={drill ? () => drill({ 当前年级: k }) : undefined}
          />
        ))}
      </Panel>

      <Panel
        title={tl('年级人数变化')}
        extra={<ExportBtn filename="grade-flow.csv" head={[tl('年级'), tl('入学人数'), tl('当前人数'), tl('变化')]} rows={table} />}
      >
        {/* 第 1 列（年级）与第 3 列（当前人数）都是「当前年级」，第 2 列（入学人数）按「入学年级」下钻 */}
        <SimpleTable
          head={[tl('年级'), tl('入学人数'), tl('当前人数'), tl('变化')]}
          rows={table}
          clickableCols={drill ? [0, 1, 2] : undefined}
          onCellClick={
            drill
              ? (i, j) => {
                  const grade = String(table[i]?.[0] ?? '');
                  if (!grade) return;
                  drill(j === 1 ? { 入学年级: grade } : { 当前年级: grade });
                }
              : undefined
          }
        />
      </Panel>
    </>
  );
}

/* ── 3. 入学趋势 ───────────────────────────────── */
export function EnrollmentTrend({ rows, drill }: { rows: Row[]; drill?: Drill }) {
  const tl = useTl();
  const byYear = countBy(rows, '入学年份').filter(([k]) => k !== EMPTY_KEY);
  const data = byYear.map(([label, value]) => ({ label, value }));

  return (
    <Panel
      title={tl('按入学年份')}
      extra={<ExportBtn filename="enrollment-trend.csv" head={[tl('入学年份'), tl('人数')]} rows={byYear} />}
    >
      {data.length ? (
        <ColumnChart
          data={data}
          onPick={drill ? (label) => drill({ 入学年份: label }) : undefined}
        />
      ) : (
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>{tl('暂无数据')}</div>
      )}
    </Panel>
  );
}

/* ── 4. 档案完整度 ─────────────────────────────── */
/** 关键档案字段（用于统计缺失率；与学生档案表真实字段一致） */
const COMPLETENESS_FIELDS = [
  '性别', '出生日期', '入学日期', '校区', '当前年级', '入学年级', '入学年份',
  '当前学段', '实际学制', '入学类型', '来源渠道', '原学校', '原学校类型',
  '合同状态', '付款状态', '综合评定等级', '签证情况', '数据密级',
  '学生手机号', '学生邮箱', '现居住省', '城市',
  '班主任', '招生负责老师', '升学导师',
  'GPA成绩', '出勤率', '作业完成率', '意向专业', '目标国家', '预计毕业日期',
];

export function ProfileCompleteness({ rows }: { rows: Row[] }) {
  const tl = useTl();
  const total = rows.length || 1;
  const stats = COMPLETENESS_FIELDS.map((f) => {
    const missing = rows.filter((r) => !val(r, f)).length;
    return { field: f, missing, rate: Math.round((missing / total) * 100) };
  }).sort((a, b) => b.missing - a.missing);

  const filledRate = Math.round(
    (stats.reduce((s, x) => s + (total - x.missing), 0) / (stats.length * total)) * 100,
  );

  return (
    <>
      <MetricRow>
        <MetricCard label={tl('关键字段数')} value={COMPLETENESS_FIELDS.length} />
        <MetricCard label={tl('整体填充率')} value={filledRate} sub="%" />
        <MetricCard label={tl('全空字段数')} value={stats.filter((s) => s.missing === rows.length).length} />
      </MetricRow>

      <Panel
        title={tl('字段缺失排行')}
        extra={
          <ExportBtn
            filename="profile-completeness.csv"
            head={[tl('字段'), tl('缺失人数'), tl('缺失率')]}
            rows={stats.map((s) => [s.field, s.missing, `${s.rate}%`])}
          />
        }
      >
        <SimpleTable
          head={[tl('字段'), tl('缺失人数'), tl('缺失率')]}
          rows={stats.map((s) => [s.field, s.missing, `${s.rate}%`])}
        />
      </Panel>
    </>
  );
}

/* ── 空态报表（表结构存在、业务数据未录入） ─────── */
export function EmptyReport({ name, source, href }: { name: string; source: string; href?: string }) {
  const tl = useTl();
  return (
    <EmptyData
      title={tl('暂无数据')}
      hint={`${name}：${source} ${tl('当前无记录，录入后本报表自动出图')}`}
      href={href}
    />
  );
}
