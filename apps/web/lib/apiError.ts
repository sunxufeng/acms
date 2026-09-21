import { MODULE_ACTION_LABELS, MODULE_RESOURCES, type ModuleAction } from '@acms/contracts';

/**
 * 把后端 403 的**机器码**翻成人话。
 *
 * 后端为了可断言，403 的 message 是 `FORBIDDEN:module:<key>:<action>`
 * （见 apps/api/src/shared/generic-crud.module.ts 的 require()）。这东西直接弹给用户
 * 等于没说：不知道是哪个模块、哪个动作，也不知道该找谁 ——
 * 2026-09-21 峰哥就是看到「FORBIDDEN:module:studentRecords:create」来问是什么问题。
 *
 * 这里把 key 换成**权限矩阵里的中文名**（模块名 + 列头动作名），用户照着这句话
 * 就能让管理员在「角色管理」里找到那一格。
 *
 * ⚠️ 模块名/动作名取自 contracts 的中文标签（`MODULE_RESOURCES.label` /
 *    `MODULE_ACTION_LABELS`）—— 它们是权限矩阵的行名与列名，**中文界面下才是可操作的指引**，
 *    所以英文界面里也照原样带上（否则英文用户拿着 "Student Records" 找不到那一行）。
 */
export interface ForbiddenInfo {
  /** 模块 key（如 studentRecords）；非模块类 403（`FORBIDDEN:xxx`）时为空串 */
  moduleKey: string;
  /** 动作（如 create）；解析不到时为空串 */
  action: ModuleAction | '';
  /** 中文模块名（矩阵里的行名） */
  moduleLabel: string;
  /** 中文动作名（矩阵里的列名） */
  actionLabel: string;
}

/** 解析 403 机器码；不是权限错误时返回 null */
export function forbiddenInfo(e: unknown): ForbiddenInfo | null {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  if (!raw.includes('FORBIDDEN')) return null;
  const m = /FORBIDDEN:module:([A-Za-z0-9_-]+):([a-z]+)/.exec(raw);
  if (!m) return { moduleKey: '', action: '', moduleLabel: '', actionLabel: '' };
  const key = m[1] ?? '';
  const action = (m[2] ?? '') as ModuleAction;
  const res = MODULE_RESOURCES.find((r) => r.key === key);
  return {
    moduleKey: key,
    action,
    moduleLabel: res?.label ?? key,
    actionLabel: (MODULE_ACTION_LABELS[action] as string | undefined) ?? action,
  };
}

/**
 * 权限错误的一句话（中文，供没有 i18n 基建的页面直接用；有 i18n 的页面请用
 * `t('common.noPermissionAction')`，见 CrudPage）。
 */
export function forbiddenText(e: unknown): string | null {
  const info = forbiddenInfo(e);
  if (!info) return null;
  if (!info.moduleLabel) return '没有权限执行这个操作，请联系管理员开通。';
  return `没有权限执行这个操作（${info.moduleLabel} · ${info.actionLabel}）。请联系管理员在「角色管理」里为你的角色勾选该权限。`;
}
