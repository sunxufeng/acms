import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { BaseClient, toText } from '@acms/base-adapter';
import {
  DATA_LEVELS,
  PERMISSIONS,
  ROLE_PERMISSION_CONFIG_KEY,
  TABLES,
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

  async createRole(dto: CreateRoleInput): Promise<{ roles: RoleDef[]; allPermissions: Permission[]; dataLevels: DataLevel[] }> {
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
    await this.persist([...current, next]);
    return this.getConfig();
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
