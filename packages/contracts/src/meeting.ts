/**
 * 会议纪要「可见范围」的前后端共享契约。
 *
 * 为什么放 contracts 而不是各写一份：
 *   「可见范围」的四个取值同时被**后端判据**（`meeting-visibility.ts` 的分支匹配）
 *   和**前端表单**（下拉选项 + 条件显隐）使用。
 *   两边各写一份字符串数组，只要有一处改字（「部门内」vs「部门内可见」）就会静默失配 ——
 *   症状是「前端能选、后端判不到」⇒ 记录对所有人隐身，且不报任何错。
 *   同款范式见 `getnote.ts`（来源/标签的拆分规则）与 `weiling.ts`（状态文案）。
 */

/** 可见范围字段名（会议纪要表的 jsonb key） */
export const MEETING_VISIBILITY_FIELD = '可见范围';
/** 指定可见用户字段名（多选，存**用户表 record id 数组**） */
export const MEETING_VISIBLE_USERS_FIELD = '可见用户';
/**
 * 指定可见部门字段名（多选，存**部门表的 open_department_id 数组** —— 不是部门名）。
 *
 * 🔴 为什么存 id 而不是部门名：
 *   「部门内可见」用的是记录上的「部门」字段（历史原因存的是名字），但**多值字段的筛选只能走
 *   `contains` 子串匹配**（`data->>'可见部门'` 对数组返回的是 `["a","b"]` 这段 JSON 文本，
 *   等值匹配根本命中不了）。用部门名做子串匹配会串台 —— 「教学」会命中「教学管理中心」。
 *   而 open_department_id（`od-…`）是唯一字符串、互不为子串，两条路径（SQL / 内存）行为一致。
 *   顺带还免疫「部门改名」：改名后历史记录依然有效。
 */
export const MEETING_VISIBLE_DEPTS_FIELD = '可见部门';
/** 创建人 ID 字段名（冗余存 openId，仅供「仅自己可见」判据使用，界面不展示） */
export const MEETING_CREATOR_FIELD = '创建人ID';
/** 记录所属部门字段名（会议纪要的既有字段，存**部门名**） */
export const MEETING_DEPT_FIELD = '部门';

/**
 * 五个可见范围取值。
 *
 * 🔴 **顺序即表单下拉顺序，第一项就是新建默认值**
 *   （前端 `defaultFirstOption: true` 取 `[0]`，与 `MEETING_DEFAULT_VISIBILITY` 必须一致）。
 *   默认「部门内可见」而非「公开」：避免新建即全公司可见。
 *
 * 🔴 这是**代码固化的枚举**，不要改造成字典：字典的真源是生产 `data/dictionaries.json`（运行时可改），
 *   一旦有人改了选项值，后端判据的分支就全部落空 ⇒ 所有记录对所有人隐身。
 *   凡是与代码逻辑耦合的枚举，一律留在代码里。
 */
export const MEETING_VISIBILITY_SCOPES = ['部门内可见', '公开', '指定部门可见', '指定用户可见', '仅自己可见'] as const;
export type MeetingVisibilityScope = (typeof MEETING_VISIBILITY_SCOPES)[number];

/** 新建时的默认可见范围（= `MEETING_VISIBILITY_SCOPES[0]`） */
export const MEETING_DEFAULT_VISIBILITY: MeetingVisibilityScope = '部门内可见';

/**
 * 各可见范围的说明文案（表单下拉旁的提示 / 文档用）。
 * 键与 `MEETING_VISIBILITY_SCOPES` 一一对应。
 */
export const MEETING_VISIBILITY_HINTS: Record<MeetingVisibilityScope, string> = {
  公开: '所有能打开会议纪要模块的人都能看到',
  部门内可见: '本部门（含下级部门）的人，以及该部门负责人能看到',
  指定部门可见: '下面选中的部门（含其下级部门）里的人都能看到',
  指定用户可见: '只有下面选中的同事、你自己和系统管理员能看到',
  仅自己可见: '只有你自己和系统管理员能看到',
};
