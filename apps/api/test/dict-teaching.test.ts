import { describe, expect, it } from 'vitest';
import { DICTIONARIES, DICTIONARIES_RAW } from '../src/dictionary/dict.data.js';
import {
  ABSENT_MODES,
  EXCUSED_MODES,
  ROUND_MODES,
} from '../src/exam-grade/exam-grade.logic.js';

/**
 * 教学域字典（2026-09-20 从各页面硬编码下拉迁入）。
 *
 * 这组测试盯的是**一个不报错的坑**：字典是可编辑的（运营能在「字典管理」页改），
 * 但「舍入口径 / 免考处理 / 缺考处理」三者的**值就是期末结转的判据字面量**
 * （服务端按 `batch.缺考处理 === '计0分'` 这种等式判定）。一旦有人为了「改个说法」
 * 把字典值改了，新选的批次就算不出总评，而老数据仍按旧值算 —— 症状是
 * 「有的批次对、有的不对」，全程不报错、也没日志。
 *
 * 所以这里断言：字典里这三个 key 的选项**逐一等于**服务端常量。
 * 有人手抄字符串（而不是 import 常量）时，这条会立刻红。
 */
describe('教学域字典', () => {
  const KEYS = [
    '学年',
    '教学学期',
    '舍入口径',
    '免考处理',
    '缺考处理',
    '行为类型',
    '评语标签',
    '适用范围',
  ];

  it('八个 key 都已登记（漏了的话页面的下拉会是空的）', () => {
    for (const k of KEYS) {
      expect(DICTIONARIES_RAW[k], `字典缺少 key：${k}`).toBeDefined();
      expect(DICTIONARIES[k]?.length ?? 0, `字典 ${k} 没有候选项`).toBeGreaterThan(0);
    }
  });

  it('🔴 舍入口径 = ROUND_MODES（顺序也要一致：它决定下拉的展示顺序）', () => {
    expect(DICTIONARIES_RAW['舍入口径']).toEqual([...ROUND_MODES]);
  });

  it('🔴 免考处理 = EXCUSED_MODES', () => {
    expect(DICTIONARIES_RAW['免考处理']).toEqual([...EXCUSED_MODES]);
  });

  it('🔴 缺考处理 = ABSENT_MODES', () => {
    expect(DICTIONARIES_RAW['缺考处理']).toEqual([...ABSENT_MODES]);
  });

  it('学年：2020 ~ 2030 共 11 个（成绩批次与课程规划共用同一份）', () => {
    const years = DICTIONARIES_RAW['学年'] ?? [];
    expect(years.length).toBe(11);
    expect(years[0]).toBe('2020学年');
    expect(years[years.length - 1]).toBe('2030学年');
  });

  it('教学学期的取值与「成绩批次」表的字段枚举一致（否则选了值但落字段时会不一致）', () => {
    expect(DICTIONARIES_RAW['教学学期']).toEqual(['第一学期', '第二学期', '全学年']);
  });

  it('🔴 「学期」字典仍是**学生档案**的口径，没被教学域覆盖', () => {
    // 学生档案的「学期」是 2025春 / 2025秋 这种；教学域的学期是「第一学期」。
    // 两者共用一个 key 会让某一侧的下拉出现错值 —— 所以教学域另立「教学学期」。
    const terms = DICTIONARIES_RAW['学期'] ?? [];
    expect(terms.some((t) => t.includes('春') || t.includes('秋'))).toBe(true);
    expect(terms).not.toContain('第一学期');
  });
});
