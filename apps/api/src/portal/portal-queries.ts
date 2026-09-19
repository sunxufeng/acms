/**
 * 家长 / 学生门户的**查询层**：把「这个学生能看到什么」算出来。
 *
 * 为什么单独一个文件、且只吃一个 `SqlStore`：
 *   - 学生端（`PortalService`）与家长端（`ParentService`）要读的是**同一批数据**、
 *     只是视角（viewer）不同 ⇒ 读法必须只有一份，否则一定会漂移成
 *     「学生端 3 条、家长端 2 条」而没人说得清为什么。
 *   - 不注入任何 Nest 依赖，所以两个 service 都能直接调，也不会造成循环依赖
 *     （与 `markbook/homework-link.data.ts` 同一思路）。
 *
 * ⚠️ 三个实现上的硬约束（项目反复踩过）：
 *   1. `SqlStore.search` 的记录 id 字段名是 **`recordId`**，不是 `id`。
 *   2. **单页上限 500**，不翻页会静默少数据 ⇒ 一律用 `fetchAll()`（已含翻页）。
 *   3. 关联字段（`学生` / `成绩册列` / `关联学生编号` / `教学班`）**不能做等值 filter**，
 *      只能拉全再内存过滤，用 `linkIds()` 解析（jsonb 里有 `{link_record_ids}`、
 *      `[{record_ids}]`、裸 id 多种形态）。
 */

import { TABLES, STUDENT_RECORD_TYPE_FIELD } from '@acms/contracts';
import type { SqlStore } from '../sql-store/sql-store.js';
import { fetchAll } from '../markbook/homework-link.data.js';
import { linkIds } from '../shared/record.util.js';
import {
  cellVisible,
  columnAllows,
  commVisible,
  dayOf,
  switchOn,
  todayStr,
  type PortalViewer,
} from './portal-visibility.js';

/** 成绩册列里参与门户展示的字段（列级开关 + 展示用） */
const COL = {
  name: '列名称',
  subject: '科目',
  type: '考核类型',
  date: '考核日期',
  status: '状态',
  studentVisible: '学生可见',
  parentVisible: '家长可见',
  completeDate: '完成日期',
  class: '班级',
} as const;

/** 成绩册条目的字段 */
const ENTRY = {
  column: '成绩册列',
  student: '学生',
  score: '得分',
  full: '百分制',
  level: '等级',
  attained: '是否达标',
  comment: '评语',
  cellStatus: '单元格状态',
  studentVisible: '学生可见',
  parentVisible: '家长可见',
} as const;

export interface PortalGradeItem {
  id: string;
  列名称: string;
  科目: string;
  考核类型: string;
  考核日期: string;
  得分: string;
  满分: string;
  等级: string;
  是否达标: string;
  评语: string;
  单元格状态: string;
}

/**
 * 该学生的**过程成绩**（成绩册条目）。
 *
 * 判定链：条目属于该学生 → 列放行（开关 + 家长闸门）→ 条目未显式拒绝。
 * 只回放行的格子；被遮掉的**不返回计数**（家长端不该知道"藏了几条"）。
 */
export async function gradesOf(
  sql: SqlStore,
  studentId: string,
  viewer: PortalViewer,
  today: string = todayStr(),
): Promise<PortalGradeItem[]> {
  const [colRows, entryRows] = await Promise.all([
    fetchAll(sql, TABLES.markbookColumn.tableId),
    fetchAll(sql, TABLES.markbookEntry.tableId),
  ]);

  const cols = new Map<string, Record<string, any>>();
  for (const r of colRows) cols.set(r.id, r.f);

  const items: PortalGradeItem[] = [];
  for (const e of entryRows) {
    if (!linkIds(e.f[ENTRY.student]).includes(studentId)) continue;
    const colId = linkIds(e.f[ENTRY.column])[0] ?? '';
    const col = cols.get(colId);
    if (!col) continue;
    if (!cellVisible(viewer, col, e.f, today)) continue;
    const rawScore = e.f[ENTRY.score];
    items.push({
      id: e.id,
      列名称: String(col[COL.name] ?? ''),
      科目: String(col[COL.subject] ?? '').trim(),
      考核类型: String(col[COL.type] ?? ''),
      考核日期: dayOf(col[COL.date]),
      得分: rawScore === null || rawScore === undefined || rawScore === '' ? '' : String(rawScore),
      // 满分优先取条目的「百分制」（换算后），没有才回落列的满分口径
      满分: String(e.f[ENTRY.full] ?? '') || '100',
      等级: String(e.f[ENTRY.level] ?? ''),
      是否达标: String(e.f[ENTRY.attained] ?? ''),
      评语: String(e.f[ENTRY.comment] ?? ''),
      单元格状态: String(e.f[ENTRY.cellStatus] ?? '正常') || '正常',
    });
  }

  // 最近的考核在前；同日按列名稳定排序（避免两次请求顺序不同）
  return items.sort(
    (a, b) => b.考核日期.localeCompare(a.考核日期) || a.列名称.localeCompare(b.列名称, 'zh-CN'),
  );
}

export interface PortalHomeworkItem {
  id: string;
  课题: string;
  作业布置: string;
  教学目标: string;
  备课日期: string;
  课次: string;
  教学班: string;
}

/**
 * 该学生的**作业布置**（课时教案里的「作业布置」，带可见性开关）。
 *
 * 口径：
 *   - `教案状态 === '已发布'` 才出（草稿没定稿，不该给家长/学生看）
 *   - `家长可见 / 学生可见 === '是'`（教案的开关是显式 opt-in，与成绩册同口径）
 *   - 教学班命中该生（命中不了时按「不做排除」处理，与作业联动同一取舍：
 *     教学班还没建之前，若强求匹配，整条链路都是死的）
 */
export async function homeworkOf(
  sql: SqlStore,
  studentId: string,
  viewer: PortalViewer,
  today: string = todayStr(),
): Promise<PortalHomeworkItem[]> {
  const [lessonRows, classIds] = await Promise.all([
    fetchAll(sql, TABLES.lessonEntry.tableId),
    myClassIds(sql, studentId),
  ]);

  const items: PortalHomeworkItem[] = [];
  for (const r of lessonRows) {
    if (String(r.f['教案状态'] ?? '') !== '已发布') continue;
    if (!columnAllows(viewer, r.f, today)) continue;
    const ids = linkIds(r.f['教学班']);
    if (ids.length && classIds.size && !ids.some((id) => classIds.has(id))) continue;
    const hw = String(r.f['作业布置'] ?? '').trim();
    // 只公布"真的布置了作业"的教案：没写作业的教案对家长没有信息量
    if (!hw) continue;
    items.push({
      id: r.id,
      课题: String(r.f['课题'] ?? ''),
      作业布置: hw,
      教学目标: String(r.f['教学目标'] ?? ''),
      备课日期: dayOf(r.f['备课日期']),
      课次: String(r.f['课次'] ?? r.f['课次文本'] ?? ''),
      教学班: String(r.f['教学班文本'] ?? ''),
    });
  }
  return items.sort((a, b) => b.备课日期.localeCompare(a.备课日期));
}

export interface PortalCommItem {
  id: string;
  沟通时间: string;
  沟通主题: string;
  沟通人: string;
  沟通总结: string;
  沟通明细: string;
  家长反馈: string;
  闭环状态: string;
}

/**
 * 该学生的**家校沟通记录**（三合一后的 `dailyFollowup` 表）。
 *
 * 为什么必须卡 `记录类型 === '家校沟通'`：同一张表里还有「日常跟进」「学生观察」——
 * 那两类是**教师内部记录**（含对学生的负面观察、内部待办），不能出门户。
 * 三合一之前这里读的是独立的家校沟通表，合并后若不补这个条件，
 * 就会把教师的内部跟进记录直接推给家长。
 *
 * 敏感级别按 `PARENT_PORTAL_EXCLUDED_LEVELS` 收口（见 portal-visibility.ts）。
 */
export async function commsOf(
  sql: SqlStore,
  studentId: string,
  today: string = todayStr(),
): Promise<PortalCommItem[]> {
  void today;
  const rows = await fetchAll(sql, TABLES.dailyFollowup.tableId);
  const items: PortalCommItem[] = [];
  for (const r of rows) {
    if (String(r.f[STUDENT_RECORD_TYPE_FIELD] ?? '') !== '家校沟通') continue;
    if (!linkIds(r.f['关联学生编号']).includes(studentId)) continue;
    if (!commVisible(r.f['信息敏感级别'])) continue;
    items.push({
      id: r.id,
      沟通时间: dayOf(r.f['沟通时间']),
      沟通主题: String(r.f['沟通主题'] ?? ''),
      沟通人: String(r.f['沟通人'] ?? ''),
      沟通总结: String(r.f['沟通总结'] ?? ''),
      沟通明细: String(r.f['沟通明细'] ?? ''),
      家长反馈: String(r.f['家长反馈'] ?? ''),
      闭环状态: String(r.f['闭环状态'] ?? ''),
    });
  }
  return items.sort((a, b) => b.沟通时间.localeCompare(a.沟通时间));
}

/** 本人考勤（按关联学生过滤，最近 200 条倒序） */
export interface PortalAttendanceItem {
  id: string;
  考勤日期: string;
  方向: string;
  考勤状态: string;
  签到方式: string;
  校区: string;
  到校时间: string;
  离校时间: string;
  考勤结果: string;
}

export async function attendancesOf(sql: SqlStore, studentId: string): Promise<PortalAttendanceItem[]> {
  const rows = await fetchAll(sql, TABLES.attendance.tableId);
  const items: PortalAttendanceItem[] = [];
  for (const r of rows) {
    if (!linkIds(r.f['关联学生编号']).includes(studentId)) continue;
    items.push({
      id: r.id,
      考勤日期: dayOf(r.f['考勤日期']),
      方向: String(r.f['方向'] ?? ''),
      考勤状态: String(r.f['考勤状态'] ?? ''),
      签到方式: String(r.f['签到方式'] ?? ''),
      校区: String(r.f['校区'] ?? ''),
      到校时间: String(r.f['到校时间'] ?? ''),
      离校时间: String(r.f['离校时间'] ?? ''),
      考勤结果: String(r.f['考勤结果'] ?? ''),
    });
  }
  return items.sort((a, b) => b.考勤日期.localeCompare(a.考勤日期));
}

/** 该生修读的教学班 id 集合（录取关系 → 教学班） */
export async function myClassIds(sql: SqlStore, studentId: string): Promise<Set<string>> {
  const rows = await fetchAll(sql, TABLES.enrollment.tableId);
  const out = new Set<string>();
  for (const r of rows) {
    if (!linkIds(r.f['关联学生']).includes(studentId)) continue;
    for (const id of linkIds(r.f['关联教学班'])) out.add(id);
  }
  return out;
}

/**
 * 子女列表用的学生摘要（家长端多子女切换）。
 *
 * 只回展示必需的三项：姓名 / 学号 / 校区 —— 家长切换器不该顺带把孩子的完整档案带出来。
 */
export async function studentSummaries(
  sql: SqlStore,
  ids: readonly string[],
): Promise<{ id: string; 姓名: string; 学号: string; 校区: string }[]> {
  if (!ids.length) return [];
  const want = new Set(ids);
  const rows = await fetchAll(sql, TABLES.studentProfile.tableId);
  const out: { id: string; 姓名: string; 学号: string; 校区: string }[] = [];
  for (const r of rows) {
    if (!want.has(r.id)) continue;
    out.push({
      id: r.id,
      姓名: String(r.f['学生姓名'] ?? ''),
      学号: String(r.f['学生编号'] ?? ''),
      校区: String(r.f['校区'] ?? ''),
    });
  }
  // 按传入顺序排（家长端切换条的次序要稳定，不能随表内顺序抖动）
  const order = new Map(ids.map((id, i) => [id, i]));
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** 学号 + 姓名 → 学生档案（家长绑定用；`学生编号` 或 `学籍号（脱敏）` 任一命中即可） */
export async function findStudentByNo(
  sql: SqlStore,
  studentNo: string,
  name: string,
): Promise<{ id: string; 姓名: string; 学号: string; 校区: string } | null> {
  const no = String(studentNo ?? '').trim();
  const nm = String(name ?? '').trim();
  if (!no || !nm) return null;
  const rows = await fetchAll(sql, TABLES.studentProfile.tableId);
  for (const r of rows) {
    if (String(r.f['学生姓名'] ?? '').trim() !== nm) continue;
    const a = String(r.f['学生编号'] ?? '').trim();
    const b = String(r.f['学籍号（脱敏）'] ?? '').trim();
    if (a === no || b === no) {
      return { id: r.id, 姓名: nm, 学号: a || no, 校区: String(r.f['校区'] ?? '') };
    }
  }
  return null;
}

/** 是否对家长开放（供清单类数据复用；`switchOn` 的对外别名，避免调用方各写各的判定） */
export function visibleSwitch(v: unknown): boolean {
  return switchOn(v);
}
