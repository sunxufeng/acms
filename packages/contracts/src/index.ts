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
// 学生档案「入学年月 → 入学年份 / Arete入学年」的派生规则（界面自动带出 + 单测钉住）
export * from './student-enroll.js';
// 笔记归档到飞书云盘的口径（命名/文件夹归一/到点判据，定时任务与报告共用一份）
export * from './note-archive.js';
// IDP（个人发展计划）重构：幂等键 / 学年学期区间 / 沟通次数口径 / 「我的 IDP」菜单判据
// —— 都是「几处共用一份」的判据，别在 service 或页面里再写一遍
export * from './idp.js';
