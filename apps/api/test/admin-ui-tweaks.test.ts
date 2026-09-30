/**
 * 后台/页面小调整的接线守卫（2026-09-30）。
 *
 * 两条都是"改一处、另一处忘改就静默串位"的类型：
 *  · 隐藏一列时，表头与单元格必须**用同一个常量**判断（拆成两处各写一遍必然串位）；
 *  · 筛选框顺序来自 contracts/页面里的一个数组，改顺序只影响渲染 ——
 *    但如果有人把「顺序」误当「优先级」去改过滤逻辑，就要在这里被拦住。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');

describe('A. IDP 配置页：隐藏「操作」列', () => {
  const page = read('apps/web/app/idp-configs/page.tsx');

  it('🔴 表头与单元格用**同一个常量**判断（各写一遍 = 迟早串位）', () => {
    expect(page).toContain('const SHOW_OPS_COLUMN = false;');
    // 该常量出现 3 次：定义 1 + 表头 1 + 单元格 1
    expect((page.match(/SHOW_OPS_COLUMN/g) ?? []).length).toBe(3);
  });

  it('关掉的是「操作」列（列头文案 colOps），不是别的列', () => {
    // ⚠️ 锚点要用**列头那处**，不能用常量名第一次出现的位置 ——
    //    那前面是一大段注释（"之所以用常量开关…"），取 ±200 窗口根本框不到 colOps。
    const i = page.indexOf("t('colOps')");
    expect(i).toBeGreaterThan(0);
    expect(page.slice(Math.max(0, i - 260), i)).toContain('{SHOW_OPS_COLUMN ?');
    // 单元格那处同样由它控制（否则表头没了、格子还在 ⇒ 整张表错位）
    // ⚠️ 这里**不能用「viewComms 前 N 字符」当窗口** —— 中间隔着 setTarget 的一大段对象，
    //    窗口一放大又会把别的分支框进来（这个文件里已经因此返工三次）。
    //    判据改成"两种写法都在页面上"，短、稳、且能拦住"只改一处"。
    expect(page).toContain('{SHOW_OPS_COLUMN ? (');
    expect(page).toContain("t('viewComms')");
  });

  it('🔴 抽屉入口代码**保留**（只是不渲染）—— 删干净就再没有地方能打开它了', () => {
    expect(page).toContain('setTarget({');
    expect(page).toContain('IdpCommDrawer');
  });
});

describe('B. 报表：筛选条件「入学年份」在「入学年月」之前', () => {
  const page = read('apps/web/app/reports/page.tsx');

  it('FILTER_KEYS 的顺序就是界面上的筛选框顺序', () => {
    const m = /const FILTER_KEYS = \[(.*?)\] as const;/.exec(page);
    expect(m, '找不到 FILTER_KEYS').toBeTruthy();
    const keys = (m?.[1] ?? '').split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
    expect(keys).toEqual(['校区', '当前年级', '入学年份', '入学年月', '是否是新生']);
    expect(keys.indexOf('入学年份')).toBeLessThan(keys.indexOf('入学年月'));
  });

  it('🔴 顺序只影响渲染：过滤与下钻仍是 `FILTER_KEYS` 遍历，不许为顺序另写一套', () => {
    // 过滤：every 遍历；下钻合并：for of 遍历 —— 都与顺序无关
    expect(page).toContain('FILTER_KEYS.every(');
    expect(page).toContain('for (const k of FILTER_KEYS)');
    // 反向：不许出现"按位置判断"的写法
    expect(page).not.toContain('FILTER_KEYS[0]');
    expect(page).not.toContain('FILTER_KEYS[2]');
  });
});
