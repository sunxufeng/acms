import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { ROLE_PERMISSION_CONFIG_KEY, TABLES, USER_TABLE } from '@acms/contracts';
import { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT } from '../base.provider.js';
import { buildFilter } from './record.util.js';
import {
  isScopeUnrestricted,
  mergeRoleScopes,
  mergeScopes,
  normalizeScope,
  normalizeRoleScope,
  normalizeUserScopeEntry,
  SCOPE_DENY_ALL,
  studentInScope,
  type RoleScopeCfg,
  type StudentScope,
  type UserScopeEntry,
} from './student-scope.js';

/** 用户级「学生档案范围」配置的配置键（与角色配置同表，避免动飞书用户表结构） */
export const USER_SCOPE_CONFIG_KEY = 'user_scope_config';

/** 组织级角色：不受学生范围限制（与校区 ABAC 的豁免口径保持一致） */
const ORG_WIDE_ROLES = ['系统管理员', '院级管理'];

/** 配置缓存：10 秒 TTL + 写操作即时失效，避免每个列表请求都全量查配置表 */
const CACHE_TTL_MS = 10_000;

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'object') {
    // 飞书文本字段可能被包成 [{ text: '...' }]
    if (Array.isArray(raw)) {
      const first = raw[0] as { text?: string } | undefined;
      return first?.text ? parseJsonObject(first.text) : null;
    }
    return raw as Record<string, unknown>;
  }
  const s = String(raw).trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 学生档案「数据范围」的解析与落库。
 *
 * 职责边界：
 *  - 判定逻辑（AND/OR/留空语义）在 `student-scope.ts` 的纯函数里，这里只负责**找配置**；
 *  - 配置落点两处（都放系统配置表，**不动飞书用户表结构**）：
 *      · 角色级 → `role_permission_config` 的每个 role.dataScope
 *      · 人级   → `user_scope_config`（openId → { mode, scope }）
 *  - 优先级：组织级角色豁免 > 人级 > 角色级（多角色取并集）
 *
 * 以 @Global 模块注册，student.service 与 generic-crud 都可直接注入。
 */
@Injectable()
export class StudentScopeService {
  private readonly logger = new Logger('StudentScope');
  private userCfgCache: { at: number; map: Record<string, UserScopeEntry> } | null = null;
  private roleCfgCache: { at: number; map: Record<string, RoleScopeCfg> } | null = null;
  private studentCache: { at: number; rows: { id: string; name: string; rec: Record<string, unknown> }[] } | null =
    null;

  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  /** 读系统配置表的一条 JSON 配置 */
  private async readConfig(key: string): Promise<Record<string, unknown> | null> {
    const res = await this.base.search(TABLES.systemConfig.tableId, {
      pageSize: 5,
      filter: buildFilter([{ field: '配置键', value: [key] }]),
    });
    const rec = res.items?.[0];
    if (!rec) return null;
    const fields = (rec.fields ?? rec) as Record<string, unknown>;
    return parseJsonObject(fields['配置值']);
  }

  /** 人级配置表：openId → 条目 */
  private async userEntries(): Promise<Record<string, UserScopeEntry>> {
    const now = Date.now();
    if (this.userCfgCache && now - this.userCfgCache.at < CACHE_TTL_MS) return this.userCfgCache.map;
    const raw = await this.readConfig(USER_SCOPE_CONFIG_KEY);
    const map: Record<string, UserScopeEntry> = {};
    for (const [k, v] of Object.entries(raw ?? {})) map[k] = normalizeUserScopeEntry(v);
    this.userCfgCache = { at: now, map };
    return map;
  }

  /** 角色级配置表：角色 key → 范围配置（未配置 = null ⇒ **一条都看不到**） */
  private async roleScopes(): Promise<Record<string, RoleScopeCfg>> {
    const now = Date.now();
    if (this.roleCfgCache && now - this.roleCfgCache.at < CACHE_TTL_MS) return this.roleCfgCache.map;
    // ⚠️ 这里是**读**配置：直接解析 systemConfig 里那条 JSON 的 roles[].dataScope。
    //    不要用 @acms/domain 的 loadRolePermissionConfig —— 那是「把矩阵写进权限引擎」的入口，返回 void。
    const raw = await this.readConfig(ROLE_PERMISSION_CONFIG_KEY);
    const roles = (raw?.roles ?? []) as { key?: string; dataScope?: unknown }[];
    const map: Record<string, RoleScopeCfg> = {};
    for (const r of roles) {
      if (r?.key) map[r.key] = normalizeRoleScope(r.dataScope);
    }
    this.roleCfgCache = { at: now, map };
    return map;
  }

  /** 清缓存（配置写入后调用，保证「改完立即生效」） */
  clearCache(): void {
    this.userCfgCache = null;
    this.roleCfgCache = null;
    this.studentCache = null;
  }

  /**
   * 解析当前用户的有效范围。
   * @returns `null` = 不限制（看全部）；`SCOPE_DENY_ALL` = **一条都看不到**；否则为需要满足的范围
   *
   * 🔴 2026-09-18 语义翻转：角色级**一个维度都没配**时，原来返回 `null`（放行、看全部），
   *    现在返回 `SCOPE_DENY_ALL`（看不到任何学生）。原因是「不选 = 看全部」与直觉相反，
   *    在角色管理页上尤其危险（配了范围却没勾任何值时，人会以为已经收紧了）。
   *    要「看全部」必须显式：组织级角色 / 人级 `mode:'all'` / 角色勾「不限制」（`dataScope:'all'`）。
   */
  async resolve(user: SessionUser): Promise<StudentScope | null> {
    try {
      if ((user.roles ?? []).some((r) => ORG_WIDE_ROLES.includes(r))) return null;

      // 1) 人级优先
      const entries = await this.userEntries();
      const entry = entries[user.openId];
      if (entry?.mode === 'all') return null;
      if (entry?.mode === 'custom' && entry.scope) return entry.scope;

      // 2) 角色级：多角色取并集
      const roleMap = await this.roleScopes();
      const merged = mergeRoleScopes((user.roles ?? []).map((r) => roleMap[r] ?? null));
      if (merged === 'all') return null; // 显式配了「不限制（看全部）」
      if (!merged) return SCOPE_DENY_ALL; // 都没配 ⇒ 一条都看不到（fail-closed）
      return merged;
    } catch (e) {
      // 配置读不到时**不阻断**（宁可放行也不要把人挡在门外），但要留日志。
      // ⚠️ 这是本次 fail-closed 收紧里**刻意保留的唯一例外**：它防的是「基础设施故障」
      //    （配置表读不到），不是「配置没配」——后者已改为看不到。若哪天要求更严，
      //    把这里改成 return SCOPE_DENY_ALL 即可（代价：一次读表抖动会让所有人列表变空）。
      this.logger.warn(`解析学生范围失败，按不限制处理: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * 范围「来源说明」：不仅给结果，还给**是哪一层限制的**。
   *
   * 学生档案页顶部的提示条用它 —— 范围导致看不到数据有三层
   * （人级配置 / 角色级配置 / ABAC 校区），表现都是空列表，界面上必须能区分。
   * level 语义：
   *   org         组织级角色，豁免
   *   user-all    人级配了「全部学生」（例外放宽）
   *   user-custom 人级配了「自定义」
   *   role-all    角色显式配了「不限制（看全部学生）」
   *   role        角色级按维度过滤（多角色并集）
   *   role-none   🔴 角色**都没配**数据范围 ⇒ 一条都看不到（2026-09-18 起；界面要能说清）
   *   none        都没配但按不限制兜底（仅配置读取失败时会出现）
   */
  async explain(user: SessionUser): Promise<{ level: string; scope: StudentScope | null; visible: number; total: number }> {
    const rows = await this.allStudents();
    const total = rows.length;
    try {
      if ((user.roles ?? []).some((r) => ORG_WIDE_ROLES.includes(r))) {
        return { level: 'org', scope: null, visible: total, total };
      }
      const entry = (await this.userEntries())[user.openId];
      if (entry?.mode === 'all') return { level: 'user-all', scope: null, visible: total, total };
      if (entry?.mode === 'custom' && entry.scope) {
        return {
          level: 'user-custom',
          scope: entry.scope,
          visible: rows.filter((r) => studentInScope(r.rec, entry.scope as StudentScope)).length,
          total,
        };
      }
      const roleMap = await this.roleScopes();
      const merged = mergeRoleScopes((user.roles ?? []).map((r) => roleMap[r] ?? null));
      if (merged === 'all') return { level: 'role-all', scope: null, visible: total, total };
      if (!merged) return { level: 'role-none', scope: null, visible: 0, total };
      return { level: 'role', scope: merged, visible: rows.filter((r) => studentInScope(r.rec, merged)).length, total };
    } catch (e) {
      this.logger.warn(`范围说明解析失败，按不限制处理: ${(e as Error).message}`);
      return { level: 'none', scope: null, visible: total, total };
    }
  }

  /** 全量学生（缓存 10 秒）：recordId + 姓名 + 扁平记录 */
  private async allStudents(): Promise<{ id: string; name: string; rec: Record<string, unknown> }[]> {
    const now = Date.now();
    if (this.studentCache && now - this.studentCache.at < CACHE_TTL_MS) return this.studentCache.rows;
    const rows: { id: string; name: string; rec: Record<string, unknown> }[] = [];
    let token: string | undefined;
    let guard = 0;
    do {
      const res = await this.base.search(TABLES.studentProfile.tableId, { pageSize: 200, pageToken: token });
      for (const it of res.items ?? []) {
        const rec = (it.fields ?? it) as Record<string, unknown>;
        const id = String((it as { recordId?: string }).recordId ?? (rec as { id?: string }).id ?? '');
        const flat = { ...rec };
        for (const k of Object.keys(flat)) {
          const v = flat[k];
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            const t = (v as { text?: string }).text;
            if (t !== undefined) flat[k] = t;
          }
        }
        rows.push({ id, name: String(flat['学生姓名'] ?? '').trim(), rec: flat });
      }
      token = res.hasMore ? res.pageToken : undefined;
    } while (token && guard++ < 20);
    this.studentCache = { at: now, rows };
    return rows;
  }

  /**
   * 范围内学生的 key 集合。
   * @param by 'id' → 学生 record id；'name' → 学生姓名
   * @returns null = 不限制（调用方不要做过滤）；数组 = 允许的 key（可能为空数组 = 一条都不可见）
   */
  async visibleKeys(scope: StudentScope | null, by: 'id' | 'name'): Promise<string[] | null> {
    if (isScopeUnrestricted(scope)) return null;
    const rows = await this.allStudents();
    const hit = rows.filter((r) => studentInScope(r.rec, scope));
    const set = new Set(hit.map((r) => (by === 'id' ? r.id : r.name)).filter(Boolean));
    return Array.from(set);
  }

  /** 判断单个学生（按 recordId）是否可见 —— 学生档案详情/全景等自建接口用 */
  async studentVisible(user: SessionUser, studentRecordId: string): Promise<boolean> {
    const scope = await this.resolve(user);
    if (isScopeUnrestricted(scope)) return true;
    const rows = await this.allStudents();
    const hit = rows.find((r) => r.id === studentRecordId);
    if (!hit) return false; // 查不到就别放行
    return studentInScope(hit.rec, scope);
  }

  /** 读某用户的人级配置（配置界面回显用） */
  async getUserEntry(openId: string): Promise<UserScopeEntry> {
    const entries = await this.userEntries();
    return entries[openId] ?? { mode: 'role' };
  }

  /** 全部用户的人级配置（用户管理列表批量回显用，避免逐行查） */
  async allUserEntries(): Promise<Record<string, UserScopeEntry>> {
    return this.userEntries();
  }

  /**
   * 写某用户的人级配置。
   * 整表读改写（条目数 = 账号数，几十条，成本可忽略）——避免为一条记录引入并发写风险更复杂的方案。
   */
  async setUserEntry(openId: string, entry: UserScopeEntry): Promise<void> {
    if (!openId) return;
    const tableId = TABLES.systemConfig.tableId;
    const res = await this.base.search(tableId, {
      pageSize: 5,
      filter: buildFilter([{ field: '配置键', value: [USER_SCOPE_CONFIG_KEY] }]),
    });
    const exist = res.items?.[0] as { recordId?: string } | undefined;
    const raw = await this.readConfig(USER_SCOPE_CONFIG_KEY);
    const map: Record<string, unknown> = { ...(raw ?? {}) };
    const norm = normalizeUserScopeEntry(entry);
    if (norm.mode === 'role') delete map[openId];
    else map[openId] = norm;
    const payload = { 配置键: USER_SCOPE_CONFIG_KEY, 配置值: JSON.stringify(map) };
    const oldId = exist?.recordId ?? String((exist as { id?: string })?.id ?? '');
    if (oldId) await this.base.update(tableId, oldId, payload);
    else await this.base.create(tableId, payload);
    this.userCfgCache = null;
  }

  /** 学生范围候选值（当前年级 / 当前状态 + 人数 + 两维交叉计数），供配置界面用 */
  async options(): Promise<{
    dims: { dim: string; values: { value: string; count: number }[] }[];
    cross: { 当前年级: string; 当前状态: string; count: number }[];
    total: number;
  }> {
    const rows = await this.allStudents();
    const dims = ['当前年级', '当前状态'];
    const out = dims.map((dim) => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const v = String(r.rec[dim] ?? '').trim();
        if (v) m.set(v, (m.get(v) ?? 0) + 1);
      }
      return {
        dim,
        values: Array.from(m.entries())
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-CN')),
      };
    });
    const crossMap = new Map<string, number>();
    for (const r of rows) {
      const g = String(r.rec['当前年级'] ?? '').trim();
      const s = String(r.rec['当前状态'] ?? '').trim();
      if (!g && !s) continue;
      const k = `${g}\u0000${s}`;
      crossMap.set(k, (crossMap.get(k) ?? 0) + 1);
    }
    return {
      dims: out,
      cross: Array.from(crossMap.entries()).map(([k, count]) => {
        const [g = '', s = ''] = k.split('\u0000');
        return { 当前年级: g, 当前状态: s, count };
      }),
      total: rows.length,
    };
  }
}
