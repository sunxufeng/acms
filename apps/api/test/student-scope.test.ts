import { describe, expect, it } from 'vitest';
import {
  isDenyAll,
  isScopeUnrestricted,
  mergeRoleScopes,
  normalizeRoleScope,
  normalizeScope,
  SCOPE_DENY_ALL,
  studentInScope,
} from '../src/shared/student-scope.js';

/**
 * 学生档案「数据范围」判定的契约测试。
 *
 * 🔴 本文件锁的是 **2026-09-18 的语义翻转**（峰哥报障：「角色管理里数据范围一个都不选，
 *    为什么能看到所有学生？」）。翻转前：全空 = 不限制（看全部）；翻转后：全空 = 看不到。
 *    这块最危险的不是写错代码，而是**有人"顺手改回去"** —— 所以每个分支都要有测试钉住。
 *
 * 纯函数，不连数据库、不改任何数据。
 */

const REC = { 当前年级: 'Pre-1', 当前状态: '在校在读' };

describe('SCOPE_DENY_ALL（显式「一条都不可见」）', () => {
  it('🔴 不算「不限制」—— 这是语义翻转的支点', () => {
    expect(isScopeUnrestricted(SCOPE_DENY_ALL)).toBe(false);
    expect(isDenyAll(SCOPE_DENY_ALL)).toBe(true);
  });

  it('🔴 任何记录都不在范围内', () => {
    expect(studentInScope(REC, SCOPE_DENY_ALL)).toBe(false);
    expect(studentInScope({}, SCOPE_DENY_ALL)).toBe(false);
    // 维度完全吻合也不行
    expect(studentInScope({ 当前年级: 'Pre-1', 当前状态: '在校在读' }, SCOPE_DENY_ALL)).toBe(false);
  });

  it('反过来：null / undefined / {} 仍然是「不限制」（豁免路径不受翻转影响）', () => {
    expect(isScopeUnrestricted(null)).toBe(true);
    expect(isScopeUnrestricted(undefined)).toBe(true);
    expect(isScopeUnrestricted({})).toBe(true);
    expect(studentInScope(REC, null)).toBe(true);
    expect(studentInScope(REC, {})).toBe(true);
  });

  it('🔴 `__denyAll` 不能从外部输入进来（谁也不能靠调接口把自己配成看不见）', () => {
    expect(normalizeScope({ __denyAll: true } as unknown)).toBeNull();
    expect(normalizeScope({ __denyAll: true, 当前年级: ['Pre-1'] } as unknown)).toEqual({ 当前年级: ['Pre-1'] });
  });
});

describe('normalizeScope / normalizeRoleScope', () => {
  it('全空归一为 null', () => {
    expect(normalizeScope({})).toBeNull();
    expect(normalizeScope({ 当前年级: [] })).toBeNull();
    expect(normalizeScope(null)).toBeNull();
    expect(normalizeScope('garbage')).toBeNull();
  });

  it('去空、去重、只保留已知维度', () => {
    expect(normalizeScope({ 当前年级: ['Pre-1', 'Pre-1', '  '], 未知维度: ['x'] })).toEqual({
      当前年级: ['Pre-1'],
    });
  });

  it("🔴 角色级支持字符串 'all'（显式「不限制」的唯一表达）", () => {
    expect(normalizeRoleScope('all')).toBe('all');
    expect(normalizeRoleScope({ 当前年级: ['Pre-1'] })).toEqual({ 当前年级: ['Pre-1'] });
    expect(normalizeRoleScope(null)).toBeNull();
    expect(normalizeRoleScope('ALL')).toBeNull(); // 只认精确小写，不做模糊匹配
  });
});

describe('mergeRoleScopes（多角色并集）', () => {
  it("🔴 任一角色配了 'all' ⇒ 整体不限制", () => {
    expect(mergeRoleScopes(['all', { 当前年级: ['Pre-1'] }])).toBe('all');
    expect(mergeRoleScopes([null, 'all'])).toBe('all');
  });

  it('🔴 所有角色都没配 ⇒ null（调用方必须当作「看不到任何学生」）', () => {
    expect(mergeRoleScopes([null, null])).toBeNull();
    expect(mergeRoleScopes([])).toBeNull();
    expect(mergeRoleScopes([{}, { 当前年级: [] }])).toBeNull();
  });

  it('多角色维度值取并集', () => {
    expect(mergeRoleScopes([{ 当前年级: ['Pre-1'] }, { 当前年级: ['Pre-2'], 当前状态: ['在校在读'] }])).toEqual({
      当前年级: ['Pre-1', 'Pre-2'],
      当前状态: ['在校在读'],
    });
  });
});

describe('studentInScope（维度之间 AND、同一维度 OR）', () => {
  const scope = { 当前年级: ['Pre-1', 'Pre-2'], 当前状态: ['在校在读'] };

  it('两个维度都命中 ⇒ 可见', () => {
    expect(studentInScope(REC, scope)).toBe(true);
  });

  it('同一维度多选满足任一即可（OR）', () => {
    expect(studentInScope({ 当前年级: 'Pre-2', 当前状态: '在校在读' }, scope)).toBe(true);
  });

  it('维度之间必须同时满足（AND）', () => {
    expect(studentInScope({ 当前年级: 'Pre-1', 当前状态: '已毕业' }, scope)).toBe(false);
    expect(studentInScope({ 当前年级: 'Pre-3', 当前状态: '在校在读' }, scope)).toBe(false);
  });

  it('未参与限制的维度不看', () => {
    // 范围只管 当前状态 ⇒ 年级是什么都不影响（但两个维度都要满足 AND 的前提）
    expect(studentInScope({ 当前年级: 'Pre-9', 当前状态: '在校在读' }, { 当前状态: ['在校在读'] })).toBe(true);
    expect(studentInScope({ 当前年级: 'Pre-1' }, { 当前状态: ['在校在读'] })).toBe(false); // 该维度空值 ⇒ 不可见
  });

  it('🔴 范围要求了某维度、记录该维度为空 ⇒ 不可见（宁可少看不可漏看）', () => {
    expect(studentInScope({ 当前状态: '在校在读' }, { 当前年级: ['Pre-1'] })).toBe(false);
  });

  it('维度是多选数组时按交集判断', () => {
    expect(studentInScope({ 当前年级: ['Pre-5', 'Pre-1'], 当前状态: '在校在读' }, scope)).toBe(true);
    expect(studentInScope({ 当前年级: ['Pre-5', 'Pre-6'], 当前状态: '在校在读' }, scope)).toBe(false);
  });
});
