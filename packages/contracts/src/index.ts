export * from './role.js';
export * from './module-permissions.js';
// 「学生记录」合并类型（依赖 module-permissions 的 modulePermission）
export * from './student-records.js';
export * from './tables.js';
// 成绩册列的口径（前后端共用：新建列的预览与真正建列必须是同一份规则）
export * from './markbook.js';
export * from './api.js';
export * from './homepage.js';
export * from './department.js';
export * from './getnote.js';
export * from './followup-owner.js';
export * from './weiling.js';
export * from './meeting.js';
export * from './meeting-room.js';
// 学生维度的「笔记来源」口径（分区中文名 + 实体类型 → 归属模块），前端与多个 service 共用
export * from './student-note-sources.js';
