// @ts-nocheck
// 智能体（Agent）存储（含飞书应用绑定、长期记忆、API Key 信封）属于 acaily 企业版能力，
// 本迁移的「核心可运行闭环」范围不含「绑定独立飞书应用的智能体」。
// 这里给出最小桩实现，仅满足 automation/runner 的 import 契约：
// 返回 null / 空值表示「未关联智能体」，runner 会回退到收件人(caller)的个人模型配置。
export function getAgent(_id) {
  return null;
}

export function getAgentApiKey(_id) {
  return null;
}

export function getAgentFeishuSecret(_id) {
  return null;
}

// 记忆型自动化（actionType='memory'）在核心范围不会触发（创建自动化时未绑智能体），保留兼容签名。
export function saveAgent(patch, _id) {
  return { ...(patch || {}) };
}

// 把新记忆追加到既有记忆文本之后（多行拼接）。
export function appendMemory(prev, add) {
  const p = (prev || '').trim();
  const a = (add || '').trim();
  if (!p) return a;
  if (!a) return p;
  return `${p}\n${a}`;
}
