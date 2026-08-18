import {
  Injectable,
  Inject,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { ROLES, USER_LEVEL_OPTIONS, USER_TABLE } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient, toText, toStringArray } from '@acms/base-adapter';
import { BASE_CLIENT } from '../base.provider.js';
import { AuditService } from '../audit/audit.service.js';
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

  async list(
    user: SessionUser,
    query: { q?: string; pageSize?: string; pageToken?: string } = {},
  ) {
    this.requireAdmin(user);
    const q = query.q;
    // 传入 pageSize 时走服务端游标分页（用户管理列表页每页 N 条）；
    // 不传 pageSize 时返回全部用户（学生表单的班主任/招生选择器依赖全量）。
    if (query.pageSize) {
      const ps = Number(query.pageSize) || 50;
      const res = await this.base.search(USER_TABLE.tableId, { pageSize: ps, pageToken: query.pageToken });
      let flats = res.items.map((r) => this.flat(r));
      if (q) {
        const s = String(q).toLowerCase();
        flats = flats.filter(
          (f) =>
            String(f['姓名'] ?? '').toLowerCase().includes(s) ||
            String(f['飞书 Open ID'] ?? '').toLowerCase().includes(s),
        );
      }
      flats.sort((a, b) => String(a['姓名']).localeCompare(String(b['姓名']), 'zh'));
      return { items: flats, total: res.total, hasMore: res.hasMore, pageToken: res.pageToken };
    }
    const raw = await this.fetchAll();
    let flats = raw.map((r) => this.flat(r));
    if (q) {
      const s = String(q).toLowerCase();
      flats = flats.filter(
        (f) =>
          String(f['姓名'] ?? '').toLowerCase().includes(s) ||
          String(f['飞书 Open ID'] ?? '').toLowerCase().includes(s),
      );
    }
    flats.sort((a, b) => String(a['姓名']).localeCompare(String(b['姓名']), 'zh'));
    return { items: flats, total: flats.length, hasMore: false, pageToken: undefined };
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
    if (!openId) throw new BadRequestException('VALIDATION:飞书 Open ID 必填');
    if (!name) throw new BadRequestException('VALIDATION:姓名 必填');

    const roles = toStringArray(dto['系统角色']).filter((r) => (ROLES as readonly string[]).includes(r));
    const levelRaw = toText(dto['数据密级上限']) || '';
    const level = (USER_LEVEL_OPTIONS as readonly string[]).includes(levelRaw) ? levelRaw : 'L4';
    const statusRaw = toText(dto['账号状态']) || STATUS_ENABLED;
    const status = VALID_STATUS.includes(statusRaw) ? statusRaw : STATUS_ENABLED;
    const campus = toText(dto['默认校区']);
    const teacherType = toText(dto['教师类型']);

    const fields: Record<string, unknown> = {
      '飞书 Open ID': openId,
      姓名: name,
      系统角色: roles.length ? roles : [ADMIN_ROLE],
      数据密级上限: level,
      账号状态: status,
    };
    if (campus) fields['默认校区'] = campus;
    if (teacherType) fields['教师类型'] = teacherType;
    const recordId = await this.base.create(USER_TABLE.tableId, fields);
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
