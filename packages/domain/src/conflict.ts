/**
 * 排课冲突预检（纯函数，可单测；BR-006 / 设计文档 6.3）
 * 比较同一日期下 教师 / 场地 / 教学班 的时间重叠。
 * 设计原则：时间无法解析 → 视为硬冲突（fail-closed）。
 */

export type ConflictType = '教师冲突' | '场地冲突' | '班级冲突';

export interface SessionLike {
  id: string;
  教学班文本?: string;
  授课教师文本?: string;
  场地文本?: string;
  课次日期?: string;
  开始时间?: string;
  结束时间?: string;
}

export interface SessionConflict {
  type: ConflictType;
  sessionId: string;
  field: string;
}

export interface ConflictResult {
  hard: SessionConflict[];
  soft: SessionConflict[];
}

/** 从 "YYYY-MM-DD HH:mm" / "HH:mm" 取分钟数；无法解析返回 null */
function toMinutes(t?: string): number | null {
  if (!t) return null;
  const m = t.trim().match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function preflightSessionConflicts(
  draft: SessionLike,
  existing: SessionLike[],
): ConflictResult {
  const hard: SessionConflict[] = [];
  const date = (draft.课次日期 || '').trim();
  const s = toMinutes(draft.开始时间);
  const e = toMinutes(draft.结束时间);
  const draftValid = s !== null && e !== null && s < e;
  if (!date) return { hard, soft: [] };

  for (const ex of existing) {
    if (ex.id === draft.id) continue; // 编辑时跳过自身
    if ((ex.课次日期 || '').trim() !== date) continue;
    const es = toMinutes(ex.开始时间);
    const ee = toMinutes(ex.结束时间);
    const exValid = es !== null && ee !== null && es < ee;
    // 时间重叠判定（两段都有效时）
    const overlap = draftValid && exValid && s < ee && es < e;
    // 既有课次时间不可解析：同资源即保守判定为冲突
    const conservative = !exValid;

    const check = (field: keyof SessionLike, type: ConflictType) => {
      const a = (draft[field] || '').trim();
      const b = (ex[field] || '').trim();
      if (a && b && a === b && (overlap || conservative || !draftValid)) {
        hard.push({ type, sessionId: ex.id, field: String(field) });
      }
    };
    check('授课教师文本', '教师冲突');
    check('场地文本', '场地冲突');
    check('教学班文本', '班级冲突');
  }
  return { hard, soft: [] };
}
