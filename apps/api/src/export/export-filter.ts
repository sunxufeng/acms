/**
 * 「数据导出」里跟**三合一记录表（学生记录）**相关的那点判断 —— 抽成纯函数，方便单测。
 *
 * 背景（2026-09-21 峰哥报障）：日常跟进 / 家校沟通 / 学生观察 在 2026-09-18 合并成
 * **一张物理表**（「日常跟进表」）+ 一个「记录类型」字段区分，但**导出页没跟着改**：
 *   - 「日常跟进」`/export/dailyFollowup` → 导的是**整张表**（5 类记录全在里面）；
 *   - 「家校沟通」`/export/homeSchoolComm` → 指向**合并前的旧表**（生产实测 **0 行**，
 *     导出来是个只有表头的空 CSV）；「学生观察」同理。
 * 也就是：用户点哪个都一样（或什么都没有），导不了「只导这一类」。
 *
 * 现在的口径：
 *   - 三个历史导出键（dailyFollowup / homeSchoolComm / studentObservation）**都落到
 *     三合一表上**（旧表已空，永远不该再作为导出对象），各自带一个默认「记录类型」；
 *   - 类型由查询参数覆盖（`?记录类型=IDP沟通`），新增类型不必再加导出键；
 *   - 类型取值必须合法（否则会导出一个空文件，用户以为"没数据"）；
 *   - **空记录类型的行按 `defaultType`（日常跟进）归属** —— 与列表同源，
 *     否则合并前的老记录在导出里会集体消失。
 */
import {
  STUDENT_RECORD_EXPORT_ALL,
  STUDENT_RECORD_EXPORT_KEY,
  STUDENT_RECORD_TYPE_FIELD,
  STUDENT_RECORD_TYPE_VALUES,
} from '@acms/contracts';

/**
 * 三合一记录：历史导出键 → 该键默认导出的「记录类型」。
 *
 * ⚠️ 三个键都映射到**同一张表**（`RECORD_EXPORT_TABLE`）：
 * `TABLES.homeSchoolComm` / `TABLES.studentObservation` 指向的是**合并前的旧表**
 * （生产实测 0 行），继续按它们取表就会导出一份空 CSV。
 */
export const RECORD_EXPORT_KEYS: Record<string, string> = {
  dailyFollowup: '日常跟进',
  homeSchoolComm: '家校沟通',
  studentObservation: '学生观察',
};

/** 三合一后的唯一物理表（TABLES 的键）—— 常量收在 contracts，前端拼 URL 也用同一份 */
export const RECORD_EXPORT_TABLE = STUDENT_RECORD_EXPORT_KEY;

export type ExportTarget =
  /** 普通表：全量导出（行为不变） */
  | { kind: 'plain' }
  /** 三合一记录表：只导某一种类型，或全部有权类型 */
  | { kind: 'records'; tableKey: string; type: string; all: boolean }
  /** 传了未知的记录类型 */
  | { kind: 'bad-type'; value: string };

/**
 * 解析导出目标。
 * @param tableKey URL 里的表键
 * @param typeParam 查询参数「记录类型」（可空；空 = 用该键的默认类型）
 */
export function resolveRecordExport(tableKey: string, typeParam?: string): ExportTarget {
  const fallbackType = RECORD_EXPORT_KEYS[tableKey];
  if (!fallbackType) return { kind: 'plain' };
  const want = String(typeParam ?? '').trim();
  if (!want) return { kind: 'records', tableKey: RECORD_EXPORT_TABLE, type: fallbackType, all: false };
  if (want === STUDENT_RECORD_EXPORT_ALL) return { kind: 'records', tableKey: RECORD_EXPORT_TABLE, type: '', all: true };
  if (!STUDENT_RECORD_TYPE_VALUES.includes(want)) return { kind: 'bad-type', value: want };
  return { kind: 'records', tableKey: RECORD_EXPORT_TABLE, type: want, all: false };
}

/** 取一行的「记录类型」；空值按 defaultType 归属（与列表的 buildTypeScopeFilter 同源） */
export function rowRecordType(
  fields: Record<string, unknown>,
  defaultType: string,
): string {
  return String(fields?.[STUDENT_RECORD_TYPE_FIELD] ?? '').trim() || defaultType;
}

/**
 * 挑出要导出的行。
 *
 * @param allowed 该用户**有权读取**的类型（`typeAllowedValues()` 的结果）：
 *                `null` = 不限制（管理员/豁免角色）；数组 = 只看这些类型
 *
 * 🔴 导出的可见范围**不能宽于列表**：类型权限在这里判一次，
 *    否则「列表里看不到的家校沟通记录，导出却拿得到」。
 * ⚠️ 目前只做**类型**级别的同源；列表还有一层**行级范围**（学生档案数据范围 /
 *    studentScoped），导出尚未套用 —— 见 export.module.ts 的同名注释。
 */
export function pickRecordRows<T extends { fields: Record<string, unknown> }>(
  rows: T[],
  allowed: string[] | null,
  target: { type: string; all: boolean },
  defaultType: string,
): T[] {
  const permit = allowed === null ? null : new Set(allowed);
  return rows.filter((r) => {
    const v = rowRecordType(r.fields, defaultType);
    if (permit && !permit.has(v)) return false;
    return target.all || v === target.type;
  });
}
