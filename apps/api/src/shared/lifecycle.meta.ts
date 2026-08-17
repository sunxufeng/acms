/**
 * 学生全生命周期域（M1 招生与学生）的 7 张飞书表的元数据。
 * 字段名严格对应飞书实际字段（通过 listFields 核对）。
 *  - numbers:    数值字段（写入时强转 number）
 *  - dateFields: 日期字段（写入时字符串→毫秒时间戳，读取时→本地日期字符串）
 *  - readonly:   不可写字段（人员/附件/多选/勾选），避免飞书类型校验失败
 *  - statusField/ defaultStatus: 状态展示与新建默认
 */
import { TABLES } from '@acms/contracts';
import type { RecordMeta } from './generic-crud.module.js';

const PERM_R = 'student:read';
const PERM_W = 'student:write';

export const LIFECYCLE_METAS: RecordMeta[] = [
  {
    path: 'source-followups',
    tableId: TABLES.sourceFollowup.tableId,
    readPerm: PERM_R,
    writePerm: PERM_W,
    dateFields: ['活动参与日期', '跟进日期', '下次跟进日期'],
    readonly: ['跟进负责人', '跟进附件', '关联学生编号'],
    statusField: '跟进状态',
    defaultStatus: '未跟进',
    searchField: '关联学生编号',
    sortField: '跟进日期',
  },
  {
    path: 'student-attendances',
    tableId: TABLES.attendance.tableId,
    readPerm: PERM_R,
    writePerm: PERM_W,
    dateFields: ['考勤日期', '到校时间', '离校时间'],
    readonly: ['班主任', '记录人', '佐证附件', '关联学生编号', '学年', '班级'],
    statusField: '考勤状态',
    defaultStatus: '正常',
    searchField: '关联学生编号',
    sortField: '考勤日期',
  },
  {
    path: 'grades',
    tableId: TABLES.academicGrade.tableId,
    readPerm: PERM_R,
    writePerm: PERM_W,
    numbers: ['成绩', '满分'],
    dateFields: ['考核日期'],
    readonly: ['任课教师', '成绩附件', '关联学生编号', '学年', '课程'],
    statusField: '成绩状态',
    defaultStatus: '草稿',
    searchField: '关联学生编号',
    sortField: '考核日期',
  },
  {
    path: 'practice-activities',
    tableId: TABLES.practiceActivity.tableId,
    readPerm: PERM_R,
    writePerm: PERM_W,
    numbers: ['服务或参与时长'],
    dateFields: ['活动开始日期', '活动结束日期'],
    readonly: ['活动负责人', '活动证明', '关联学生编号', '关联授权'],
    statusField: '安全确认状态',
    defaultStatus: '待确认',
    searchField: '活动名称',
    sortField: '活动开始日期',
  },
  {
    path: 'home-school-comms',
    tableId: TABLES.homeSchoolComm.tableId,
    readPerm: PERM_R,
    writePerm: PERM_W,
    dateFields: ['沟通时间', '跟进截止日期', '闭环日期'],
    readonly: ['沟通人', '待办负责人', '沟通主题', '沟通附件', '关联学生编号', '关联监护人'],
    statusField: '闭环状态',
    defaultStatus: '无需跟进',
    searchField: '家长',
    sortField: '沟通时间',
  },
  {
    path: 'stage-evaluations',
    tableId: TABLES.stageEvaluation.tableId,
    readPerm: PERM_R,
    writePerm: PERM_W,
    dateFields: ['评价日期', '复核日期'],
    readonly: ['班主任', '是否通过', '评价人', '评价附件', '关联学生编号', '学年'],
    statusField: '评价完整度',
    defaultStatus: '待提交',
    searchField: '关联学生编号',
    sortField: '评价日期',
  },
  {
    path: 'alumni-followups',
    tableId: TABLES.alumniFollowup.tableId,
    readPerm: PERM_R,
    writePerm: PERM_W,
    dateFields: ['跟进时间', '下次跟进日期'],
    readonly: ['跟进负责人', '校友参与意愿', '跟进附件', '关联学生编号'],
    statusField: '跟进状态',
    defaultStatus: '待跟进',
    searchField: '关联学生编号',
    sortField: '跟进时间',
  },
];

/** 系统配置表（M6 运营工作台补充）：key-value 配置，仅管理员可写 */
export const CONFIG_METAS: RecordMeta[] = [
  {
    path: 'settings',
    tableId: TABLES.systemConfig.tableId,
    readPerm: 'config:read',
    writePerm: 'config:write',
    statusField: '状态',
    defaultStatus: '启用',
    searchField: '配置键',
    sortField: '分组',
  },
];
