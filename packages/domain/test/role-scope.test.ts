import { describe, it, expect } from 'vitest';
import { sameDataScope, isScopeDenyAll, ROLE_SCOPE_DIMS, engineLevelOfUserField } from '@acms/contracts';

/**
 * 「数据范围」纯函数契约测试。
 *
 * 为什么要有这一组：角色管理页的 `dirty` 判断曾**漏掉 dataScope 字段**，
 * 导致「改完数据范围 ⇒ 保存按钮点不动」（2026-09-18 峰哥报障）。
 * 这类「比较两个配置是否相等」的逻辑一旦写错，症状是**静默的**：
 * 要么按钮点不动，要么反过来「没改也能保存」。所以逐条钉死。
 *
 * ⚠️ 被测函数住在 `@acms/contracts`（前端与后端共用）；contracts 包没有测试基建，
 *    因此测试放在这里有 vitest 的包里跑（domain 已依赖 contracts，不会引入新依赖）。
 */
describe('sameDataScope：判断两个数据范围配置是否语义相等', () => {
  it('都是「显式不限制（all）」⇒ 相等', () => {
    expect(sameDataScope('all', 'all')).toBe(true);
  });

  it('「all」与「维度对象」是两个不同状态 ⇒ 不相等（否则改完按钮点不动、或没改也能存）', () => {
    expect(sameDataScope('all', { 当前年级: ['Pre-1'] })).toBe(false);
    expect(sameDataScope({ 当前年级: ['Pre-1'] }, 'all')).toBe(false);
  });

  it('🔴 维度数组的**顺序无关** ⇒ 取消一个勾再勾回来不算改动（这是不能用 JSON 比较的原因）', () => {
    expect(sameDataScope({ 当前年级: ['Pre-1', 'Pre-2'] }, { 当前年级: ['Pre-2', 'Pre-1'] })).toBe(true);
  });

  it('undefined / null / {} 三者都表示「未配置」⇒ 互相相等（否则一打开编辑器就显示「未保存」）', () => {
    expect(sameDataScope(undefined, undefined)).toBe(true);
    expect(sameDataScope(undefined, {})).toBe(true);
    expect(sameDataScope(null, {})).toBe(true);
    expect(sameDataScope({ 当前年级: [] }, undefined)).toBe(true);
    expect(sameDataScope({ 当前年级: [] }, { 当前状态: [] })).toBe(true);
  });

  it('🔴 未配置 vs 配了一个维度 ⇒ 不相等（正是「改完点不动」的那个场景）', () => {
    expect(sameDataScope(undefined, { 当前年级: ['Pre-1'] })).toBe(false);
    expect(sameDataScope({ 当前年级: ['Pre-1'] }, undefined)).toBe(false);
  });

  it('同一维度换值 / 值个数不同 ⇒ 不相等', () => {
    expect(sameDataScope({ 当前年级: ['Pre-1'] }, { 当前年级: ['Pre-2'] })).toBe(false);
    expect(sameDataScope({ 当前年级: ['Pre-1'] }, { 当前年级: ['Pre-1', 'Pre-2'] })).toBe(false);
    expect(sameDataScope({ 当前年级: ['Pre-1'] }, { 当前年级: ['Pre-1'], 当前状态: ['在校在读'] })).toBe(false);
  });

  it('多维度逐项比较', () => {
    const a = { 当前年级: ['Pre-1'], 当前状态: ['在校在读'] };
    expect(sameDataScope(a, { 当前状态: ['在校在读'], 当前年级: ['Pre-1'] })).toBe(true);
    expect(sameDataScope(a, { 当前年级: ['Pre-1'], 当前状态: ['休学'] })).toBe(false);
  });

  it('冗余空格 / 重复值不影响判定（与后端 normalizeScope 同口径）', () => {
    expect(sameDataScope({ 当前年级: [' Pre-1 '] }, { 当前年级: ['Pre-1'] })).toBe(true);
    expect(sameDataScope({ 当前年级: ['Pre-1', 'Pre-1'] }, { 当前年级: ['Pre-1'] })).toBe(true);
  });

  it('脏数据（字符串 / 数字 / 非数组）不抛异常，**按「该维度为空」处理**', () => {
    expect(() => sameDataScope('Pre-1', { 当前年级: ['Pre-1'] })).not.toThrow();
    expect(sameDataScope({ 当前年级: 123 }, undefined)).toBe(true);
    // 🔴 非数组**不**宽容地当成单值数组：后端 `normalizeScope()` 就是「非数组 ⇒ 该维度丢弃」，
    //    前端若在这里宽容处理，会出现「界面认为没改动、后端实际存成空」的错位。
    //    口径必须一致，宁可判成「有改动」。
    expect(sameDataScope({ 当前年级: 'Pre-1' }, { 当前年级: ['Pre-1'] })).toBe(false);
    expect(sameDataScope({ 当前年级: 'Pre-1' }, undefined)).toBe(true);
  });

  it('维度清单真源：从 contracts 取（改维度只改一处）', () => {
    expect([...ROLE_SCOPE_DIMS]).toEqual(['当前年级', '当前状态']);
  });
});

describe('engineLevelOfUserField：用户表「数据密级上限」原始值 → 会话里的引擎密级', () => {
  it('🔴 留空 ⇒ undefined（= 会话不带该字段 ⇒ 回退到角色管理的「数据密级上限」）', () => {
    // 这是本次修复的支点：以前这里被写成 'L1'，于是角色上限成了死代码（设了不生效）
    expect(engineLevelOfUserField('')).toBeUndefined();
    expect(engineLevelOfUserField('   ')).toBeUndefined();
    expect(engineLevelOfUserField(undefined)).toBeUndefined();
    expect(engineLevelOfUserField(null)).toBeUndefined();
  });

  it('已知取值 ⇒ 对应的 L1–L4（覆盖角色上限）', () => {
    expect(engineLevelOfUserField('一般')).toBe('L1');
    expect(engineLevelOfUserField('内部')).toBe('L2');
    expect(engineLevelOfUserField('敏感')).toBe('L3');
    expect(engineLevelOfUserField('高度敏感')).toBe('L4');
    expect(engineLevelOfUserField('L4')).toBe('L4');
  });

  it('前后空格不影响识别（界面复制粘贴常带空格）', () => {
    expect(engineLevelOfUserField(' 敏感 ')).toBe('L3');
  });

  it('🔴 无法识别 ⇒ L1 而**不是** undefined（否则等于给写错值的人提权到角色上限）', () => {
    expect(engineLevelOfUserField('机密')).toBe('L1');
    expect(engineLevelOfUserField('l3')).toBe('L1'); // 大小写敏感：约定存中文或 L4
  });
});

describe('isScopeDenyAll：是否表示「一条都看不到」', () => {
  it('all ⇒ false（那是显式看全部）', () => {
    expect(isScopeDenyAll('all')).toBe(false);
  });

  it('未配置 / 维度全空 ⇒ true', () => {
    expect(isScopeDenyAll(undefined)).toBe(true);
    expect(isScopeDenyAll(null)).toBe(true);
    expect(isScopeDenyAll({})).toBe(true);
    expect(isScopeDenyAll({ 当前年级: [] })).toBe(true);
  });

  it('任一维度有值 ⇒ false', () => {
    expect(isScopeDenyAll({ 当前年级: ['Pre-1'] })).toBe(false);
    expect(isScopeDenyAll({ 当前状态: ['在校在读'] })).toBe(false);
  });

  it('勾了值又全取消 ⇒ 回到「一条都看不到」（页面据此收敛成 undefined）', () => {
    const afterUncheck = { 当前年级: [] as string[] };
    expect(isScopeDenyAll(afterUncheck)).toBe(true);
    expect(sameDataScope(afterUncheck, undefined)).toBe(true);
  });
});
