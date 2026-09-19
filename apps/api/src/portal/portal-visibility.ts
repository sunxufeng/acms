/**
 * 家长 / 学生门户的**可见性判据唯一真源**（纯函数，无 Nest 依赖）。
 *
 * 为什么单独一个文件：
 *   家长端与学生端要读同一批数据（成绩册 / 课时教案 / 家校沟通），但**可见性口径不同** ——
 *   成绩册列上是两个正交开关（`学生可见` / `家长可见`），家长端还多一道「完成闸门」。
 *   若在 PortalService 与 ParentService 里各写一遍，症状会是「学生看得到、家长看不到」
 *   或者反过来，而两边都"没报错"。所以判据只写在这里，两个 service 都调它。
 *
 * 三条必须知道的语义（都来自生产数据的现实，不是想当然）：
 *
 * 1. **`''`（空串）≠ 可见**。markbook 写入侧一律 `String(payload.studentVisible ?? '')`
 *    （markbook.service.ts:740），空串表示"没设置过"。判定一律 `=== '是'`，
 *    绝不能用 `!== '否'` —— 那会把所有历史数据（全空）当成"可见"，
 *    等于把没打算公开的成绩直接推到家长手机上。
 *
 * 2. **条目级开关的空值 = 跟随列**。`学生可见 / 家长可见` 在**列**和**条目**上都有；
 *    条目上的空值是最常见的（作业同步写入的就是空串，homework-sync.service.ts:195），
 *    所以条目级只认显式 `'否'` 拦截，空值不额外限制 —— 否则一同步就把家长端清空。
 *
 * 3. **闸门的空值 = 不设闸门（开放）**。`完成日期` 只在成绩册列上，语义是
 *    "达到该日期前不对家长开放"。生产现存列**全部为空**，若把空值解释成"关闭"，
 *    上线瞬间家长端成绩会全空 —— 那看起来就像功能坏了。
 */

/** 门户视角：学生本人 / 家长 */
export type PortalViewer = 'student' | 'parent';

export const VISIBLE_YES = '是';
export const VISIBLE_NO = '否';

/**
 * 今天（`YYYY-MM-DD`，**本地时区**）。
 *
 * ⚠️ 不要用 `toISOString().slice(0,10)`：那是 UTC，东八区晚上 8 点之后就变成"昨天"，
 * 于是"今天刚过完成日期"的成绩会晚一天才对家长开放（且只在晚上复现，极难排查）。
 */
export function todayStr(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 日期字段取值（统一截到天；可能带时间戳或 `YYYY/MM/DD`） */
export function dayOf(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m && m[1] && m[2] && m[3]) {
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  return s.slice(0, 10);
}

/** 开关判定：**只有显式「是」才算打开**（空串 = 未设置 = 不可见，理由见文件头第 1 条） */
export function switchOn(v: unknown): boolean {
  return String(v ?? '').trim() === VISIBLE_YES;
}

/**
 * 完成闸门：达到 `完成日期` 当天才放行。
 *
 * - 空值 = 不设闸门（开放）
 * - 只对**家长**生效（字段注释：「达到该日期前不对家长开放」）
 */
export function gateOpenForParent(completeDate: unknown, today: string): boolean {
  const d = dayOf(completeDate);
  if (!d) return true;
  return d <= today;
}

/** 条目级开关：只认显式「否」拦截，空值跟随列（理由见文件头第 2 条） */
export function entryAllows(v: unknown): boolean {
  return String(v ?? '').trim() !== VISIBLE_NO;
}

/** 判据用到的列/条目形状（只需要这几个字段，便于测试直接喂字面量） */
export interface VisibilityFields {
  状态?: unknown;
  学生可见?: unknown;
  家长可见?: unknown;
  完成日期?: unknown;
}

/**
 * 列级放行判定（成绩册列 / 教案条目共用）。
 *
 * 判定顺序：停用 → 开关 → 闸门。任一项不过就不放行。
 * 返回 false 的原因**不对外暴露**（家长端不该知道"有一份成绩被藏起来了"）。
 */
export function columnAllows(viewer: PortalViewer, col: VisibilityFields, today: string): boolean {
  if (String(col.状态 ?? '启用').trim() === '停用') return false;
  const key = viewer === 'parent' ? '家长可见' : '学生可见';
  if (!switchOn(col[key])) return false;
  // 闸门只约束家长；学生看自己的成绩不受"成绩还没出完"影响
  if (viewer === 'parent' && !gateOpenForParent(col.完成日期, today)) return false;
  return true;
}

/**
 * 单元格（成绩册条目）放行判定 = **列放行 且 条目不显式拒绝**。
 *
 * 两道都要过：列是主控（没打算公开的列，条目上是"是"也不放行），
 * 条目是逐格微调（同一列里某个学生的成绩单独遮掉）。
 */
export function cellVisible(
  viewer: PortalViewer,
  col: VisibilityFields,
  entry: VisibilityFields,
  today: string,
): boolean {
  if (!columnAllows(viewer, col, today)) return false;
  const key = viewer === 'parent' ? '家长可见' : '学生可见';
  return entryAllows(entry[key]);
}

/**
 * 沟通记录（家校沟通）放行判定。
 *
 * 家校沟通表**没有**可见性开关（字段清单里就没有），所以这里只能用已有的口径收窄：
 *   - 只放 `记录类型 === '家校沟通'` 的记录（三合一后同一张表还有日常跟进 / 学生观察，
 *     那些是教师内部记录，不能给家长看）
 *   - 排除 `信息敏感级别` 高于"内部"的记录（`敏感` / `高度敏感` 一律不出门户）
 *
 * ⚠️ 学生视角同样排除 —— 家校沟通里常含家长对孩子的评价，学生看到会引发新问题；
 *    真要放开，改 `PARENT_PORTAL_EXCLUDED_LEVELS` 一处即可。
 */
export const PARENT_PORTAL_EXCLUDED_LEVELS: readonly string[] = ['敏感', '高度敏感'];

export function commVisible(level: unknown, today?: string): boolean {
  void today;
  const lv = String(level ?? '').trim();
  return !PARENT_PORTAL_EXCLUDED_LEVELS.includes(lv);
}
