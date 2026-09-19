import { describe, expect, it } from 'vitest';
import { buildColumnFields, safeWeight, weightedTotal } from '../src/markbook/markbook.logic.js';

/**
 * 成绩册列的写入字段构造（2026-09-20 补页面时新增的回归保护）。
 *
 * 这一条规则看起来只是「写不写空串」，但踩过之后代价很高：
 * 原先每个键都是 `String(payload.x ?? '')`，于是**表单没渲染的字段等于被清空**。
 * 「科目」就这么被清掉过 —— 而科目是期末总评拆科目的唯一依据，
 * 一旦清空，结转时所有科目会合成一条，且全程不报错。
 */
describe('buildColumnFields', () => {
  it('只传定位字段时，**不**顺手写出其它字段（否则会静默清空科目/可见性/闸门）', () => {
    const f = buildColumnFields({ cls: 'Pre-1', name: '第一次月考' });
    expect(Object.keys(f).sort()).toEqual(['列名称', '班级'].sort());
    // 下面这些正是「以前会被清空」的字段：一个都不该出现
    for (const k of ['科目', '描述', '学生可见', '家长可见', '完成日期', '等级体系', '考核日期']) {
      expect(f).not.toHaveProperty(k);
    }
  });

  it('显式传空串 = 清空（区分「没传」与「传空」）', () => {
    const f = buildColumnFields({
      cls: 'Pre-1',
      name: 'x',
      subject: '',
      studentVisible: '',
      completeDate: '',
      desc: '',
    });
    expect(f['科目']).toBe('');
    expect(f['学生可见']).toBe('');
    expect(f['完成日期']).toBe('');
    expect(f['描述']).toBe('');
  });

  it('可见性与闸门：三个值原样写入（判据只认「是」，空串 = 未设置）', () => {
    const f = buildColumnFields({
      cls: 'Pre-1',
      name: 'x',
      studentVisible: '是',
      parentVisible: '否',
      completeDate: '2026-12-31',
    });
    expect(f['学生可见']).toBe('是');
    expect(f['家长可见']).toBe('否');
    expect(f['完成日期']).toBe('2026-12-31');
  });

  it('权重与满分兜底：非正数回落 1 / 100（不要让 0 分制列把总评算成 0）', () => {
    const f = buildColumnFields({ cls: 'Pre-1', name: 'x', weight: 0, fullMark: -5 });
    expect(f['列权重']).toBe(1);
    expect(f['满分']).toBe(100);
  });

  it('等级体系是关联字段：传 id 存数组、传空存空数组', () => {
    expect(buildColumnFields({ cls: 'Pre-1', name: 'x', scaleId: 'rec_scale' })['等级体系']).toEqual(['rec_scale']);
    expect(buildColumnFields({ cls: 'Pre-1', name: 'x', scaleId: '' })['等级体系']).toEqual([]);
  });

  it('科目与列名称都去首尾空格（科目手打多一个空格会拆出第二个科目）', () => {
    const f = buildColumnFields({ cls: ' Pre-1 ', name: '  月考  ', subject: ' 数学 ' });
    expect(f['列名称']).toBe('月考');
    expect(f['科目']).toBe('数学');
    expect(f['班级']).toBe('Pre-1');
  });
});

/**
 * 顺带把「两层权重」的兜底也钉住：列权重 × 类型权重，两者缺省都按 1，
 * 分母只算实际参与项（自归一化）—— 只录了部分考核时不该被没录的项拉低。
 */
describe('safeweight / weightedTotal（两层权重与自归一化）', () => {
  it('safeWeight：非正数与非法值一律回落 1', () => {
    expect(safeWeight(0)).toBe(1);
    expect(safeWeight(-3)).toBe(1);
    expect(safeWeight('')).toBe(1);
    expect(safeWeight('2.5')).toBe(2.5);
  });

  it('weightedTotal：分母只算已录入项', () => {
    // 一次 90 分（权重 1）+ 一次 80 分（权重 1）→ 85；未录入的项不进分母
    const r = weightedTotal([
      { score: 90, weight: 1 },
      { score: 80, weight: 1 },
    ]);
    expect(r.total).toBe(85);
    expect(r.weightSum).toBe(2);

    // 只有一项时，总评就等于那一项（而不是被「没录的两项」摊薄）
    const one = weightedTotal([{ score: 60, weight: 3 }]);
    expect(one.total).toBe(60);
    expect(one.weightSum).toBe(3);
  });
});
