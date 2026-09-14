/**
 * 作业 ↔ 成绩册联动的**数据读取层**（只读，无 Nest 依赖）。
 *
 * 为什么单独一个文件：
 *   - `MarkbookService.getGrid`（列头的完成率）与 `HomeworkSyncService`（同步 / 预览）
 *     都要读作业的两张表，读法（分页拉全、作业名称归一、教学班匹配、多版本取最新）
 *     必须只有一份，否则「列头显示完成率 2/3、同步却只认到 1 人」这种不一致无法解释。
 *   - 这里**不注入任何 Nest 依赖**，只吃一个 `SqlStore`，所以 MarkbookService 直接调用它
 *     也不会造成 MarkbookService ↔ HomeworkSyncService 的循环依赖。
 *
 * ⚠️ 两个已知坑：
 *   1. `SqlStore.search` 的记录 id 字段名是 **`recordId`** 而不是 `id`（项目反复踩过），
 *      下面一律 `recordId ?? id` 兜底。
 *   2. 教学班为空（生产当前就是空的）时**不做排除**：作业表里「教学班」没填的行仍然算数，
 *      因为调用方已经先用「本班学生名单」收过口 —— 两道过滤中有一道生效即可，
 *      若强行要求教学班匹配，教学班没建之前整条链路都是死的。
 */

import { TABLES } from '@acms/contracts';
import type { SqlStore } from '../sql-store/sql-store.js';
import { firstLinkId, toDateStr } from '../curriculum/curriculum.logic.js';
import {
  HOMEWORK_NAME_FIELD,
  SUBMISSION_SCORE_FIELDS,
  TRACKER_DONE_FIELD,
  completionRate,
  isDone,
  normHomeworkName,
  optNum,
  type PlanExisting,
  type PlanSubmission,
  type PlanTracker,
} from './homework-link.logic.js';
import { textOf } from './markbook.logic.js';

/** 分页拉全（SqlStore 单页上限 500，不翻页会静默少算） */
export async function fetchAll(sql: SqlStore, tableId: string): Promise<{ id: string; f: Record<string, any> }[]> {
  const out: { id: string; f: Record<string, any> }[] = [];
  let token: string | undefined;
  let guard = 0;
  do {
    const res = await sql.search(tableId, { pageSize: 500, pageToken: token });
    for (const r of res.items || []) {
      const x = r as unknown as { recordId?: string; id?: string; fields?: Record<string, any> };
      out.push({ id: String(x.recordId ?? x.id ?? ''), f: (x.fields || {}) as Record<string, any> });
    }
    token = res.hasMore ? res.pageToken : undefined;
  } while (token && guard++ < 60);
  return out;
}

/** 教学班 record id → 名称（作业表的「教学班」是关联字段，只存 id） */
export async function teachingClassNames(sql: SqlStore): Promise<Map<string, string>> {
  const rows = await fetchAll(sql, TABLES.teachingClass.tableId);
  const map = new Map<string, string>();
  for (const r of rows) {
    const name = textOf(r.f['教学班名称']);
    if (r.id && name) map.set(r.id, name);
  }
  return map;
}

/**
 * 关联字段原始值 → 可读名称集合。
 * 关联 id 查得到名称就给名称；查不到就把 id 原样放进去（宁可多、不可漏）。
 */
export function classNamesOf(raw: unknown, classNames: Map<string, string>): Set<string> {
  const out = new Set<string>();
  const text = textOf(raw);
  if (text) for (const part of text.split(/[、,，]/)) if (part.trim()) out.add(part.trim());
  const id = firstLinkId(raw);
  if (id) out.add(classNames.get(id) ?? id);
  return out;
}

/**
 * 「教学班」是否属于目标班级。
 * 取不到任何可读值时返回 true —— 交给「本班学生名单」那道过滤收口（见文件头注释 2）。
 */
export function matchesClass(raw: unknown, cls: string, classNames: Map<string, string>): boolean {
  const names = classNamesOf(raw, classNames);
  if (!names.size) return true;
  return names.has(cls);
}

export interface HomeworkTables {
  /** 作业名称 → 学生 record id → 完成情况 */
  trackers: Map<string, Map<string, PlanTracker>>;
  /** 作业名称 → 学生 record id → 最新一版提交 */
  submissions: Map<string, Map<string, PlanSubmission>>;
  /** 该班出现过的所有作业名称（去重，用于下拉选择） */
  names: string[];
  /** 作业名称 → 追踪表的作业名称原值（回写/展示用，保持与数据一致） */
  rawNames: Map<string, string>;
}

/**
 * 读出该班的作业两表数据并按「作业名称」分组。
 *
 * `homeworkName` 传空则返回该班全部作业（前端下拉用）；传值则只返回该作业。
 * 学生维度的收口由调用方用名单做，这里不重复判断。
 */
export async function readHomeworkTables(
  sql: SqlStore,
  cls: string,
  homeworkName?: string,
): Promise<HomeworkTables> {
  const [trackerRows, subRows, classNames] = await Promise.all([
    fetchAll(sql, TABLES.homeworkTracker.tableId),
    fetchAll(sql, TABLES.homeworkSubmission.tableId),
    teachingClassNames(sql),
  ]);

  const trackers = new Map<string, Map<string, PlanTracker>>();
  const submissions = new Map<string, Map<string, PlanSubmission>>();
  const rawNames = new Map<string, string>();
  const want = homeworkName ? normHomeworkName(homeworkName) : '';

  for (const r of trackerRows) {
    const raw = String(r.f[HOMEWORK_NAME_FIELD] ?? '');
    const key = normHomeworkName(raw);
    if (!key) continue;
    if (want && key !== want) continue;
    if (!matchesClass(r.f['教学班'], cls, classNames)) continue;
    const sid = firstLinkId(r.f['学生']);
    if (!sid) continue;
    rawNames.set(key, raw);
    const m = trackers.get(key) ?? new Map<string, PlanTracker>();
    // 同一学生同一作业可能有多行（补录），「完成」优先 —— 教师补记一条完成不该被判成未完成
    const prev = m.get(sid);
    m.set(sid, { studentId: sid, done: (prev?.done ?? false) || isDone(r.f[TRACKER_DONE_FIELD]) });
    trackers.set(key, m);
  }

  for (const r of subRows) {
    const raw = String(r.f[HOMEWORK_NAME_FIELD] ?? '');
    const key = normHomeworkName(raw);
    if (!key) continue;
    if (want && key !== want) continue;
    if (!matchesClass(r.f['教学班'], cls, classNames)) continue;
    const sid = firstLinkId(r.f['学生']);
    if (!sid) continue;
    rawNames.set(key, raw);

    let score: number | null = null;
    for (const f of SUBMISSION_SCORE_FIELDS) {
      const n = optNum(r.f[f]);
      if (n != null) {
        score = n;
        break;
      }
    }
    const candidate: PlanSubmission = {
      studentId: sid,
      score,
      status: textOf(r.f['提交状态']),
      late: textOf(r.f['是否迟交']),
      version: optNum(r.f['版本号']) ?? 0,
    };
    const m = submissions.get(key) ?? new Map<string, PlanSubmission>();
    const prev = m.get(sid);
    // 多版本：版本号大的胜；版本号相同（或都为 0）时后写的胜（fetchAll 按 created_at DESC 返回）
    if (!prev || candidate.version >= prev.version) m.set(sid, candidate);
    submissions.set(key, m);
  }

  return { trackers, submissions, names: [...rawNames.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN')), rawNames };
}

/** 某成绩册列下已存在的条目（学生 record id → 当前值 + 需要原样保留的字段） */
export async function readExistingEntries(sql: SqlStore, columnId: string): Promise<Map<string, PlanExisting>> {
  const rows = await fetchAll(sql, TABLES.markbookEntry.tableId);
  const out = new Map<string, PlanExisting>();
  for (const r of rows) {
    if (firstLinkId(r.f['成绩册列']) !== columnId) continue;
    const sid = firstLinkId(r.f['学生']);
    if (!sid) continue;
    out.set(sid, {
      score: optNum(r.f['得分']),
      comment: textOf(r.f['评语']),
      visibleStudent: textOf(r.f['学生可见']),
      visibleParent: textOf(r.f['家长可见']),
    });
  }
  return out;
}

/**
 * 列头用的完成率。
 *
 * 口径：已完成人数 / 该班名单人数（分母与学生名单同源，和 sync 的 scanned 一致）。
 * `tracked` 单独给出来 —— 追踪表只记了一部分学生时，界面能看出「不是没完成，是没记」。
 */
export interface HomeworkRate {
  homeworkName: string;
  done: number;
  total: number;
  /** 追踪表里实际有记录的学生数 */
  tracked: number;
  rate: number;
}

/**
 * 给一批「已绑定作业的列」算完成率。
 * 只读、不改任何数据（反向展示路径，不引入新的写路径）。
 */
export function homeworkRatesOf(
  tables: HomeworkTables,
  binds: { columnId: string; homeworkName: string }[],
  rosterIds: string[],
): Record<string, HomeworkRate> {
  const out: Record<string, HomeworkRate> = {};
  const roster = new Set(rosterIds);
  for (const b of binds) {
    const name = normHomeworkName(b.homeworkName);
    if (!name) continue;
    const m = tables.trackers.get(name);
    let done = 0;
    let tracked = 0;
    if (m) {
      for (const [sid, t] of m) {
        if (!roster.has(sid)) continue;
        tracked++;
        if (t.done) done++;
      }
    }
    out[b.columnId] = {
      homeworkName: name,
      done,
      total: roster.size,
      tracked,
      rate: completionRate(done, roster.size),
    };
  }
  return out;
}

/** 该班某作业的完成情况（预览头部的 2/3 用） */
export function completionOf(tables: HomeworkTables, homeworkName: string, rosterIds: string[]): { done: number; total: number } {
  const name = normHomeworkName(homeworkName);
  const m = tables.trackers.get(name);
  const roster = new Set(rosterIds);
  let done = 0;
  if (m) for (const [sid, t] of m) if (roster.has(sid) && t.done) done++;
  return { done, total: roster.size };
}

/** 提交时间（毫秒）→ 仅供展示/排序，解析不了给空串 */
export function submissionDate(f: Record<string, any>): string {
  return toDateStr(f['提交时间']);
}
