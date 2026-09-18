/**
 * 手机号归一化与有效性判据 —— **全站唯一一份**。
 *
 * 为什么单独抽出来：这条判据被两个方向同时依赖，而它们**必须同口径**，否则
 * 「报表说 2011 条、点进去只有 1922 条」这类差值会反复出现（2026-09-18 实测差 89）：
 *   - 报表侧：`reports/contact-dedup.ts` 用它算「无手机号记录」「重复只可能出现在这批里」；
 *   - 列表侧：通用 CRUD 的 `<字段>__invalid=1` 筛选用它做下钻。
 */

/**
 * 归一化手机号：只留数字，剥掉 +86 / 086 前缀。
 * 展示仍用原值，归一化只用于**匹配与有效性判断**。
 */
export function normalizePhone(raw: unknown): string {
  const d = String(raw ?? '').replace(/[^0-9]/g, '');
  if (d.length === 13 && d.startsWith('86')) return d.slice(2);
  if (d.length === 14 && d.startsWith('086')) return d.slice(3);
  return d;
}

/**
 * 有效手机号：**7~15 位**。
 *
 * 库里确实存在 19 / 23 位的异常值（两个号连写）与「无」「-」这类占位符 ——
 * 它们归一化后要么超长、要么为空，都不算有效号。
 * ⚠️ 这个范围是「宽松」的有意选择：大陆号 11 位、境外号长短不一，
 *    收紧到 11 位会把境外联系人误判成「没手机号」。
 */
export function isValidPhone(phoneKey: string): boolean {
  return phoneKey.length >= 7 && phoneKey.length <= 15;
}

/** 原始值 → 是否「无有效手机号」（报表与列表**共用这一个入口**） */
export function isInvalidPhone(raw: unknown): boolean {
  return !isValidPhone(normalizePhone(raw));
}
