/**
 * 课程规划的零依赖纯逻辑：日期归一 / 迟交核算 / 部署编排。
 *
 * ⚠️ 刻意不 import Nest、不 import 存储层（对照 skill 的「坑 5：同一判据不要写两遍」）：
 * `curriculum.meta.ts`（纯数据，运行时被子模块引用）与 `curriculum.service.ts` 都要用到
 * 迟交判据与日期解析，把算法放这里两边引用同一份，避免口径漂移。
 */

/** 数值字段统一解析（排序 / 课时数 / 课时数），空值与非法值都给 0 */
export function numOf(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * 归一成**本地时区**的 `YYYY-MM-DD`，解析不了返回空串。
 *
 * 为什么不能只认字符串：本模块的新建表没有登记 `acms_fields` 元数据，
 * SqlStore 的 `normalize()` 不会把日期还原成 `YYYY-MM-DD`，读出来仍是毫秒戳。
 * 因此数字、`YYYY-MM-DD`、`YYYY-MM-DD HH:mm` 三种形态都要能解析。
 */
export function toDateStr(v: unknown): string {
  if (v == null || v === '') return '';
  if (typeof v === 'number' || /^\d{10,}$/.test(String(v).trim())) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '';
    return fmtLocal(new Date(n));
  }
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? '' : fmtLocal(new Date(t));
}

/** 归一成 epoch 毫秒；解析不了返回 null */
export function toMs(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{10,}$/.test(s)) return Number(s);
  // 'YYYY-MM-DD HH:mm' 的 ISO 变体在部分引擎里解析不稳，先补 T
  const t = new Date(s.includes('T') ? s : s.replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? null : t;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 关联字段原始值是否包含某个 record id。
 * 兼容三种落库形态：`['rec_x']`（本模块通用 CRUD 写的）、`[{ record_ids:['rec_x'] }]`（飞书迁移态）、
 * 以及兜底的「JSON 文本里含该 id」。
 */
export function hasLinkId(v: unknown, id: string): boolean {
  if (!id) return false;
  const arr = Array.isArray(v) ? v : [v];
  for (const it of arr) {
    if (typeof it === 'string' && it === id) return true;
    if (it && typeof it === 'object') {
      const o = it as {
        record_ids?: unknown;
        link_record_ids?: unknown;
        record_id?: unknown;
        link_record_id?: unknown;
        id?: unknown;
      };
      for (const key of ['record_ids', 'link_record_ids'] as const) {
        const list = o[key];
        if (Array.isArray(list) && list.some((x) => String(x) === id)) return true;
      }
      for (const key of ['record_id', 'link_record_id', 'id'] as const) {
        if (o[key] != null && String(o[key]) === id) return true;
      }
    }
  }
  return String(v ?? '').includes(id);
}

/** 取关联字段里的第一个 record id（本模块的关联都是单值语义） */
export function firstLinkId(v: unknown): string {
  const arr = Array.isArray(v) ? v : [v];
  for (const it of arr) {
    if (typeof it === 'string' && it) return it;
    if (it && typeof it === 'object') {
      const o = it as {
        record_ids?: unknown;
        link_record_ids?: unknown;
        record_id?: unknown;
        link_record_id?: unknown;
        id?: unknown;
      };
      for (const key of ['record_ids', 'link_record_ids'] as const) {
        const list = o[key];
        if (Array.isArray(list) && list.length) return String(list[0]);
      }
      for (const key of ['record_id', 'link_record_id', 'id'] as const) {
        if (o[key] != null && String(o[key])) return String(o[key]);
      }
    }
  }
  return '';
}

export interface LateResult {
  是否迟交: string;
  /** 迟交时长，向上取整到分钟（不足 1 分钟按 1 分钟算，避免显示「迟交 0 分钟」） */
  迟交分钟数: number;
}

/**
 * 迟交核算：截止时间 vs 提交时间。
 *
 * 规则（Gibbon 的 homework 口径）：只有「截止时间」与「提交时间」**都有**时才能判定；
 * 缺一即返回 null（没交、或作业没设截止，都谈不上迟交）。
 * 提交时间晚于截止时间 → 迟交，分钟数向上取整；否则不迟交、0 分钟。
 */
export function computeLate(submittedAt: unknown, dueAt: unknown): LateResult | null {
  const sub = toMs(submittedAt);
  const due = toMs(dueAt);
  if (sub == null || due == null) return null;
  if (sub <= due) return { 是否迟交: '否', 迟交分钟数: 0 };
  return { 是否迟交: '是', 迟交分钟数: Math.max(1, Math.ceil((sub - due) / 60000)) };
}

export interface DeployPair {
  /** 单元环节 record id */
  blockId: string;
  /** 课次 record id */
  sessionId: string;
}

export interface DeployPlan {
  /** 需要新建的开课环节（环节 ↔ 课次 一对一按序对齐） */
  pairs: DeployPair[];
  /** 本次跳过的环节（replaceExisting=false 且该环节已部署过） */
  skippedBlockIds: string[];
  /** 排不满的环节（课次数不够） */
  overflowBlockIds: string[];
  /** 没排到环节的空余课次 */
  idleSessionIds: string[];
}

/**
 * 部署编排：环节按顺序落到课次上（一对一，**不重复使用课次**）。
 *
 * 语义（与 Gibbon 的 deploy 一致）：
 *   - 第 i 个环节 → 第 i 个课次；课时数不参与编排，只做展示（避免「一个环节跨多节课」的复杂度）
 *   - 课次少于环节 → 多出来的环节进 overflowBlockIds（前端提示「课次不足」）
 *   - 课次多于环节 → 多出来的课次进 idleSessionIds（前端提示「有空余课次」）
 *   - `replaceExisting=false` 时，已部署过的环节保持原课次不动、也不占位
 */
export function planDeploy(
  blockIds: string[],
  sessionIds: string[],
  alreadyDeployedBlockIds: Iterable<string> = [],
  replaceExisting = true,
): DeployPlan {
  const deployed = new Set(alreadyDeployedBlockIds);
  const pairs: DeployPair[] = [];
  const skippedBlockIds: string[] = [];
  const overflowBlockIds: string[] = [];
  const idleSessionIds: string[] = [];
  const total = Math.min(blockIds.length, sessionIds.length);
  for (let i = 0; i < total; i++) {
    const blockId = blockIds[i] as string;
    const sessionId = sessionIds[i] as string;
    if (!replaceExisting && deployed.has(blockId)) {
      skippedBlockIds.push(blockId);
      continue;
    }
    pairs.push({ blockId, sessionId });
  }
  // 课次不足时，溢出的环节一律记下来（这些环节本来也想部署）
  for (let i = total; i < blockIds.length; i++) overflowBlockIds.push(blockIds[i] as string);
  for (let i = blockIds.length; i < sessionIds.length; i++) idleSessionIds.push(sessionIds[i] as string);
  return { pairs, skippedBlockIds, overflowBlockIds, idleSessionIds };
}

/** 留存率：分子/分母都取整，分母为 0 时返回 0（避免 NaN 传到前端渲染成 "NaN%"） */
export function ratio(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 10000) / 10000;
}
