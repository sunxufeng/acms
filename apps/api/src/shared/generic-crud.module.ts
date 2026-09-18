/**
 * 通用记录 CRUD 模块（M1 学生生命周期域：生源跟进 / 学生考勤 / 学业成绩 / 实践活动 /
 * 家校沟通 / 阶段评价 / 校友跟进）。这些表结构高度同质，统一用一份泛型服务 + 动态
 * 控制器承载，避免 7×4 重复文件。每种表通过 RecordMeta 描述字段约束。
 */
import {
  Controller, Get, Post, Put, Delete, Param, Query, Body, Req, Res, UseGuards,
  Inject, Injectable, Module, type DynamicModule, type Type,
} from '@nestjs/common';
import type { Request } from 'express';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { type Permission, type ModuleAction, moduleByPath, modulePermission } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { toText, type FilterCondition, type FilterGroup } from '@acms/base-adapter';
import { BASE_CLIENT, baseClientProvider } from '../base.provider.js';
import { SessionGuard } from '../auth/session.guard.js';
import { AuditService } from '../audit/audit.service.js';
import { FieldMaskService } from './field-mask.service.js';
import { StudentScopeService } from './student-scope.service.js';
import { encryptSecret, isEncrypted, isSecretMask, maskSecret } from './secret-cipher.js';
import { buildWriteFields, toFlatRecord, buildFilter } from './record.util.js';
import { isInvalidPhone } from './phone.util.js';
// 「疑似重复」下钻：复用**报表那一份**分组逻辑，保证卡片数字与下钻名单同口径
import { DEDUP_MODES, dedupMemberIds, toDedupRow, type DedupMode } from '../reports/contact-dedup.js';

/** 把「毫秒时间戳（number / 纯数字字符串）」或「日期字符串」统一解析为 epoch ms；无法解析返回 null */
function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}

/** 把「可能是 JSON 字符串」的值解析成对象；解析不了返回空对象。用于自定义字段这类整包 JSON 列 */
function parseJsonObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v !== 'string' || !v.trim()) return {};
  try {
    const p = JSON.parse(v);
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 行级数据范围的条件表达式（与列表查询共用同一份定义，见 RecordMeta.rowScope） */
export type RowScopeFilter = FilterCondition | FilterGroup;

/**
 * rowScope / defaults 可用的**只读查询助手**。
 *
 * 为什么由引擎传进来：meta 是静态配置对象，拿不到依赖注入，而
 * 「先查关联关系再拼范围条件」这类需求（如「我在哪些邮件账户的关联用户里」）
 * 必须能查别的表。引擎在调用时把 base 客户端包一层传进来即可。
 */
export interface RowScopeContext {
  /** 按表查记录（最多 500 条），返回扁平记录数组，每项带 `id` */
  search: (tableId: string, filter?: RowScopeFilter) => Promise<Record<string, unknown>[]>;
}

/**
 * 判断一行是否满足行级范围条件。
 * 只实现 rowScope / typeScope 用得到的子集：等值 / contains / isempty / isnotempty / and / or。
 * （算子名与 `SqlStore.buildCondition` 对齐，两边必须能表达同一件事，否则服务端分页与内存兜底会漂移。）
 *
 * 存在的意义：行级范围既要在**服务端查询**里表达（否则分页与 total 都是错的），
 * 又要在**拿到单行之后**判断（详情、导出、内存深筛）。两处各写一套的话早晚漂移，
 * 所以统一由本函数消费同一份条件对象。
 */
export function matchFilter(row: Record<string, unknown>, cond: RowScopeFilter | 'none' | null | undefined): boolean {
  if (cond === null || cond === undefined) return true;
  if (cond === 'none') return false;
  if ('conjunction' in cond) {
    const list = cond.conditions ?? [];
    if (!list.length) return true;
    return cond.conjunction === 'or'
      ? list.some((c) => matchFilter(row, c))
      : list.every((c) => matchFilter(row, c));
  }
  // ⚠️ 关联字段（link）在内存路径里，展示值已被 `resolveLinks` 换成姓名，
  //    原始 record id 只留在 `<字段>__link` 数组里。行级范围条件用的是 **id**
  //    （姓名会重名，不能当判据），所以这里必须把 `__link` 也纳入候选，
  //    否则「只被关联、没有归属人ID」的用户一旦触发内存路径（带 `__has`/`_from` 等深筛）
  //    就会一条都看不到 —— 判据与服务端 SQL 路径（ILIKE 命中 jsonb 里的 id）保持一致。
  //    见 `__has` 分支同款处理（「两边都认，传 id 或传名称都能筛到」）。
  const cells = [row[cond.field], row[`${cond.field}__link`]];
  const have = cells
    .flatMap((c) => (Array.isArray(c) ? c : [c]))
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(toText(v)));
  const op = (cond.op ?? 'is').toLowerCase();
  // ⚠️ 空值判断必须排在下面「want 为空 ⇒ 不限制」之前：`isempty` 的 value 本来就是空数组，
  //    顺序反了会走成 `!want.length ⇒ return true`（变成「谁都能看」），语义正好相反。
  //    算子名与 SqlStore.buildCondition 一致（`coalesce(col,'') = ''`，等价于「无值或空串」）。
  if (op === 'isempty') return have.every((h) => h === '');
  if (op === 'isnotempty') return have.some((h) => h !== '');
  const want = (cond.value ?? []).map((v) => String(v));
  if (!want.length) return true;
  return want.some((w) => (op === 'contains' ? have.some((h) => h.includes(w)) : have.includes(w)));
}

export interface RecordMeta {
  /** 路由前缀，如 'source-followups' */
  path: string;
  /** TABLES 中的键或真实 tableId */
  tableId: string;
  readPerm: string;
  writePerm: string;
  /** 只读字段（含自增编号、附件等不写字段） */
  readonly?: string[];
  /** 数值字段 */
  numbers?: string[];
  /** 多值字段 */
  multi?: string[];
  /**
   * 新建时的字段默认值（只作用于 create，update 不受影响）。
   * ⚠️ 在 writeFields 之后套用 —— 这样即使字段登记在 readonly 里（如系统维护的「调度状态」），
   * 也能在新建时拿到初始值，而不是等到定时任务第一次跑才有值。
   * 用户显式传了同名字段则不覆盖。
   */
  defaults?:
    | Record<string, unknown>
    | ((
        fields: Record<string, unknown>,
        user?: SessionUser,
        ctx?: RowScopeContext,
      ) => Record<string, unknown> | Promise<Record<string, unknown>>);
  /** 状态字段（展示 + 可编辑） */
  statusField?: string;
  defaultStatus?: string;
  /** q 关键字检索字段（单字段 contains）。与 searchFields 二选一，searchFields 优先 */
  searchField?: string;
  /** q 关键字检索字段（多字段 OR 匹配，如配置键 + 配置值） */
  searchFields?: string[];
  /** 日期字段（写时字符串→毫秒时间戳） */
  dateFields?: string[];
  /** 列表默认排序字段 */
  sortField?: string;
  /** 学生 360 聚合时如何把记录关联到某学生：
   *  - { field: '关联学生编号', by: 'id' }：关联字段为 link，存 record id（考勤/成绩/实践/评价/校友）
   *  - { field: '关联学生', by: 'name' }：关联字段为文本，存学生姓名（招生/家校/日常跟进） */
  studentMatch?: { field: string; by: 'id' | 'name' };
  /**
   * 本模块是否按**学生档案数据范围**过滤（2026-09-15）。
   *
   * 声明为 true 后，用户看到的本模块记录会被限制在「他能看的学生」范围内
   * （判据取自 studentMatch 声明的那个字段），与 rowScope 是 AND 关系。
   *
   * 为什么用显式声明而不是「有 studentMatch 就自动生效」：
   * 招生跟进（source-followups）也有 studentMatch，但招生老师需要看自己负责的线索，
   * 不应当被学生档案范围牵连。要接入哪个模块，逐个显式打开。
   */
  studentScoped?: boolean;
  /**
   * 「关联学生要经中间表跳转」时的声明（2026-09-15）。
   *
   * 用于**子表**：IDP 沟通记录不直接关联学生，而是挂在 IDP 方案下（「关联IDP方案」→ 方案 →「关联学生」）。
   * 声明后，本模块的范围判据变成「该行关联的中间记录，其学生是否可见」：
   *   先查中间表筛出可见记录 id，再用这些 id 过滤本表。
   * ⚠️ 与 studentScoped 二选一，同时声明时以 studentVia 为准（它更具体）。
   */
  studentVia?: { linkField: string; linkTable: string; innerMatchField: string; innerMatchBy: 'id' | 'name' };
  /** 时间范围筛选字段（用于审计日志等的操作时间区间过滤，内存过滤） */
  rangeField?: string;
  /** 跨字段校验：结束时间必须晚于开始时间（如会议纪要的开始时间/结束时间） */
  timeRange?: { startField: string; endField: string };
  /** 关联字段（type=18/21/22）：需跨表解析为可读名。field=本表字段名，table=目标表 tableId，nameField=目标表用于展示的字段名 */
  linkFields?: { field: string; table: string; nameField: string }[];
  /**
   * 凭证字段（如开放平台的 App Secret）：
   *  - 写入时 AES 加密落库
   *  - 读取时一律回显掩码 `******`，前端原样回传表示「不修改」
   * 用于开放平台外接系统凭证，避免明文出现在列表、备份与日志里。
   */
  secretFields?: string[];
  /**
   * 需要跨表/自定义逻辑才能判断的筛选参数名（仅 listDeep 内存过滤阶段生效）。
   * 列在这里的参数不会被当成「字段名等值匹配」，交由 deepFilter 处理。
   */
  deepParams?: string[];
  /**
   * 是否支持「疑似重复」下钻（`?dedup=strong|likely|all|mergeable`）。
   *
   * 「是否重复」不是一个字段，而是**报表当场算出来的**（按姓名分桶 + 反证据排除，见
   * `reports/contact-dedup.ts`）。所以只有那些「有对应去重报表」的表才该打开这个开关，
   * 否则 `?dedup=` 会静默失去意义（对无关表来说是未知参数，会被当成字段等值筛成 0 条）。
   */
  dedupParams?: boolean;
  /**
   * 行级「记录类型」权限过滤（2026-09-18）。
   *
   * 用于**多个业务模块合并到同一张表**的场景（学生记录 = 日常跟进 / 家校沟通 / 学生观察）：
   * 表里用一个单选字段区分类型，用户能看**哪些类型**由各自模块的权限点决定。
   *
   * 生效方式（三条，都在本文件里，改一处要一起看）：
   *   - 读：`rowScopeFor` 追加一条「类型 ∈ 有权限的类型」，服务端过滤 ⇒ 分页与 total 正确；
   *         详情 / 导出 / 内存深筛消费同一份条件（matchFilter）。
   *         一条类型权限都没有 ⇒ 返回 `'none'`（一条都看不到）。
   *   - 进入：`require('read')` 放宽成「任一类型权限即可」，见 `anyStudentRecordPerm` 的注释 ——
   *         合并前每个模块各有权限点、角色配置里存的就是那三个，主入口若只认新权限点会**没人能进**。
   *   - 写：create 校验「所填类型」对应的 write 权限，避免用日常跟进的写权限建出家校沟通记录。
   *
   * ⚠️ `defaultType` 是给「未打类型的历史记录」兜底的：字段为空时按它归属。
   *    没有这层兜底，任何漏打类型的记录会对**所有人**静默消失（比权限放大更危险）。
   */
  typeScope?: {
    /** 类型字段名（单选），如「记录类型」 */
    field: string;
    /** 类型值 → 模块 key（用 `module:<key>:read|write` 拼权限点） */
    typeModules: Record<string, string>;
    /** 字段为空/未打类型时视为哪一类（缺省取 typeModules 的第一个） */
    defaultType?: string;
    /** 绕过类型过滤的角色（缺省 `['系统管理员']`） */
    bypassRoles?: string[];
  };
  /**
   * 自定义深度筛选钩子：返回 false 表示剔除该行，其它值（含 undefined）表示保留。
   * 只在 URL/查询里出现 deepParams 中的参数时才有必要实现。
   */
  deepFilter?: (
    row: Record<string, unknown>,
    query: Record<string, string | undefined>,
  ) => boolean | undefined | null | Promise<boolean | undefined | null>;
  /**
   * 行级数据范围：非豁免角色**只允许访问满足该条件**的行。
   *
   * - 返回 `FilterCondition` / `FilterGroup`：合并进列表查询做服务端过滤（分页与 total 才正确），
   *   详情 / 导出 / 内存深筛用**同一个条件对象**做判断（`matchFilter` 消费）
   * - 返回 `'none'`：一条都看不到（例如「我不在任何账户的关联用户里」）
   * - 返回 `null`：不限制
   *
   * ⚠️ 判据只写这一处。服务端查询与内存判断共用同一份条件，不要在两处各实现一遍 —— 必然漂移。
   * ⚠️ 覆盖 list / listDeep / listByLinkSearch / detail / exportCsv；
   *    `update` / `archive` / `transition` 都会先调 `detail()`，因此自动受保护。
   * ⚠️ 行范围是**强制**的：与用户自己传的筛选是 AND 关系，前端无法绕过。
   */
  rowScope?: (
    user: SessionUser,
    ctx: RowScopeContext,
  ) => RowScopeFilter | 'none' | null | Promise<RowScopeFilter | 'none' | null>;
  /** 行级范围的豁免角色（默认只豁免 `系统管理员`） */
  rowScopeBypassRoles?: string[];
  /**
   * 审计四件套中「以业务字段为准」的字段名（如卫瓴的「创建时间」= 线索进入时间）。
   * 不配置时保持默认行为：审计字段一律以 PG 物理列（落库时间）为准。
   */
  auditOverride?: string[];
}

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

/**
 * 「记录类型」域：当前用户对该模块各类型持有的权限集合。
 *
 * 返回值三态，**必须区分**（混了就是权限漏洞或功能消失）：
 *   - `null`：本模块没有 typeScope，或用户命中豁免角色（默认系统管理员）⇒ **不限制**
 *   - `[]`  ：有类型域但一个类型权限都没有 ⇒ **什么都不允许**
 *   - 非空数组：允许的类型值
 *
 * 导出给 `student-360` 复用 —— 学生全景要按同一判据决定「这个分区能不能看」，
 * 两处各写一套必然漂移（会出现「列表看不到、全景看得到」这类鬼故事）。
 */
export function typeAllowedValues(
  meta: Pick<RecordMeta, 'typeScope'>,
  user: SessionUser,
  action: ModuleAction,
): string[] | null {
  const ts = meta.typeScope;
  if (!ts) return null;
  const bypass = ts.bypassRoles ?? ['系统管理员'];
  if ((user.roles ?? []).some((r) => bypass.includes(r))) return null;
  const principal = toPrincipal(user);
  return Object.entries(ts.typeModules)
    .filter(([, key]) => authorize(principal, modulePermission(key, action) as Permission).allowed)
    .map(([value]) => value);
}

/**
 * 「记录类型」域的行级可见条件。
 *
 *   - `null`   不限制（无 typeScope / 豁免角色）
 *   - `'none'` 一条都不可见（有类型域但无任何类型权限）
 *   - 条件对象 可直接并入 rowScope（服务端过滤 ⇒ 分页与 total 正确，详情/导出/内存深筛复用同一份）
 *
 * ⚠️ 未打类型的记录按 `defaultType` 归属：只有用户对该类型有权限时才放行。
 *    没有这层兜底，任何漏打类型的记录会对**所有人**静默消失（比权限放大更危险）。
 */
export function buildTypeScopeFilter(
  meta: Pick<RecordMeta, 'typeScope'>,
  user: SessionUser,
): RowScopeFilter | 'none' | null {
  const ts = meta.typeScope;
  if (!ts) return null;
  const allowed = typeAllowedValues(meta, user, 'read');
  if (allowed === null) return null;
  if (!allowed.length) return 'none';
  const conds: RowScopeFilter[] = [{ field: ts.field, op: 'is', value: allowed }];
  const def = ts.defaultType ?? Object.keys(ts.typeModules)[0] ?? '';
  if (def && allowed.includes(def)) conds.push({ field: ts.field, op: 'isempty', value: [] });
  return conds.length === 1 ? conds[0]! : { conjunction: 'or', conditions: conds };
}

export class BaseRecordService {
  constructor(
    protected readonly meta: RecordMeta,
    @Inject(BASE_CLIENT) protected readonly base: BaseClient,
    @Inject(AuditService) protected readonly audit: AuditService,
    @Inject(FieldMaskService) protected readonly mask: FieldMaskService,
    /**
     * 学生档案数据范围服务（2026-09-15，**可选**）。
     * 只有声明了 `studentScoped: true` 的模块需要它（由 makeService 注入）；
     * 其它子类（邮件归档 / IDP / getnote / behaviour）不传即可，行为完全不变。
     */
    protected readonly studentScope?: StudentScopeService,
  ) {}

  /** 操作人展示名 */
  private actorName(user: SessionUser): string {
    return user.name || user.openId || 'unknown';
  }

  /**
   * 判断某条记录是否落在当前用户的**行级数据范围**内（供子类 / 自建接口复用）。
   *
   * 为什么需要它：`detail()` 已能拦住越界读，但**自建接口不经过 detail** ——
   * 例如「解析附件下载链接」「手动关联学生」这类带 `:id` 的自定义路由，
   * 只在 controller 里判了 `mail:read` 就放行 ⇒ 知道一个 record id 就能越权取别人的附件。
   * 这类入口必须自己过一道范围，判据与列表/详情同源（同一个 rowScopeFor）。
   *
   * 越界返回 false，由调用方决定语义（读场景建议按 404 处理，不暴露记录是否存在）。
   */
  async rowVisible(user: SessionUser, recordId: string): Promise<boolean> {
    const rec = await this.base.get(this.tableId, recordId);
    if (!rec) return false;
    const scope = await this.rowScopeFor(user);
    if (!scope) return true;
    if (scope === 'none') return false;
    const flat = toFlatRecord(rec, this.readonlySet(), this.multiSet(), this.linkSet(), this.auditOverrideSet());
    return matchFilter(flat, scope);
  }

  /**
   * 解析当前用户的行级数据范围：`null` = 不限制；`'none'` = 一条都看不到；否则为过滤条件。
   * 是 rowScope 的唯一入口，列表/详情/导出/内存深筛都从这里取，保证口径一致。
   */
  protected async rowScopeFor(user: SessionUser): Promise<RowScopeFilter | 'none' | null> {
    const parts: RowScopeFilter[] = [];

    const scope = this.meta.rowScope;
    if (scope) {
      const bypass = this.meta.rowScopeBypassRoles ?? ['系统管理员'];
      if (!(user.roles ?? []).some((r) => bypass.includes(r))) {
        const s = await scope(user, this.scopeContext());
        if (s === 'none') return 'none';
        if (s) parts.push(s);
      }
    }

    // 学生档案数据范围（2026-09-15）：本模块声明了 studentScoped 时才生效。
    // 判据 = 「该行关联的学生」是否落在用户可见范围内（组织级角色 / 未配范围 → 不限制）。
    if (this.meta.studentScoped && this.meta.studentMatch && this.studentScope) {
      const by = this.meta.studentMatch.by === 'name' ? 'name' : 'id';
      const keys = await this.studentScope.visibleKeys(await this.studentScope.resolve(user), by);
      if (keys) {
        if (!keys.length) return 'none'; // 一个学生都看不到 ⇒ 本模块一条也不可见
        // ⚠️ 算子选择（安全优先）：
        //   by=id   → contains：record id 是长随机串，子串误匹配几乎不可能，
        //              且能同时命中「单值」与「多值 JSON 数组」两种存储形态
        //   by=name → is（精确等值）：姓名用 contains 会「张三」匹配到「张三丰」，
        //              属于越权放行；宁可少看不可多看
        parts.push({
          field: this.meta.studentMatch.field,
          op: by === 'id' ? 'contains' : 'is',
          value: keys,
        });
      }
    }

    // 子表：经中间表间接关联学生（如 IDP 沟通记录 → IDP 方案 → 关联学生）
    if (this.meta.studentVia && this.studentScope) {
      const via = this.meta.studentVia;
      const keys = await this.studentScope.visibleKeys(await this.studentScope.resolve(user), via.innerMatchBy);
      if (keys) {
        if (!keys.length) return 'none';
        const mid = await this.base.search(via.linkTable, {
          pageSize: 500,
          filter: buildFilter([
            { field: via.innerMatchField, op: via.innerMatchBy === 'name' ? 'is' : 'contains', value: keys },
          ]),
        });
        const ids = (mid.items ?? [])
          .map((r) => String((r as { recordId?: string }).recordId ?? (r as { id?: string }).id ?? ''))
          .filter(Boolean);
        if (!ids.length) return 'none'; // 中间表里没有可见记录 ⇒ 本表也不可见
        parts.push({ field: via.linkField, op: 'contains', value: ids });
      }
    }

    // 记录类型权限（2026-09-18）：多个模块合并到同一张表后，按用户持有的类型权限过滤。
    // 与 rowScope 同址，所以 list / listDeep / detail / exportCsv 自动一致；且列表是**服务端**过滤，
    // 分页与 total 才正确。判据与学生全景共用同一份（buildTypeScopeFilter），避免两处漂移。
    const typeCond = buildTypeScopeFilter(this.meta, user);
    if (typeCond === 'none') return 'none'; // 一个类型权限都没有 ⇒ 一条也不可见
    if (typeCond) parts.push(typeCond);

    if (!parts.length) return null;
    return parts.length === 1 ? parts[0]! : { conjunction: 'and', conditions: parts };
  }

  /**
   * 当前用户对「记录类型」的可见/可写集合。
   *
   * 返回值三态，三个分支**必须区分**（混了就是权限漏洞或功能消失）：
   *   - `null`：本模块没有 typeScope，或用户命中豁免角色（默认系统管理员）⇒ **不限制**
   *   - `[]`  ：有类型域但一个类型权限都没有 ⇒ **什么都不允许**
   *   - 非空数组：允许的类型值
   */
  private typeAllows(user: SessionUser, action: ModuleAction): string[] | null {
    // 判据只写一份（模块级 typeAllowedValues）—— 学生全景也会消费同一份，
    // 两处各实现一遍必然漂移（会出现「列表看不到、全景看得到」这类鬼故事）。
    return typeAllowedValues(this.meta, user, action);
  }

  /**
   * 写入前校验「记录类型」。
   *
   * 校验三件事，缺一不可：
   *   ① 类型必须落在一个已知取值上（写错别字会造出一条**谁都看不见**的记录 —— 它匹配不上
   *      任何类型的过滤条件，等于静默丢数据）；
   *   ② 用户对所写类型有同名动作权限（否则「只有日常跟进写权限的人」能建/改出家校沟通记录，
   *      越权写入别人的业务域）；
   *   ③ create 缺省时补 `defaultType`（保证每条记录都带类型）。
   *
   * ⚠️ `fill: false`（update 场景）时必须传 `currentType`：用户没改类型就**绝不写回类型字段**，
   *    否则一条「家校沟通」记录会在编辑别的字段时被静默改成「日常跟进」——
   *    类型是业务含义的载体，不能被默认值覆盖。
   */
  private resolveWriteType(
    user: SessionUser,
    dto: Record<string, unknown>,
    action: ModuleAction,
    opts?: { fill?: boolean; currentType?: unknown },
  ): void {
    const ts = this.meta.typeScope;
    if (!ts) return;
    const fallback = ts.defaultType ?? Object.keys(ts.typeModules)[0] ?? '';
    const has = dto[ts.field] !== undefined && String(dto[ts.field]).trim() !== '';
    const value = has
      ? String(dto[ts.field]).trim()
      : opts?.fill === false
        ? String(opts.currentType ?? '').trim() || fallback
        : fallback;
    if (!(value in ts.typeModules)) {
      throw new BadRequestException(`VALIDATION:未知的${ts.field}「${value}」`);
    }
    // 豁免角色（系统管理员）typeAllows 返回 null ⇒ 不限制
    const allowed = this.typeAllows(user, action);
    if (allowed && !allowed.includes(value)) {
      throw new ForbiddenException(`FORBIDDEN:${ts.field}=${value}`);
    }
    if (has || opts?.fill !== false) dto[ts.field] = value;
  }

  /**
   * 给 rowScope / defaults 用的只读查询助手（见 RowScopeContext）。
   * ⚠️ 跨表读时不要套用本表的 readonly / multi / link 字段集 —— 那是**本表**的元数据，
   * 套到别的表上会把字段错误地扁平化。
   */
  protected scopeContext(): RowScopeContext {
    return {
      search: async (tableId, filter) => {
        const res = await this.base.search(tableId, {
          pageSize: 500,
          ...(filter ? { filter: buildFilter([filter]) } : {}),
        });
        // ⚠️ 返回**原始字段值**，不做 toFlatRecord 扁平化：关联/多值字段在原始形态下是数组，
        // 扁平化会把它拼成「a、b」字符串，调用方就没法按成员判断了。
        // 判断数组请用宽容解析（兼容 数组 / {link_record_ids:[...]} / JSON 字符串 三种形态）。
        return (res.items ?? []).map((r) => ({
          ...((r as unknown as { fields?: Record<string, unknown> }).fields ?? {}),
          id: (r as unknown as { recordId?: string }).recordId,
        }));
      },
    };
  }

  /** 审计：跳过审计日志表自身，避免自审计噪声 */
  private emitAudit(
    user: SessionUser,
    action: '创建' | '更新' | '删除',
    recordId: string,
    detail?: string,
  ): void {
    if (this.meta.path === 'audit-logs') return;
    void this.audit.log({
      actor: this.actorName(user),
      action,
      module: this.meta.path,
      recordId,
      detail,
    });
  }

  private get tableId() {
    return this.meta.tableId;
  }

  private readonlySet() {
    return new Set(this.meta.readonly ?? []);
  }
  private numberSet() {
    return new Set(this.meta.numbers ?? []);
  }
  private multiSet() {
    return new Set(this.meta.multi ?? []);
  }
  private linkSet() {
    return new Set((this.meta.linkFields ?? []).map((l) => l.field));
  }
  private auditOverrideSet() {
    return new Set(this.meta.auditOverride ?? []);
  }

  /** 模块级权限映射：generic-crud 现在按 module:<key>:<action> 鉴权，做到「按钮隐藏＝接口也拦」。 */
  private get mod() {
    return moduleByPath(this.meta.path);
  }
  private modPerm(action: ModuleAction): Permission | null {
    const m = this.mod;
    return m ? (modulePermission(m.key, action) as Permission) : null;
  }
  /** 命中模块资源时用模块权限；否则回退 legacy meta 权限（前向兼容未登记模块）。 */
  private require(user: SessionUser, action: ModuleAction): void {
    const m = this.mod;
    // 类型域模块（学生记录三合一）：判定改为「**任一类型模块的同名动作**权限」。
    //
    // 为什么不能直接用 `module:studentRecords:<action>`：合并前每个模块各有权限点，
    // 角色配置里存的就是那三个（生产实测：24 人的主力角色 Phase1 只持有
    // `module:studentObservations:enter/read/refresh`，系统管理员持有全套）。
    // 若主入口只认新权限点，结果就是「没有任何角色能进入 / 没有任何人能新建」——
    // 把「看得见」降级成「看不见」，且不报错、只是内容空掉。
    //
    // ⚠️ 这里只放宽「能不能进出这个入口」；**具体能看/能写哪个类型**由 typeAllows 逐类型判定
    //    （读见 rowScopeFor，写见 resolveWriteType），所以范围**不会**被放大。
    if (this.meta.typeScope) {
      const allowed = this.typeAllows(user, action);
      if (allowed === null || allowed.length) return;
      throw new ForbiddenException(`FORBIDDEN:${m ? modulePermission(m.key, action) : action}`);
    }
    const p =
      this.modPerm(action) ??
      ((action === 'read' || action === 'refresh' ? this.meta.readPerm : this.meta.writePerm) as Permission);
    if (!authorize(toPrincipal(user), p).allowed) throw new ForbiddenException('FORBIDDEN:' + p);
  }

  /** 审计等场景的扩展筛选参数（不走飞书服务端过滤，按需内存过滤） */
  private static readonly DEEP_PARAMS = ['from', 'to', 'actor', 'module', 'action'] as const;

  async list(user: SessionUser, query: Record<string, string | undefined>) {
    this.require(user, 'read');
    // 行级数据范围：强制项，与用户自己传的筛选是 AND 关系（前端绕不过）。
    // 'none' 直接短路成空页，不必打库。
    const scope = await this.rowScopeFor(user);
    if (scope === 'none') {
      return { items: [], total: 0, hasMore: false, pageToken: undefined };
    }
    // 审计日志：按操作人(模糊)/业务模块(模糊)/操作类型(精确)/时间范围 筛选，内存过滤
    // ⚠️ 以下几种也必须走内存过滤，否则会被主分支当成「字段名等值匹配」直接筛空：
    //  - `<字段>_from/_to` 时间区间、dim/dimval 自定义字段、meta.deepParams（如 follower）
    const hasDeep =
      BaseRecordService.DEEP_PARAMS.some((k) => query[k]) ||
      Object.keys(query).some((k) => /_(from|to)$/.test(k)) ||
      // 后缀约定的筛选一律内存过滤（等值匹配表达不了）：
      //   `<字段>__has=值`      多值字段的成员包含（jsonb 数组 / 「、」分隔字符串）
      //   `<字段>__notempty=1`  字段非空（报表下钻「已匹配在校生」= 关联学生非空）
      //   `<字段>__empty=1`     字段为空
      //   `<字段>__gt=数字` / `<字段>__lt=数字`  数值比较（如「跟进次数 > 0」）
      //   `<字段>__invalid=1`   字段值**无效**（目前只对「手机号」有定义：空或位数不在 7~15 位，
      //                         与去重报表的「无手机号记录」同判据 —— 否则下钻数字会少 89 条）
      Object.keys(query).some((k) => /__(has|notempty|empty|gt|lt|invalid)$/.test(k) && query[k]) ||
      !!(query.dim && query.dimval) ||
      // 疑似重复下钻（只在声明了 dedupParams 的表上生效）
      !!(this.meta.dedupParams && query.dedup) ||
      (this.meta.deepParams ?? []).some((k) => query[k]);
    if (hasDeep) {
      return this.listDeep(user, query, scope);
    }
    // 关联字段（link）作为搜索目标时，飞书服务端 contains 对关联字段无效 → 走内存按解析文本过滤
    if (query.q && this.meta.searchField && this.linkSet().has(this.meta.searchField)) {
      return this.listByLinkSearch(query, scope);
    }
    const conditions: (FilterCondition | FilterGroup)[] = [];
    // 行级范围最先入列：与后面的用户筛选取 AND
    if (scope) conditions.push(scope);
    for (const [k, v] of Object.entries(query)) {
      if (['pageToken', 'sortBy', 'sortOrder', 'q', 'pageSize'].includes(k)) continue;
      if (!v) continue;
      // `<字段>__contains=值` → 模糊匹配（SqlStore 侧翻译成 ILIKE '%值%'，仍是服务端过滤、分页正确）。
      //
      // 背景（2026-09-14 用户实测）：字段筛选原先**一律等值** —— 前端 `filterType: 'text'`
      // 只是输入框形态，后端并不知道该模糊匹配，于是联系人页「关联学生」输入「赵」恒为 0 条、
      // 必须输入完整值「赵浩元」才筛得到。
      // 自建 controller（考勤/排课/结算/合作…）的文本筛选一直是手写 `op: 'contains'`，
      // 只有通用 CRUD 这条路径漏了，这里补齐；下拉（filterType 'select'）仍是等值。
      const contains = /^(.+?)__contains$/.exec(k);
      conditions.push(
        contains
          ? { field: contains[1] as string, op: 'contains', value: [v] }
          : { field: k, value: [v] },
      );
    }
    if (query.q) {
      const q = query.q;
      const fields = this.meta.searchFields?.length
        ? this.meta.searchFields
        : this.meta.searchField
          ? [this.meta.searchField]
          : undefined;
      if (fields?.length) {
        const f0 = fields[0];
        conditions.push(
          fields.length > 1 && f0 !== undefined
            ? {
                conjunction: 'or',
                conditions: fields.map((f) => ({ field: f, op: 'contains', value: [q] })),
              }
            : { field: f0 ?? '', op: 'contains', value: [q] },
        );
      }
    }
    const sort = query.sortBy
      ? [{ field: query.sortBy, desc: query.sortOrder !== 'asc' }]
      : [{ field: this.meta.sortField ?? '更新时间', desc: true }];
    const pageSize = Number(query.pageSize) || 50;
    const res = await this.base.search(this.tableId, {
      pageSize,
      pageToken: query.pageToken,
      filter: buildFilter(conditions),
      sort,
    });
    const items = res.items.map((r) => toFlatRecord(r, this.readonlySet(), this.multiSet(), this.linkSet(), this.auditOverrideSet()));
    await this.resolveLinks(items);
    const masked = this.mod ? this.mask.maskMany(user, this.mod.key, items) : items;
    if (this.meta.secretFields?.length) masked.forEach((r) => this.maskSecrets(r));
    return {
      items: masked,
      total: res.total,
      hasMore: res.hasMore,
      pageToken: res.pageToken,
    };
  }

  /** 关联字段搜索：拉全量 → 解析可读名 → 按解析文本模糊过滤 */
  private async listByLinkSearch(
    query: Record<string, string | undefined>,
    scope: RowScopeFilter | 'none' | null = null,
  ) {
    const sf = this.meta.searchField!;
    const q = String(query.q).toLowerCase();
    const rows = (await this.fetchAll()).map((r) => toFlatRecord(r, this.readonlySet(), this.multiSet(), this.linkSet(), this.auditOverrideSet()));
    await this.resolveLinks(rows);
    // 行级范围在内存路径同样强制（走的是与列表查询同一份条件）
    const filtered = rows.filter((r) => matchFilter(r, scope) && String(r[sf] ?? '').toLowerCase().includes(q));
    if (this.meta.secretFields?.length) filtered.forEach((r) => this.maskSecrets(r));
    return { items: filtered, total: filtered.length, hasMore: false, pageToken: undefined };
  }

  /** 关联字段跨表解析：将 [{record_ids:[...]}] 的 id 替换为目标表的可读名（如 学生姓名） */
  private async resolveLinks(items: Record<string, unknown>[]): Promise<void> {
    const links = this.meta.linkFields;
    if (!links || !links.length || !items.length) return;
    // 收集每个目标表需解析的 id
    const need: Record<string, { nameField: string; ids: Set<string> }> = {};
    for (const l of links) {
      for (const it of items) {
        const ids = (it[l.field + '__link'] as string[]) || [];
        if (!ids.length) continue;
        const entry = need[l.table] ?? (need[l.table] = { nameField: l.nameField, ids: new Set() });
        ids.forEach((id) => entry.ids.add(id));
      }
    }
    if (!Object.keys(need).length) return;
    // 并行批量取名字（按 20 一组并发，避免一次性开太多连接）
    const nameMap = new Map<string, string>();
    const chunk = <T,>(arr: T[], n: number): T[][] => {
      const out: T[][] = [];
      for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
      return out;
    };
    await Promise.all(
      Object.entries(need).map(async ([table, info]) => {
        const batches = chunk([...info.ids], 20);
        for (const batch of batches) {
          await Promise.all(
            batch.map(async (id) => {
              const rec = await this.base.get(table, id);
              const name = rec ? toText(rec.fields[info.nameField]) : '';
              nameMap.set(`${table}|${id}`, name || id);
            }),
          );
        }
      }),
    );
    // 回填可读名
    for (const it of items) {
      for (const l of links) {
        const ids = (it[l.field + '__link'] as string[]) || [];
        if (!ids.length) {
          it[l.field] = '';
          continue;
        }
        it[l.field] = ids.map((id) => nameMap.get(`${l.table}|${id}`) || id).join('、');
      }
    }
  }

  /** 扩展筛选（仅审计日志使用）：拉全量后在内存做 模糊/精确/时间区间 过滤，保证 total 准确 */
  private async listDeep(
    user: SessionUser,
    query: Record<string, string | undefined>,
    scope: RowScopeFilter | 'none' | null = null,
  ) {
    const rangeField = this.meta.rangeField ?? this.meta.dateFields?.[0];
    const rows = (await this.fetchAll()).map((r) => toFlatRecord(r, this.readonlySet(), this.multiSet(), this.linkSet(), this.auditOverrideSet()));
    // ⚠️ 内存过滤路径也必须解析关联字段：主分支（服务端过滤）走的是 resolveLinks，
    // 这条路径以前漏了 —— 结果 link 字段直接显示一串 record id，而且 `__has` 筛不到。
    await this.resolveLinks(rows);
    // 行级范围先过一遍（内存路径同样强制，判据与列表查询同源）
    let filtered = scope ? rows.filter((r) => matchFilter(r, scope)) : rows;
    if (rangeField && (query.from || query.to)) {
      const from = query.from ? new Date(query.from + 'T00:00:00').getTime() : -Infinity;
      const to = query.to ? new Date(query.to + 'T23:59:59.999').getTime() : Infinity;
      filtered = filtered.filter((r) => {
        // ⚠️ 必须用 toEpochMs：时间字段可能是 ISO 字符串（卫瓴「创建时间」就是），
        // 直接 Number() 会得到 NaN，整个区间筛选静默返回 0 条。
        const t = toEpochMs(r[rangeField]);
        return t !== null && t >= from && t <= to;
      });
    }
    if (query.actor) {
      const a = String(query.actor).toLowerCase();
      filtered = filtered.filter((r) => String(r['操作人'] ?? '').toLowerCase().includes(a));
    }
    if (query.module) {
      const m = String(query.module).toLowerCase();
      filtered = filtered.filter((r) => String(r['业务模块'] ?? '').toLowerCase().includes(m));
    }
    if (query.action) {
      filtered = filtered.filter((r) => String(r['操作类型'] ?? '') === query.action);
    }

    // 字段级时间区间：参数名约定 `<字段名>_from` / `<字段名>_to`。
    // 报表下钻要按「最近跟进时间」这类非默认时间字段过滤，不想为单个模块往通用层
    // 塞专用参数名，所以用后缀约定表达（例：最近跟进时间_from=2026-09-01）。
    const fieldRanges = new Map<string, { from: number; to: number }>();
    // ⚠️ 要跳过的是「带后缀的参数名」本身（如 最近跟进时间_from），不是字段名 ——
    // 只跳过字段名的话，下面的等值过滤还会拿参数名去匹配，结果被筛成 0 条。
    const fieldRangeKeys: string[] = [];
    for (const [k, v] of Object.entries(query)) {
      if (!v) continue;
      const m = /^(.+)_(from|to)$/.exec(k);
      if (!m) continue;
      const field = m[1] as string;
      const kind = m[2] as string;
      fieldRangeKeys.push(k);
      const t = new Date(kind === 'to' ? `${v}T23:59:59.999` : `${v}T00:00:00`).getTime();
      if (!Number.isFinite(t)) continue;
      const e = fieldRanges.get(field) ?? { from: -Infinity, to: Infinity };
      if (kind === 'to') e.to = t;
      else e.from = t;
      fieldRanges.set(field, e);
    }
    for (const [field, r] of fieldRanges) {
      filtered = filtered.filter((row) => {
        const t = toEpochMs(row[field]);
        return t !== null && t >= r.from && t <= r.to;
      });
    }

    // 自定义字段（JSON 列）下钻：dim=字段 api_name，dimval=原始值（多个用逗号分隔）。
    // 卫瓴联系人把上游 95 个自定义字段整包存在「自定义字段」列里，无法作为独立列筛选，
    // 报表要下钻看名单只能这样匹配。
    if (query.dim && query.dimval) {
      const dim = String(query.dim);
      const wants = new Set(String(query.dimval).split(',').map((s) => s.trim()).filter(Boolean));
      filtered = filtered.filter((r) => {
        const raw = parseJsonObject(r['自定义字段'])[dim];
        if (raw == null || raw === '') return false;
        const vals = Array.isArray(raw) ? raw : [raw];
        return vals.some((x) => wants.has(String(x)));
      });
    }

    // 多值字段的成员包含筛选：参数名约定 `<字段>__has=<值>`。
    // 数组存的多值字段（如上游账号的「所属分组」）用等值筛选必然落空，只能这样匹配。
    // 支持两类载体：jsonb 数组（multi 字段）与「、/,」分隔的字符串（link 解析后的展示值）。
    const suffixKeys: string[] = [];
    for (const [k, v] of Object.entries(query)) {
      if (!v || !k.endsWith('__has')) continue;
      suffixKeys.push(k);
      const field = k.slice(0, -'__has'.length);
      const want = String(v);
      filtered = filtered.filter((r) => {
        const raw = r[field];
        // link 字段解析后：展示值是「A、B」字符串、原始 id 留在 `<字段>__link` 数组里。
        // 两边都认，调用方传 id 或传名称都能筛到。
        for (const a of [raw, r[field + '__link']]) {
          if (Array.isArray(a) && a.some((x) => String(x) === want)) return true;
        }
        return String(raw ?? '')
          .split(/[、,，]/)
          .map((x) => x.trim())
          .includes(want);
      });
    }

    // 模糊包含筛选：参数名约定 `<字段>__contains=<值>`（与主分支的 ILIKE 语义一致）。
    // 单用它不会走到这里（主分支服务端就能表达），但**与 `__has` 等混用时**会命中本路径
    // —— 那时若不处理，这个条件会被静默忽略（返回比预期更多的行）。
    for (const [k, v] of Object.entries(query)) {
      if (!v || !k.endsWith('__contains')) continue;
      suffixKeys.push(k);
      const field = k.slice(0, -'__contains'.length);
      const kw = String(v).toLowerCase();
      filtered = filtered.filter((r) => String(r[field] ?? '').toLowerCase().includes(kw));
    }

    // 其余后缀约定：非空 / 为空 / 数值比较 / 值无效。都表达不了「等值」，只能内存过滤。
    for (const [k, v] of Object.entries(query)) {
      if (!v) continue;
      const m = /^(.+?)__(notempty|empty|gt|lt|invalid)$/.exec(k);
      if (!m) continue;
      suffixKeys.push(k);
      const field = m[1] as string;
      const op = m[2] as string;
      if (op === 'notempty') {
        filtered = filtered.filter((r) => !isBlankVal(r[field]));
        continue;
      }
      if (op === 'empty') {
        filtered = filtered.filter((r) => isBlankVal(r[field]));
        continue;
      }
      if (op === 'invalid') {
        // 「值无效」目前**只对手机号有定义**：空，或归一化后位数不在 7~15 位
        // （与去重报表的 `stats.noPhone` 同一判据，见 shared/phone.util.ts）。
        // 其它字段没有「有效」语义 ⇒ 不加任何过滤（但也不再当字段等值，见 suffixKeys），
        // 免得退化成「当成空值过滤」这种看着像 bug 的行为。
        if (field === '手机号') filtered = filtered.filter((r) => isInvalidPhone(r[field]));
        continue;
      }
      const num = Number(v);
      if (!Number.isFinite(num)) continue;
      filtered = filtered.filter((r) => {
        const x = Number(r[field]);
        return Number.isFinite(x) && (op === 'gt' ? x > num : x < num);
      });
    }

    // 「疑似重复」下钻（`?dedup=strong|likely|all|mergeable`，需 `meta.dedupParams`）。
    // 「是否重复」不是字段而是报表当场算的（按姓名分桶 + 反证据），所以这里复用
    // `dedupMemberIds` —— 与页面那张卡片**同一份**分组逻辑，数字才能对齐。
    if (this.meta.dedupParams && query.dedup && DEDUP_MODES.has(String(query.dedup))) {
      // ⚠️ 在**全量 rows** 上算命中集合，不是在已过滤的 filtered 上：
      //    报表卡片是全量口径（50 组 / 109 条），若先按渠道筛再分组，数字会变小，
      //    用户会以为「点进去比卡片少」。其它筛选条件照旧按 AND 叠加在下面。
      const ids = dedupMemberIds(
        rows.map((r) => toDedupRow(String(r.id ?? ''), r)),
        String(query.dedup) as DedupMode,
      );
      filtered = filtered.filter((r) => ids.has(String(r.id ?? '')));
    }

    // 其余查询参数按字段等值过滤（如会议纪要按「会议类型 / 状态 / 部门」筛选）。
    // 只跳过 DEEP_PARAMS 与分页/排序参数，保证审计日志的既有行为完全不变。
    const skip = new Set<string>([
      ...BaseRecordService.DEEP_PARAMS,
      'pageToken',
      'pageSize',
      'sortBy',
      'sortOrder',
      'q',
      'dim',
      'dimval',
      // `<字段>_from/_to` 已按时间区间处理过，不能再当字段名做等值匹配（会直接筛空）
      ...fieldRangeKeys,
      // `<字段>__has` / `<字段>__contains` 同理，已按各自语义处理过
      ...suffixKeys,
      ...(this.meta.deepParams ?? []),
      // `dedup` 已在上面按「疑似重复」处理过；不跳过的话会被当字段名等值匹配 ⇒ 恒 0 条。
      // 只在声明了 dedupParams 的表上跳过，其它表维持「未知参数 = 等值筛选」的既有行为。
      ...(this.meta.dedupParams ? ['dedup'] : []),
    ]);
    for (const [k, v] of Object.entries(query)) {
      if (!v || skip.has(k)) continue;
      const want = String(v);
      filtered = filtered.filter((r) => String(r[k] ?? '') === want);
    }
    // 关键字检索（与 list 主分支一致的 contains 语义）
    if (query.q) {
      const fields = this.meta.searchFields?.length
        ? this.meta.searchFields
        : this.meta.searchField
          ? [this.meta.searchField]
          : [];
      if (fields.length) {
        const kw = String(query.q).toLowerCase();
        filtered = filtered.filter((r) =>
          fields.some((f) => String(r[f] ?? '').toLowerCase().includes(kw)),
        );
      }
    }
    // 跨表/自定义筛选（如卫瓴按跟进人反查跟进记录）：返回 false 才剔除
    if (this.meta.deepFilter) {
      const kept: typeof filtered = [];
      for (const r of filtered) {
        const res = await this.meta.deepFilter(r, query);
        if (res !== false) kept.push(r);
      }
      filtered = kept;
    }
    if (rangeField) {
      // 同 rangeField 过滤：时间可能是 ISO 字符串，Number() 会得 NaN 让排序失效
      filtered.sort((x, y) => (toEpochMs(y[rangeField]) ?? 0) - (toEpochMs(x[rangeField]) ?? 0));
    }
    // ⚠️ 同样必须与主分支一致地做「模块字段遮蔽 + 凭证掩码」：
    // 漏掉这一步，任何走内存过滤的查询都会把 secretFields（如上游厂商密钥）原样吐出去。
    const masked = this.mod ? this.mask.maskMany(user, this.mod.key, filtered) : filtered;
    if (this.meta.secretFields?.length) masked.forEach((r) => this.maskSecrets(r));
    return { items: masked, total: masked.length, hasMore: false, pageToken: undefined };
  }

  /** 拉取整表（上限 20000 行，足够内部审计日志规模） */
  private async fetchAll(): Promise<{ recordId: string; fields: Record<string, unknown> }[]> {
    const out: { recordId: string; fields: Record<string, unknown> }[] = [];
    let tok: string | undefined;
    let guard = 0;
    do {
      const res = await this.base.search(this.tableId, { pageSize: 100, pageToken: tok });
      out.push(...res.items);
      tok = res.hasMore ? res.pageToken : undefined;
    } while (tok && guard++ < 200);
    return out;
  }

  async detail(user: SessionUser, id: string) {
    this.require(user, 'read');
    const rec = await this.base.get(this.tableId, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    const flat = toFlatRecord(rec, this.readonlySet(), this.multiSet(), this.linkSet(), this.auditOverrideSet());
    // 行级范围：越界按「不存在」处理（404 而非 403）—— 不向调用方暴露该记录是否存在。
    // ⚠️ update / archive / transition 都会先调本方法，所以写操作一并受保护，不必逐个加。
    const scope = await this.rowScopeFor(user);
    if (!matchFilter(flat, scope)) throw new NotFoundException('NOT_FOUND');
    await this.resolveLinks([flat]);
    const out = this.mod ? this.mask.mask(user, this.mod.key, flat) : flat;
    return this.maskSecrets(out);
  }

  private writeFields(dto: Record<string, unknown>) {
    const fields = buildWriteFields(dto, this.readonlySet(), this.numberSet());
    // 关联字段（link）：前端提交单 record id 字符串，飞书 record link 写入要求 [record_id]
    for (const l of this.meta.linkFields ?? []) {
      const v = fields[l.field];
      if (typeof v === 'string' && v.trim()) fields[l.field] = [v.trim()];
      else if (Array.isArray(v) && v.length) fields[l.field] = v.map((it) => (typeof it === 'string' ? it : (it as { record_id?: string })?.record_id)).filter(Boolean);
      else if (l.field in dto && (v === '' || v == null)) fields[l.field] = [];
    }
    for (const k of this.meta.dateFields ?? []) {
      const v = fields[k];
      if (typeof v === 'string') {
        if (v.trim() === '') delete fields[k];
        else {
          const t = new Date(v.trim()).getTime();
          if (!Number.isNaN(t)) fields[k] = t;
          else delete fields[k];
        }
      }
    }
    // 凭证字段：掩码 = 不修改（删掉，保留原值）；空串 = 清空；其它 = 加密后写入
    for (const k of this.meta.secretFields ?? []) {
      if (!(k in fields)) continue;
      const v = fields[k];
      if (isSecretMask(v)) delete fields[k];
      else if (v == null || String(v).trim() === '') fields[k] = '';
      else if (isEncrypted(v)) fields[k] = String(v);
      else fields[k] = encryptSecret(String(v));
    }
    return fields;
  }

  /** 读取侧把凭证字段换成掩码 */
  private maskSecrets<T extends Record<string, unknown>>(row: T): T {
    const keys = this.meta.secretFields;
    if (!keys?.length) return row;
    for (const k of keys) {
      if (k in row) (row as Record<string, unknown>)[k] = maskSecret(row[k]);
    }
    return row;
  }

  /** 跨字段时间校验：结束时间须晚于开始时间（配置 meta.timeRange 时生效） */
  private validateTimeRange(fields: Record<string, unknown>): void {
    const tr = this.meta.timeRange;
    if (!tr) return;
    const s = fields[tr.startField];
    const e = fields[tr.endField];
    if (s == null || e == null || s === '' || e === '') return;
    // ⚠️ writeFields 已把 dateFields 转成毫秒时间戳（number），也可能是原始日期字符串，两种都要支持
    const st = toEpochMs(s);
    const et = toEpochMs(e);
    if (st == null || et == null) return;
    if (et <= st) {
      throw new BadRequestException(
        `VALIDATION:${tr.endField}必须晚于${tr.startField}`,
      );
    }
  }

  async create(user: SessionUser, dto: Record<string, unknown>) {
    this.require(user, 'create');
    // 类型域：补齐/校验「记录类型」（写在 strip/writeFields 之前 —— 那两步会过滤字段，
    // 类型可能被过滤掉，必须在原始 dto 上判）
    this.resolveWriteType(user, dto, 'create');
    const stripped = this.mod ? this.mask.stripProtected(user, this.mod.key, dto) : dto;
    const fields = this.writeFields(stripped);
    this.validateTimeRange(fields);
    if (this.meta.statusField && !fields[this.meta.statusField] && this.meta.defaultStatus) {
      fields[this.meta.statusField] = this.meta.defaultStatus;
    }
    // 模块级默认值：放在 writeFields 之后，才能给 readonly 的系统字段一个初始值。
    // 传函数时按**已写入的字段**推导（如「调度状态」要由 状态/可调度/过期时间 决定，
    // 直接写死 '可调度' 会在用户显式停调时给出一致性错误的初始值）；第二个参数是当前用户，
    // 用于「归属人默认成创建者」这类需要身份的字段（如邮件账户的「创建者openId」）。
    const defs =
      typeof this.meta.defaults === 'function'
        ? await this.meta.defaults(fields, user, this.scopeContext())
        : (this.meta.defaults ?? {});
    for (const [k, v] of Object.entries(defs)) {
      if (!(k in fields)) fields[k] = v;
    }
    const recordId = await this.base.create(this.tableId, fields);
    this.emitAudit(user, '创建', recordId, Object.keys(fields).join(','));
    return this.detail(user, recordId);
  }

  async update(user: SessionUser, id: string, dto: Record<string, unknown>) {
    this.require(user, 'update');
    // detail 既做越权读校验（越界会 404），也把**当前**记录取回来给类型校验用
    const current = await this.detail(user, id);
    // 类型域：用户没传「记录类型」时**不改动它**（fill:false），只校验现有类型他有没有写权限。
    // 若这里误用 create 的补齐语义，编辑任意字段都会把类型重置成默认值。
    this.resolveWriteType(user, dto, 'update', {
      fill: false,
      currentType: this.meta.typeScope ? current[this.meta.typeScope.field] : undefined,
    });
    const stripped = this.mod ? this.mask.stripProtected(user, this.mod.key, dto) : dto;
    const fields = this.writeFields(stripped);
    this.validateTimeRange({ ...current, ...fields });
    if (Object.keys(fields).length === 0) throw new BadRequestException('VALIDATION:无可更新字段');
    await this.base.update(this.tableId, id, fields);
    this.emitAudit(user, '更新', id, Object.keys(fields).join(','));
    return this.detail(user, id);
  }

  async archive(user: SessionUser, id: string) {
    this.require(user, 'delete');
    await this.detail(user, id);
    await this.base.delete(this.tableId, id);
    this.emitAudit(user, '删除', id);
    return { ok: true };
  }

  async transition(user: SessionUser, id: string, to: string) {
    this.require(user, 'update');
    if (!this.meta.statusField) throw new BadRequestException('NO_STATUS_FIELD');
    await this.detail(user, id);
    await this.base.update(this.tableId, id, { [this.meta.statusField]: to });
    return this.detail(user, id);
  }

  /** 服务端导出 CSV：当前模块全量记录（上限 20000），UTF-8 BOM 防 Excel 乱码。 */
  async exportCsv(user: SessionUser): Promise<{ csv: string; filename: string }> {
    this.require(user, 'export');
    // 行级范围：导出必须与列表同范围 —— 否则等于绕开隔离把全量数据拉走。
    const scope = await this.rowScopeFor(user);
    if (scope === 'none') return { csv: '﻿', filename: `${this.meta.path}.csv` };
    const rows = await this.fetchAll();
    const flatRows = rows
      .map((r) => toFlatRecord(r, this.readonlySet(), this.multiSet(), this.linkSet(), this.auditOverrideSet()))
      .filter((r) => matchFilter(r, scope));
    const maskedRows = this.mod
      ? flatRows.map((r) => this.mask.mask(user, this.mod!.key, r))
      : flatRows;
    if (!maskedRows.length) return { csv: '﻿', filename: `${this.meta.path}.csv` };
    const fields = Array.from(new Set(maskedRows.flatMap((r) => Object.keys(r)))).filter(
      (k) => !k.endsWith('__link'),
    );
    const esc = (v: unknown): string => {
      const s = Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? toText((x as { text?: string })?.text ?? '') : String(x))).join('、') : v == null ? '' : String(toText(v));
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = fields.map(esc).join(',');
    const body = maskedRows
      .map((r) => fields.map((f) => esc(r[f])).join(','))
      .join('\n');
    return { csv: '﻿' + header + '\n' + body, filename: `${this.meta.path}.csv` };
  }

  /** 服务端批量导入：逐行 create（BaseClient 仅支持单条，串行 ≤200/批）。失败行计入 failed，不中断整体。 */
  async importRows(user: SessionUser, rows: Record<string, unknown>[]): Promise<{ ok: number; failed: number }> {
    this.require(user, 'import');
    let ok = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        // 类型域：批量导入同样要补齐 + 校验「记录类型」——
        // 导入是绕过表单的入口，漏了这一步就能用导入造出「越权类型」或「无类型」的记录。
        this.resolveWriteType(user, row, 'create');
        const fields = this.writeFields(row);
        if (Object.keys(fields).length === 0) {
          failed++;
          continue;
        }
        await this.base.create(this.tableId, fields);
        ok++;
      } catch {
        failed++;
      }
    }
    return { ok, failed };
  }
}

function makeService(meta: RecordMeta): Type<BaseRecordService> {
  @Injectable()
  class GService extends BaseRecordService {
    constructor(
      @Inject(BASE_CLIENT) base: BaseClient,
      @Inject(AuditService) audit: AuditService,
      @Inject(FieldMaskService) mask: FieldMaskService,
      @Inject(StudentScopeService) studentScope: StudentScopeService,
    ) {
      super(meta, base, audit, mask, studentScope);
    }
  }
  return GService as unknown as Type<BaseRecordService>;
}

function makeController(meta: RecordMeta, SvcClass: Type<BaseRecordService>) {
  @Controller(meta.path)
  @UseGuards(SessionGuard)
  class GController {
    constructor(@Inject(SvcClass) private readonly svc: BaseRecordService) {}
    @Get() list(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
      return this.svc.list((req as Request & { user: SessionUser }).user, q);
    }
    // ⚠️ 静态路由（export/import）必须声明在 :id 参数路由之前，否则 /<path>/export 会被
    // @Get(':id') 捕获为 id='export' 而误返回 404。Nest 按声明顺序匹配路由。
    @Get('export') async exportCsv(
      @Req() req: Request,
      @Res({ passthrough: true }) res: import('express').Response,
    ) {
      const { csv, filename } = await this.svc.exportCsv((req as Request & { user: SessionUser }).user);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      return csv;
    }
    @Post('import') importRows(@Req() req: Request, @Body() body: { rows?: Record<string, unknown>[] }) {
      return this.svc.importRows((req as Request & { user: SessionUser }).user, body.rows ?? []);
    }
    @Get(':id') detail(@Req() req: Request, @Param('id') id: string) {
      return this.svc.detail((req as Request & { user: SessionUser }).user, id);
    }
    @Post() create(@Req() req: Request, @Body() body: Record<string, unknown>) {
      return this.svc.create((req as Request & { user: SessionUser }).user, body);
    }
    @Put(':id') update(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) {
      return this.svc.update((req as Request & { user: SessionUser }).user, id, body);
    }
    @Delete(':id') archive(@Req() req: Request, @Param('id') id: string) {
      return this.svc.archive((req as Request & { user: SessionUser }).user, id);
    }
    @Post(':id/transition') transition(@Req() req: Request, @Param('id') id: string, @Body() body: { to: string }) {
      return this.svc.transition((req as Request & { user: SessionUser }).user, id, body.to);
    }
  }
  return GController;
}

@Module({})
export class GenericCrudModule {
  static registerAll(metas: RecordMeta[]): DynamicModule {
    const controllers: Type[] = [];
    const providers: Type[] = [];
    for (const meta of metas) {
      const SvcClass = makeService(meta);
      controllers.push(makeController(meta, SvcClass));
      providers.push(SvcClass);
    }
    return {
      module: GenericCrudModule,
      controllers,
      providers: [...providers, baseClientProvider],
    };
  }
}

/** 空值判定（用于 `<字段>__empty` / `<字段>__notempty`）：空串、null、空数组都算空 */
function isBlankVal(v: unknown): boolean {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === '';
}
