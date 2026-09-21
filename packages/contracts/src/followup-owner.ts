/**
 * 「跟进人 / 负责人」在**从我的笔记转换新建**时的默认值口径（2026-09-21 峰哥定，三处共用）。
 *
 * 口径：
 *  - **代转**（笔记不是你录的，`noteOwner` ≠ 登录用户）⇒ 记**笔记归属人** —— 谁录的笔记归谁；
 *  - 其余情况（自己录的笔记，或归属人取不到）⇒ 记**当前登录用户**。
 *
 * 为什么放在 contracts：招生跟进 / 校友长期跟进 / 实践活动 三个模块都要用同一份判断，
 * 各写一份必然漂移（会出现「同一个动作在两个模块里归属到不同人」这种查不出来的错）。
 * 与状态判据同理：口径只有一份，前端调它、单测也断言它。
 */
export function defaultFollowupOwner(input: { userName?: string; noteOwner?: string }): string {
  const me = String(input?.userName ?? '').trim();
  const owner = String(input?.noteOwner ?? '').trim();
  if (owner && owner !== me) return owner;
  return me || owner;
}
