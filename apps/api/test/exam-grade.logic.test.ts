import { describe, expect, it } from 'vitest';
import {
  ABSENT_MODES,
  EXCUSED_MODES,
  ROUND_MODES,
  computeGpa,
  computeTermGrade,
  detectAnomalies,
  parseScoreInput,
  pickMode,
  rankTermGrades,
  roundBy,
  termGradeKey,
  type LevelDef,
  type TermGradeItem,
} from '../src/exam-grade/exam-grade.logic.js';

/** 与 markbook 共用的等级体系：A(90-100) B(80-89) C(70-79) D(60-69) E(0-59) */
const LEVELS: LevelDef[] = [
  { id: 'a', scaleId: 's', label: 'A', order: 1, min: 90, max: 100, concern: false },
  { id: 'b', scaleId: 's', label: 'B', order: 2, min: 80, max: 89, concern: false },
  { id: 'c', scaleId: 's', label: 'C', order: 3, min: 70, max: 79, concern: false },
  { id: 'd', scaleId: 's', label: 'D', order: 4, min: 60, max: 69, concern: false },
  { id: 'e', scaleId: 's', label: 'E', order: 5, min: 0, max: 59, concern: true },
];

// ───────────────────────── 输入解析 ─────────────────────────

/**
 * `pickMode`：把批次/设置里存的档位文本归一为合法枚举。
 *
 * 加它的原因是一个**静默算反**的坑：这三个档位现在由字典供候选，运营把
 * 「不计入分母」改成别的写法后，`=== '不计入分母'` 判假 ⇒ 免考反而被算进分母，
 * 且不报错。归一后未知值回落下一级，至少不会算反。
 */
describe('pickMode（档位归一）', () => {
  it('合法值原样返回', () => {
    expect(pickMode('不计入分母', EXCUSED_MODES)).toBe('不计入分母');
    expect(pickMode('计0分', ABSENT_MODES)).toBe('计0分');
    expect(pickMode('向上取整', ROUND_MODES)).toBe('向上取整');
  });

  it('空值 / 空白 / null / undefined → 空串（由调用方回落下一级）', () => {
    expect(pickMode('', ROUND_MODES)).toBe('');
    expect(pickMode('   ', ROUND_MODES)).toBe('');
    expect(pickMode(null, ROUND_MODES)).toBe('');
    expect(pickMode(undefined, ROUND_MODES)).toBe('');
  });

  it('🔴 未知文案 → 空串（**不能**原样通过：原样通过会让口径算反）', () => {
    expect(pickMode('不计分母', EXCUSED_MODES)).toBe('');
    expect(pickMode('记0分', ABSENT_MODES)).toBe('');
    expect(pickMode('四舍五入 ', ROUND_MODES)).toBe('四舍五入'); // 首尾空白会被 trim
  });
});

describe('parseScoreInput', () => {
  it('普通数字原样通过', () => {
    const r = parseScoreInput('78', { fullMark: 100 });
    expect(r.ok).toBe(true);
    expect(r.score).toBe(78);
    expect(r.status).toBe('正常');
  });

  it('空 = 未录入（不是 0、不是免考）', () => {
    const r = parseScoreInput('   ', { fullMark: 100 });
    expect(r).toMatchObject({ ok: true, score: null, status: '正常' });
  });

  it('支持百分比，按满分折算', () => {
    expect(parseScoreInput('85%', { fullMark: 50 }).score).toBe(42.5);
    expect(parseScoreInput('85％', { fullMark: 20 }).score).toBe(17);
  });

  it('支持字母等级，折成等级区间中位', () => {
    const r = parseScoreInput('B', { fullMark: 100, levels: LEVELS });
    expect(r.ok).toBe(true);
    expect(r.score).toBe(84.5); // (80+89)/2
  });

  it('字母等级容忍大小写与全角加号', () => {
    const withPlus: LevelDef[] = [
      ...LEVELS,
      { id: 'bp', scaleId: 's', label: 'B+', order: 2, min: 85, max: 89, concern: false },
    ];
    expect(parseScoreInput('b+', { fullMark: 100, levels: withPlus }).score).toBe(87);
    expect(parseScoreInput('b＋', { fullMark: 100, levels: withPlus }).score).toBe(87);
    // 等级体系里没有的字母 → 报错而不是静默变 null
    expect(parseScoreInput('Z', { fullMark: 100, levels: LEVELS }).ok).toBe(false);
  });

  it('* 与「免」= 免考，得分为空', () => {
    expect(parseScoreInput('*', { fullMark: 100 })).toMatchObject({ ok: true, score: null, status: '免考' });
    expect(parseScoreInput('免考', { fullMark: 100 })).toMatchObject({ ok: true, score: null, status: '免考' });
    expect(parseScoreInput('EX', { fullMark: 100 }).status).toBe('免考');
  });

  it('「缺」= 缺考，按 0 分算但状态不同', () => {
    const r = parseScoreInput('缺', { fullMark: 100 });
    expect(r).toMatchObject({ ok: true, score: 0, status: '缺考' });
  });

  it('负数归 0 并给出 warning（RosarioSIS 口径）', () => {
    const r = parseScoreInput('-5', { fullMark: 100 });
    expect(r.ok).toBe(true);
    expect(r.score).toBe(0);
    expect(r.warning).toContain('负数');
  });

  it('超过满分按满分截断并给出 warning', () => {
    const r = parseScoreInput('120', { fullMark: 100 });
    expect(r.score).toBe(100);
    expect(r.warning).toContain('截断');
  });

  it('非法输入必须报错、且不返回分数（不能静默变 null）', () => {
    const r = parseScoreInput('八十八', { fullMark: 100 });
    expect(r.ok).toBe(false);
    expect(r.score).toBeNull();
    expect(r.error).toBeTruthy();
    expect(r.display).toBe('八十八'); // 保留原值供前端回显
  });

  it('全角数字归一化', () => {
    expect(parseScoreInput('７８', { fullMark: 100 }).score).toBe(78);
  });

  it('满分缺失时按 100 兜底', () => {
    const r = parseScoreInput('200', {});
    expect(r.score).toBe(100);
  });
});

// ───────────────────────── 舍入 ─────────────────────────

describe('roundBy', () => {
  it('各口径', () => {
    expect(roundBy('四舍五入', 82.48)).toBe(82);
    expect(roundBy('四舍五入', 82.5)).toBe(83);
    expect(roundBy('向上取整', 82.1)).toBe(83);
    expect(roundBy('向下取整', 82.9)).toBe(82);
    expect(roundBy('保留1位小数', 82.456)).toBe(82.5);
    expect(roundBy('不处理', 82.456)).toBe(82.46);
  });
  it('null 透传', () => {
    expect(roundBy('四舍五入', null)).toBeNull();
  });
});

// ───────────────────────── 结转 ─────────────────────────

function item(over: Partial<TermGradeItem> = {}): TermGradeItem {
  return {
    columnId: 'c1',
    columnName: '考核一',
    typeName: '作业',
    subject: '数学',
    fullMark: 100,
    weight: 1,
    score: 80,
    status: '正常',
    ...over,
  };
}

describe('computeTermGrade', () => {
  it('自归一化：分母只算有值项', () => {
    const r = computeTermGrade([
      item({ columnId: 'c1', score: 90, weight: 1, fullMark: 100 }),
      item({ columnId: 'c2', score: 70, weight: 1, fullMark: 100 }),
      item({ columnId: 'c3', score: null, weight: 5, fullMark: 100 }), // 未录入，不进分母
    ]);
    expect(r.total).toBe(80);
    expect(r.count).toBe(2);
    expect(r.weightSum).toBe(2);
  });

  it('不同满分先归一化再加权', () => {
    const r = computeTermGrade([
      item({ columnId: 'c1', score: 18, fullMark: 20, weight: 1 }), // 90
      item({ columnId: 'c2', score: 30, fullMark: 50, weight: 1 }), // 60
    ]);
    expect(r.total).toBe(75);
  });

  it('免考默认不进分母（不会拉低总评）', () => {
    const r = computeTermGrade([
      item({ columnId: 'c1', score: 90, weight: 1 }),
      item({ columnId: 'c2', score: null, status: '免考', weight: 3 }),
    ]);
    expect(r.total).toBe(90);
    expect(r.weightSum).toBe(1);
    expect(r.excusedCount).toBe(1);
  });

  it('批次口径设为「计0分」时免考按 0 进分母', () => {
    const r = computeTermGrade(
      [item({ columnId: 'c1', score: 90, weight: 1 }), item({ columnId: 'c2', score: null, status: '免考', weight: 1 })],
      { excused: '计0分' },
    );
    expect(r.total).toBe(45);
    expect(r.weightSum).toBe(2);
  });

  it('缺考默认按 0 分进分母（要扣分）', () => {
    const r = computeTermGrade([
      item({ columnId: 'c1', score: 90, weight: 1 }),
      item({ columnId: 'c2', score: 0, status: '缺考', weight: 1 }),
    ]);
    expect(r.total).toBe(45);
    expect(r.count).toBe(2);
    expect(r.absentCount).toBe(1);
  });

  it('批次口径设为「不计入分母」时缺考跳过', () => {
    const r = computeTermGrade(
      [item({ columnId: 'c1', score: 90, weight: 1 }), item({ columnId: 'c2', score: 0, status: '缺考', weight: 1 })],
      { absent: '不计入分母' },
    );
    expect(r.total).toBe(90);
  });

  it('全都没值时总评为 null（不是 0）', () => {
    const r = computeTermGrade([item({ score: null }), item({ columnId: 'c2', score: null })]);
    expect(r.total).toBeNull();
    expect(r.level).toBe('');
  });

  it('映射等级与达标（序号越小越好）', () => {
    const r = computeTermGrade([item({ score: 82 })], { levels: LEVELS, targetOrder: 2 });
    expect(r.level).toBe('B');
    expect(r.levelOrder).toBe(2);
    expect(r.attained).toBe('达标');

    const r2 = computeTermGrade([item({ score: 75 })], { levels: LEVELS, targetOrder: 2 });
    expect(r2.level).toBe('C');
    expect(r2.attained).toBe('未达标');
  });

  it('未设目标时达标为空串（不误判）', () => {
    const r = computeTermGrade([item({ score: 75 })], { levels: LEVELS });
    expect(r.attained).toBe('');
  });

  it('E 档带 concern 标记', () => {
    const r = computeTermGrade([item({ score: 40 })], { levels: LEVELS });
    expect(r.level).toBe('E');
    expect(r.concern).toBe(true);
  });

  it('明细带逐项贡献，便于前端展示「怎么算的」', () => {
    const r = computeTermGrade([
      item({ columnId: 'c1', columnName: '作业', score: 90, weight: 1 }),
      item({ columnId: 'c2', columnName: '期中', score: 70, weight: 3 }),
    ]);
    expect(r.details).toHaveLength(2);
    expect(r.details[0].contribution).toBe(90);
    expect(r.details[1].contribution).toBe(210);
    expect(r.total).toBe(75);
  });

  it('舍入口径生效', () => {
    const r = computeTermGrade([item({ score: 82.4 })], { round: '四舍五入' });
    expect(r.total).toBe(82);
  });
});

// ───────────────────────── 排名 ─────────────────────────

describe('rankTermGrades', () => {
  it('竞赛排名法：同分同名次、下一名跳号', () => {
    const { ranks, total } = rankTermGrades([
      { id: 'a', total: 93 },
      { id: 'b', total: 88 },
      { id: 'c', total: 88 },
      { id: 'd', total: 80 },
    ]);
    expect(ranks.get('a')).toBe(1);
    expect(ranks.get('b')).toBe(2);
    expect(ranks.get('c')).toBe(2);
    expect(ranks.get('d')).toBe(4); // 跳号
    expect(total).toBe(4);
  });

  it('null 总评不参与排名', () => {
    const { ranks, total } = rankTermGrades([
      { id: 'a', total: 90 },
      { id: 'b', total: null },
    ]);
    expect(ranks.has('b')).toBe(false);
    expect(total).toBe(1);
  });
});

// ───────────────────────── GPA ─────────────────────────

describe('computeGpa', () => {
  it('加权与不加权', () => {
    const r = computeGpa([
      { points: 4, weight: 1 },
      { points: 3, weight: 3 },
    ]);
    expect(r.weighted).toBe(3.25); // (4*1+3*3)/4
    expect(r.unweighted).toBe(3.5);
    expect(r.subjectCount).toBe(2);
    expect(r.hasAnyPoints).toBe(true);
  });

  it('不计入 GPA 的科目被排除', () => {
    const r = computeGpa([
      { points: 4, weight: 1 },
      { points: 0, weight: 1, counted: false },
    ]);
    expect(r.weighted).toBe(4);
    expect(r.subjectCount).toBe(1);
  });

  it('一个绩点都没配时返回 null 并明确 hasAnyPoints=false', () => {
    const r = computeGpa([{ points: null, weight: 1 }]);
    expect(r.weighted).toBeNull();
    expect(r.hasAnyPoints).toBe(false);
  });
});

// ───────────────────────── 异常审查 ─────────────────────────

describe('detectAnomalies', () => {
  const base = {
    entryId: 'e1',
    columnId: 'c1',
    columnName: '向量小测',
    studentId: 's1',
    studentName: '王砚舟',
    fullMark: 30,
    status: '正常' as const,
    classAvg: 62,
    historyAvg: null,
  };

  it('R1 超满分', () => {
    const hits = detectAnomalies({ ...base, score: 32 });
    expect(hits.map((h) => h.rule)).toContain('R1 超满分');
  });

  it('R2 零分（正常状态下）', () => {
    const hits = detectAnomalies({ ...base, score: 0, classAvg: 78 });
    expect(hits.map((h) => h.rule)).toContain('R2 零分');
  });

  it('R2 不误报缺考', () => {
    const hits = detectAnomalies({ ...base, score: 0, status: '缺考', classAvg: 78 });
    expect(hits.map((h) => h.rule)).not.toContain('R2 零分');
  });

  it('R3 离群高', () => {
    const hits = detectAnomalies({ ...base, score: 28 }); // 93.3 vs 62*1.5=93
    expect(hits.map((h) => h.rule)).toContain('R3 离群高');
  });

  it('R3 不误报满分（满分走 R1 边界外的正常情况）', () => {
    const hits = detectAnomalies({ ...base, score: 30 }); // 100，pct<100 不成立
    expect(hits.map((h) => h.rule)).not.toContain('R3 离群高');
  });

  it('R4 离群低', () => {
    const hits = detectAnomalies({ ...base, fullMark: 50, score: 15, classAvg: 78 });
    expect(hits.map((h) => h.rule)).toContain('R4 离群低');
  });

  it('R5 突变（与本人历史均值比）', () => {
    const hits = detectAnomalies({ ...base, fullMark: 100, score: 82, classAvg: 74.5, historyAvg: 46 });
    expect(hits.map((h) => h.rule)).toContain('R5 突变');
  });

  it('班级均值样本不足时不触发离群规则', () => {
    const hits = detectAnomalies({ ...base, score: 28, classAvg: null });
    expect(hits.map((h) => h.rule).some((r) => r.startsWith('R3') || r.startsWith('R4'))).toBe(false);
  });

  it('阈值可调', () => {
    const strict = detectAnomalies({ ...base, score: 28 }, { highFactor: 2, lowFactor: 0.5, swingScore: 30 });
    expect(strict.map((h) => h.rule)).not.toContain('R3 离群高');
  });

  it('空值不报异常', () => {
    expect(detectAnomalies({ ...base, score: null })).toHaveLength(0);
  });
});

// ───────────────────────── 幂等键 ─────────────────────────

describe('termGradeKey', () => {
  it('批次 + 学生 + 科目', () => {
    expect(termGradeKey('b1', 's1', '数学')).toBe('b1__s1__数学');
    expect(termGradeKey('b1', 's1', '')).toBe('b1__s1__');
  });
});
