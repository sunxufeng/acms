import type { StudentService } from '../../../student/student.service.js';

/**
 * 学生档案查询工具：按姓名/英文名/学籍号模糊搜索，把命中学生的「姓名、英文名、学籍号、校区、当前状态」返回，
 * 供 AI 在「整理云盘文件」等场景里按文件名里的学生姓名匹配系统里的学生。
 * 复用 StudentService（自带 ABAC 行级校验），以当前登录用户身份查询。
 */
export function createStudentQueryTool(studentService: StudentService) {
  return {
    name: 'query_students',
    description:
      '查询学生档案（按姓名/英文名/学籍号模糊搜索）。当用户需要把文件里的学生姓名匹配到系统里的学生、或想查某个学生的学号/校区/状态时使用。参数：{"keyword":"姓名或英文名或学籍号片段","page_size":最多返回条数(默认20)}。返回匹配学生的清单（姓名、英文名、学籍号、校区、当前状态、学生编号）。',
    async run(args: any, context: any) {
      const user = context && context.user;
      if (!user) return '错误：缺少用户上下文';
      const keyword = (args && args.keyword) || '';
      const pageSize = Number((args && args.page_size) || 20);
      try {
        const res = await studentService.list(user, { q: keyword, pageSize });
        const items = (res.items || []).map((s: any) => ({
          学生编号: s.学生编号,
          姓名: s.学生姓名,
          英文名: s.英文名,
          学籍号: s.学籍号,
          校区: s.校区,
          当前状态: s.当前状态,
        }));
        if (!items.length) return `未找到匹配「${keyword}」的学生。`;
        return JSON.stringify({ count: items.length, students: items }, null, 2);
      } catch (e) {
        return `查询学生失败：${(e as Error).message}`;
      }
    },
  };
}
