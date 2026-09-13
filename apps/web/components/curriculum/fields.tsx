'use client';

import { type CSSProperties, type ReactNode } from 'react';

/**
 * 课程规划 / 课时教案的专用表单控件与展示件。
 * ──────────────────────────────────────────────────────────────────
 * 为什么需要这一层：
 *   1. **日期回填**。新表的 `ensureTable` 没登记 `acms_fields` 元数据，SqlStore 的
 *      `normalize()` 不会把日期还原成 `YYYY-MM-DD` —— 接口回传的是毫秒戳字符串，
 *      而 CrudPage 的 `date` / `datetime` 两种内置类型都是把值直接塞进 `<input>`，
 *      毫秒戳会渲染成一串数字。所以日期字段一律用 `renderField` 挂这里的控件。
 *   2. **多标签页**。三个菜单下各有 3~5 张子表，用一个 chip 组切换比拆十个路由好维护。
 *
 * 颜色一律取 CSS 变量（深浅主题自动跟随），不写死色值。
 */

const hintStyle: CSSProperties = { fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 4 };

// ── 值 ↔ 输入框文本 ─────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 任意形态（毫秒戳 / 数字串 / 日期串）→ Date；解析不了返回 null */
export function msOf(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = new Date(s.includes('T') ? s : s.replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? null : t;
}

/** → `YYYY-MM-DD`（给 `<input type="date">`） */
export function toDateInput(v: unknown): string {
  const ms = msOf(v);
  if (ms == null) {
    // 已经是 'YYYY-MM-DD' 这类字符串时直接取前 10 位，避免时区把日期挪一天
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? '').trim());
    return m ? (m[1] as string) : '';
  }
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** → `YYYY-MM-DDTHH:mm`（给 `<input type="datetime-local">`） */
export function toDateTimeInput(v: unknown): string {
  const ms = msOf(v);
  if (ms == null) {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(v ?? '').trim());
    return m ? `${m[1]}T${m[2]}` : '';
  }
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 列表展示：`YYYY-MM-DD`；空值给 `—`（避免列表出现空白单元格） */
export function fmtDate(v: unknown): string {
  return toDateInput(v) || '—';
}

/** 列表展示：`YYYY-MM-DD HH:mm` */
export function fmtDateTime(v: unknown): string {
  const s = toDateTimeInput(v);
  return s ? s.replace('T', ' ') : '—';
}

/** 百分比展示：0.1234 → `12.3%` */
export function fmtPct(ratio: unknown): string {
  const n = Number(ratio);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

// ── 表单控件 ────────────────────────────────────────────────────────

/** 日期选择：提交毫秒戳（与后端 dateFields 的写入口径一致），清空时提交空串 */
export function DateField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  return (
    <input
      className="form-input"
      type="date"
      value={toDateInput(value)}
      onChange={(e) => onChange(e.target.value ? new Date(`${e.target.value}T00:00:00`).getTime() : '')}
    />
  );
}

/** 日期时间选择：提交毫秒戳 */
export function DateTimeField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  return (
    <input
      className="form-input"
      type="datetime-local"
      value={toDateTimeInput(value)}
      onChange={(e) => onChange(e.target.value ? new Date(e.target.value).getTime() : '')}
    />
  );
}

// ── 展示件 ──────────────────────────────────────────────────────────

/** 覆盖率进度条（0~1）。颜色取 accent，不用红绿硬编码 —— 覆盖率低不等于出错 */
export function CoverageBar({ value, width = 110 }: { value: unknown; width?: number }) {
  const n = Number(value);
  const pct = Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n * 100))) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          width,
          height: 6,
          borderRadius: 999,
          background: 'var(--surface-input)',
          border: '1px solid var(--border)',
          overflow: 'hidden',
        }}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
      </div>
      <span className="muted" style={{ fontSize: 'var(--font-xs)', minWidth: 38 }}>{`${pct}%`}</span>
    </div>
  );
}

/** 状态色：把业务状态映射到全站统一的 status-* 类（定义在 globals.css） */
export function statusClassOf(s: string): string {
  if (s === '已完成' || s === '已发布' || s === '启用') return 'status-active';
  if (s === '进行中' || s === '审核中') return 'status-warn';
  if (s === '已归档' || s === '已取消' || s === '停用' || s === '已退回') return 'status-left';
  return 'status-draft';
}

/** 顶部标签页：用全站既有的 .chip / .chip-active，不新造样式 */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { key: T; label: string }[];
}) {
  return (
    <div className="filter-bar">
      {tabs.map((tb) => (
        <button
          key={tb.key}
          type="button"
          className={`chip${value === tb.key ? ' chip-active' : ''}`}
          onClick={() => onChange(tb.key)}
        >
          {tb.label}
        </button>
      ))}
    </div>
  );
}

/** 提示条（复用 globals.css 的 .notice 系列） */
export function Notice({
  kind = 'info',
  title,
  children,
}: {
  kind?: 'info' | 'ok' | 'error';
  title: string;
  children?: ReactNode;
}) {
  const cls = kind === 'ok' ? 'notice notice-ok' : kind === 'error' ? 'notice notice-error' : 'notice notice-info';
  return (
    <div className={cls}>
      <div className="notice-title">{title}</div>
      {children ? <div className="notice-detail">{children}</div> : null}
    </div>
  );
}

/** 表单字段下方的小字说明（与 CrudColumn.hint 的观感一致） */
export function FieldHint({ children }: { children: ReactNode }) {
  return <div style={hintStyle}>{children}</div>;
}

/** 指标卡：覆盖率的数字概览 */
export function StatCard({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="stat-card">
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{label}</div>
      <div style={{ fontSize: 'var(--font-xl)', fontWeight: 700, marginTop: 4 }}>{value}</div>
      {sub ? (
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 2 }}>{sub}</div>
      ) : null}
    </div>
  );
}
