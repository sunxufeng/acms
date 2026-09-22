/**
 * 学生维度「笔记来源」的口径（2026-09-22 新增）。
 *
 * 为什么放 contracts：这两份映射**前端与多个 service 都要用**，而且历史上已经漂移过一次 ——
 * `SECTION_LABELS` 原本只写在 `student-360.service.ts` 里，新的「学生关联笔记」聚合要用
 * 同一份「路径 → 中文名」，各抄一份必然再次漂移。
 */

/**
 * 模块路径 → 分区中文名。
 * 两个消费点：学生全景的分区标题、关联笔记的来源标签。
 */
export const SECTION_LABELS: Record<string, string> = {
  'source-followups': '招生跟进',
  'student-attendances': '学生考勤',
  grades: '学业成绩',
  'practice-activities': '实践活动',
  // 学生记录（2026-09-18）：日常跟进 / 家校沟通 / 学生观察 三合一后的分区名。
  // 三个旧 path 的条目已删除 —— 它们与主表指向同一张表（遍历时按 tableId 去重），
  // 留在这里只会让人误以为还有三个独立分区。
  'student-records': '学生记录',
  'stage-evaluations': '阶段评价',
  'alumni-followups': '校友跟进',
  'idp-plans': 'IDP方案',
  // 考试与成绩（2026-09-16 Phase 2）：不是 RecordMeta 驱动的表
  termGrades: '期末总评',
  reportCards: '成绩单',
};

/** 直接挂在学生档案上的笔记，`实体类型` 固定是这个值 */
export const NOTE_ENTITY_TYPE_STUDENT = '学生档案';

/**
 * 「笔记关联」表里 `实体类型` 的取值 → 归属模块路径。
 *
 * ⚠️ **为什么要列这么多别名**：这张表的 `实体类型` 是自由文本，历史上出现过三种写法 ——
 *   1. 记录自身的类型名（「IDP沟通」「家校沟通」…）—— 记录详情页 `NotePanel` 现在传的是它；
 *   2. 合并后的统称（「学生记录」）—— **生产实测 19 条是这个值**，而详情页按类型名查
 *      ⇒ 这些笔记在记录详情页里根本查不出来（本次顺带要修的就是这个口径）；
 *   3. 模块中文名（「招生跟进」「学业成绩」…）—— 自建实体页传的。
 *
 * 所以聚合查询**不按类型白名单**，而是「拿实体 ID + 这张映射」反查归属表 ——
 * 这样无论历史写的是哪个别名，都能被捞回来，也不会因为将来新增别名而静默漏掉。
 *
 * ⚠️ 没登记的表（如「会议纪要」）会在聚合里被跳过：会议纪要表**没有学生字段**，
 * 结构上无法归属到学生，登记了也只会给出错误归属。
 */
export const NOTE_ENTITY_TYPE_TO_PATH: Record<string, string> = {
  学生记录: 'student-records',
  日常跟进: 'student-records',
  IDP沟通: 'student-records',
  学生沟通: 'student-records',
  家校沟通: 'student-records',
  学生观察: 'student-records',
  招生跟进: 'source-followups',
  学生考勤: 'student-attendances',
  学业成绩: 'grades',
  实践活动: 'practice-activities',
  阶段评价: 'stage-evaluations',
  校友跟进: 'alumni-followups',
  IDP计划: 'idp-plans',
  会议纪要: 'meeting-minutes',
};

/** 一篇笔记的来源（把笔记挂到学生身上的那条「路径」） */
export interface StudentNoteSource {
  /** 来源模块的实体类型，与「笔记关联」表里的取值一致（如「IDP沟通」「招生跟进」） */
  entityType: string;
  /** 展示标签：记录自身的「记录类型」优先（IDP沟通 > 学生记录），否则模块中文名 */
  label: string;
  /** 来源记录的 id */
  recordId: string;
  /** 来源记录的标题（沟通主题 / 跟进内容 …），取不到时回落标签 */
  recordTitle: string;
  /** 来源记录的时间（毫秒）；取不到为 null —— 前端排到最后，不要当成 0 */
  recordTime: number | null;
  /** 点来源跳哪：`/<模块路径>/<记录 id>` */
  detailHref: string;
  /** 关联这条笔记的人 */
  linkedBy: string;
  /** 关联时间（飞书返回的文本，原样展示） */
  linkedAt: string;
  /**
   * 归属是**按姓名文本**匹配出来的（招生跟进这类没有可用关联字段的表）。
   * 前端要据此打「可不准确」的提示 —— 姓名有家长称谓、手机号等脏值。
   */
  byName: boolean;
}

/** 聚合后的一篇笔记（同一篇被多条路径关联时合并成一条） */
export interface StudentNoteLink {
  noteId: string;
  title: string;
  sources: StudentNoteSource[];
  /** 至少有一条「直接关联学生档案」的路径 ⇒ 前端才给「解除」按钮 */
  direct: boolean;
}

export interface StudentNoteLinksResult {
  studentId: string;
  studentName: string;
  notes: StudentNoteLink[];
  /** 来源标签 → 该来源下的笔记数（给顶部筛选 chips 用） */
  counts: Record<string, number>;
  /** 直接关联的笔记数 */
  directCount: number;
  /**
   * 因**无模块权限**而被跳过的来源标签。
   * 前端据此提示「还有 N 处来源你看不到」—— 不提示的话，用户会以为这个学生真的只有这几篇。
   */
  hiddenSources: string[];
}
