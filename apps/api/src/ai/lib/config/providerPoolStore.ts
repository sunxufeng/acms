// @ts-nocheck
// Provider 池（组织级共享模型密钥）属于 acaily 企业版能力，本迁移的「核心可运行闭环」范围不含。
// 这里给出最小桩实现，仅满足 gateway/router 的 import 契约：
// 返回 null 表示「没有组织级 Provider 池」，router 会回退到用户个人配置（routeChat 的主路径）。
export function getProvider(_id) {
  return null;
}

export function getProviderApiKey(_id) {
  return null;
}
