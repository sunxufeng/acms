/**
 * 学生档案「数据范围」判定（纯函数，无任何依赖，便于单测与多模块复用）。
 *
 * 2026-09-15 建立。背景：学生域此前只有「权限点 + 校区 ABAC + 字段级密级」三层，
 * **没有行级范围** —— 24 个 Phase1 账号都能看到全部 82 个学生（A 班班主任能看到 B 班档案）。
 *
 * 语义（由峰哥确认）：
 *  - 维度之间：同时满足（AND）
 *  - 同一维度多选：满足任一（OR）
 *  - 某维度留空：该维度不参与限制
 *  - 所有维度都留空：**不限制**（看全部）—— 这是默认态，所以上线不会改变任何人的可见范围
 *
 * ⚠️ 本文件只做「一条记录是否在范围内」的判断；「谁配了什么范围」由 StudentScopeService 解析。
 *    两者分开是为了让判定逻辑能被 student.service（自建接口）与 generic-crud（通用模块）共用，
 *    避免两个地方各写一遍导致口径漂移。
 */

/** 可配置的维度。只做两个（2026-09-15 峰哥确认）：入学年级字典与实际数据不符，故不纳入。 */
export const STUDENT_SCOPE_DIMS = ['当前年级', '当前状态'] as const;
export type StudentScopeDim = (typeof STUDENT_SCOPE_DIMS)[number];

/** 一个范围配置：维度 → 允许的值集合 */
export type StudentScope = Partial<Record<StudentScopeDim, string[]>>;

/** 是否等于「不限制」：null / 空对象 / 每个维度都空 */
export function isScopeUnrestricted(scope: StudentScope | null | undefined): boolean {
  if (!scope) return true;
  return STUDENT_SCOPE_DIMS.every((d) => !(scope[d]?.length));
}

/** 归一化任意输入为范围对象（去空、去重、只保留已知维度）；全空返回 null */
export function normalizeScope(raw: unknown): StudentScope | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out: StudentScope = {};
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
 * 一条学生记录是否落在范围内。
 * @param scope null/undefined/全空 = 不限制（返回 true）
 */
export function studentInScope(
  rec: Record<string, unknown>,
  scope: StudentScope | null | undefined,
): boolean {
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
