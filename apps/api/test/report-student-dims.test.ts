/**
 * 报表「学生结构概览」维度 / 筛选键的**两端同源**守卫（2026-09-26 新增）。
 *
 * 为什么需要它：报表的字段值不是"前端有什么就显示什么"，而是**后端白名单投影**出来的 ——
 * `reports.service.ts` 的 `DIMENSION_FIELDS` 只放行名单里的字段，其余一律降级成占位符
 * （脱敏取向，见 `project()`）。于是有一个很容易踩、且**完全不报错**的失败模式：
 *
 *   前端加了一个维面 / 筛选框，后端没把这个字段加进白名单
 *   ⇒ 分组统计读到空数组 ⇒ 那个维面显示"暂无数据"，或整列显示"未填写"，
 *      看起来像"这批学生都没填这个字段"，实际是**值根本没传出来**。
 *
 * 所以这里把三件事钉住（全部是"漏一处就静默出错"的接线）：
 *   ① 每个维面 key 都必须在后端投影白名单里；
 *   ② 每个公共筛选键也必须在白名单里（否则筛选恒 0 —— 同理，值压根没传过来）；
 *   ③ 每个维面 key 都要在**学生列表页的下钻白名单**里（否则点维面跳过去时该条件被忽略，
 *      下钻出来的名单与报表上的数字对不上）。
 *
 * ⚠️ 断言只写"关系"，不写死维面清单 —— 以后再加维度不必回来改这里。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(path.join(here, '..', '..', ...p), 'utf8');

const reportsSvc = read('api', 'src', 'reports', 'reports.service.ts');
const reportsPage = read('web', 'app', 'reports', 'page.tsx');
const panels = read('web', 'components', 'reports', 'panels.tsx');
const studentsPage = read('web', 'app', 'students', 'page.tsx');

/**
 * 从 `const NAME = [ ... ];` 里抠出全部单引号字符串（用于取字段名数组）。
 *
 * ⚠️ 收尾要同时认 `];` **和** `] as const;` —— 只看 `];` 时会越过真正的结尾、
 *    把文件后面几十行的字符串一起吞进来（实测：FILTER_KEYS 里被混进一个 `'0'`，
 *    断言报的是"筛选键「0」不在白名单里"，看着像业务问题，其实是提取器写错了）。
 */
function stringArrayAfter(src: string, marker: string): string[] {
  const i = src.indexOf(marker);
  expect(i, `源码里找不到标记：${marker}`).toBeGreaterThan(-1);
  const rest = src.slice(i);
  const end = rest.search(/\]\s*(as const)?\s*;/);
  expect(end, `标记后面找不到数组结尾：${marker}`).toBeGreaterThan(-1);
  return [...rest.slice(0, end).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** 从 `{ key: 'X', title: 'Y' }` 形式的数组里只取 key */
function panelKeys(src: string, marker: string): string[] {
  const i = src.indexOf(marker);
  expect(i, `源码里找不到标记：${marker}`).toBeGreaterThan(-1);
  const chunk = src.slice(i, src.indexOf('];', i));
  return [...chunk.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]);
}

const DIMENSION_FIELDS = stringArrayAfter(reportsSvc, 'const DIMENSION_FIELDS');
const FILTER_KEYS = stringArrayAfter(reportsPage, 'const FILTER_KEYS');
const DRILL_KEYS = stringArrayAfter(studentsPage, 'const DRILL_KEYS');
const PANEL_KEYS = panelKeys(panels, 'const DIMENSION_PANELS');

describe('学生结构概览 · 维度接线（前端维面 ⊆ 后端投影白名单）', () => {
  it('解析到了四份清单（守卫自身别空跑）', () => {
    expect(DIMENSION_FIELDS.length).toBeGreaterThan(5);
    expect(FILTER_KEYS.length).toBeGreaterThan(2);
    expect(DRILL_KEYS.length).toBeGreaterThan(5);
    expect(PANEL_KEYS.length).toBeGreaterThan(5);
  });

  it('🔴 每个维面都必须被后端投影（否则该维面整维空 / 全是"未填写"，且不报错）', () => {
    for (const k of PANEL_KEYS) {
      expect(DIMENSION_FIELDS, `维面「${k}」不在 DIMENSION_FIELDS 里 ⇒ 值传不出来`).toContain(k);
    }
  });

  it('🔴 每个公共筛选键也必须被后端投影（否则筛选恒 0）', () => {
    for (const k of FILTER_KEYS) {
      expect(DIMENSION_FIELDS, `筛选键「${k}」不在 DIMENSION_FIELDS 里 ⇒ 筛选恒 0`).toContain(k);
    }
  });

  it('🔴 每个维面都要在下钻白名单里（否则点维面跳过去时条件被忽略，名单与数字对不上）', () => {
    for (const k of PANEL_KEYS) {
      expect(DRILL_KEYS, `维面「${k}」不在 students 页 DRILL_KEYS 里 ⇒ 下钻会忽略该条件`).toContain(k);
    }
  });

  it('本次新增的两个入学维度都在两端（入学年份 / Arete入学年）', () => {
    // 这两条是**具体值**断言（本次交付的要求），不是"全集推导"——
    // 它们与「入学年月」是三个不同字段：入学年月=26秋季（学期）、入学年份=2026（年）、
    // Arete入学年=第6年（Arete 第 N 学年）。
    for (const k of ['入学年份', 'Arete入学年']) {
      expect(DIMENSION_FIELDS).toContain(k);
      expect(PANEL_KEYS).toContain(k);
      expect(DRILL_KEYS).toContain(k);
    }
    // 「入学年月」不许被改名成「入学年份」（2026-09-22 已经腾过一次名字，别再撞）
    expect(PANEL_KEYS).toContain('入学年月');
  });

  it('维面里没有重复 key（重复会让同一个维度渲染两遍）', () => {
    expect(new Set(PANEL_KEYS).size).toBe(PANEL_KEYS.length);
  });
});
