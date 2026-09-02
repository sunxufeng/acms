'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

/** 每页条数候选项（默认 5 保持与既有行为一致） */
export const PAGE_SIZE_OPTIONS = [5, 10, 20, 50];

/**
 * 页码序列：首页 / 末页常显，当前页 ±win 为窗口，断层处返回 'gap' 表示省略号。
 * 例：page=6, totalPages=17 → [1, 'gap', 5, 6, 7, 'gap', 17]
 */
export function buildPageItems(page: number, totalPages: number, win = 1): (number | 'gap')[] {
  const set = new Set<number>([1, totalPages]);
  for (let p = page - win; p <= page + win; p++) if (p >= 1 && p <= totalPages) set.add(p);
  const out: (number | 'gap')[] = [];
  let prev = 0;
  for (const p of Array.from(set).sort((a, b) => a - b)) {
    if (prev && p - prev > 1) out.push('gap');
    out.push(p);
    prev = p;
  }
  return out;
}

export interface PaginationProps {
  total: number;
  page: number;
  pageSize: number;
  loading?: boolean;
  onPageChange: (page: number) => void;
  /** 传入后显示「N 条/页」下拉；切换每页条数由调用方负责重置游标并重载第 1 页 */
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
}

/**
 * 全站列表统一的底部分页条：共 N 条 · ‹ 页码(含首尾页与省略号) › · N 条/页 · 跳至 __ 页
 * 纯 UI 组件，不持有数据；翻页走调用方的 goToPage（pageToken 游标机制不变）。
 */
export default function Pagination({
  total,
  page,
  pageSize,
  loading,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
}: PaginationProps) {
  const tc = useTranslations('crud');
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const [jump, setJump] = useState('');

  // 总页数变化（筛选/切换每页条数）后清掉跳页输入框里的残留数字
  useEffect(() => {
    setJump('');
  }, [totalPages]);

  const disabled = Boolean(loading);
  const pageUnit = tc('pageUnit');

  const items = buildPageItems(page, totalPages);

  const submitJump = () => {
    const raw = Number.parseInt(jump, 10);
    setJump('');
    if (!raw) return;
    const target = Math.min(Math.max(raw, 1), totalPages);
    if (target !== page) onPageChange(target);
  };

  return (
    <div className="pagination">
      <span className="pagination-total">{tc('total', { total })}</span>

      <div className="pagination-pages">
        <button
          type="button"
          className="pagination-nav"
          disabled={disabled || page <= 1}
          aria-label={tc('prevPage')}
          title={tc('prevPage')}
          onClick={() => onPageChange(page - 1)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>

        {items.map((it, i) =>
          it === 'gap' ? (
            <span key={`gap-${i}`} className="pagination-gap">…</span>
          ) : (
            <button
              key={it}
              type="button"
              className={`pagination-page${it === page ? ' active' : ''}`}
              disabled={disabled}
              aria-current={it === page ? 'page' : undefined}
              onClick={() => onPageChange(it)}
            >
              {it}
            </button>
          ),
        )}

        <button
          type="button"
          className="pagination-nav"
          disabled={disabled || page >= totalPages}
          aria-label={tc('nextPage')}
          title={tc('nextPage')}
          onClick={() => onPageChange(page + 1)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>

      <div className="pagination-tail">
        {onPageSizeChange && (
          <span className="pagination-size">
            <select
              className="pagination-select"
              value={pageSize}
              disabled={disabled}
              aria-label={tc('perPage', { size: pageSize })}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
            >
              {pageSizeOptions.map((s) => (
                <option key={s} value={s}>{tc('perPage', { size: s })}</option>
              ))}
            </select>
            <svg className="pagination-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </span>
        )}

        <span className="pagination-jump">
          <span className="pagination-jump-label">{tc('goTo')}</span>
          <input
            className="pagination-jump-input"
            type="text"
            inputMode="numeric"
            value={jump}
            placeholder={String(page)}
            onChange={(e) => setJump(e.target.value.replace(/[^\d]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitJump();
              }
            }}
            onBlur={submitJump}
          />
          {pageUnit ? <span className="pagination-jump-label">{pageUnit}</span> : null}
        </span>
      </div>
    </div>
  );
}
