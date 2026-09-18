import { describe, expect, it } from 'vitest';
import {
  DEDUP_MODES,
  dedupMemberIds,
  type DedupRow,
} from '../src/reports/contact-dedup.js';
import { isInvalidPhone, isValidPhone, normalizePhone } from '../src/shared/phone.util.js';

/**
 * 「疑似重复」下钻（`?dedup=`）与「无有效手机号」（`?手机号__invalid=1`）的契约测试。
 *
 * 背景（2026-09-18）：去重报表的统计卡要做下钻，点进去看名单。难点是「是否重复」
 * **不是表里的字段**，而是报表当场按姓名分桶算出来的 ⇒ 列表必须复用 `dedupMemberIds`，
 * 否则「卡片 50 组 / 点进去多少条」两处口径必然漂移。
 *
 * 另一条：卡片的「无手机号记录」算的是**无有效手机号**（空 **或** 位数不在 7~15），
 * 而列表原先只有 `__empty`（真为空）—— 实测差 89 条，所以新增了 `__invalid`。
 *
 * 纯函数、不连数据库。
 */

/** 构造一行（只写关心的字段，其余给默认值，避免测试被无关字段干扰） */
function row(
  id: string,
  name: string,
  o: { phone?: string; owner?: string; channel?: string; remark?: string; createdAt?: number } = {},
): DedupRow {
  const phone = o.phone ?? '';
  return {
    id,
    name,
    phone,
    phoneKey: normalizePhone(phone),
    remark: o.remark ?? '',
    channel: o.channel ?? '',
    owner: o.owner ?? '',
    stage: '',
    lost: '',
    student: '',
    studentName: '',
    createdAt: o.createdAt ?? 1,
    lastFollowAt: 0,
    score: 0,
    weilingId: '',
    wxId: '',
  };
}

describe('手机号有效性：报表与列表必须同一判据', () => {
  it('归一化：剥掉 +86 / 086 与非数字字符', () => {
    expect(normalizePhone('+86 13800138000')).toBe('13800138000');
    expect(normalizePhone('086-138 0013 8000')).toBe('13800138000');
    expect(normalizePhone('138-0013-8000')).toBe('13800138000');
  });

  it('有效 = 7~15 位（境外号也要放行）', () => {
    expect(isValidPhone('13800138000')).toBe(true);
    expect(isValidPhone('1234567')).toBe(true);
    expect(isValidPhone('123456')).toBe(false); // 6 位太短
    expect(isValidPhone('')).toBe(false);
  });

  it('isInvalidPhone：空 / 占位符 / 位数异常都算「无有效手机号」', () => {
    expect(isInvalidPhone('')).toBe(true);
    expect(isInvalidPhone('无')).toBe(true);
    expect(isInvalidPhone('-')).toBe(true);
    // 两个号连写 → 19 位，归一化后仍然超长
    expect(isInvalidPhone('1380013800013900139000')).toBe(true);
    // 正常号
    expect(isInvalidPhone('13800138000')).toBe(false);
    expect(isInvalidPhone('+86 13800138000')).toBe(false);
  });
});

describe('dedupMemberIds：四种模式下钻命中哪些记录', () => {
  /**
   * 四组样本：
   *   A strong：同名 + 同手机号（2 条）
   *   B likely：同名 + 同归属人（2 条）
   *   C weak  ：仅同名（2 条）
   *   D       ：同名但两个不同手机号 ⇒ 反证据排除，不成组（2 条）
   */
  const rows: DedupRow[] = [
    row('a1', '张三', { phone: '13800138000', createdAt: 1 }),
    row('a2', '张三', { phone: '13800138000', createdAt: 2 }),
    row('b1', '李四', { owner: '王老师', createdAt: 1 }),
    row('b2', '李四', { owner: '王老师', createdAt: 2 }),
    row('c1', '王五', { createdAt: 1 }),
    row('c2', '王五', { createdAt: 2 }),
    row('d1', '赵六', { phone: '13800138000', createdAt: 1 }),
    row('d2', '赵六', { phone: '13900139000', createdAt: 2 }),
    // 单条同名不成组，也不该命中
    row('e1', '孙七', { phone: '13700137000', createdAt: 1 }),
  ];

  it('all → 三种档位的全部组成员（D 被反证据排除、单条不成组）', () => {
    const ids = dedupMemberIds(rows, 'all');
    expect([...ids].sort()).toEqual(['a1', 'a2', 'b1', 'b2', 'c1', 'c2']);
    expect(ids.has('d1')).toBe(false);
    expect(ids.has('e1')).toBe(false);
  });

  it('likely → 强证据 + 较可信（滤掉仅同名的 C）', () => {
    expect([...dedupMemberIds(rows, 'likely')].sort()).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('strong → 只有强证据组', () => {
    expect([...dedupMemberIds(rows, 'strong')].sort()).toEqual(['a1', 'a2']);
  });

  it('mergeable → 每组去掉「建议保留」的那条（= 合并后可减少）', () => {
    // 建议保留取「信息最全」；A 组两条同分 ⇒ 取创建最早的 a1
    expect([...dedupMemberIds(rows, 'mergeable')].sort()).toEqual(['a2', 'b2', 'c2']);
  });

  it('mergeable 的条数 == all 的条数 − 组数（口径自洽）', () => {
    const all = dedupMemberIds(rows, 'all');
    const canMerge = dedupMemberIds(rows, 'mergeable');
    // 3 组（A/B/C）、6 条成员 ⇒ 可减少 3 条
    expect(all.size - canMerge.size).toBe(3);
  });

  it('DEDUP_MODES 覆盖全部四个取值（接口层用它挡非法值）', () => {
    expect([...DEDUP_MODES].sort()).toEqual(['all', 'likely', 'mergeable', 'strong']);
    expect(DEDUP_MODES.has('weak')).toBe(false); // weak 不对外暴露：页面用 all 表达
  });
});
