/**
 * 学生档案「入学年月 → 入学年份 / Arete入学年」的派生规则（**前后端共用一份**）。
 *
 * ── 规则来源（2026-09-22 峰哥给的范例）──────────────────────────────
 *   沈嘉铖 `STU-00266`：入学年月 `23秋季` → 入学年份 `2023`、Arete入学年 `第3年`
 *   ⇒ 入学年份 = `20` + `NN`；Arete入学年 = `第(入学年份 − 2020)年`
 *
 * 🔴 两条读法都能解释这个范例，**必须用全量数据排除一个**：
 *    ① 第(入学年份 − 2020)年 —— Arete 第 N 个年度（2021 = 第1年，本文件采用）
 *    ② 入学后第 N 年（当前年份 − 入学年份）—— 范例上同样得 3
 *    套到全量数据：② 会把 `26秋季`（2026 年入学的 61 人）算成 **第 0 年**，
 *    而字典 `Arete入学年` 只有 第1年–第10年 ⇒ ② 被否。
 *    **只拿一个范例反推规则时，一定要拿全量数据做排除** —— 否则整批数据会按错规则填，
 *    而且错得很像真的（每个值都落在字典范围内，看不出来）。
 *
 * ① 与既有的「Arete毕业届：第四届 = 2024 年入学」是同一套编号（自洽校验）。
 */

export const ENROLL_MONTH_FIELD = '入学年月';
export const ENROLL_YEAR_FIELD = '入学年份';
export const ARETE_ENROLL_YEAR_FIELD = 'Arete入学年';

/** 第1年 = 2021 年入学，即 `第N年 = 入学年份 − ARETE_ENROLL_BASE_YEAR` */
export const ARETE_ENROLL_BASE_YEAR = 2020;

/**
 * 字典 `Arete入学年` 的上限（第10年 = 2030 年入学）。
 * 推导结果超出这个范围时**返回空**（不允许，见下）：写一个字典里没有的值，
 * 界面上会显示成"这个字段没值"，比不填更难排查。
 */
export const ARETE_ENROLL_MAX_YEAR_NO = 10;

/** `NN春季 / NN秋季` —— 与字典 `入学年月` 的 15 个选项同形 */
const ENROLL_MONTH_RE = /^(\d{2})(春季|秋季)$/;

/** `23秋季` → `2023`；形态不符返回空串 */
export function enrollYearFromMonth(month: unknown): string {
  const m = ENROLL_MONTH_RE.exec(String(month ?? '').trim());
  if (!m) return '';
  return String(2000 + Number(m[1]));
}

/** `2023` → `第3年`；非 4 位数字或超出字典范围（第1–第10年）返回空串 */
export function areteEnrollYearLabel(enrollYear: unknown): string {
  const s = String(enrollYear ?? '').trim();
  if (!/^\d{4}$/.test(s)) return '';
  const no = Number(s) - ARETE_ENROLL_BASE_YEAR;
  if (no < 1 || no > ARETE_ENROLL_MAX_YEAR_NO) return '';
  return `第${no}年`;
}

/**
 * 由「入学年月」推出两个字段的**待填值**（键就是数据 key，与表单字段同名）。
 *
 * 语义边界（与「招生跟进·选联系人带出学生姓名」同一套）：
 * - 返回空对象 = **推导不出就不动**，调用方**不要**拿它去清空已有值。
 *   所以清空「入学年月」不会顺手抹掉「入学年份 / Arete入学年」——
 *   便利填充不该变成静默的数据删除，要清由人手动清。
 * - 这是**便利填充，不是不变式**：带出后用户仍可手改（峰哥明确要求），
 *   因此服务端不做强制覆盖，只在「入学年月」变化的那一刻由界面带出。
 */
export function deriveEnrollFields(
  month: unknown,
): { [ENROLL_YEAR_FIELD]?: string; [ARETE_ENROLL_YEAR_FIELD]?: string } {
  const year = enrollYearFromMonth(month);
  if (!year) return {};
  const label = areteEnrollYearLabel(year);
  if (!label) return {};
  return { [ENROLL_YEAR_FIELD]: year, [ARETE_ENROLL_YEAR_FIELD]: label };
}
