import { describe, expect, it } from 'vitest';
import {
  aggregateByStudent,
  bandOf,
  competitionRanks,
  computeBands,
  gpaBands,
  mean,
  quantile,
  type TermGradeLike,
} from '../src/reports/exam-stats.js';

const row = (over: Partial<TermGradeLike> = {}): TermGradeLike => ({
  studentId: 's1',
  studentName: '张三',
  cls: 'Pre-1',
  subject: '数学',
  total: 80,
  level: 'B',
  levelOrder: 2,
  attained: '达标',
  weightedGpa: 3,
  unweightedGpa: 3,
  count: 3,
  ...over,
});

describe('分数段（边界不能重复计数）', () => {
  it('90 只进第一段，不进 80–89', () => {
    expect(bandOf(90)).toBe('90 分以上');
    expect(bandOf(89.9)).toBe('80–89 分');
  });
  it('60 属于 60–69，59.9 才算不及格段', () => {
    expect(bandOf(60)).toBe('60–69 分');
    expect(bandOf(59.9)).toBe('60 分以下');
  });
  it('空数据返回 5 个 0 段（页面要画得出来）', () => {
    expect(computeBands([]).map((b) => b.count)).toEqual([0, 0, 0, 0, 0]);
  });
  it('各段之和 == 输入条数（不重不漏）', () => {
    const totals = [100, 90, 85, 75, 65, 60, 0, 59];
    const sum = computeBands(totals).reduce((a, b) => a + b.count, 0);
    expect(sum).toBe(totals.length);
  });
});

describe('平均与分位数', () => {
  it('空数组返回 null（不是 0 —— 0 分和"没数据"是两件事）', () => {
    expect(mean([])).toBeNull();
    expect(quantile([], 0.5)).toBeNull();
  });
  it('中位数取线性插值并保留 1 位', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([80, 90], 0.5)).toBe(85);
  });
});

describe('竞赛排名法（1,1,3 而不是 1,1,2）', () => {
  it('同值同名次，下一名跳号', () => {
    const r = competitionRanks([{ v: 3.5 }, { v: 3.5 }, { v: 3.2 }, { v: 3.0 }], (x) => x.v);
    expect(r).toEqual([1, 1, 3, 4]);
  });
  it('null 不参与排名，对应名次也是 null', () => {
    const r = competitionRanks([{ v: null }, { v: 5 }, { v: 3 }], (x) => x.v);
    expect(r).toEqual([null, 1, 2]);
  });
  it('全部为 null 时全 null（未配绩点的场景）', () => {
    expect(competitionRanks([{ v: null }, { v: null }], (x) => x.v)).toEqual([null, null]);
  });
});

describe('按学生聚合（一个学生多科目先合成一行）', () => {
  it('GPA 取各科平均；没配绩点的科目不进平均但计入科目数', () => {
    const rows = [
      row({ subject: '数学', weightedGpa: 4, unweightedGpa: 4, total: 90 }),
      row({ subject: '英语', weightedGpa: 2, unweightedGpa: 2, total: 70 }),
      // 这科没配绩点（null），但仍是一门科目
      row({ subject: '物理', weightedGpa: null, unweightedGpa: null, total: 60 }),
    ];
    const [s] = aggregateByStudent(rows);
    expect(s?.subjectCount).toBe(3);
    expect(s?.gpaSubjectCount).toBe(2);
    expect(s?.weightedGpa).toBe(3); // (4+2)/2，不是 (4+2+0)/3
    expect(s?.avgTotal).toBe(73.3);
  });

  it('全部没配绩点 ⇒ GPA 为 null（页面显示"未配置"而不是 0.00）', () => {
    const [s] = aggregateByStudent([row({ weightedGpa: null }), row({ subject: '英语', weightedGpa: null })]);
    expect(s?.weightedGpa).toBeNull();
    expect(s?.gpaSubjectCount).toBe(0);
  });

  it('代表等级取最好的一条（序号小者优），不是第一条', () => {
    const rows = [row({ subject: '数学', level: 'C', levelOrder: 3 }), row({ subject: '英语', level: 'A', levelOrder: 1 })];
    expect(aggregateByStudent(rows)[0]?.level).toBe('A');
  });

  it('达标科目数按「达标」逐条统计', () => {
    const rows = [row({ attained: '达标' }), row({ attained: '未达标' }), row({ attained: '达标' })];
    expect(aggregateByStudent(rows)[0]?.attainedCount).toBe(2);
  });

  it('多个学生各自一行，互不串味', () => {
    const rows = [
      row({ studentId: 'a', studentName: 'A', weightedGpa: 4 }),
      row({ studentId: 'b', studentName: 'B', weightedGpa: 2 }),
    ];
    const out = aggregateByStudent(rows);
    expect(out.map((x) => x.studentName)).toEqual(['A', 'B']);
    expect(out.map((x) => x.weightedGpa)).toEqual([4, 2]);
  });
});

describe('GPA 分段', () => {
  it('4.0 / 3.0 / 2.0 的边界落进较高一段', () => {
    const out = gpaBands([4.0, 3.0, 2.0, 1.0]);
    expect(out.find((b) => b.label === '3.5 以上')?.count).toBe(1); // 4.0
    expect(out.find((b) => b.label === '3.0–3.5')?.count).toBe(1); // 3.0
    expect(out.find((b) => b.label === '2.0–2.5')?.count).toBe(1); // 2.0
    expect(out.find((b) => b.label === '2.0 以下')?.count).toBe(1); // 1.0
  });
});
