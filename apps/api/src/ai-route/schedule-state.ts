/**
 * 上游账号的「调度状态」判定。
 *
 * 单独抽成一个无依赖的纯函数模块，原因有两个：
 *  1. 网关侧（AiRouteService）与元数据侧（lifecycle.meta 的新建默认值）都要用同一套判据，
 *     复制一份必然漂移 —— 「列表显示可调度、网关却跳过它」这类不一致最难查
 *  2. lifecycle.meta 是纯数据模块，不能 import 带 Nest 依赖的 service（会成环）
 *
 * 不依赖任何 Nest / pg 模块，随时可被两侧引用。
 */

/** 账号字段（宽松类型：宽表里可能是 number / string / undefined） */
export type AccountFields = Record<string, unknown>;

/**
 * 账号额度是否已用尽。返回空串表示可用。
 * 口径与分组限额一致：0 或空 = 该档不限；跨档时把用量视为 0
 * （真正的归零由累加时写「统计日 / 用量月份」标记完成）。
 */
export function accountQuotaReason(f: AccountFields, now = Date.now()): string {
  const tiers: [string, string, string, string][] = [
    ['日额度USD', '今日已用USD', '统计日', utcDay(now)],
    ['月额度USD', '本月已用USD', '用量月份', utcMonth(now)],
  ];
  for (const [limitField, usedField, markField, mark] of tiers) {
    const limit = Number(f[limitField] ?? 0);
    if (!(limit > 0)) continue;
    const used = String(f[markField] ?? '') === mark ? Number(f[usedField] ?? 0) : 0;
    if (used >= limit) return `${limitField.replace('USD', '')}已用尽（${used.toFixed(4)} / ${limit}）`;
  }
  return '';
}

/**
 * 一个账号此刻的调度状态（枚举值，与字典「调度状态」一致）。
 * 顺序即优先级：停用 → 手动停调 → 过期 → 限流冷却 → 过载冷却 → 临时摘除 → 额度用尽 → 标记异常 → 可调度。
 */
export function scheduleStateOf(f: AccountFields, now = Date.now()): string {
  if (String(f['状态'] ?? '') !== '启用') return '已停用';
  if (String(f['可调度'] ?? '是') !== '是') return '手动停调';
  const exp = Number(f['过期时间'] ?? 0);
  if (exp && now > exp && String(f['过期自动暂停'] ?? '是') === '是') return '已过期';
  if (Number(f['限流解除时间'] ?? 0) > now) return '限流冷却';
  if (Number(f['过载解除时间'] ?? 0) > now) return '过载冷却';
  if (Number(f['临时不可调度解除时间'] ?? 0) > now) return '临时摘除';
  if (accountQuotaReason(f, now)) return '额度用尽';
  if (String(f['健康状态'] ?? '正常') === '异常') return '已标记异常';
  return '可调度';
}

/** UTC 日标记（YYYY-MM-DD），用于「今日用量」的跨天归零判断 */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC 月标记（YYYY-MM），用于「本月用量」的跨月归零判断 */
export function utcMonth(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}
