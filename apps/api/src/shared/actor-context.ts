import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 操作人上下文（审计字段「创建人 / 更新人」的唯一来源）。
 *
 * 为什么用 AsyncLocalStorage 而不是给 create/update 加 actor 参数：
 * 全站有 78 处 base.create / base.update 调用点，逐个改签名既易漏又会污染接口；
 * 而「谁在操作」本质上是请求级上下文，不是业务参数。这里让请求进来时建立 store，
 * SessionGuard 解析出用户后写入 store，存储层直接读取 —— 业务代码零改动。
 * 后台任务（无 HTTP 请求）用 runAs() 显式声明身份。
 */

/** 操作主体。id 是稳定标识（飞书 openId 或 system:<来源>），name 仅用于展示 */
export interface Actor {
  id: string;
  name: string;
}

interface ActorStore {
  actor: Actor | null;
}

const als = new AsyncLocalStorage<ActorStore>();

/**
 * 全局中间件：为每个 HTTP 请求建立**可变** store。
 * 用 run() 包裹 next() 保证异步上下文能传下去；store 内容留空，
 * 等 SessionGuard 解析出用户后再由 setActor 写入。
 */
export function runWithActorStore(next: () => void): void {
  als.run({ actor: null }, next);
}

/** 写入当前上下文的操作人（由 SessionGuard 调用） */
export function setActor(actor: Actor): void {
  const store = als.getStore();
  if (store) store.actor = actor;
}

/** 读取当前操作人；不在任何上下文内时返回 null（如进程启动期、裸脚本） */
export function currentActor(): Actor | null {
  return als.getStore()?.actor ?? null;
}

/**
 * 后台任务入口：显式以指定身份执行，使其内部的写入都被记到该身份名下。
 * 例：runAs(systemActor('mail-archive', '系统 · 邮件归档'), () => this.fetchOnce())
 */
export function runAs<T>(actor: Actor, fn: () => T): T {
  return als.run({ actor }, fn);
}

/** 兜底身份：识别不了来源时使用 */
export const UNKNOWN_ACTOR: Actor = { id: 'system:unknown', name: '系统（未识别来源）' };

/** 后台任务身份构造器，形如 system:mail-archive */
export function systemActor(source: string, label: string): Actor {
  return { id: `system:${source}`, name: label };
}

/**
 * 系统身份的展示名映射（DB 里只存 id，展示时反查这里）。
 * 新增后台写入源时**必须**在此登记，否则界面上会显示原始 id。
 */
const SYSTEM_LABELS: Record<string, string> = {
  'system:mail-archive': '系统 · 邮件归档',
  'system:getnote-sync': '系统 · 笔记同步',
  'system:getnote-convert': '系统 · 笔记转换',
  'system:ai-automation': '系统 · AI 自动化',
  'system:monitor': '系统 · 监控告警',
  'system:role-sync': '系统 · 角色同步',
  'system:import': '系统 · 批量导入',
  'system:migration': '系统 · 历史迁移',
  'system:unknown': '系统（未识别来源）',
};

/** 系统身份 → 展示名；非系统身份（openId）返回空串，由调用方查用户表 */
export function systemLabel(id: string): string {
  return SYSTEM_LABELS[id] ?? (id.startsWith('system:') ? `系统 · ${id.slice(7)}` : '');
}

/** 由会话用户构造操作人（openId 作稳定 key，姓名作展示名） */
export function actorFromUser(user: { openId?: string; name?: string } | undefined | null): Actor {
  if (!user?.openId) return UNKNOWN_ACTOR;
  return { id: user.openId, name: user.name || user.openId };
}
