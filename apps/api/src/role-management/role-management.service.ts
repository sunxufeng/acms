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
  ROLE_PERMISSION_VERSION,
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
  inheritModulePermissions,
} from '@acms/domain';
import { BASE_CLIENT } from '../base.provider.js';
import { runAs, systemActor } from '../shared/actor-context.js';
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
  /** 缺省/旧版本仅迁移一次；保存后的撤权不可在重启时恢复。 */
  permissionVersion?: number;
  key: string;
  label?: string;
  permissions: string[];
  maxDataLevel: string;
  protected?: boolean;
  /** 菜单可见性白名单；空/缺省 = 不额外限制 */
  menus?: string[];
}

export interface CreateRoleInput {
  key: string;
  label?: string;
  permissions: string[];
  maxDataLevel: string;
  menus?: string[];
}

export interface UpdateRoleInput {
  label?: string;
  permissions?: string[];
  maxDataLevel?: string;
  menus?: string[];
}

@Injectable()
export class RoleManagementService implements OnModuleInit {
  private readonly logger = new Logger(RoleManagementService.name);

  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  /**
   * 应用启动即把已持久化的角色权限矩阵载入引擎，确保鉴权与配置一致。
   * 启动期没有 HTTP 请求上下文，这里显式声明身份，避免写入被记成 system:unknown。
   */
  async onModuleInit(): Promise<void> {
    await runAs(systemActor('role-sync', '系统 · 角色同步'), () => this.ensureLoaded());
  }

  private defaultConfig(): StoredRole[] {
    return (Object.keys(ROLE_PERMISSIONS) as Role[]).map((key) => ({
      key,
      permissions: [...ROLE_PERMISSIONS[key]],
      maxDataLevel: ROLE_MAX_LEVEL[key],
      protected: PROTECTED_ROLES.has(key),
      permissionVersion: ROLE_PERMISSION_VERSION,
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

  /**
   * 带重试地读取权限配置。
   *
   * ⚠️ 为什么必须重试（2026-09-09 事故复盘）：
   * `onModuleInit` 阶段飞书 tenant token 往往还没就绪，此时 `base.search` 可能返回
   * 空结果（**不抛错**），`readStored()` 于是返回 null，代码转头就用**静态默认矩阵**
   * —— 而默认矩阵里既没有自定义角色（如 Phase1），也不含后来在界面上新增的权限点。
   * 后果：每次重启，自定义角色被授予的权限静默失效，用户大面积 403，日志里一个字都没有。
   *
   * 实测：15:37 部署重启后，Amy（Phase1）的 `getnote:read` 凭空消失，知识库页一直转圈；
   * 直到有人再保存一次权限矩阵（persist 会热更新引擎）才恢复 —— 所以现象看起来
   * 像「时好时坏的玄学 bug」，实际是启动时序问题。
   */
  private async readStoredWithRetry(attempts = 5): Promise<StoredRole[] | null> {
    for (let i = 0; i < attempts; i++) {
      try {
        const stored = await this.readStored();
        if (stored) return stored;
      } catch (e) {
        this.logger.warn(`读取角色权限配置失败（第 ${i + 1}/${attempts} 次）：${(e as Error).message}`);
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
    this.logger.warn(
      `未读到角色权限配置（已重试 ${attempts} 次），本次启动使用内置默认矩阵。` +
        '若为首次部署属正常；否则自定义角色的授权在重启后将不生效，请检查飞书系统配置表 role_permission_config。',
    );
    return null;
  }

  /**
   * 自愈：锁定角色（系统管理员）的「拥有全部权限」由代码保证，而非存储快照。
   *
   * ⚠️ 背景（2026-09-11）：新增「会议纪要」模块后，管理员访问新模块却 403。
   * 原因：系统管理员权限集被设计成锁定（防止管理员自锁），但存储里留的是**历史时点的权限快照**，
   * 新增模块产生的 `module:xxx:*` 权限点不会自动进快照 → 越权保护反过来把管理员自己挡在门外。
   * 这里用代码默认的全量权限覆盖锁定角色（只改内存、不回写，保留「权限集不可编辑」的锁定语义）。
   */
  private healLockedRoles(roles: StoredRole[]): StoredRole[] {
    for (const r of roles) {
      if (!LOCKED_PERMISSION_ROLES.has(r.key)) continue;
      const full = ROLE_PERMISSIONS[r.key as Role];
      if (full) r.permissions = [...full];
    }
    return roles;
  }

  private async ensureLoaded(): Promise<void> {
    const stored = await this.readStoredWithRetry();
    const roles = this.healLockedRoles(stored ?? this.defaultConfig());
    // 先持久化版本与权限，再加载引擎；失败即中止启动，避免未落盘的继承被反复执行。
    if (stored && this.migratePermissions(stored)) {
      await this.persist(stored);
      this.logger.log(`已完成角色权限 v${ROLE_PERMISSION_VERSION} 一次性迁移`);
    }
    this.applyToEngine(roles);
    // 启动即把已配置角色回填为「系统角色」字段选项（含历史新增角色），失败不影响启动
    await this.syncRoleOptions(roles);
  }

  /**
   * 自动把角色同步为「系统用户表-系统角色」字段选项，
   * 使新建角色可直接分配给系统用户（选项名 = 角色标识 key，与鉴权引擎一致）。
   *
   * ⚠️ 函数名里没有「飞书」：本方法走 BASE_CLIENT 路由，实际写入当前数据存储层的字段定义
   * （PG 切流后写 PostgreSQL），并不调用任何飞书接口。历史命名 syncRoleOptionsToFeishu 有误导性。
   * 仅追加缺失项，不改动/删除已有选项（避免孤立已分配记录）。
   * 外部角色（student/parent）不进入系统用户表，跳过。
   * @returns 本次实际新增的选项名
   */
  private async syncRoleOptions(roles: StoredRole[]): Promise<string[]> {
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
      this.logger.log(`已自动同步角色选项到「${ROLE_FIELD_NAME}」字段：${missing.join('、')}`);
      return missing;
    } catch (e) {
      this.logger.error(`同步角色选项失败：${(e as Error).message}`);
      return [];
    }
  }

  /** 只迁移旧角色；绝不补回已撤销的旧菜单权限，也不触碰 v2 的显式授权。 */
  private migratePermissions(roles: StoredRole[]): boolean {
    let changed = false;
    for (const role of roles) {
      if ((role.permissionVersion ?? 0) >= ROLE_PERMISSION_VERSION) continue;
      role.permissions = inheritModulePermissions(role);
      role.permissionVersion = ROLE_PERMISSION_VERSION;
      changed = true;
    }
    return changed;
  }

  private applyToEngine(roles: StoredRole[]): void {
    loadRolePermissionConfig(
      roles.map((r) => ({
        key: r.key,
        label: r.label?.trim() || r.key,
        permissions: r.permissions as Permission[],
        maxDataLevel: (r.maxDataLevel as DataLevel) ?? 'L1',
        menus: r.menus,
      })),
    );
  }

  private toRoleDef(r: StoredRole): RoleDef {
    return {
      key: r.key,
      label: r.label?.trim() || r.key,
      permissions: r.permissions as Permission[],
      maxDataLevel: (r.maxDataLevel as DataLevel) ?? 'L1',
      menus: r.menus,
      protected: !!r.protected || PROTECTED_ROLES.has(r.key),
      lockedPermissions: LOCKED_PERMISSION_ROLES.has(r.key),
    };
  }

  /** 读取角色权限矩阵（含全部权限点与密级，供前端渲染） */
  async getConfig(): Promise<{ roles: RoleDef[]; allPermissions: Permission[]; dataLevels: DataLevel[] }> {
    const stored = await this.readStored();
    const roles = this.healLockedRoles(stored ?? this.defaultConfig());
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

  /** 菜单白名单：去重、去空。空数组表示「不限制」（前端清空即恢复自动） */
  private sanitizeMenus(arr: unknown): string[] | undefined {
    if (arr === undefined || arr === null) return undefined;
    if (!Array.isArray(arr)) return undefined;
    const out = [...new Set(arr.map((m) => String(m ?? '').trim()).filter(Boolean))];
    return out.length ? out : undefined;
  }

  async createRole(
    dto: CreateRoleInput,
  ): Promise<{
    roles: RoleDef[];
    allPermissions: Permission[];
    dataLevels: DataLevel[];
    syncedRoleOptions: string[];
  }> {
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
      permissionVersion: ROLE_PERMISSION_VERSION,
      permissions: this.sanitizePerms(dto.permissions),
      maxDataLevel: this.normalizeLevel(dto.maxDataLevel),
      menus: this.sanitizeMenus(dto.menus),
    };
    const merged = [...current, next];
    await this.persist(merged);
    // 新建角色即时同步为「系统角色」字段选项，便于分配给用户
    const syncedRoleOptions = EXTERNAL_ROLES.has(key) ? [] : await this.syncRoleOptions(merged);
    return { ...(await this.getConfig()), syncedRoleOptions };
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
    if (dto.menus !== undefined) {
      const menus = this.sanitizeMenus(dto.menus);
      if (menus) role.menus = menus;
      else delete role.menus;
    }

    role.permissionVersion = ROLE_PERMISSION_VERSION;
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
