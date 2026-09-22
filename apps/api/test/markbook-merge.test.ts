import { describe, expect, it } from 'vitest';
import {
  columnBaseName,
  mergeColumnsByBaseName,
  mergedWeightFull,
} from '@acms/contracts';

/**
 * 「按学科分行」视图的列归并（2026-09-23）。
 *
 * 钉住的是那条被生产截图打出来的规则：
 * 建列时勾了 3 个科目 ⇒ `subjectColumnDrafts` 拼出「日常 · 数学 / 日常 · 英语 / 日常 · 生物学」
 * 三条**独立列记录**。按学科分行视图里科目已经在行上，表头必须把这三条归并成一列，
 * 否则每行只有斜对角一格能填，另外两格永远是空的。
 */

const col = (id: string, name: string, subject: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  subject,
  ...extra,
});

describe('columnBaseName', () => {
  it('去掉「 · 科目」后缀', () => {
    expect(columnBaseName('日常 · 数学', '数学')).toBe('日常');
    expect(columnBaseName('期末考试 · 语文', '语文')).toBe('期末考试');
  });

  it('没有后缀 / 科目为空时原样返回（手打列名不能被截）', () => {
    expect(columnBaseName('期末语文', '')).toBe('期末语文');
    expect(columnBaseName('期末语文', '语文')).toBe('期末语文');
    expect(columnBaseName('日常 · 数学', '数学课')).toBe('日常 · 数学');
  });

  it('列名恰好等于后缀时不返回空串（否则表头会空掉）', () => {
    // 入参会先 trim ⇒ ' · 数学' → '· 数学'，去后缀后为空 ⇒ 退回原值本身
    expect(columnBaseName(' · 数学', '数学')).toBe('· 数学');
    expect(columnBaseName(' · 数学', '数学')).not.toBe('');
  });
});

describe('mergeColumnsByBaseName', () => {
  it('同一考核项的三个科目合成一列，bySubject 各自可查', () => {
    const groups = mergeColumnsByBaseName([
      col('a', '日常 · 数学', '数学'),
      col('b', '日常 · 英语', '英语'),
      col('c', '日常 · 生物学', '生物学'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].base).toBe('日常');
    expect(groups[0].cols.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(groups[0].bySubject.get('英语')?.id).toBe('b');
    expect(groups[0].bySubject.has('语文')).toBe(false);
  });

  it('不同基础名 / 不同科目行不混在一起', () => {
    const groups = mergeColumnsByBaseName([
      col('a', '日常 · 数学', '数学'),
      col('b', '课堂表现 · 数学', '数学'),
      col('c', '日常 · 英语', '英语'),
    ]);
    expect(groups.map((g) => g.base)).toEqual(['日常', '课堂表现']);
    expect(groups[0].cols.map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('未指定科目的列（空科目）不加后缀也各自成列，不会互相吞并', () => {
    const groups = mergeColumnsByBaseName([
      col('a', '日常', ''),
      col('b', '课堂表现', ''),
    ]);
    expect(groups.map((g) => g.base)).toEqual(['日常', '课堂表现']);
    expect(groups[0].bySubject.get('')?.id).toBe('a');
  });

  it('🔴 撞名保护：同一 (基础名, 科目) 出现两条时各自独立成列，不许吃掉一条', () => {
    const groups = mergeColumnsByBaseName([
      col('a', '日常 · 数学', '数学'),
      col('b', '日常 · 数学', '数学'),
      col('c', '日常 · 英语', '英语'),
    ]);
    // 两条撞名的各自成组（base 退回原列名），英语那条单独成组
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.cols.map((c) => c.id))).toEqual([['a'], ['b'], ['c']]);
    expect(groups[0].base).toBe('日常 · 数学');
  });

  it('归并不改变列顺序（表头顺序必须跟服务端 sort 一致）', () => {
    const groups = mergeColumnsByBaseName([
      col('a', '期末 · 数学', '数学'),
      col('b', '日常 · 数学', '数学'),
      col('c', '期末 · 语文', '语文'),
      col('d', '日常 · 语文', '语文'),
    ]);
    expect(groups.map((g) => g.base)).toEqual(['期末', '日常']);
  });

  it('空输入返回空数组（不影响「还没有列」的空态分支）', () => {
    expect(mergeColumnsByBaseName([])).toEqual([]);
  });
});

describe('mergedWeightFull', () => {
  it('各科目权重满分一致 ⇒ same=true，表头可以写具体数值', () => {
    const r = mergedWeightFull([
      col('a', '日常 · 数学', '数学', { weight: 1, fullMark: 100 }),
      col('b', '日常 · 英语', '英语', { weight: 1, fullMark: 100 }),
    ]);
    expect(r.same).toBe(true);
    expect(r.weight).toBe(1);
    expect(r.fullMark).toBe(100);
  });

  it('🔴 按科目不同 ⇒ same=false（硬写第一条的满分是错的，老师会以为整列都按它算）', () => {
    const r = mergedWeightFull([
      col('a', '日常 · 数学', '数学', { weight: 1, fullMark: 100 }),
      col('b', '日常 · 英语', '英语', { weight: 2, fullMark: 120 }),
    ]);
    expect(r.same).toBe(false);
    expect(r.items.map((i) => [i.subject, i.weight, i.fullMark])).toEqual([
      ['数学', 1, 100],
      ['英语', 2, 120],
    ]);
  });

  it('缺字段时按 1 / 100 兜底（不出现 NaN 进表头）', () => {
    const r = mergedWeightFull([col('a', '日常 · 数学', '数学')]);
    expect(r.weight).toBe(1);
    expect(r.fullMark).toBe(100);
  });
});
