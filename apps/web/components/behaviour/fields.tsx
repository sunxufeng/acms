'use client';

import { type CSSProperties, type ReactNode } from 'react';

/**
 * 行为记录（Behaviour）的专用表单控件与展示件。
 * ──────────────────────────────────────────────────────────────────
 * 为什么需要这一层：
 *   1. **日期回填**。自建表的 `ensureTable` 没登记 `acms_fields` 元数据，SqlStore 的
 *      `normalize()` 不会把日期还原成 `YYYY-MM-DD` —— 接口回传的是毫秒戳，
 *      而 CrudPage 的 `date` / `datetime` 内置类型是直接把值塞进 `<input>`，
 *      毫秒戳会渲染成一串数字。所以日期字段一律用 `renderField` 挂这里的控件。
 *   2. **多标签页**。四张表用一个 chip 组切换比拆四个路由好维护（与课程规划同一做法）。
 *
 * 颜色一律取 CSS 变量（深浅主题自动跟随），不写死色值。
 */

const hintStyle: CSSProperties = { fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 4 };

// ── 值 ↔ 输入框文本 ─────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 任意形态（毫秒戳 / 数字串 / 日期串）→ 毫秒；解析不了返回 null */
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

/** 列表展示：`YYYY-MM-DD`；空值给 `—` */
export function fmtDate(v: unknown): string {
  return toDateInput(v) || '—';
}

/** 列表展示：`YYYY-MM-DD HH:mm` */
export function fmtDateTime(v: unknown): string {
  const s = toDateTimeInput(v);
  return s ? s.replace('T', ' ') : '—';
}

/** 截断长文本（信件正文/触发原因在列表里只给预览，完整内容进编辑页） */
export function truncate(v: unknown, n = 36): string {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return '—';
  return s.length > n ? `${s.slice(0, n)}…` : s;
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

/**
 * 状态色：把业务状态映射到全站统一的 `status-*` 类（定义在 globals.css）。
 * 可用类：status-active(绿) / status-warn(橙) / status-off(红) / status-graduated(灰) / status-draft(蓝)
 */
export function statusClassOf(s: string): string {
  if (s === '已完成' || s === '已发布' || s === '已确认' || s === '已发送' || s === '启用') return 'status-active';
  if (s === '进行中' || s === '处理中' || s === '待跟进') return 'status-warn';
  if (s === '已解除' || s === '已归档' || s === '停用') return 'status-graduated';
  return 'status-draft';
}

/** 告警等级色：严重 → 红；中度 → 橙；轻度 → 蓝 */
export function alertLevelClass(level: string): string {
  if (level === '严重') return 'status-off';
  if (level === '中度') return 'status-warn';
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

/** 指标卡：统计页的数字概览 */
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
