import { describe, expect, it } from 'vitest';
import {
  ARETE_ENROLL_MAX_YEAR_NO,
  ENROLL_MONTH_FIELD,
  ENROLL_YEAR_FIELD,
  ARETE_ENROLL_YEAR_FIELD,
  areteEnrollYearLabel,
  deriveEnrollFields,
  enrollYearFromMonth,
} from '@acms/contracts';

/**
 * 学生档案「入学年月 → 入学年份 / Arete入学年」派生规则的契约测试。
 *
 * 🔴 本文件锁的是 **2026-09-22 峰哥给的范例反推出来的口径**：
 *   沈嘉铖 `23秋季` → 入学年份 `2023`、Arete入学年 `第3年`。
 *
 * 这块最危险的不是写错，而是**换回另一种读法**：
 *   「入学后第 N 年（当前年份 − 入学年份）」在范例上**同样等于 3**，
 *   但套到全量数据会把 `26秋季`（61 人）算成 **第 0 年** —— 不在字典里。
 *   所以下面专门有一条测试钉住「26秋季 不能是第0年」，删了它就等于把两个读法又混在一起。
 *
 * 纯函数，不连数据库、不改任何数据。
 */

describe('入学年份 = 20 + NN（与春/秋无关）', () => {
  it('范例：23秋季 → 2023', () => {
    expect(enrollYearFromMonth('23秋季')).toBe('2023');
  });

  it('春/秋同一学年 → 同年份', () => {
    expect(enrollYearFromMonth('25春季')).toBe('2025');
    expect(enrollYearFromMonth('25秋季')).toBe('2025');
  });

  it('两端边界：21 → 2021（最早在用的值）、30 → 2030', () => {
    expect(enrollYearFromMonth('21春季')).toBe('2021');
    expect(enrollYearFromMonth('30秋季')).toBe('2030');
  });

  it('形态不符一律返空（宁可不填，也不要猜）', () => {
    for (const bad of ['', '  ', '2023', '26夏季', '第3年', 'abc', undefined, null, 2609]) {
      expect(enrollYearFromMonth(bad as unknown)).toBe('');
    }
  });
});

describe('Arete入学年 = 第(入学年份 − 2020)年', () => {
  it('范例：2023 → 第3年', () => {
    expect(areteEnrollYearLabel('2023')).toBe('第3年');
  });

  it('🔴 锚点：2021 → 第1年（与「Arete毕业届：第四届 = 2024 年入学」同一套编号）', () => {
    expect(areteEnrollYearLabel('2021')).toBe('第1年');
    expect(areteEnrollYearLabel('2024')).toBe('第4年');
  });

  it('🔴 排除另一种读法：26秋季 必须是 第6年，绝不能算出「第0年」', () => {
    // 「入学后第 N 年（当前年份 − 入学年份）」会得到 0 ⇒ 被否。
    // 这条断言就是两个读法的分界，删了等于允许整批数据按错规则填。
    expect(deriveEnrollFields('26秋季')).toEqual({
      [ENROLL_YEAR_FIELD]: '2026',
      [ARETE_ENROLL_YEAR_FIELD]: '第6年',
    });
    expect(areteEnrollYearLabel('2026')).not.toBe('第0年');
  });

  it('超出字典范围（第1–第10年）返空 —— 不写字典里没有的值', () => {
    expect(areteEnrollYearLabel('2030')).toBe('第10年');          // 上限，正好合法
    expect(areteEnrollYearLabel('2031')).toBe('');                 // 第11年，超上限
    expect(areteEnrollYearLabel('2019')).toBe('');                 // 第-1年
    expect(areteEnrollYearLabel('不是年份')).toBe('');
  });

  it('上限常量与字典 Arete入学年 的项数一致（改字典要一起改）', () => {
    expect(ARETE_ENROLL_MAX_YEAR_NO).toBe(10);
  });
});

describe('deriveEnrollFields：推导不出就**不动**（不是清空）', () => {
  it('可推导时同时给出两个字段（键就是数据 key）', () => {
    expect(deriveEnrollFields('23秋季')).toEqual({
      [ENROLL_YEAR_FIELD]: '2023',
      [ARETE_ENROLL_YEAR_FIELD]: '第3年',
    });
  });

  it('🔴 清空「入学年月」返回**空对象** —— 调用方不得据此清掉已有值', () => {
    // 便利填充不该变成静默的数据删除：要清由人手动清。
    expect(deriveEnrollFields('')).toEqual({});
    expect(deriveEnrollFields(null)).toEqual({});
    expect(deriveEnrollFields('26夏季')).toEqual({});
    for (const r of [deriveEnrollFields(''), deriveEnrollFields('40秋季')]) {
      expect(Object.keys(r)).toHaveLength(0);
    }
  });

  it('字段名常量与前端表单/字典一致（手抄字符串改一处就会静默脱钩）', () => {
    expect(ENROLL_MONTH_FIELD).toBe('入学年月');
    expect(ENROLL_YEAR_FIELD).toBe('入学年份');
    expect(ARETE_ENROLL_YEAR_FIELD).toBe('Arete入学年');
  });
});
