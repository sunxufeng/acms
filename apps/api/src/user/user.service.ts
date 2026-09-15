import {
  Injectable,
  Inject,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { USER_LEVEL_OPTIONS, USER_TABLE } from '@acms/contracts';
import { authorize, getRoleList, type Principal } from '@acms/domain';
import { BaseClient, toText, toStringArray } from '@acms/base-adapter';
import { BASE_CLIENT } from '../base.provider.js';
import { AuditService } from '../audit/audit.service.js';
import { DepartmentService } from '../department/department.service.js';
import { StudentScopeService } from '../shared/student-scope.service.js';
import { normalizeUserScopeEntry } from '../shared/student-scope.js';
import { buildWriteFields, toFlatRecord } from '../shared/record.util.js';

const MULTI_FIELDS = new Set(['系统角色']);
const ADMIN_ROLE = '系统管理员';
const STATUS_ENABLED = '启用';
const STATUS_DISABLED = '停用';
const VALID_STATUS = [STATUS_ENABLED, STATUS_DISABLED];
const USER_MODULE = 'users';

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

/**
 * 用户管理（系统用户表 CRUD）。仅 系统管理员（admin:user）可操作。
 * 安全约束：不能禁用/删除自己；不能把系统中最后一名系统管理员降级或删除，避免锁死。
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    @Inject(AuditService) private readonly audit: AuditService,
    /**
     * 部门服务：用户管理页的「按部门筛选」与列表「部门」列都要用。
     * 用户表本身**没有部门字段** —— 人与部门的关系只存在于部门成员快照里
     * （飞书同步落下，记录 id = `${部门ID}__${open_id}`），所以按部门筛人
     * 必然要站在成员快照上做，复用它的子树展开逻辑。
     */
    @Inject(DepartmentService) private readonly dept: DepartmentService,
    /**
     * 学生档案「数据范围」（2026-09-15）：人级配置存在系统配置表（不动飞书用户表结构），
     * 用户管理页负责读写它 —— 列表回显 + 保存时拦截写入。
     */
    @Inject(StudentScopeService) private readonly scopeSvc: StudentScopeService,
  ) {}

  private requireAdmin(user: SessionUser): void {
    if (!authorize(toPrincipal(user), 'admin:user').allowed)
      throw new ForbiddenException('FORBIDDEN:admin:user');
  }

  private actor(user: SessionUser): string {
    return user.name || user.openId || 'unknown';
  }

  private flat(rec: { recordId: string; fields: Record<string, unknown> }) {
    return toFlatRecord(rec, new Set(), MULTI_FIELDS);
  }

  /** 拉取全部用户原始记录（用于计数 / 安全校验） */
  private async fetchAll(): Promise<{ recordId: string; fields: Record<string, unknown> }[]> {
    const out: { recordId: string; fields: Record<string, unknown> }[] = [];
    let tok: string | undefined;
    let guard = 0;
    do {
      const res = await this.base.search(USER_TABLE.tableId, { pageSize: 100, pageToken: tok });
      out.push(...res.items);
      tok = res.hasMore ? res.pageToken : undefined;
    } while (tok && guard++ < 50);
    return out;
  }

  /**
   * 人员姓名列表（供表单下拉选「主持人 / 记录人 / 沟通人」等）。
   *
   * ⚠️ 为什么不用 list()：list() 要求 admin:user，而填这些字段的是一线老师/教务，
   * 他们拿不到就会看到空下拉（2026-09-11 实测：Emily 的 /users 直接 403）。
   * 姓名属于内部业务数据、本来就在各处流转，全员可读是合理的；
   * 这里**只返回姓名**，不吐 Open ID / 角色 / 密级等敏感字段。
   */
  async listNames(): Promise<string[]> {
    const raw = await this.fetchAll();
    const names = raw
      .map((r) => String(this.flat(r)['姓名'] ?? '').trim())
      .filter(Boolean);
    return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  /**
   * 人员目录（全员可读）：姓名 + 飞书 Open ID + 教师类型 + 默认校区 + 系统角色。
   *
   * 用途：学生列表的「班主任 / 招生老师」筛选、学生表单的班主任与招生负责老师选择器、
   * AI 自动化的收件人选择器 —— 这些字段在系统里**存的是 Open ID**，
   * 只拿姓名无法完成「所选姓名 → Open ID」的还原，筛选与写入都会失效。
   *
   * ⚠️ 边界：不返回密级（dataLevel）、账号状态、邮箱、手机等敏感字段；
   * 用户管理页的完整数据仍走 list()（admin:user）。
   */
  async listDirectory(): Promise<
    { id: string; name: string; openId: string; teacherType: string; campus: string; roles: string[] }[]
  > {
    const raw = await this.fetchAll();
    const out = raw.map((r) => {
      const f = this.flat(r);
      const roles = f['系统角色'];
      return {
        // 用户记录 id：**关联字段**（如邮件账户的「关联用户」）存的是 record id，
        // 而业务人字段（班主任/招生老师）存的是 Open ID —— 两个都给，调用方各取所需。
        id: String((r as unknown as { recordId?: string }).recordId ?? ''),
        name: String(f['姓名'] ?? '').trim(),
        openId: String(f['飞书 Open ID'] ?? '').trim(),
        teacherType: String(f['教师类型'] ?? '').trim(),
        campus: String(f['默认校区'] ?? '').trim(),
        roles: Array.isArray(roles) ? roles.map((x) => String(x)) : roles ? [String(roles)] : [],
      };
    });
    return out
      .filter((u) => u.name && u.openId)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  /** openId → 所属部门名（可能多个，飞书允许多人多部门）。列表页「部门」列用它 */
  private async departmentByOpenId(): Promise<Map<string, string[]>> {
    const idx = await this.dept.memberIndex();
    const m = new Map<string, string[]>();
    for (const it of idx) {
      if (!it.departmentName) continue;
      const arr = m.get(it.openId) ?? [];
      if (!arr.includes(it.departmentName)) arr.push(it.departmentName);
      m.set(it.openId, arr);
    }
    return m;
  }

  /**
   * 给列表行注入「所属部门」。
   * ⚠️ 这是**只读展示字段**，用户表里并不存在它 —— create/update 都是逐字段白名单式取值
   *（见 resolve 的用法），不会把这个注入字段写回 Base；列定义里也是 form: false。
   */
  private withDepartment(
    flats: Record<string, unknown>[],
    map: Map<string, string[]>,
  ): Record<string, unknown>[] {
    return flats.map((f) => ({
      ...f,
      所属部门: (map.get(String(f['飞书 Open ID'] ?? '').trim()) ?? []).join('、'),
    }));
  }

  /**
   * 给列表行注入「学生档案范围」（人级配置）。
   * ⚠️ 与「所属部门」一样是**注入字段**：用户表里并不存在它 —— 人级范围存在系统配置表
   *    （`user_scope_config`，刻意不动飞书用户表结构）。create/update 是逐字段白名单取值，
   *    不会把它写回 Base；写入走 update 里的显式拦截（见下）。
   */
  private async withScope(flats: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const entries = await this.scopeSvc.allUserEntries();
    return flats.map((f) => ({
      ...f,
      学生档案范围: entries[String(f['飞书 Open ID'] ?? '').trim()] ?? { mode: 'role' },
    }));
  }

  /** 关键字过滤：姓名 / 飞书 Open ID（用户管理页搜索框的口径，保持原行为） */
  private applyKeyword(flats: Record<string, unknown>[], q?: string): Record<string, unknown>[] {
    if (!q) return flats;
    const s = String(q).toLowerCase();
    return flats.filter(
      (f) =>
        String(f['姓名'] ?? '').toLowerCase().includes(s) ||
        String(f['飞书 Open ID'] ?? '').toLowerCase().includes(s),
    );
  }

  async list(
    user: SessionUser,
    query: {
      q?: string;
      pageSize?: string;
      pageToken?: string;
      /** 左侧组织架构树选中的部门 id（飞书 open_department_id） */
      departmentId?: string;
      /** 传 '0' 表示只看该部门**直属**成员；缺省 = 含下级部门 */
      includeSub?: string;
    } = {},
  ) {
    this.requireAdmin(user);
    const q = query.q;
    const deptId = String(query.departmentId ?? '').trim();
    const sortByName = (arr: Record<string, unknown>[]) =>
      arr.sort((a, b) => String(a['姓名']).localeCompare(String(b['姓名']), 'zh'));

    /**
     * 按部门筛选（用户管理页左树）。
     *
     * ⚠️ 必须**先过滤再分页**：下面的 pageSize 分支是「先取一页、再在内存里过滤关键字」，
     * 那套做法在带部门条件时会把「本页里属于该部门的那几条」当成全部，total 与页数全错。
     * 所以这里走「全量拉 → 过滤 → 返回**全集**（不带 pageToken）」，由 CrudPage 前端切片分页
     * （它已有 fallback：无 pageToken 且条数 > 每页大小 ⇒ 前端分页）。用户量级几十条，可忽略代价。
     */
    if (deptId) {
      const openIds = await this.dept.memberOpenIds(deptId, query.includeSub !== '0');
      const raw = await this.fetchAll();
      const flats = sortByName(
        this.applyKeyword(
          raw.map((r) => this.flat(r)).filter((f) => openIds.has(String(f['飞书 Open ID'] ?? '').trim())),
          q,
        ),
      );
      const items = await this.withScope(this.withDepartment(flats, await this.departmentByOpenId()));
      return { items, total: items.length, hasMore: false, pageToken: undefined };
    }

    /**
     * 其余情况一律返回**过滤后的全集**（不带 pageToken），由前端切片分页。
     *
     * 为什么要改掉原来的「pageSize 走服务端游标分页」（2026-09-15）：
     * 旧实现是「先按 Base 物理顺序取一页 → 再在**这一页内**按姓名排序」，
     * 于是列表呈现的是「本页内有序、跨页无序」—— 翻页时名字会来回跳，
     * 用户管理页尤其明显（第一页首个是「郝瑞玲」，翻到第二页又冒出「曹德强」）。
     * 现在改成先全量排序再交给前端切片，全局顺序稳定；用户量级几十条，代价可忽略，
     * 也与上面「按部门筛选」的口径统一（都走同一条路径）。
     */
    const raw = await this.fetchAll();
    const flats = sortByName(this.applyKeyword(raw.map((r) => this.flat(r)), q));
    const items = await this.withScope(this.withDepartment(flats, await this.departmentByOpenId()));
    return { items, total: items.length, hasMore: false, pageToken: undefined };
  }

  async get(user: SessionUser, id: string) {
    this.requireAdmin(user);
    const rec = await this.base.get(USER_TABLE.tableId, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return this.flat(rec);
  }

  /** 解析单个字段：未提供（undefined）则保留原值；空字符串对单选/文本视为保留 */
  private resolve(dto: Record<string, unknown>, key: string, existing: unknown, multi: boolean): unknown {
    const raw = dto[key];
    if (raw === undefined) return existing;
    if (multi) return toStringArray(raw);
    const s = toText(raw);
    return s === '' ? existing : s;
  }

  async create(user: SessionUser, dto: Record<string, unknown>) {
    this.requireAdmin(user);
    const openId = toText(dto['飞书 Open ID']);
    const name = toText(dto['姓名']);
    if (!name) throw new BadRequestException('VALIDATION:姓名 必填');

    // 用动态有效角色清单校验（含角色管理里新建的自定义角色），避免自定义角色被静默剔除
    const roles = toStringArray(dto['系统角色']).filter((r) => getRoleList().includes(r));
    const levelRaw = toText(dto['数据密级上限']) || '';
    const level = (USER_LEVEL_OPTIONS as readonly string[]).includes(levelRaw) ? levelRaw : 'L4';
    const statusRaw = toText(dto['账号状态']) || STATUS_ENABLED;
    const status = VALID_STATUS.includes(statusRaw) ? statusRaw : STATUS_ENABLED;
    const campus = toText(dto['默认校区']);
    const teacherType = toText(dto['教师类型']);

    // 「默认校区」必填。为什么要在服务端拦（前端 required 只画星号、不拦提交）：
    //   - 校区填错 ⇒ ABAC 按校区逐行过滤，该用户**一条学生/相关数据都看不到**
    //   - 校区**留空** ⇒ 反而被 `userCampuses.length > 0` 判成「不受限制」，能看到全部数据
    //     （2026-09-15 实测 Arete Developer 就是空校区、看到全部 82 人）
    // 两个方向都出过事，所以这里必须硬拦，不能只靠前端默认值。
    if (!campus) {
      throw new BadRequestException(
        'VALIDATION:默认校区 必填 —— 留空会不受校区限制、看到全部数据；填错则一条也看不到',
      );
    }

    const fields: Record<string, unknown> = {
      姓名: name,
      系统角色: roles.length ? roles : [ADMIN_ROLE],
      数据密级上限: level,
      账号状态: status,
    };
    if (openId) fields['飞书 Open ID'] = openId;
    if (campus) fields['默认校区'] = campus;
    if (teacherType) fields['教师类型'] = teacherType;
    const recordId = await this.base.create(USER_TABLE.tableId, fields);
    /**
     * 人级「学生档案范围」：新建时也能直接配（UserForm 会随表单一起提交）。
     * 落在 systemConfig（`user_scope_config`），**不写进飞书用户表** —— 与 update 同一套。
     * 放在 create 之后：需要 openId 已确定，且失败时用户记录已经建好（可再编辑修正）。
     */
    if (openId && '学生档案范围' in dto) {
      await this.scopeSvc.setUserEntry(openId, normalizeUserScopeEntry(dto['学生档案范围']));
    }
    await this.audit.log({
      actor: this.actor(user),
      action: '创建',
      module: USER_MODULE,
      recordId,
      detail: `用户 ${name}(${openId}) 角色=${roles.join('/') || ADMIN_ROLE}`,
    });
    return this.get(user, recordId);
  }

  async update(user: SessionUser, id: string, dto: Record<string, unknown>) {
    this.requireAdmin(user);
    const existing = await this.get(user, id);
    const existingOpenId = String(existing['飞书 Open ID'] ?? '');
    const isSelf = existingOpenId && existingOpenId === user.openId;
    const existingRoles = toStringArray(existing['系统角色']) as string[];
    const existingAdmin = existingRoles.includes(ADMIN_ROLE);

    const roles = this.resolve(dto, '系统角色', existingRoles, true) as string[];
    const resultRoles = roles.length ? roles : existingRoles;
    const status = this.resolve(dto, '账号状态', existing['账号状态'], false) as string;
    const resultStatus = VALID_STATUS.includes(status) ? status : STATUS_ENABLED;
    const rawLevel = this.resolve(dto, '数据密级上限', existing['数据密级上限'], false) as string;
    const level = (USER_LEVEL_OPTIONS as readonly string[]).includes(rawLevel)
      ? rawLevel
      : (toText(existing['数据密级上限']) || 'L4');
    const name = this.resolve(dto, '姓名', existing['姓名'], false) as string;
    const openId = this.resolve(dto, '飞书 Open ID', existing['飞书 Open ID'], false) as string;
    // 同 create 的硬拦：**显式**提交了空校区就明确报错。
    // ⚠️ 必须在 resolve 之前判：`resolve` 把 '' 当成「没提供」、回退成原值，
    //    写在其后这段就永远不会触发（表现为 200 + 静默保留原值 —— 想清空的人会以为改成功了）。
    const campusRaw = dto['默认校区'];
    if (campusRaw !== undefined && toText(campusRaw) === '') {
      throw new BadRequestException(
        'VALIDATION:默认校区 不能清空 —— 留空会不受校区限制、看到全部数据',
      );
    }
    const campus = this.resolve(dto, '默认校区', existing['默认校区'], false) as string;
    const teacherType = this.resolve(dto, '教师类型', existing['教师类型'], false) as string;

    // 安全：不能对自己降权 / 禁用，避免把自己锁死
    if (isSelf) {
      if (!resultRoles.includes(ADMIN_ROLE))
        throw new BadRequestException('SAFETY:不能取消自己的系统管理员角色');
      if (resultStatus === STATUS_DISABLED)
        throw new BadRequestException('SAFETY:不能禁用自己的账号');
    }
    // 安全：不能把最后一名系统管理员降级
    if (existingAdmin && !resultRoles.includes(ADMIN_ROLE)) {
      const all = await this.fetchAll();
      const adminCount = all.filter((r) =>
        (toStringArray(r.fields['系统角色']) as string[]).includes(ADMIN_ROLE),
      ).length;
      if (adminCount <= 1) throw new BadRequestException('SAFETY:至少保留一名系统管理员');
    }

    /**
     * 「学生档案范围」（人级）：不是用户表字段 —— 它存在系统配置表（`user_scope_config`），
     * 刻意不动飞书用户表结构。这里显式拦截并写配置；下面的 fields 是白名单，
     * 所以这个字段**不会**被写进 Base。
     * 权限与改账号同级（update 已要求 admin:user）—— 改它等于改「这个人能看哪些学生」。
     */
    if ('学生档案范围' in dto) {
      const targetOpenId = String(openId || existingOpenId || '').trim();
      if (targetOpenId) {
        await this.scopeSvc.setUserEntry(targetOpenId, normalizeUserScopeEntry(dto['学生档案范围']));
      }
    }

    const fields: Record<string, unknown> = {
      '飞书 Open ID': openId,
      姓名: name,
      系统角色: resultRoles,
      数据密级上限: level,
      账号状态: resultStatus,
    };
    if (campus) fields['默认校区'] = campus;
    if (teacherType) fields['教师类型'] = teacherType;
    await this.base.update(USER_TABLE.tableId, id, fields);
    await this.audit.log({
      actor: this.actor(user),
      action: '更新',
      module: USER_MODULE,
      recordId: id,
      detail: `用户 ${name}(${openId}) 角色=${resultRoles.join('/')} 状态=${resultStatus}`,
    });
    return this.get(user, id);
  }

  async setStatus(user: SessionUser, id: string, status: string) {
    this.requireAdmin(user);
    if (!VALID_STATUS.includes(status)) throw new BadRequestException('VALIDATION:非法状态');
    const existing = await this.get(user, id);
    const existingOpenId = String(existing['飞书 Open ID'] ?? '');
    const isSelf = existingOpenId && existingOpenId === user.openId;
    if (isSelf && status === STATUS_DISABLED)
      throw new BadRequestException('SAFETY:不能禁用自己的账号');
    await this.base.update(USER_TABLE.tableId, id, { 账号状态: status });
    await this.audit.log({
      actor: this.actor(user),
      action: '更新',
      module: USER_MODULE,
      recordId: id,
      detail: `账号状态→${status}`,
    });
    return this.get(user, id);
  }

  async remove(user: SessionUser, id: string) {
    this.requireAdmin(user);
    const existing = await this.get(user, id);
    const existingOpenId = String(existing['飞书 Open ID'] ?? '');
    const isSelf = existingOpenId && existingOpenId === user.openId;
    if (isSelf) throw new BadRequestException('SAFETY:不能删除自己');
    const existingRoles = toStringArray(existing['系统角色']) as string[];
    if (existingRoles.includes(ADMIN_ROLE)) {
      const all = await this.fetchAll();
      const adminCount = all.filter((r) =>
        (toStringArray(r.fields['系统角色']) as string[]).includes(ADMIN_ROLE),
      ).length;
      if (adminCount <= 1) throw new BadRequestException('SAFETY:至少保留一名系统管理员');
    }
    await this.base.delete(USER_TABLE.tableId, id);
    await this.audit.log({
      actor: this.actor(user),
      action: '删除',
      module: USER_MODULE,
      recordId: id,
      detail: `用户 ${existing['姓名']}(${existingOpenId})`,
    });
    return { ok: true };
  }
}
