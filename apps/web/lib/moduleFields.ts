/**
 * 模块字段注册表：菜单 key → 该模块可用来承接笔记内容的字段名列表。
 *
 * 用途：转换配置页每行的「总结写入字段」「原始记录写入字段」下拉候选项。
 * 只登记核对过列定义的模块；**未登记的模块自动降级为手工输入文本框**，
 * 这样新开发的模块即使没登记也能配（只是没有下拉提示）。
 *
 * ⚠️ 这里写的是飞书表的**字段 key**（列定义里的 `key`），不是显示 label。
 *    写错不会报错，飞书会静默丢弃 —— 所以用下拉而不是手填正是为了防这个。
 */
export const MODULE_FIELDS: Record<string, string[]> = {
  // 学生闭环
  homeSchoolComms: ['沟通总结', '沟通明细', '家长反馈', '沟通人备注', '待办事项'],
  dailyFollowups: ['沟通总结', '沟通明细', '沟通人备注', '待办事项'],
  sourceFollowups: ['沟通总结', '沟通明细', '跟进内容', '参观反馈', '家长或学生诉求', '下一步行动'],
  practiceActivities: ['活动内容', '活动表现', '参与情况', '成果与反思', '活动名称'],
  grades: ['课堂表现', '教师评语', '考核名称'],
  stageEvaluations: ['评价内容', '优势表现', '待改进项', '改进计划'],
  studentAttendances: ['异常描述', '处理结果'],
  alumniFollowups: ['跟进事项', '跟进备注'],
  idpPlans: ['展示内容', '展示亮点', '原始文档'],
};

/** 取某模块的候选字段；未登记返回空数组（调用方降级为文本框） */
export function fieldsForMenu(menuKey: string): string[] {
  return MODULE_FIELDS[menuKey] ?? [];
}
