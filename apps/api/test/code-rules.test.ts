/**
 * 「代码规则」（v14，2026-10-01）的守卫测试。
 *
 * 背景（峰哥）：把"学籍号这类编号怎么生成"从代码里拿出来，做成后台可配页面。
 * 判据与生成器在 `packages/contracts/src/code-rules.ts`（前后端共用一份）。
 *
 * 🔴 本文件最重要的一条：**默认规则必须能逐条复现生产存量学籍号**。
 *    为什么关键：学籍号是**学生与家长的登录凭证**，而"已生成的号绝不追溯修改"
 *    ⇒ 如果默认规则跟存量格式不一致，新建的学生会拿到**另一套格式**的号，
 *    两套格式长期并存、且没有任何报错。
 *
 * 🔴 默认规则不是拍脑袋写的、也不是照抄设计稿里的 `AR-26秋-B-0001`（那是假设值）——
 *    是**从生产 84 条只读盘点里逆推出来的**（82/82 一致）：
 *    `[入学年份取后2位][入学年月→FA|SP][-][入学年级→项目码][-][流水3位]`
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CODE_RULE_CONFIG,
  DEFAULT_STUDENT_NO_RULE,
  MODULE_RESOURCES,
  MODULE_RESOURCE_INTRODUCED_VERSION,
  ROLE_PERMISSION_VERSION,
  codeRuleConflicts,
  codeRuleFor,
  codeRulesVisible,
  cycleKeyOf,
  fieldValueOf,
  formatDatePart,
  generateCode,
  mapFieldValue,
  normalizeCodeRuleConfig,
  type CodeRule,
} from '@acms/contracts';

// ── 生产夹具（2026-10-01 只读盘点：84 条里挑 34 条，覆盖 18 种「学期×入学年级」组合） ──
// ⚠️ 另有 2 条（`26FA-FEP-003` 李东霖 / `26FA-P3-005` 庄心怡）的「入学年级」字段是空的
//    ⇒ 输入缺失，无法复现（这是数据缺口，不是规则问题），故不进夹具。
const FIXTURE: { code: string; year: string; term: string; grade: string }[] = [
  { code: '23FA-P1-001', year: '2023', term: '23秋季', grade: 'Pre-1' },
  { code: '24FA-P1-001', year: '2024', term: '24秋季', grade: 'G10' },
  { code: '24FA-P1-002', year: '2024', term: '24秋季', grade: 'Pre-1' },
  { code: '24FA-P1-003', year: '2024', term: '24秋季', grade: 'Pre-1' },
  { code: '24FA-P1-008', year: '2024', term: '24秋季', grade: 'Pre-1' },
  { code: '25FA-P1-001', year: '2025', term: '25秋季', grade: 'Pre-1' },
  { code: '25FA-P1-002', year: '2025', term: '25秋季', grade: 'Pre-1' },
  { code: '25FA-P1-008', year: '2025', term: '25秋季', grade: 'Pre-1' },
  { code: '25FA-P2-001', year: '2025', term: '25秋季', grade: 'Pre-2' },
  { code: '25FA-P2-002', year: '2025', term: '25秋季', grade: 'Pre-2' },
  { code: '25FA-P3-001', year: '2025', term: '25秋季', grade: 'Pre-3' },
  { code: '25SP-P1-001', year: '2025', term: '25春季', grade: 'Pre-1' },
  { code: '26FA-FEP-001', year: '2026', term: '26秋季', grade: '未来企业家班' },
  { code: '26FA-FEP-002', year: '2026', term: '26秋季', grade: '未来企业家班' },
  { code: '26FA-P1-001', year: '2026', term: '26秋季', grade: 'Pre-1' },
  { code: '26FA-P1-002', year: '2026', term: '26秋季', grade: 'Pre-1' },
  { code: '26FA-P1-008', year: '2026', term: '26秋季', grade: 'Pre-1' },
  { code: '26FA-P1-025', year: '2026', term: '26秋季', grade: 'Pre-1' },
  { code: '26FA-P2-001', year: '2026', term: '26秋季', grade: 'Pre-2' },
  { code: '26FA-P2-002', year: '2026', term: '26秋季', grade: 'Pre-2' },
  { code: '26FA-P3-001', year: '2026', term: '26秋季', grade: 'Pre-3' },
  { code: '26FA-P3-002', year: '2026', term: '26秋季', grade: 'Pre-3' },
  { code: '26FA-Y1-001', year: '2026', term: '26秋季', grade: '大一' },
  { code: '26FA-Y1-002', year: '2026', term: '26秋季', grade: '大一' },
  { code: '26SP-FEP-001', year: '2026', term: '26春季', grade: '未来企业家班' },
  { code: '26SP-GP-001', year: '2026', term: '26春季', grade: '全球领航计划' },
  { code: '26SP-GP-002', year: '2026', term: '26春季', grade: '全球领航计划' },
  { code: '26SP-P1-001', year: '2026', term: '26春季', grade: 'Pre-1' },
  { code: '26SP-P1-002', year: '2026', term: '26春季', grade: 'Pre-1' },
  { code: '26SP-P1-008', year: '2026', term: '26春季', grade: 'Pre-1' },
  { code: '26SP-P2-001', year: '2026', term: '26春季', grade: 'Pre-2' },
  { code: '26SP-P2-002', year: '2026', term: '26春季', grade: 'Pre-2' },
  { code: '26SP-P3-001', year: '2026', term: '26春季', grade: 'Pre-3' },
  { code: '26SP-P3-002', year: '2026', term: '26春季', grade: 'Pre-3' },
  { code: '26SP-Y1-001', year: '2026', term: '26春季', grade: '大一' },
];

const prefixOf = (code: string) => code.slice(0, code.lastIndexOf('-'));
const serialOf = (code: string) => Number(code.slice(code.lastIndexOf('-') + 1));

/** 一个固定的"现在"（试算要可复现；学期语义由夹具字段决定，与它无关） */
const NOW = Date.parse('2026-10-01T12:00:00+08:00');

const fieldsOf = (r: { year: string; term: string; grade: string }) => ({
  入学年份: r.year,
  入学年月: r.term,
  入学年级: r.grade,
});

describe('🔴 默认规则必须逐条复现生产存量学籍号', () => {
  it('34 条样本、18 种「学期×入学年级」组合，逐条复现', () => {
    const failures: string[] = [];
    for (const row of FIXTURE) {
      const prefix = prefixOf(row.code);
      const serial = serialOf(row.code);
      /*
       * 该流水线里"本条之前"的号。
       *
       * 🔴 必须**补齐成连续的 001..(serial-1)**，不能只用夹具里的那几条 ——
       *    夹具是**抽样**（每组只取了 001/002/003/008 这种），少掉中间号会让
       *    "取最大+1"算出的下一个号偏小（`24FA-P1-008` 被算成 `…-004`）。
       *    生产里这些号是连续的（人工按顺序发），补全才等于真实输入。
       *    （这条我第一版写错了，看到 5 条"复现失败"才发现是夹具抽样的问题。）
       */
      const existing = Array.from({ length: Math.max(0, serial - 1) }, (_, i) => `${prefix}-${String(i + 1).padStart(3, '0')}`);
      const got = generateCode(DEFAULT_STUDENT_NO_RULE, { nowMs: NOW, fields: fieldsOf(row), existing });
      if (got.code !== row.code) {
        failures.push(`${row.code}（入学年份=${row.year} 入学年月=${row.term} 入学年级=${row.grade}）→ 生成 ${got.code}${got.reason ? `（${got.reason}）` : ''}`);
      }
    }
    expect(failures, `以下存量学籍号复现失败：\n${failures.join('\n')}`).toEqual([]);
  });

  it('每组的下一个号 = 该组当前最大流水 + 1（「取最大+1」语义，有空洞也不复用）', () => {
    const groups = new Map<string, string[]>();
    for (const r of FIXTURE) {
      const p = prefixOf(r.code);
      groups.set(p, [...(groups.get(p) ?? []), r.code]);
    }
    for (const [prefix, codes] of groups) {
      const max = Math.max(...codes.map(serialOf));
      const expectNext = `${prefix}-${String(max + 1).padStart(3, '0')}`;
      const row = FIXTURE.find((x) => prefixOf(x.code) === prefix)!;
      const got = generateCode(DEFAULT_STUDENT_NO_RULE, { nowMs: NOW, fields: fieldsOf(row), existing: codes });
      expect(got.code, `${prefix} 组下一个号`).toBe(expectNext);
    }
    // 有空洞（001/003）⇒ 下一个是 004，而不是回填 002 —— 复用空洞里的号会撞上"已删除
    // 记录的旧号"，而学籍号是登录凭证，宁可跳号
    const gap = generateCode(DEFAULT_STUDENT_NO_RULE, {
      nowMs: NOW,
      fields: { 入学年份: '2026', 入学年月: '26秋季', 入学年级: 'Pre-1' },
      existing: ['26FA-P1-001', '26FA-P1-003'],
    });
    expect(gap.code).toBe('26FA-P1-004');
  });

  it('流水线是「同前缀」而不是全局：换一学期/换一项目码就重新从 001 起', () => {
    const got = generateCode(DEFAULT_STUDENT_NO_RULE, {
      nowMs: NOW,
      // ⚠️ 字段必须与期望的号一致：26春季 + Pre-2 ⇒ 前缀 `26SP-P2`
      fields: { 入学年份: '2026', 入学年月: '26春季', 入学年级: 'Pre-2' },
      // 26FA-P1 已经有 25 个号，但新开的 26SP-P2 不该接着 26
      existing: Array.from({ length: 25 }, (_, i) => `26FA-P1-${String(i + 1).padStart(3, '0')}`),
    });
    expect(got.code).toBe('26SP-P2-001');
  });

  it('🔴 段之间不插多余分隔符（`26FA-P1-001` 而不是 `26-FA-P1-001`）', () => {
    // 「年+学期」是连在一起的，靠显式文本段表达分隔；若用"所有段之间都插 -"会生成错号
    expect(DEFAULT_STUDENT_NO_RULE.separator).toBe('');
    const got = generateCode(DEFAULT_STUDENT_NO_RULE, {
      nowMs: NOW,
      fields: { 入学年份: '2026', 入学年月: '26秋季', 入学年级: 'Pre-1' },
      existing: [],
    });
    expect(got.code).toBe('26FA-P1-001');
    expect(got.code).not.toContain('--');
  });

  it('默认配置里「学生编号」规则存在但**停用**（K5）', () => {
    const studentCode = codeRuleFor({ ...DEFAULT_CODE_RULE_CONFIG, rules: DEFAULT_CODE_RULE_CONFIG.rules.map((r) => ({ ...r, enabled: true })) }, 'studentProfile', '学生编号');
    // 上面那行是"假装全启用"来证明它确实存在于配置里；真正的断言在下面
    expect(studentCode).toBeTruthy();
    const real = DEFAULT_CODE_RULE_CONFIG.rules.find((r) => r.key === 'studentCode')!;
    expect(real.enabled).toBe(false);
    const noRule = codeRuleFor(DEFAULT_CODE_RULE_CONFIG, 'studentProfile', '学生编号');
    expect(noRule, '停用的规则不该被 codeRuleFor 命中（否则会自动生成）').toBeNull();
  });
});

describe('生成器：撞号 / 退化 / 边界', () => {
  it('撞号策略 next ⇒ 往后跳到第一个没被占用的号（允许跳号，K3）', () => {
    const got = generateCode(DEFAULT_STUDENT_NO_RULE, {
      nowMs: NOW,
      fields: { 入学年份: '2026', 入学年月: '26秋季', 入学年级: 'Pre-1' },
      existing: ['26FA-P1-001', '26FA-P1-002', '26FA-P1-003'],
    });
    expect(got.code).toBe('26FA-P1-004');
  });

  it('撞号策略 error ⇒ 返回原因、不生成（而不是硬写一个重复号）', () => {
    /*
     * 什么时候真的会撞？
     *   "取最大+1"这个算法下，**同一组内**算出的号不可能跟组内已有的撞
     *   （数字单调 + padStart 不会截断 ⇒ 不同数字必渲染成不同串）。
     *   真正会撞的是：库里的号**解析不出来**（前缀对不上）却恰好等于即将生成的串。
     *   最常见的触发方式就是**固定文本大小写不一致**（规则里写 `26fa-p1-`，
     *   库里存的是 `26FA-P1-001`）—— 所以这个分支是"配置写歪了"的安全网。
     */
    const rule: CodeRule = {
      ...DEFAULT_STUDENT_NO_RULE,
      conflict: 'error',
      segments: [
        { kind: 'text', value: '26fa-p1-' },
        { kind: 'serial', digits: 3, start: 1, step: 1, cycle: 'none', scope: 'prefix', scopeField: '' },
      ],
    };
    const got = generateCode(rule, { nowMs: NOW, fields: {}, existing: ['26FA-P1-001'] });
    expect(got.code).toBe('');
    expect(got.reason).toContain('已存在');

    // 反证：把固定文本改成大写（与库里一致）⇒ 能正常解析出流水 1、下一个是 2
    const okRule: CodeRule = { ...rule, segments: [{ kind: 'text', value: '26FA-P1-' }, rule.segments[1]] };
    expect(generateCode(okRule, { nowMs: NOW, fields: {}, existing: ['26FA-P1-001'] }).code).toBe('26FA-P1-002');
  });

  it('🔴 没有流水号段 ⇒ 拒绝生成（否则每条记录拿到同一个号）', () => {
    const rule: CodeRule = { ...DEFAULT_STUDENT_NO_RULE, segments: [{ kind: 'text', value: 'X' }] };
    const got = generateCode(rule, { nowMs: NOW, fields: {}, existing: [] });
    expect(got.code).toBe('');
    expect(got.reason).toContain('流水号');
  });

  it('停用的规则不生成', () => {
    const got = generateCode({ ...DEFAULT_STUDENT_NO_RULE, enabled: false }, { nowMs: NOW, fields: {}, existing: [] });
    expect(got.code).toBe('');
    expect(got.reason).toContain('未启用');
  });

  it('字段缺失 ⇒ 退化（段渲染成空、流水从 start 起），**不抛错**', () => {
    const got = generateCode(DEFAULT_STUDENT_NO_RULE, { nowMs: NOW, fields: {}, existing: [] });
    // 三个字段段都渲染成空 ⇒ 只剩两个固写的 `-` 与流水 ⇒ `--001`。
    // 难看，但这是"三个输入全空"的退化输入，**不该抛错**（抛错会连带把新建学生弄挂）；
    // 批量为这类记录补号时，「预检」会把这样的号列出来让人先看到。
    expect(got.code).toBe('--001');
    expect(got.serial).toBe(1);
  });

  it('传垃圾进 generateCode 也不抛错', () => {
    for (const bad of [null, undefined, 0, 'x', []]) {
      expect(() =>
        generateCode(bad as unknown as CodeRule, { nowMs: NOW, fields: {}, existing: [] }),
      ).not.toThrow();
      expect(() =>
        generateCode({ ...DEFAULT_STUDENT_NO_RULE, segments: bad as never }, { nowMs: NOW, fields: {}, existing: [] }),
      ).not.toThrow();
    }
  });

  it('随机段：同一 seed 结果一致（试算可复现）', () => {
    const rule: CodeRule = {
      ...DEFAULT_STUDENT_NO_RULE,
      segments: [{ kind: 'random', length: 4, charset: 'AB' }, { kind: 'serial', digits: 2, start: 1, step: 1, cycle: 'none', scope: 'global', scopeField: '' }],
    };
    const a = generateCode(rule, { nowMs: NOW, fields: {}, existing: [], randomSeed: 's1' });
    const b = generateCode(rule, { nowMs: NOW, fields: {}, existing: [], randomSeed: 's1' });
    const c = generateCode(rule, { nowMs: NOW, fields: {}, existing: [], randomSeed: 's2' });
    expect(a.code).toBe(b.code);
    expect(a.code).toHaveLength(6);
    expect(c.code).not.toBe(a.code);
  });

  it('大小写选项生效（uppercase 会把固定文本也带上）', () => {
    const rule: CodeRule = { ...DEFAULT_STUDENT_NO_RULE, upperCase: 'lower' };
    const got = generateCode(rule, { nowMs: NOW, fields: { 入学年份: '2026', 入学年月: '26秋季', 入学年级: 'Pre-1' }, existing: [] });
    expect(got.code).toBe('26fa-p1-001');
  });
});

describe('字段取值与映射', () => {
  it('last2 / first2 / raw', () => {
    expect(fieldValueOf({ 入学年份: '2026' }, '入学年份', 'last2')).toBe('26');
    expect(fieldValueOf({ 入学年份: '2026' }, '入学年份', 'first2')).toBe('20');
    expect(fieldValueOf({ 入学年份: '2026' }, '入学年份', 'raw')).toBe('2026');
  });

  it('取不到值时一律空串（不抛错、不写 "undefined"）', () => {
    for (const v of [undefined, null, '', '  ', 0]) {
      expect(fieldValueOf({ x: v }, 'x', 'raw')).toBe(v === 0 ? '0' : '');
    }
    expect(fieldValueOf({}, 'nope', 'last2')).toBe('');
  });

  it('🔴 后缀匹配：字段值是「26秋季」而键是「秋季」⇒ 必须命中', () => {
    expect(mapFieldValue('26秋季', { 秋季: 'FA', 春季: 'SP' }, 'suffix')).toBe('FA');
    expect(mapFieldValue('25春季', { 秋季: 'FA', 春季: 'SP' }, 'suffix')).toBe('SP');
  });

  it('长键优先（避免「季」抢先命中「秋季」）', () => {
    expect(mapFieldValue('26秋季', { 季: 'X', 秋季: 'FA' }, 'suffix')).toBe('FA');
  });

  it('不配映射 ⇒ 原样返回（"没配"与"配了没命中"是两回事）', () => {
    expect(mapFieldValue('Pre-1', {}, 'exact')).toBe('Pre-1');
    expect(mapFieldValue('Pre-1', { 别的: 'X' }, 'exact')).toBe('Pre-1');
  });

  it('exact 不命中 ⇒ 原样返回', () => {
    expect(mapFieldValue('未知年级', { 'Pre-1': 'P1' }, 'exact')).toBe('未知年级');
  });
});

describe('日期分量与重置周期', () => {
  const at = (s: string) => Date.parse(`${s}+08:00`);

  it('六种日期格式', () => {
    const t = at('2026-09-28T10:00:00');
    expect(formatDatePart('year4', t)).toBe('2026');
    expect(formatDatePart('year2', t)).toBe('26');
    expect(formatDatePart('yearMonth', t)).toBe('202609');
    expect(formatDatePart('yearMonthDay', t)).toBe('20260928');
    expect(formatDatePart('academicYear', t)).toBe('2026-2027');
    expect(formatDatePart('term', t)).toBe('26秋');
  });

  it('学期边界：8 月及以后算秋季、2~7 月算春季、1 月算上一年秋季', () => {
    expect(formatDatePart('term', at('2026-07-31T10:00:00'))).toBe('26春');
    expect(formatDatePart('term', at('2026-08-01T10:00:00'))).toBe('26秋');
    expect(formatDatePart('term', at('2027-01-15T10:00:00'))).toBe('26秋');
    expect(formatDatePart('term', at('2027-02-01T10:00:00'))).toBe('27春');
  });

  it('学年跨年：1 月属于上一学年', () => {
    expect(formatDatePart('academicYear', at('2027-01-15T10:00:00'))).toBe('2026-2027');
    expect(formatDatePart('academicYear', at('2026-08-01T10:00:00'))).toBe('2026-2027');
  });

  it('非法时间戳不抛错（回落成当前时间）', () => {
    for (const bad of [NaN, Infinity, undefined, null, 'abc']) {
      expect(() => formatDatePart('year4', bad as number)).not.toThrow();
      expect(formatDatePart('year4', bad as number)).toMatch(/^\d{4}$/);
    }
  });

  it('重置窗口键：none 为空串（= 全局一条线）', () => {
    expect(cycleKeyOf('none', at('2026-09-28T10:00:00'))).toBe('');
    expect(cycleKeyOf('year', at('2026-09-28T10:00:00'))).toBe('2026');
    expect(cycleKeyOf('term', at('2026-09-28T10:00:00'))).toBe('26秋');
    expect(cycleKeyOf('month', at('2026-09-28T10:00:00'))).toBe('202609');
    expect(cycleKeyOf('day', at('2026-09-28T10:00:00'))).toBe('20260928');
  });
});

describe('归一化：逐项回落、永不抛错', () => {
  it('垃圾输入 ⇒ 回落成默认配置（不是空配置）', () => {
    for (const bad of [null, undefined, 0, 'x', [], { rules: 'nope' }, { rules: [null, 1, 'a'] }]) {
      const cfg = normalizeCodeRuleConfig(bad);
      expect(cfg.rules.length, `输入 ${JSON.stringify(bad)}`).toBeGreaterThan(0);
      expect(cfg.rules.some((r) => r.key === 'studentNo')).toBe(true);
    }
  });

  it('🔴 默认规则被删掉 ⇒ 补回来（学籍号是登录凭证，静默消失比报错难查）', () => {
    const cfg = normalizeCodeRuleConfig({ rules: [{ key: 'other', name: '别的', targetTable: 'x', targetField: 'y', segments: [{ kind: 'serial' }] }] });
    expect(cfg.rules.some((r) => r.key === 'studentNo')).toBe(true);
    expect(cfg.rules.some((r) => r.key === 'other')).toBe(true);
  });

  it('按 key 去重（同 key 两条 ⇒ 后来的覆盖先来的）', () => {
    const cfg = normalizeCodeRuleConfig({
      rules: [
        { key: 'studentNo', name: 'A' },
        { key: 'studentNo', name: 'B' },
      ],
    });
    expect(cfg.rules.filter((r) => r.key === 'studentNo')).toHaveLength(1);
    expect(cfg.rules.find((r) => r.key === 'studentNo')!.name).toBe('B');
  });

  it('流水位数 / 起始 / 步长 / 重试次数被钳到合理范围', () => {
    const r = normalizeCodeRuleConfig({
      rules: [
        {
          key: 'studentNo',
          segments: [{ kind: 'serial', digits: 999, start: -5, step: 0, cycle: '乱写', scope: '乱写' }],
          conflictRetry: 99999,
        },
      ],
    }).rules[0];
    const ser = r.segments.find((s) => s.kind === 'serial') as Extract<CodeRule['segments'][number], { kind: 'serial' }>;
    expect(ser.digits).toBe(10); // 上限
    expect(ser.start).toBe(0); // 下限
    expect(ser.step).toBe(1); // 非法 ⇒ 回落 1（0 步长会让撞号跳号死循环）
    expect(ser.cycle).toBe('term'); // 非法 ⇒ 回落默认
    expect(ser.scope).toBe('prefix');
    expect(r.conflictRetry).toBe(1000);
  });

  it('空段列表 ⇒ 回落成默认段（空段会生成空编号，比报错更糟）', () => {
    const r = normalizeCodeRuleConfig({ rules: [{ key: 'studentNo', segments: [] }] }).rules.find((x) => x.key === 'studentNo')!;
    expect(r.segments.length).toBeGreaterThan(0);
  });

  it('字段真名里的全角括号与空格不被破坏', () => {
    const r = normalizeCodeRuleConfig({ rules: [{ key: 'studentNo', targetField: '  学籍号（脱敏）  ' }] }).rules.find((x) => x.key === 'studentNo')!;
    expect(r.targetField).toBe('学籍号（脱敏）');
  });

  it('同一目标字段被两条启用规则占用 ⇒ 报出来（否则"有时 A 有时 B"且不报错）', () => {
    // ⚠️ 用一个**默认配置里没有**的字段，避免默认的 `studentNo` 规则也参与进来
    //    （它同样指向 学籍号（脱敏），会让冲突数变成 2 —— 那是正确行为，但会干扰这条断言）
    const cfg = normalizeCodeRuleConfig({
      rules: [
        { key: 'a', name: '规则A', targetTable: 'studentProfile', targetField: '批次号', enabled: true, segments: [{ kind: 'serial' }] },
        { key: 'b', name: '规则B', targetTable: 'studentProfile', targetField: '批次号', enabled: true, segments: [{ kind: 'serial' }] },
      ],
    });
    const c = codeRuleConflicts(cfg);
    expect(c).toHaveLength(1);
    expect(c[0]).toContain('批次号');
    expect(c[0]).toContain('规则A');
    expect(c[0]).toContain('规则B');
  });

  it('默认的学籍号规则若被人又加一条同字段规则 ⇒ 也能报出来', () => {
    const cfg = normalizeCodeRuleConfig({
      rules: [
        { key: 'dup', name: '重复的学籍号规则', targetTable: 'studentProfile', targetField: '学籍号（脱敏）', enabled: true, segments: [{ kind: 'serial' }] },
      ],
    });
    expect(codeRuleConflicts(cfg).length).toBeGreaterThanOrEqual(1);
  });
});

describe('权限与菜单', () => {
  const res = MODULE_RESOURCES.find((r) => r.key === 'codeRules');

  it('资源已登记且形状正确（配置类：不随迁移发放 + 必须含 update）', () => {
    expect(res, 'codeRules 资源必须登记').toBeTruthy();
    expect(res!.legacyRead).toBeNull();
    expect(res!.legacyWrite).toBeNull();
    expect(res!.menuPermission).toBeNull();
    expect(res!.actions).toEqual(['read', 'update']);
  });

  it('🔴 不得带 enter（menuPermission 为 null 时 enter 会被无条件发给全站角色）', () => {
    expect(res!.actions).not.toContain('enter');
  });

  it('引入版本 == 当次抬的版本号（否则那段增量迁移覆盖不到）', () => {
    expect(MODULE_RESOURCE_INTRODUCED_VERSION.codeRules).toBe(ROLE_PERMISSION_VERSION);
  });

  it('菜单可见性靠显式判据（有 read 才显示，否则菜单在但点进去 403）', () => {
    expect(codeRulesVisible(['module:codeRules:read'])).toBe(true);
    expect(codeRulesVisible([])).toBe(false);
    expect(codeRulesVisible(['module:weilingContacts:read'])).toBe(false);
  });
});
