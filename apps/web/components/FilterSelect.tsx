'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useTl } from '../lib/useTl';

/**
 * 全站**唯一**的下拉筛选触发器（2026-09-22 从 `CrudPage` 内部抽成独立组件）。
 *
 * ## 为什么必须抽出来
 *
 * 此前这个组件只存在于 `CrudPage` **内部**、没有导出，于是自建页面要加筛选只有两条路：
 * 复制一份，或者改用原生 `<select>`。结果漂移出 4 种长相：
 *  - `/students` 复制版：只显示标签（看不出当前筛了什么），且它多了**多选**能力；
 *  - `/ai/skills`、`/ai/config` 复制版（两份逐字相同）：空值时**少了「：全部」**；
 *  - 报表/成绩册等 11 处原生 select：没有「标签：」前缀与统一下拉面板；
 *  - `/student-360` 用表单标签式（文字在控件上方）。
 *
 * 抽成组件 + 导出后，「要筛选」的正确做法是 import 本组件，而不是再复制一份。
 *
 * ## 两条不可动摇的显示规则
 *
 * ① 触发器**永远**显示 `标签：当前值`，空值显示 `标签：全部`。
 *    🔴 空值也必须显示（2026-09-21 峰哥报障「状态下拉显示『状态：有效』不统一」）：
 *    原先空值只显示标签，而带默认值的筛选（`filterDefault`，如笔记状态默认「有效」）
 *    显示 `状态：有效` ⇒ 同一排筛选框两种长相。统一后触发器本身就是
 *    「当前在按什么筛」的回显，也顺手让「没选 = 不筛（全部）」显式可见。
 * ② 下拉里「全部」项**始终存在且位于首位**（两种模式都是），点击 = 清空。
 *    ⇒ 不再需要单独的「清除筛选」行，单选/多选的下拉结构因此完全一致。
 *
 * ## 单选 vs 多选的行为差异（有意为之）
 *
 * - 单选：点选项 ⇒ 选中并关闭。**重复点已选项不会取消** —— 清空统一走「全部」。
 *   这样与既有 50 个模块页的行为一致（改 toggle-off 会动到全部页面的手感）。
 * - 多选：点选项 ⇒ 勾选/取消，**不关闭**（要连点几个）；一个都不勾 = 未筛。
 *   值以全角顿号连接后交给触发器 CSS 截断（`max-width:180px` + `text-overflow`），
 *   hover 上的 `title` 可看完整值。
 */

export type FilterSelectBaseProps = {
  /** 触发器左侧的标签，如「当前状态」。已是译文（调用方自己 `t()` / `tl()`） */
  label: string;
  /** 可选值（值本身即提交值） */
  options: string[];
  /** 值 → 显示名（见 `CrudColumn.filterOptionLabels`）：只影响显示，提交的仍是值本身 */
  optionLabels?: Record<string, string>;
  /**
   * 是否可清空（默认 `true`）。
   *
   * 🔴 传 `false` 用于**必选参数**，如成绩册的「批次 / 班级」：这类值恒非空（页面逻辑依赖它），
   * 给一个「全部」项不但没意义，点下去还会把状态清成一个非法值。传 `false` 时不渲染
   * 「全部」项、空值显示占位 `—`。
   *
   * ⚠️ 但「请选择 XX」这种**向导式选择**（空 = 用户还没选，如成绩权重页的选班级）
   * 仍应保留原生 `<select>`：那里的空值语义是「未选」而不是「不限」，
   * 触发器上写「班级：全部」会误导成"所有班级的权重"。
   */
  clearable?: boolean;
};

export type FilterSelectSingleProps = FilterSelectBaseProps & {
  multiple?: false;
  /** 空串 = 全部 */
  value: string;
  onChange: (val: string) => void;
};

export type FilterSelectMultiProps = FilterSelectBaseProps & {
  multiple: true;
  /** 空数组 = 全部 */
  value: string[];
  onChange: (val: string[]) => void;
};

export function FilterSelect(props: FilterSelectSingleProps | FilterSelectMultiProps) {
  const { label, options, optionLabels } = props;
  const t = useTranslations('crud');
  const tl = useTl();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  /** 统一成数组形态再做后续判断：单选有值 = `[值]`、空值 = `[]` */
  const sel: string[] = Array.isArray(props.value) ? props.value : props.value ? [props.value] : [];
  const hasValue = sel.length > 0;
  /** 必选参数（`clearable={false}`）不给「全部」项；空值理论上不出现，兜底显示 `—` */
  const clearable = props.clearable !== false;
  const emptyText = clearable ? t('all') : '—';
  /** 多选串起来时的分隔符：中文用顿号，英文用逗号 */
  const display = sel.map((v) => tl(optionLabels?.[v] ?? v)).join(locale === 'en' ? ', ' : '、');

  /** 回写给调用方：单选收敛成字符串（取第一个），多选原样回数组 */
  function commit(next: string[]) {
    if (props.multiple) props.onChange(next);
    else props.onChange(next[0] ?? '');
  }

  return (
    <div className="filter-select" ref={ref}>
      {/* `title` 是为了值被 CSS 截断时还能 hover 看全 —— 多选选了好几个时尤其需要 */}
      <button
        type="button"
        className="filter-select-trigger"
        title={`${label}：${hasValue ? display : emptyText}`}
        onClick={() => setOpen(!open)}
      >
        <span>{label}：{hasValue ? display : emptyText}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="filter-select-dropdown">
          {clearable ? (
            <div
              className={`filter-select-opt${hasValue ? '' : ' active'}`}
              onClick={() => {
                commit([]);
                setOpen(false);
              }}
            >
              {t('all')}
            </div>
          ) : null}
          {options.map((o) => {
            const checked = sel.includes(o);
            return (
              <div
                key={o}
                className={`filter-select-opt${checked ? ' active' : ''}`}
                onClick={() => {
                  if (props.multiple) {
                    // 多选：勾选/取消，面板不关（要连着点几个）
                    commit(checked ? sel.filter((x) => x !== o) : [...sel, o]);
                  } else {
                    commit([o]);
                    setOpen(false);
                  }
                }}
              >
                {props.multiple ? <span className="filter-check">{checked ? '✓' : ''}</span> : null}
                {tl(optionLabels?.[o] ?? o)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
