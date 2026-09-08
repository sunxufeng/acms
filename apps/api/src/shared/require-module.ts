import { ForbiddenException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { modulePermission, type ModuleAction } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

/**
 * 模块级权限门控：与 generic-crud 的 require 行为一致，供独立 controller/service 复用，
 * 让「按钮隐藏＝接口也拦」覆盖全站（而非只有 generic-crud 承载的 14 个模块）。
 * ROLE_PERMISSION_VERSION=2 迁移已把 legacy 权限派生为 module:* 权限点，故替换后与现有角色一致。
 */
export function requireModule(user: SessionUser, key: string, action: ModuleAction): void {
  const perm = modulePermission(key, action);
  if (!authorize(toPrincipal(user), perm).allowed) throw new ForbiddenException('FORBIDDEN:' + perm);
}
