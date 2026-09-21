/**
 * 「使用统计」报表的聚合与归一判据测试（2026-09-21）。
 *
 * 三个必须钉死的口径（写错任何一个，报表都会"看起来对、实际错"）：
 *   ① **同一个人的多种写法必须归并成一个人**：生产实测审计日志里
 *      `孙旭峰` / `孙旭峰｜Richard` / `Richard` 三种写法合计占 73%；
 *   ② **系统任务与测试账号要单独归组**，不能混进「人」里（`验证探针` 61 次等）；
 *   ③ 矩阵的**行合计之和 = 列合计之和 = total**，且空值恒排最后、不消失。
 */
import { describe, expect, it } from 'vitest';
import { MODULE_RESOURCES } from '@acms/contracts';
import {
  SYSTEM_ACTOR,
  UNFILLED,
  buildActorDetail,
  buildActorNormalizer,
  buildMatrix,
  buildModuleLabelResolver,
  isSystemActor,
  knownNamesOf,
  normalizeActorName,
} from '../src/reports/usage-agg.js';

// 取自生产「系统用户表」的真实写法（含尾部空格的脏值）
const NAMES = [
  '孙旭峰｜Richard',
  '刘攀扬｜Amy',
  '刘佳音 ',
  '吴洁｜Joyce',
  '郝瑞玲｜Rin',
  '蒋潘云 ',
  '赵奕嘉 ',
];

describe('人员归一（「同一个人三种写法」是这张报表最容易错的地方）', () => {
  const norm = buildActorNormalizer(NAMES);

  it('中文全名 → 标准姓名（原样）', () => {
    expect(norm('孙旭峰')).toBe('孙旭峰｜Richard');
  });

  it('中文全名带分隔符 → 标准姓名', () => {
    expect(norm('孙旭峰｜Richard')).toBe('孙旭峰｜Richard');
  });

  it('只有英文名 → 归到那个人（按「｜」拆段匹配）', () => {
    expect(norm('Richard')).toBe('孙旭峰｜Richard');
    expect(norm('Amy')).toBe('刘攀扬｜Amy');
    expect(norm('Rin')).toBe('郝瑞玲｜Rin');
  });

  it('半角竖线 / 斜杠 / 空格都算同一种写法', () => {
    expect(norm('孙旭峰|Richard')).toBe('孙旭峰｜Richard');
    expect(norm('孙旭峰 / Richard')).toBe('孙旭峰｜Richard');
    expect(norm(' 孙旭峰 ｜ Richard ')).toBe('孙旭峰｜Richard');
  });

  it('🔴 尾部空格不产生第二个人（生产数据里 `刘佳音 ` 就是脏值）', () => {
    expect(norm('刘佳音')).toBe(norm('刘佳音 '));
    expect(norm('刘佳音')).toBe('刘佳音');
  });

  it('用户表里没有的名字 → 保留原名（不丢数据、不猜）', () => {
    expect(norm('校外顾问张三')).toBe('校外顾问张三');
  });

  it('空值 → 「（未填写）」，不是空字符串（否则会造出一个名字为空的"人"）', () => {
    expect(norm('')).toBe(UNFILLED);
    expect(norm('   ')).toBe(UNFILLED);
    expect(norm(undefined)).toBe(UNFILLED);
  });

  it('🔴 段匹配有多个人时**不合并**（宁可多一行，也不能把两个人的量并成一个人）', () => {
    const dup = buildActorNormalizer(['甲｜Amy', '乙｜Amy']);
    expect(dup('Amy')).toBe('Amy');
  });

  it('用户表为空时不报错，全部保留原值', () => {
    const none = buildActorNormalizer([]);
    expect(none('孙旭峰')).toBe('孙旭峰');
  });

  it('清洗函数与归一结论一致（分隔符统一成全角「｜」）', () => {
    expect(normalizeActorName(' 甲 | 乙 ')).toBe('甲｜乙');
    expect(normalizeActorName('甲\u3000乙')).toBe('甲乙');
  });

  it('knownNamesOf 去掉空串（避免用「空姓名」污染索引）', () => {
    expect(knownNamesOf(['甲', ' ', '乙'])).toEqual(['甲', '乙']);
  });
});

describe('系统任务 / 测试账号的识别', () => {
  it.each(['系统 · 行为告警重算', '系统任务', '验证探针', '探针', '测试账号', 'forge', 'adm', 'admin', 'cron 同步'])(
    '%s → 系统组',
    (raw) => expect(isSystemActor(raw)).toBe(true),
  );

  it.each(['孙旭峰', '郝瑞玲｜Rin', '刘攀扬｜Amy', 'Arete Developer'])(
    '%s → 真人（不能被误并进系统组）',
    (raw) => expect(isSystemActor(raw)).toBe(false),
  );

  it('归一函数把系统任务折成同一行', () => {
    const norm = buildActorNormalizer(NAMES);
    expect(norm('验证探针')).toBe(SYSTEM_ACTOR);
    expect(norm('系统 · 行为告警重算')).toBe(SYSTEM_ACTOR);
  });

  it('明细文本列出各写法与次数（只有一种写法时不显示，避免噪音）', () => {
    expect(buildActorDetail(new Map([['验证探针', 61], ['探针', 10]]))).toBe('验证探针 61 · 探针 10');
    expect(buildActorDetail(new Map([['探针', 10]]))).toBe('');
    expect(buildActorDetail(new Map())).toBe('');
  });
});

describe('矩阵构建', () => {
  const items = [
    { row: '刘攀扬｜Amy', col: '日常跟进' },
    { row: '刘攀扬｜Amy', col: '日常跟进' },
    { row: '刘攀扬｜Amy', col: '家校沟通' },
    { row: '徐洁｜Stefanie', col: '学生观察' },
    { row: '', col: '学生观察' }, // 记录人没填
  ];

  it('行列计数正确，且**行合计之和 = 列合计之和 = total**', () => {
    const m = buildMatrix(items);
    expect(m.total).toBe(5);
    expect(m.rows.reduce((s, r) => s + r.total, 0)).toBe(m.total);
    expect(m.colTotals.reduce((s, c) => s + c, 0)).toBe(m.total);
    expect(m.rows[0]).toMatchObject({ label: '刘攀扬｜Amy', total: 3 });
  });

  it('每个 cell 与 cols 一一对应（行内数组长度必须等于列数）', () => {
    const m = buildMatrix(items);
    for (const r of m.rows) expect(r.cells).toHaveLength(m.cols.length);
    for (const r of m.rows) expect(r.cells.reduce((s, c) => s + c, 0)).toBe(r.total);
  });

  it('行列均按合计降序', () => {
    const m = buildMatrix(items);
    expect(m.rows[0].label).toBe('刘攀扬｜Amy');
    expect(m.cols[0]).toBe('日常跟进'); // 2 > 1
  });

  it('🔴 空值行**排在最后**，且不因数量不小而挤到前面', () => {
    const m = buildMatrix([
      { row: '', col: 'X' },
      { row: '', col: 'X' },
      { row: '', col: 'X' },
      { row: '甲', col: 'X' },
    ]);
    expect(m.rows[m.rows.length - 1].label).toBe(UNFILLED);
    expect(m.rows[m.rows.length - 1].total).toBe(3);
  });

  it('空值列也保留（「有没有人没填」必须看得见）', () => {
    const m = buildMatrix([{ row: '甲', col: '' }, { row: '甲', col: 'X' }]);
    expect(m.cols).toContain(UNFILLED);
    expect(m.colTotals[m.cols.indexOf(UNFILLED)]).toBe(1);
  });

  it('空输入 → 全零矩阵（不抛错，界面显示"没有记录"而不是崩）', () => {
    const m = buildMatrix([]);
    expect(m).toEqual({ cols: [], rows: [], colTotals: [], total: 0 });
  });

  it('同一份数据两次构建顺序一致（排序必须稳定，否则每次刷新都在跳）', () => {
    const a = buildMatrix(items);
    const b = buildMatrix([...items].reverse());
    expect(a.rows.map((r) => r.label)).toEqual(b.rows.map((r) => r.label));
    expect(a.cols).toEqual(b.cols);
  });
});

describe('审计「业务模块」翻中文名', () => {
  const resolve = buildModuleLabelResolver(MODULE_RESOURCES);

  it('生产实测的 Top 模块能翻成中文（审计存的是接口路径段）', () => {
    // 直接从资源目录里挑一个真实存在、且 label 是中文的模块，避免把断言写死成易变的文案
    const sample = MODULE_RESOURCES.find((r) => r.path.startsWith('/') && /[\u4e00-\u9fa5]/.test(r.label));
    expect(sample).toBeTruthy();
    if (sample) {
      expect(resolve(sample.path.replace(/^\//, ''))).toBe(sample.label);
      expect(resolve(sample.path)).toBe(sample.label);
    }
  });

  it('大小写 / 前导斜杠 / 查询串都容错', () => {
    expect(resolve('/users')).toBe(resolve('users'));
    expect(resolve('USERS')).toBe(resolve('users'));
    expect(resolve('users?foo=1')).toBe(resolve('users'));
  });

  it('目录里没有的路径 → 原样返回（显示原值比显示「未知」更有用）', () => {
    expect(resolve('some-unknown-path')).toBe('some-unknown-path');
  });

  it('空值 → 空串（交给矩阵归到「（未填写）」）', () => {
    expect(resolve('')).toBe('');
    expect(resolve(undefined)).toBe('');
  });
});
