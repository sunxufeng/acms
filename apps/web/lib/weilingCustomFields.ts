/**
 * 卫瓴联系人的「自定义字段」解析（2026-09-21 新增）。
 *
 * 上游把 **95 个自定义字段整包存在一个列**里，且值是 **JSON 文本**而不是对象
 * （生产实测 `data->>'自定义字段'` = `'{"xsxm":"Miller","yxlxgb":1,"xssjxx":11}'`）；
 * 空值是字符串 `'{}'`，也有整列缺失的行。
 *
 * 目前只取一个字段：
 *   - `xsxm` = **学生姓名**（招生简章/活动报名表里家长填的子女姓名）
 *
 * ⚠️ 为什么单独抽这个文件：招生跟进（选联系人后带出学生姓名）与联系人管理（列表列）
 * 都要用同一份解析。各写一份必然出现「同一个联系人两处显示的学生姓名不一样」
 * （一处容错一处不catch，遇到脏值就一个显示空、一个显示原文）。
 */

/** 自定义字段里「学生姓名」的 api_name（上游定义，不要在别处手写这个字符串） */
export const WEILING_CUSTOM_STUDENT_NAME_KEY = 'xsxm';

/** 解析「自定义字段」→ 对象。任何异常都返回空对象（列表不能因为一条脏数据整页报错）。 */
export function parseWeilingCustomFields(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  const s = String(raw).trim();
  if (!s || s === '{}') return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 自定义字段里的值 → 展示文本（数组取第一项；对象取 text/name/value） */
function textOf(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return String(o.text ?? o.name ?? o.value ?? '').trim();
  }
  return String(v).trim();
}

/**
 * 取某行（卫瓴联系人）的「学生姓名」。
 *
 * 三处容错，都是为了「别让使用者看到空列却不知道为什么」：
 *   1. 兼容传进来的字段值本身（有的调用方已经把 `自定义字段` 取出来了）；
 *   2. 兼容值直接是**已解析的对象**（后端在某些接口上会 parse 后返回）；
 *   3. 数字类型的值（上游把学生姓名填成纯数字时）也照原样显示，不吞掉。
 */
export function studentNameOfContact(row: Record<string, unknown>): string {
  const fields = parseWeilingCustomFields(row['自定义字段']);
  return textOf(fields[WEILING_CUSTOM_STUDENT_NAME_KEY]);
}
