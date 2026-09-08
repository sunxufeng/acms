/**
 * 字段级密级脱敏（三层权限模型 · 第 4 层 字段密级，Stage 4b）。
 *
 * 规则：每个受控字段有一个密级 L1–L4；用户 maxDataLevel 低于字段密级时，
 * 该字段自动脱敏（不拦截整条记录，仅隐藏/打码该字段）。脱敏方式按字段密级推导：
 *   - L4 高度敏感：完全隐藏（●●●）
 *   - L2/L3（内部/敏感）：部分打码（手机号 138****8899，其余 首***尾）
 * 纯函数实现，不依赖 Nest，便于多 service 与单测复用。
 */

export interface FieldLevel {
  /** 受控字段名（飞书 Base 字段名，如「证件号码」） */
  field: string;
  /** 所属模块 key（与 module-permissions 的 key 一致：students / teachers / billing / partnerships） */
  module: string;
  /** 字段密级 L1–L4 */
  level: 1 | 2 | 3 | 4;
}

/** 引擎密级 / 中文密级 → 数字排名（L1=1 … L4=4） */
const LEVEL_RANK: Record<string, number> = {
  L1: 1, '1': 1, 一般: 1, 公开: 1,
  L2: 2, '2': 2, 内部: 2,
  L3: 3, '3': 3, 敏感: 3,
  L4: 4, '4': 4, 高度敏感: 4,
};
export function rankOf(level: string | undefined | null): number {
  if (!level) return 1;
  return LEVEL_RANK[String(level)] ?? 1;
}

/** 按字段密级推导脱敏方式 */
export type MaskStyle = 'partial' | 'full';
function maskStyleOf(fieldLevel: number): MaskStyle {
  return fieldLevel >= 4 ? 'full' : 'partial';
}

/** 通用部分打码：手机号/证件号（≥7 位数字）保留前 3 后 4；其他保留首尾各 1 位 */
export function partialMask(s: string): string {
  if (!s) return '';
  if (/^\d{7,}$/.test(s)) return s.replace(/^(\d{3})\d*(\d{4})$/, '$1****$2');
  if (s.length <= 2) return '***';
  return s[0] + '***' + s[s.length - 1];
}

/** 单个值按用户密级脱敏；用户密级足够（>= 字段密级）原样返回 */
export function maskValue(value: unknown, fieldLevel: number, userLevel: number): unknown {
  if (userLevel >= fieldLevel) return value;
  const s = value == null ? '' : String(value);
  if (!s) return value;
  return maskStyleOf(fieldLevel) === 'full' ? '●●●' : partialMask(s);
}

/**
 * 按字段密级表脱敏一条记录。命中 module 且用户密级不足的字段被脱敏；其余原样。
 * 返回新对象，不改动入参。
 */
export function applyFieldMask(
  levels: FieldLevel[],
  module: string | null,
  userLevel: number,
  record: Record<string, unknown>,
): Record<string, unknown> {
  if (!module || !levels.length) return record;
  const hit = levels.filter((f) => f.module === module);
  if (!hit.length) return record;
  const out: Record<string, unknown> = { ...record };
  for (const f of hit) {
    if (f.field in out) out[f.field] = maskValue(out[f.field], f.level, userLevel);
  }
  return out;
}

/**
 * 创建/更新时剔除用户密级不足且受控的字段，防止把脱敏展示值（如 138****8899）
 * 写回真实数据。高密级用户（密级足够）字段不受影响。
 */
export function stripProtectedFields(
  levels: FieldLevel[],
  module: string | null,
  userLevel: number,
  dto: Record<string, unknown>,
): Record<string, unknown> {
  if (!module || !levels.length) return dto;
  const hit = levels.filter((f) => f.module === module && userLevel < f.level);
  if (!hit.length) return dto;
  const out: Record<string, unknown> = { ...dto };
  for (const f of hit) delete out[f.field];
  return out;
}
