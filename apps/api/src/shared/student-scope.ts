/**
 * 学生档案「数据范围」判定（纯函数，无任何依赖，便于单测与多模块复用）。
 *
 * 2026-09-15 建立。背景：学生域此前只有「权限点 + 校区 ABAC + 字段级密级」三层，
 * **没有行级范围** —— 24 个 Phase1 账号都能看到全部 82 个学生（A 班班主任能看到 B 班档案）。
 *
 * 语义（2026-09-18 修订 —— 由 fail-open 改为 fail-closed）：
 *  - 维度之间：同时满足（AND）
 *  - 同一维度多选：满足任一（OR）
 *  - 某维度留空：该维度不参与限制
 *  - 🔴 **所有维度都留空：一条都看不到**（= `SCOPE_DENY_ALL`）
 *
 * 修订原因（峰哥 2026-09-18 报障）：原语义是「全空 = 不限制（看全部）」，于是
 * **角色管理里数据范围一个都不选 ⇒ 该角色能看到所有学生**，与直觉完全相反 ——
 * 「不选」在任何人看来都该是「什么都看不到」，而不是「全都能看到」。
 * 要「看全部」现在必须**显式表达**（三选一）：组织级角色（系统管理员/院级管理）天然豁免；
 * 人级配 `mode:'all'`；角色勾「不限制（看全部学生）」（存 `dataScope = 'all'`）。
 *
 * ⚠️ 本文件只做「一条记录是否在范围内」的判断；「谁配了什么范围」由 StudentScopeService 解析。
 *    两者分开是为了让判定逻辑能被 student.service（自建接口）与 generic-crud（通用模块）共用，
 *    避免两个地方各写一遍导致口径漂移。
 */

import { ROLE_SCOPE_DIMS } from '@acms/contracts';

/** 可配置的维度。**真源在 `@acms/contracts` 的 `ROLE_SCOPE_DIMS`**（前端角色管理页也用同一个），
 *  这里只做别名 —— 两边各写一遍迟早漂移（改了维度却只改一处 ⇒ 界面与判定不一致）。 */
export const STUDENT_SCOPE_DIMS = ROLE_SCOPE_DIMS;
export type StudentScopeDim = (typeof STUDENT_SCOPE_DIMS)[number];

/** 一个范围配置：维度 → 允许的值集合 */
export type StudentScope = Partial<Record<StudentScopeDim, string[]>> & {
  /** 显式「一条都不可见」，见下方 `SCOPE_DENY_ALL`。**不接受外部输入**。 */
  __denyAll?: true;
};

/**
 * 显式「一条都不可见」。
 *
 * 用「带标记的 scope」而不是「换一个更空的表示」或改签名：判定入口
 * `isScopeUnrestricted()` / `studentInScope()` 被 10 处调用点共用（学生档案、学生全景、
 * 阅卷、报表、通用 CRUD…），用标记后**所有调用点一行都不用改**就能拿到正确结果：
 * 不限制判定为 false ⇒ 调用方会去 filter ⇒ `studentInScope` 恒 false ⇒ 可见集合为空。
 */
export const SCOPE_DENY_ALL: StudentScope = { __denyAll: true };

/** 是否为「一条都不可见」标记 */
export function isDenyAll(scope: StudentScope | null | undefined): boolean {
  return Boolean(scope && (scope as { __denyAll?: unknown }).__denyAll === true);
}

/**
 * 是否等于「不限制（看全部）」：null / 空对象 / 每个维度都空。
 * 🔴 `SCOPE_DENY_ALL` **不算**不限制 —— 这是本次语义翻转的支点，别把这两个混了。
 */
export function isScopeUnrestricted(scope: StudentScope | null | undefined): boolean {
  if (isDenyAll(scope)) return false;
  if (!scope) return true;
  return STUDENT_SCOPE_DIMS.every((d) => !(scope[d]?.length));
}

/** 归一化任意输入为范围对象（去空、去重、只保留已知维度）；全空返回 null */
export function normalizeScope(raw: unknown): StudentScope | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out: StudentScope = {};
  // ⚠️ 只从白名单维度逐个取值 ⇒ `__denyAll` 这类标记**永远无法从外部输入进来**
  //    （谁也不能靠调接口把某个角色"配成"看不见或看成全部）
  for (const d of STUDENT_SCOPE_DIMS) {
    const arr = Array.isArray(o[d]) ? (o[d] as unknown[]).map((x) => String(x ?? '').trim()).filter(Boolean) : [];
    if (arr.length) out[d] = Array.from(new Set(arr));
  }
  return isScopeUnrestricted(out) ? null : out;
}

/**
 * 合并多个范围（**并集**）。
 *
 * 用于多角色场景：一个人可能同时是「教务」和「Phase1」，任一角色给了某个年级的可见权限，
 * 就应当可见 —— 与权限点的并集语义保持一致（交集会让多角色用户反而看得更少，反直觉）。
 */
export function mergeScopes(scopes: (StudentScope | null | undefined)[]): StudentScope | null {
  const out: StudentScope = {};
  for (const s of scopes) {
    if (!s) continue;
    for (const d of STUDENT_SCOPE_DIMS) {
      const v = s[d];
      if (v?.length) out[d] = Array.from(new Set([...(out[d] ?? []), ...v]));
    }
  }
  return isScopeUnrestricted(out) ? null : out;
}

/**
 * 角色级的范围配置（存在 `role_permission_config` 的 `role.dataScope`）：
 *  - `'all'`  = 显式「不限制（看全部学生）」
 *  - 对象     = 按维度过滤
 *  - `null`   = **未配置 ⇒ 该角色看不到任何学生**（2026-09-18 起；旧语义是「不限制」）
 */
export type RoleScopeCfg = StudentScope | 'all' | null;

/** 解析角色配置里的 `dataScope`（唯一入口，兼容字符串 `'all'`） */
export function normalizeRoleScope(raw: unknown): RoleScopeCfg {
  if (raw === 'all') return 'all';
  return normalizeScope(raw);
}

/**
 * 合并多角色的范围配置（并集语义，与权限点一致：多角色只会看得更多，不会更少）。
 *
 * @returns `'all'` = 任一角色显式配了「看全部」；
 *          `null`  = **所有角色都没配 ⇒ 调用方必须按「看不到任何学生」处理**；
 *          对象    = 各角色维度值的并集。
 * 🔴 注意 `null` 的含义与 2026-09-18 之前相反（那时是「不限制」）——
 *    调用方必须显式处理，见 `StudentScopeService.resolve()` / `explain()`。
 */
export function mergeRoleScopes(cfgs: RoleScopeCfg[]): RoleScopeCfg {
  if (cfgs.some((c) => c === 'all')) return 'all';
  const scopes = cfgs.filter((c): c is StudentScope => Boolean(c) && c !== 'all');
  return mergeScopes(scopes);
}

/**
 * 一条学生记录是否落在范围内。
 * @param scope null/undefined/全空 = 不限制（返回 true）；`SCOPE_DENY_ALL` = 恒 false
 */
export function studentInScope(
  rec: Record<string, unknown>,
  scope: StudentScope | null | undefined,
): boolean {
  if (isDenyAll(scope)) return false;
  if (isScopeUnrestricted(scope)) return true;
  for (const d of STUDENT_SCOPE_DIMS) {
    const want = scope![d];
    if (!want?.length) continue; // 该维度未限制
    const raw = rec[d];
    const have = (Array.isArray(raw) ? raw : [raw])
      .map((v) => String(v ?? '').trim())
      .filter(Boolean);
    // 范围要求了某维度、但这条记录该维度为空 → 不可见（宁可少看，不可漏看）
    if (!have.length) return false;
    if (!have.some((h) => want.includes(h))) return false;
  }
  return true;
}

/** 人级的三种模式 */
export type UserScopeMode = 'role' | 'all' | 'custom';

/** 人级配置（存 systemConfig 的 user_scope_config，不动飞书用户表结构） */
export interface UserScopeEntry {
  mode: UserScopeMode;
  scope?: StudentScope;
}

/** 解析人级配置条目；非法值按「跟随角色」处理 */
export function normalizeUserScopeEntry(raw: unknown): UserScopeEntry {
  if (!raw || typeof raw !== 'object') return { mode: 'role' };
  const o = raw as Record<string, unknown>;
  const mode = o.mode === 'all' || o.mode === 'custom' ? o.mode : 'role';
  if (mode !== 'custom') return { mode };
  const scope = normalizeScope(o.scope);
  // custom 但没配任何维度 ⇒ 退化为「跟随角色」，避免"配了自定义却什么都没选"造成误判为不可见
  return scope ? { mode: 'custom', scope } : { mode: 'role' };
}
