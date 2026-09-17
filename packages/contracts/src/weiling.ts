/**
 * 卫瓴（SCRM）口径常量。
 *
 * ⚠️ 为什么放 contracts：这些码值**前端筛选下拉**（`/weiling-contacts/columns.tsx`）
 * 与**报表统计**（`reports`/`weiling` 服务）都要用。各写一份必然漂移，
 * 症状是「报表里写『已认领』、列表筛选里写『1』，用户对不上号」。
 */

/**
 * 联系人「状态」码值 → 中文。
 *
 * 上游 `contact.status` 是个数字码，卫瓴的**字段描述接口里没有它**
 *（只有 `lost_state` 流失状态、`last_call_status` 上次呼叫状态），
 * 所以这几个中文名来自卫瓴后台界面的实际显示口径，不是猜的。
 *
 * 实测分布（生产 3669 条）：`1` 3606 条（全部有归属人）、`4` 63 条（52 条无归属人）、
 * `0` 当前 0 条（公海线索不在同步范围内）—— 与「已认领 / 待分配 / 待认领（公海）」自洽。
 */
export const WEILING_STATUS_LABELS: Record<string, string> = {
  '0': '待认领（公海）',
  '1': '已认领',
  '4': '待分配',
};

/** 状态码值 → 中文；未知码值原样返回（绝不编造含义） */
export function weilingStatusLabel(code: string): string {
  const k = String(code ?? '').trim();
  if (!k) return '未标注';
  return WEILING_STATUS_LABELS[k] ?? `状态 ${k}`;
}

/** 「状态」维度在报表里的展示顺序（已认领 → 待分配 → 待认领，未知码值排最后） */
export const WEILING_STATUS_ORDER: readonly string[] = ['1', '4', '0'];
