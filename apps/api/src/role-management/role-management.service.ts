import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { BaseClient, toText } from '@acms/base-adapter';
import {
  DATA_LEVELS,
  PERMISSIONS,
  ROLE_PERMISSION_CONFIG_KEY,
  TABLES,
  USER_TABLE,
  type DataLevel,
  type Permission,
  type Role,
  type RoleDef,
} from '@acms/contracts';
import {
  ROLE_MAX_LEVEL,
  ROLE_PERMISSIONS,
  loadRolePermissionConfig,
} from '@acms/domain';
import { BASE_CLIENT } from '../base.provider.js';
import { buildFilter } from '../shared/record.util.js';

const TABLE_ID = TABLES.systemConfig.tableId;

/** 不可删除的内置角色 */
const PROTECTED_ROLES = new Set(['系统管理员', 'student', 'parent']);
/** 权限集锁定的角色：仅可改名，权限/密级不可改（避免把自己锁死） */
const LOCKED_PERMISSION_ROLES = new Set(['系统管理员']);
/** 外部用户角色：不出现在飞书「系统用户表-系统角色」字段，无需同步为字段选项 */
const EXTERNAL_ROLES = new Set(['student', 'parent']);
/** 系统用户表承载角色的字段名 */
const ROLE_FIELD_NAME = '系统角色';

interface StoredRole {
  key: string;
  label?: string;
  permissions: string[];
  maxDataLevel: string;
  protected?: boolean;
}

export interface CreateRoleInput {
  key: string;
  label?: string;
  permissions: string[];
  maxDataLevel: string;
}

export interface UpdateRoleInput {
  label?: string;
  permissions?: string[];
  maxDataLevel?: string;
}

@Injectable()
export class RoleManagementService implements OnModuleInit {
  private readonly logger = new Logger(RoleManagementService.name);

  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  /** 应用启动即把已持久化的角色权限矩阵载入引擎，确保鉴权与配置一致 */
  async onModuleInit(): Promise<void> {
    await this.ensureLoaded();
  }

  private defaultConfig(): StoredRole[] {
    return (Object.keys(ROLE_PERMISSIONS) as Role[]).map((key) => ({
      key,
      permissions: [...ROLE_PERMISSIONS[key]],
      maxDataLevel: ROLE_MAX_LEVEL[key],
      protected: PROTECTED_ROLES.has(key),
    }));
  }

  private async findRecord() {
    const res = await this.base.search(TABLE_ID, {
      pageSize: 10,
      filter: buildFilter([{ field: '配置键', value: [ROLE_PERMISSION_CONFIG_KEY] }]),
    });
    return res.items[0];
  }

  private async readStored(): Promise<StoredRole[] | null> {
    const rec = await this.findRecord();
    if (!rec) return null;
    const raw = toText(rec.fields['配置值']);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { roles?: StoredRole[] };
      if (Array.isArray(parsed.roles)) return parsed.roles;
    } catch {
      /* ignore corrupt config */
    }
    return null;
  }

  private async ensureLoaded(): Promise<void> {
    const stored = await this.readStored();
    const roles = stored ?? this.defaultConfig();
    this.applyToEngine(roles);
    // 启动即把已配置角色回填为飞书字段选项（含历史新增角色），失败不影响启动
    await this.syncRoleOptionsToFeishu(roles);
  }

  /**
   * 自动把角色同步为飞书「系统用户表-系统角色」字段选项，
   * 使新建角色可在飞书中直接分配给系统用户（选项名 = 角色标识 key，与鉴权引擎一致）。
   * 仅追加缺失项，不改动/删除已有选项（避免孤立已分配记录）。
   * 外部角色（student/parent）不进入飞书系统用户表，跳过。
   * @returns 本次实际新增同步到飞书的选项名
   */
  private async syncRoleOptionsToFeishu(roles: StoredRole[]): Promise<string[]> {
    try {
      const desired = roles.map((r) => r.key).filter((k) => !EXTERNAL_ROLES.has(k));
      const fields = await this.base.listFields(USER_TABLE.tableId);
      const roleField = fields.find((f) => f.name === ROLE_FIELD_NAME);
      if (!roleField) {
        this.logger.warn(`系统用户表未找到「${ROLE_FIELD_NAME}」字段，跳过角色选项同步`);
        return [];
      }
      const existing = new Set((roleField.property.options ?? []).map((o) => o.name));
      const missing = desired.filter((k) => !existing.has(k));
      if (!missing.length) return [];
      await this.base.addFieldOptions(USER_TABLE.tableId, roleField.id, missing);
      this.logger.log(`已自动同步角色选项到飞书「${ROLE_FIELD_NAME}」字段：${missing.join('、')}`);
      return missing;
    } catch (e) {
      this.logger.error(`同步角色选项到飞书失败：${(e as Error).message}`);
      return [];
    }
  }

  private applyToEngine(roles: StoredRole[]): void {
    loadRolePermissionConfig(
      roles.map((r) => ({
        key: r.key,
        permissions: r.permissions as Permission[],
        maxDataLevel: (r.maxDataLevel as DataLevel) ?? 'L1',
      })),
    );
  }

  private toRoleDef(r: StoredRole): RoleDef {
    return {
      key: r.key,
      label: r.label?.trim() || r.key,
      permissions: r.permissions as Permission[],
      maxDataLevel: (r.maxDataLevel as DataLevel) ?? 'L1',
      protected: !!r.protected || PROTECTED_ROLES.has(r.key),
      lockedPermissions: LOCKED_PERMISSION_ROLES.has(r.key),
    };
  }

  /** 读取角色权限矩阵（含全部权限点与密级，供前端渲染） */
  async getConfig(): Promise<{ roles: RoleDef[]; allPermissions: Permission[]; dataLevels: DataLevel[] }> {
    const stored = await this.readStored();
    const roles = stored ?? this.defaultConfig();
    return {
      roles: roles.map((r) => this.toRoleDef(r)),
      allPermissions: [...PERMISSIONS],
      dataLevels: [...DATA_LEVELS],
    };
  }

  private async persist(roles: StoredRole[]): Promise<void> {
    const value = JSON.stringify({ roles });
    const rec = await this.findRecord();
    if (rec) {
      await this.base.update(TABLE_ID, rec.recordId, {
        配置值: value,
        状态: '启用',
      } as Record<string, unknown>);
    } else {
      await this.base.create(TABLE_ID, {
        配置键: ROLE_PERMISSION_CONFIG_KEY,
        配置值: value,
        分组: '权限配置',
        说明: '角色与权限矩阵（JSON）',
        状态: '启用',
      } as Record<string, unknown>);
    }
    // 持久化后立即热更新鉴权引擎，无需重启
    this.applyToEngine(roles);
  }

  private normalizeLevel(v: unknown): DataLevel {
    const s = String(v ?? '').trim();
    return (DATA_LEVELS as readonly string[]).includes(s) ? (s as DataLevel) : 'L1';
  }

  private sanitizePerms(arr: unknown): Permission[] {
    if (!Array.isArray(arr)) return [];
    return arr.filter((p): p is Permission => (PERMISSIONS as readonly string[]).includes(String(p)));
  }

  async createRole(
    dto: CreateRoleInput,
  ): Promise<{ roles: RoleDef[]; allPermissions: Permission[]; dataLevels: DataLevel[]; syncedToFeishu: string[] }> {
    const key = (dto.key ?? '').trim();
    if (!key) throw new BadRequestException('角色标识（key）不能为空');
    if (!/^[一-龥A-Za-z0-9_]+$/.test(key)) {
      throw new BadRequestException('角色标识仅支持中文、字母、数字与下划线');
    }
    const current = (await this.readStored()) ?? this.defaultConfig();
    if (current.some((r) => r.key === key)) throw new ConflictException('角色已存在');
    const next: StoredRole = {
      key,
      label: (dto.label ?? '').trim() || key,
      permissions: this.sanitizePerms(dto.permissions),
      maxDataLevel: this.normalizeLevel(dto.maxDataLevel),
    };
    const merged = [...current, next];
    await this.persist(merged);
    // 新建角色即时同步为飞书「系统角色」字段选项，便于在飞书中分配给用户
    const syncedToFeishu = EXTERNAL_ROLES.has(key) ? [] : await this.syncRoleOptionsToFeishu(merged);
    return { ...(await this.getConfig()), syncedToFeishu };
  }

  async updateRole(
    key: string,
    dto: UpdateRoleInput,
  ): Promise<{ roles: RoleDef[]; allPermissions: Permission[]; dataLevels: DataLevel[] }> {
    const current = (await this.readStored()) ?? this.defaultConfig();
    const idx = current.findIndex((r) => r.key === key);
    if (idx < 0) throw new NotFoundException('角色不存在');
    const role = { ...current[idx]! };

    if (LOCKED_PERMISSION_ROLES.has(key)) {
      // 系统管理员：权限集与密级锁定，仅允许改名，避免管理员自锁
      if (dto.permissions !== undefined) throw new ForbiddenException('系统管理员角色的权限集不可修改');
      if (dto.maxDataLevel !== undefined) throw new ForbiddenException('系统管理员角色的密级上限不可修改');
    }
    if (dto.label !== undefined) role.label = dto.label.trim() || key;
    if (dto.permissions !== undefined) role.permissions = this.sanitizePerms(dto.permissions);
    if (dto.maxDataLevel !== undefined) role.maxDataLevel = this.normalizeLevel(dto.maxDataLevel);

    current[idx] = role;
    await this.persist(current);
    return this.getConfig();
  }

  async deleteRole(key: string): Promise<{ ok: boolean }> {
    if (PROTECTED_ROLES.has(key)) throw new ForbiddenException('内置角色不可删除');
    const current = (await this.readStored()) ?? this.defaultConfig();
    const idx = current.findIndex((r) => r.key === key);
    if (idx < 0) throw new NotFoundException('角色不存在');
    current.splice(idx, 1);
    await this.persist(current);
    return { ok: true };
  }
}
