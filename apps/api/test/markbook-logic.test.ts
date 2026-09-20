import { describe, expect, it } from 'vitest';
import {
  buildColumnFields,
  columnInTerm,
  isUnassignedTerm,
  levelOptionItems,
  safeWeight,
  statsOfScores,
  subjectColumnDrafts,
  sumOfScores,
  targetLabelOf,
  weightedTotal,
  type LevelDef,
} from '../src/markbook/markbook.logic.js';

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

/**
 * 目标等级的显示名推导（2026-09-20 新增）。
 *
 * 背景：「学生成绩目标」页的表单只有**目标分 + 目标等级序号**，`目标等级` 没有录入入口 ⇒
 * 生产上 2 条目标记录里这个名字字段根本不存在。而成绩册网格原来只认这个名字，
 * 于是「设了目标却显示未设目标」，且「达标」明明算得出来（等于白算）。
 * 这条推导就是让「只有序号」也能显示出等级名。
 */
describe('targetLabelOf', () => {
  const levels: LevelDef[] = [
    { id: 'l1', scaleId: 's1', label: 'A*', order: 1, min: 90, max: 100, concern: false },
    { id: 'l2', scaleId: 's1', label: 'A', order: 2, min: 80, max: 89, concern: false },
    { id: 'l3', scaleId: 's1', label: 'B', order: 3, min: 0, max: 79, concern: true },
  ];

  it('记录里写了等级名 → 原样用它（不拿体系里的同序号值去覆盖历史写法）', () => {
    expect(targetLabelOf('优秀', 1, levels)).toBe('优秀');
  });

  it('只有序号（生产真实形态）→ 按序号在学生实际用的体系里反查', () => {
    expect(targetLabelOf('', 1, levels)).toBe('A*');
    expect(targetLabelOf(undefined, 3, levels)).toBe('B');
  });

  it('序号是字符串数字也认（数据库里可能存成 "1"）', () => {
    expect(targetLabelOf('', '2' as unknown as number, levels)).toBe('A');
  });

  it('序号在体系里找不到 → 返回空串（前端据此回落显示「序号 N」，不乱猜一个等级名）', () => {
    expect(targetLabelOf('', 9, levels)).toBe('');
  });

  it('名字与序号都空 → 空串（这条才是真正的「未设目标」）', () => {
    expect(targetLabelOf('', null, levels)).toBe('');
    expect(targetLabelOf('   ', null, levels)).toBe('');
    expect(targetLabelOf('', undefined, levels)).toBe('');
  });
});

/**
 * 成绩等级下拉候选（2026-09-20 新增）。
 *
 * 这一条防的是**最贵的一类静默错误**：目标等级序号填了个体系里不存在的数字
 * （生产实测填 1，而本校序号是 10/15/…/60）⇒ 达标判定 `实际序号 ≤ 目标序号` 恒为假，
 * 学生哪怕全 A 也永远「未达标」，接口还一切正常。下拉的候选必须就是真实等级。
 */
describe('levelOptionItems', () => {
  // 生产真实数据（致极等第体系-2026）：序号越小越好，A 最好 = 10，没有 1
  const real: LevelDef[] = [
    { id: 'f', scaleId: 's1', label: 'F', order: 60, min: 0, max: 59, concern: true },
    { id: 'd', scaleId: 's1', label: 'D', order: 50, min: 60, max: 69, concern: true },
    { id: 'cm', scaleId: 's1', label: 'C-', order: 40, min: 70, max: 73, concern: false },
    { id: 'bp', scaleId: 's1', label: 'B+', order: 20, min: 87, max: 89, concern: false },
    { id: 'am', scaleId: 's1', label: 'A-', order: 15, min: 90, max: 94, concern: false },
    { id: 'a', scaleId: 's1', label: 'A', order: 10, min: 95, max: 100, concern: false },
  ];

  it('按序号升序（越小越好 ⇒ A 排最前）且值就是序号本身', () => {
    const opts = levelOptionItems(real);
    expect(opts.map((o) => o.value)).toEqual(['10', '15', '20', '40', '50', '60']);
    expect(opts[0]).toEqual({ value: '10', label: 'A（序号 10）' });
  });

  it('label 里同时有显示值与序号 ⇒ 用户不必回头查「序号几是 A」', () => {
    const opts = levelOptionItems(real);
    expect(opts.map((o) => o.label)).toContain('A-（序号 15）');
    // 关键：**不含**「序号 1」这种体系里不存在的值（生产就是被它坑的）
    expect(opts.some((o) => o.value === '1')).toBe(false);
  });

  it('多体系时同序号只留一个，并在 label 里标出体系名', () => {
    const two: LevelDef[] = [
      { id: 'x1', scaleId: 's1', label: 'A', order: 10, min: null, max: null, concern: false },
      { id: 'x2', scaleId: 's2', label: '优', order: 10, min: null, max: null, concern: false },
    ];
    const names: Record<string, string> = { s1: '体系一', s2: '体系二' };
    const opts = levelOptionItems(two, (id) => names[id] ?? '', true);
    expect(opts).toHaveLength(1);
    expect(opts[0].value).toBe('10');
    expect(opts[0].label).toContain('体系');
  });

  it('空等级表 → 空候选（页面据此退回数字输入）', () => {
    expect(levelOptionItems([])).toEqual([]);
  });
});

/**
 * 视图聚合（2026-09-20 新增）：四种网格视图共用的两套展示口径。
 *
 * 为什么必须由服务端算并测住：前端四种视图各算一遍必然漂移 ——
 * 某一版把「免考/缺考」当成 0 参与分母，另一版忽略，同一列在两个视图里显示不同的均分，
 * 而且**都不报错**（这正是最贵的一类不一致）。
 */
describe('statsOfScores', () => {
  it('只统计数字：等级制（A）与免考留空不进分母，也不当成 0', () => {
    const r = statsOfScores([92, 85, null, undefined, 90]);
    expect(r).toEqual({ count: 3, mean: 89, max: 92, min: 85 });
  });

  it('均分保留 1 位小数（避免 86.33333333 这种展示）', () => {
    expect(statsOfScores([90, 85, 84]).mean).toBe(86.3);
  });

  it('全是空/非数字 → 参与数 0、三个值都是 null（界面显示「—」，不是 0）', () => {
    expect(statsOfScores([null, undefined])).toEqual({ count: 0, mean: null, max: null, min: null });
  });

  it('单条也能算（最高=最低=均分）', () => {
    expect(statsOfScores([77])).toEqual({ count: 1, mean: 77, max: 77, min: 77 });
  });
});

describe('sumOfScores', () => {
  it('只加数字，返回参与数（供界面标注「按 N 项合计」）', () => {
    expect(sumOfScores([92, 85, null, 90])).toEqual({ count: 3, sum: 267 });
  });

  it('没有数字项 → sum=null（而不是 0：0 会被误读成「合计为 0 分」）', () => {
    expect(sumOfScores([null, undefined])).toEqual({ count: 0, sum: null });
  });

  it('小数分也保留 1 位（部分学校按半分计）', () => {
    expect(sumOfScores([88.5, 91.5]).sum).toBe(180);
    expect(sumOfScores([88.25]).sum).toBe(88.3);
  });
});

/**
 * 多科目建列展开（2026-09-20）。
 *
 * 防的是「一列挂多个科目」这个诱惑：期末总评的幂等键是「批次 + 学生 + 科目」，
 * 一列挂两个科目 ⇒ 结转时拆不出科目、权重也没法按科目区分，而且**不报错**。
 * 所以多选必须展开成多列，展开规则在这里测住。
 */
describe('subjectColumnDrafts', () => {
  it('勾 3 个科目 = 3 列，每列一个科目（绝不合成一列）', () => {
    const d = subjectColumnDrafts({ name: '期末考试', subjects: ['语文', '数学', '英语'], sort: 5 });
    expect(d).toHaveLength(3);
    expect(d.map((x) => x.subject)).toEqual(['语文', '数学', '英语']);
    expect(d.map((x) => x.name)).toEqual(['期末考试 · 语文', '期末考试 · 数学', '期末考试 · 英语']);
  });

  it('排序连号 ⇒ 同批创建的列在网格里相邻（横着填分不会串到别的考试）', () => {
    const d = subjectColumnDrafts({ name: '月考', subjects: ['语文', '数学'], sort: 10 });
    expect(d.map((x) => x.sort)).toEqual([10, 11]);
  });

  it('只有一个科目 ⇒ 不加后缀（用户自己写的名字已够清楚）', () => {
    const d = subjectColumnDrafts({ name: '期末语文', subjects: ['语文'] });
    expect(d).toEqual([{ name: '期末语文', subject: '语文', sort: 0 }]);
  });

  it('科目去重 + trim（重复勾选不会建出两列同名同科目的）', () => {
    const d = subjectColumnDrafts({ name: '期末考试', subjects: [' 语文 ', '语文', '数学'] });
    expect(d.map((x) => x.subject)).toEqual(['语文', '数学']);
  });

  it('含「未指定」（空串）时：它单独一列且不加后缀，与有科目的列并列', () => {
    const d = subjectColumnDrafts({ name: '期末考试', subjects: ['语文', '数学', ''] });
    expect(d).toEqual([
      { name: '期末考试 · 语文', subject: '语文', sort: 0 },
      { name: '期末考试 · 数学', subject: '数学', sort: 1 },
      { name: '期末考试', subject: '', sort: 2 },
    ]);
  });

  it('空串只保留一个（多次「未指定」不会建出多列通用列）', () => {
    const d = subjectColumnDrafts({ name: '期末考试', subjects: ['', '', '无'] });
    expect(d.filter((x) => x.subject === '')).toHaveLength(1);
  });

  it('一个科目都没传 ⇒ 退化成 1 列未指定（不报错、不建出 0 列）', () => {
    expect(subjectColumnDrafts({ name: '期末考试', subjects: [] })).toEqual([
      { name: '期末考试', subject: '', sort: 0 },
    ]);
    expect(subjectColumnDrafts({ name: '期末考试' })).toHaveLength(1);
  });
});

/**
 * 学年 / 学期筛选（2026-09-20）。
 *
 * 这一条防的是**最贵的一类静默错误**：加了筛选之后，没归属的历史列被排除 ⇒
 * 页面上"数据没了"、期末结转跟着少算，而且都不报错。
 */
describe('columnInTerm', () => {
  const col = { year: '2026学年', term: '第一学期' };

  it('页面没选学年学期 ⇒ 全给（老链接/收藏的行为不变）', () => {
    expect(columnInTerm(col, {})).toBe(true);
    expect(columnInTerm(col, { year: '', term: '' })).toBe(true);
  });

  it('学年学期都对 ⇒ 显示', () => {
    expect(columnInTerm(col, { year: '2026学年', term: '第一学期' })).toBe(true);
  });

  it('学年不同 ⇒ 不显示（这正是这一层的价值：别把去年的月考算进这学期）', () => {
    expect(columnInTerm(col, { year: '2025学年', term: '第一学期' })).toBe(false);
  });

  it('学期不同 ⇒ 不显示', () => {
    expect(columnInTerm(col, { year: '2026学年', term: '第二学期' })).toBe(false);
  });

  it('🔴 列的学期是「全学年」⇒ 该学年任何学期都算它', () => {
    const whole = { year: '2026学年', term: '全学年' };
    expect(columnInTerm(whole, { year: '2026学年', term: '第一学期' })).toBe(true);
    expect(columnInTerm(whole, { year: '2026学年', term: '第二学期' })).toBe(true);
    // 但学年仍然要一致
    expect(columnInTerm(whole, { year: '2027学年', term: '第一学期' })).toBe(false);
  });

  it('🔴 未归属的历史列 ⇒ 任何筛选下都显示（否则一筛数据就没了、总评静默少算）', () => {
    const legacy = { year: '', term: '' };
    expect(columnInTerm(legacy, { year: '2026学年', term: '第一学期' })).toBe(true);
    expect(columnInTerm(legacy, { year: '2019学年', term: '第二学期' })).toBe(true);
  });

  it('列只填了一侧（如只填学年）⇒ 不因缺失的那一侧被排除', () => {
    expect(columnInTerm({ year: '2026学年', term: '' }, { year: '2026学年', term: '第一学期' })).toBe(true);
    expect(columnInTerm({ year: '', term: '第一学期' }, { year: '2026学年', term: '第一学期' })).toBe(true);
    // 但填了的那一侧不符，仍然排除
    expect(columnInTerm({ year: '', term: '第二学期' }, { year: '2026学年', term: '第一学期' })).toBe(false);
  });

  it('isUnassignedTerm：两侧都空才算未归属（界面据此标「未归属」）', () => {
    expect(isUnassignedTerm({ year: '', term: '' })).toBe(true);
    expect(isUnassignedTerm({})).toBe(true);
    expect(isUnassignedTerm({ year: '2026学年', term: '' })).toBe(false);
  });
});
