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
// 学生支持看板（2026-09-29）：信号体系判据 / 负责人自动推导 / 超期与数据范围 / 菜单可见性
// —— 🔴 每张卡上的「为什么在这里」是**证据**，被后端聚合、前端展示、单测三处共用，
//    各写一份必然漂移。与 IDP 那批同构。
export * from './student-support.js';
// 卫瓴联系人 → 学生档案「入学」：字段映射的三档判据 + 姓名可用性 + 留痕文本
// —— 🔴 前端弹窗「显示会填什么」与后端「实际填什么」必须是同一份，各写一份必然漂移
export * from './weiling-enroll.js';
// 卫瓴映射：卫瓴取值 → 学生档案选项（可配置；默认值 = 原写死的映射表）
// —— 🔴 与 weiling-enroll 的 buildEnrollDraft(ctx, mapping?) 配套，只此一份
export * from './weiling-mapping.js';
// 卫瓴联系人 ↔ 学生档案「关联来源」三态 + 取消/改指/恢复自动的写库判据
// —— 🔴 后台 matchStudents() 的跳过判据与前端列表格的状态展示必须是同一份，
//    各写一遍会出现「界面显示自动、后台其实跳过了」这种静默不一致
export * from './weiling-link.js';
// 「代码规则」：编号的段 DSL + 生成器（学籍号等自动编号）
// —— 🔴 默认规则是**逆推自生产 82 个学籍号**的（82/82 一致），单测钉住"能逐条复现存量"；
//    试算接口与真正落库必须走同一个 generateCode，前端不许自己估算
export * from './code-rules.js';
