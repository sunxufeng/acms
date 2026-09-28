import type { CrudApi, CrudColumn, CrudPageProps } from '../components/CrudPage';
import { api } from './api';
import { COLUMNS as SOURCE_FOLLOWUP_COLUMNS, parseSourceFollowupFromSummary } from '../app/source-followups/columns';
import { buildStudentRecordColumns, parseStudentRecordFromSummary } from '../app/student-records/columns';
import { buildMeetingColumns, parseMeetingFromSummary } from '../app/meeting-minutes/columns';
import { STUDENT_RECORD_TYPE_FIELD } from '@acms/contracts';

/**
 * 「我的笔记 → 转换」就地转换表单的**模块登记表**。
 *
 * ## 它解决什么
 *
 * 旧流程是「写 sessionStorage → 跳到目标模块 → 那边的新建表单消费预填」，用户要跳页、
 * 转完还得自己回列表。新流程要**就地**在笔记那一行下面铺出目标模块的新建表单
 * （峰哥 2026-09-28 要求：「很大程度减少了各种跳转，也减少了用户的操作难度」）。
 *
 * 🔴 关键约束：就地表单必须与该模块**自己的新建表单完全一致** —— 字段、措辞、
 *    联动（选联系人→带出学生姓名、选部门→带出参会人员、可见范围→可见用户/部门）、
 *    字典候选、关联字段候选项，一处都不能自己再写一遍。
 *    所以这里**只登记「从哪拿列定义与 api」**，表单渲染与提交由 CrudPage 的 `formOnly`
 *    模式负责（同一份代码、同一个提交链路），本文件不出现任何字段清单。
 *
 * ## 没登记的模块怎么办
 *
 * 返回 `null` ⇒ 调用方退回**旧行为**（跳转到该模块的新建页，见 lib/noteConvert）。
 * 这样以后在「转换配置」里新增目标模块，即使忘了在这里登记也只是「还跳页」，
 * 不会变成一个打不开的空表单。
 */

export interface ConvertFormCtx {
  /** 当前登录用户名（给需要它的模块做默认值） */
  me: string;
  /** 学生记录用：当前选中的「记录类型」（列定义按它生成措辞与显隐） */
  studentType?: string;
  /** 会议纪要用：部门 → 含下级的成员姓名（来自 `useDeptMembers`） */
  deptMembers?: Record<string, string[]>;
  /** 会议纪要用：我所属的部门 id（「指定部门可见」的默认选中值） */
  myDeptIds?: string[];
  /** 会议纪要用：被手工从参会人员删掉的人 */
  manuallyRemoved?: { current: Set<string> };
}

export interface ConvertFormParts {
  columns: CrudColumn[];
  api: CrudApi;
  /** 与目标模块页面**同一个**预填增强函数（笔记标题 → 主题、归属人 → 记录人 …） */
  enrichPrefill?: CrudPageProps['enrichPrefill'];
  /** 保存成功后「打开这条记录 ↗」的只读详情路径（与各模块列表页的 detailHref 同口径） */
  detailHref: (id: string) => string;
}

/** 拿某个模块的就地转换表单；未登记返回 null（调用方退回跳转） */
export function convertFormFor(menuKey: string, ctx: ConvertFormCtx): ConvertFormParts | null {
  switch (menuKey) {
    case 'sourceFollowups':
      return {
        columns: SOURCE_FOLLOWUP_COLUMNS,
        api: {
          create: (d) => api.createSourceFollowup(d),
        },
        enrichPrefill: parseSourceFollowupFromSummary,
        detailHref: (id) => `/source-followups/${id}`,
      };

    case 'studentRecords':
      return {
        // 措辞与显隐随「记录类型」变（沟通人 ↔ 观察人、家校沟通才有家长字段），
        // 与列表页顶部 Tab 切换时重建列定义是**同一件事**。
        columns: buildStudentRecordColumns(ctx.studentType || undefined),
        api: {
          create: (d) => api.createStudentRecord(d),
        },
        enrichPrefill: parseStudentRecordFromSummary,
        detailHref: (id) => `/student-records/${id}`,
      };

    case 'meetingMinutes':
      return {
        // 参会人员要靠 deptMembers 带出来；可见范围联动要用 myDeptIds / manuallyRemoved。
        // 这三样必须与列表页同源（都走 useDeptMembers），否则「列表里能带出、转换里带不出」。
        columns: buildMeetingColumns({
          deptMembers: ctx.deptMembers ?? {},
          myDeptIds: ctx.myDeptIds ?? [],
          manuallyRemoved: ctx.manuallyRemoved ?? { current: new Set<string>() },
        }),
        api: {
          create: (d) => api.createMeetingMinute(d),
        },
        enrichPrefill: parseMeetingFromSummary,
        detailHref: (id) => `/meeting-minutes/${id}`,
      };

    default:
      return null;
  }
}

/**
 * 就地转换时目标模块的**初始值**（笔记内容之外、模块自己必须有的默认）。
 *
 * 目前只有学生记录的「记录类型」：它决定表单长什么样，必须有值。
 * 默认给 `IDP沟通`（峰哥 2026-09-28 在确认过的设计稿里选的），用户可改。
 */
export function convertInitialExtras(menuKey: string): Record<string, unknown> {
  if (menuKey === 'studentRecords') return { [STUDENT_RECORD_TYPE_FIELD]: 'IDP沟通' };
  return {};
}
