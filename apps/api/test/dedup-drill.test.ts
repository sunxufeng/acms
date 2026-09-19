import { describe, expect, it } from 'vitest';
import {
  DEDUP_MODES,
  buildDedupGroups,
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

  it('likely → **仅**较可信档（不是「较可信及以上」）', () => {
    /**
     * 🔴 2026-09-19 #570 核对时改正的语义。
     * 报表页的分解说明按**档**列组数（强证据 25 / 较可信 14 / 仅参考 11），
     * 所以每个下钻都必须只给**本档**的记录，否则点「较可信」看到的是
     * 「强 + 较可信」的累计（线上实测 87 条 vs 该档应有多少条），数字对不上。
     * ⚠️ 这与页面**列表**的「置信度」筛选（`BuildOptions.level`，'likely' = 较可信**及以上**）
     *    是两套语义，别混。
     */
    expect([...dedupMemberIds(rows, 'likely')].sort()).toEqual(['b1', 'b2']);
  });

  it('strong → 只有强证据组', () => {
    expect([...dedupMemberIds(rows, 'strong')].sort()).toEqual(['a1', 'a2']);
  });

  it('🔴 weak → 只有最弱的「仅参考」组（2026-09-19 补）', () => {
    /**
     * 报表页的分解说明里写着「仅参考 N 组」，用户自然会想点进去看是谁 ——
     * 而此前 `weak` **不在** `DEDUP_MODES` 里，接口层不认这个取值。
     * 老实现的判定是 `if (... && DEDUP_MODES.has(mode))`，不认就整段跳过 ⇒
     * **返回全表**（线上实测 3675 条，而该档实际只有 11 组 20 余条）——
     * 画面上是「疑似重复 3675」这种大几十倍的假数字，比「少几条」更容易误导。
     * 现在两件事都做了：weak 成为合法档位（这一条），且非法取值一律给空结果（见 generic-crud）。
     */
    expect([...dedupMemberIds(rows, 'weak')].sort()).toEqual(['c1', 'c2']);
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

  it('DEDUP_MODES 覆盖全部五个取值（接口层用它挡非法值）', () => {
    expect([...DEDUP_MODES].sort()).toEqual(['all', 'likely', 'mergeable', 'strong', 'weak']);
    expect(DEDUP_MODES.has('weak')).toBe(true); // 「仅参考 N 组」也要能下钻
    expect(DEDUP_MODES.has('bogus')).toBe(false);
  });

  it('🔴 下钻条数 == 报表各档的记录数（byLevelRecords）：卡片 hint 与列表 total 同口径', () => {
    const { stats } = buildDedupGroups(rows);
    // 组数（byLevel）与记录数（byLevelRecords）不是一个量级，两个都要对
    expect(stats.byLevel).toEqual({ strong: 1, likely: 1, weak: 1 });
    expect(stats.byLevelRecords).toEqual({ strong: 2, likely: 2, weak: 2 });
    // 各档记录数之和 == 全部重复记录数
    expect(stats.byLevelRecords.strong + stats.byLevelRecords.likely + stats.byLevelRecords.weak).toBe(stats.records);
    // 关键：卡片的 hint 数字必须等于对应下钻的条数，否则用户会以为下钻漏数据
    for (const [mode, level] of [
      ['strong', 'strong'],
      ['likely', 'likely'],
      ['weak', 'weak'],
    ] as const) {
      expect(dedupMemberIds(rows, mode).size).toBe(stats.byLevelRecords[level]);
    }
    // 「涉及记录」卡 = all 下钻
    expect(dedupMemberIds(rows, 'all').size).toBe(stats.records);
    // 「合并后可减少」卡 = mergeable 下钻
    expect(dedupMemberIds(rows, 'mergeable').size).toBe(stats.mergeable);
  });
});
