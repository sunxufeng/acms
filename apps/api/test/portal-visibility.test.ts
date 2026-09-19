import { describe, expect, it } from 'vitest';
import {
  cellVisible,
  columnAllows,
  commVisible,
  dayOf,
  switchOn,
  todayStr,
} from '../src/portal/portal-visibility.js';
import {
  commsOf,
  gradesOf,
  homeworkOf,
  studentSummaries,
} from '../src/portal/portal-queries.js';
import { TABLES, STUDENT_RECORD_TYPE_FIELD } from '@acms/contracts';

/**
 * 家长 / 学生门户的可见性判据与查询层。
 *
 * 这些断言保护的是一类**不报错的错**：
 *   - 开关写成 `!== '否'` ⇒ 历史空值全被当"可见"，没打算公开的成绩直接进家长手机；
 *   - 闸门把空值当"关闭" ⇒ 上线瞬间家长端成绩全空，看起来像功能坏了；
 *   - 沟通记录漏卡 `记录类型` ⇒ 教师的内部跟进记录被推给家长。
 * 三种都不会抛异常、页面也不报错，只有"数字对不上/不该看到的看到了"。
 */

/** 假 SqlStore：按 tableId 返回预置行（只需 `search`，与 fetchAll 的调用面一致） */
function fakeSql(tables: Record<string, { id: string; fields: Record<string, unknown> }[]>) {
  return {
    search: async (tableId: string) => ({ items: tables[tableId] ?? [], hasMore: false, pageToken: undefined }),
  } as never;
}

describe('门户可见性判据（纯函数）', () => {
  it('开关：空串与「否」都不可见，只有显式「是」放行', () => {
    expect(switchOn('是')).toBe(true);
    // 🔴 空串是生产最常见的值（markbook 写入侧 `String(x ?? '')`），必须判不可见
    expect(switchOn('')).toBe(false);
    expect(switchOn(undefined)).toBe(false);
    expect(switchOn(null)).toBe(false);
    expect(switchOn('否')).toBe(false);
  });

  it('今天：按本地时区取，不用 toISOString（否则晚上 8 点后少一天）', () => {
    expect(todayStr(new Date(2026, 8, 19, 0, 30))).toBe('2026-09-19');
    expect(todayStr(new Date(2026, 8, 19, 23, 30))).toBe('2026-09-19');
  });

  it('日期归一：时间戳 / 斜杠格式都截到天', () => {
    expect(dayOf('2026-09-19T00:00:00.000Z')).toBe('2026-09-19');
    expect(dayOf('2026/9/9')).toBe('2026-09-09');
    expect(dayOf('')).toBe('');
    expect(dayOf(undefined)).toBe('');
  });

  it('列放行：停用列一律不出（含学生）', () => {
    const col = { 状态: '停用', 学生可见: '是', 家长可见: '是' };
    expect(columnAllows('student', col, '2026-09-19')).toBe(false);
    expect(columnAllows('parent', col, '2026-09-19')).toBe(false);
  });

  it('完成闸门只约束家长：未到日期家长看不到、学生照常看到', () => {
    const col = { 学生可见: '是', 家长可见: '是', 完成日期: '2026-09-30' };
    expect(columnAllows('parent', col, '2026-09-19')).toBe(false);
    expect(columnAllows('student', col, '2026-09-19')).toBe(true);
    // 到当天即放行
    expect(columnAllows('parent', col, '2026-09-30')).toBe(true);
    // 空值 = 不设闸门（生产现存列全为空，若反过来解释，上线瞬间家长端全空）
    expect(columnAllows('parent', { 家长可见: '是', 完成日期: '' }, '2026-09-19')).toBe(true);
  });

  it('两个开关正交：只给学生看的成绩，家长拿不到', () => {
    const col = { 学生可见: '是', 家长可见: '否' };
    expect(columnAllows('student', col, '2026-09-19')).toBe(true);
    expect(columnAllows('parent', col, '2026-09-19')).toBe(false);
  });

  it('条目级：显式「否」拦截，空值跟随列（否则作业同步的条目会被全清）', () => {
    const col = { 学生可见: '是', 家长可见: '是' };
    expect(cellVisible('parent', col, { 家长可见: '否' }, '2026-09-19')).toBe(false);
    expect(cellVisible('parent', col, { 家长可见: '' }, '2026-09-19')).toBe(true);
    expect(cellVisible('parent', col, {}, '2026-09-19')).toBe(true);
    // 列不放行时，条目上是「是」也无效（列是主控）
    expect(cellVisible('parent', { 家长可见: '否' }, { 家长可见: '是' }, '2026-09-19')).toBe(false);
  });

  it('沟通记录：敏感级别高于「内部」的不出门户', () => {
    expect(commVisible('')).toBe(true);
    expect(commVisible('内部')).toBe(true);
    expect(commVisible('敏感')).toBe(false);
    expect(commVisible('高度敏感')).toBe(false);
  });
});

describe('查询层：成绩 / 作业 / 沟通', () => {
  const COL = TABLES.markbookColumn.tableId;
  const ENTRY = TABLES.markbookEntry.tableId;
  const LESSON = TABLES.lessonEntry.tableId;
  const FOLLOW = TABLES.dailyFollowup.tableId;

  const col = (id: string, f: Record<string, unknown>) => ({ id, fields: f });
  const entry = (id: string, columnId: string, studentId: string, f: Record<string, unknown> = {}) => ({
    id,
    fields: { 成绩册列: [columnId], 学生: [studentId], 得分: 88, 等级: 'A', ...f },
  });

  const sql = fakeSql({
    [COL]: [
      col('c_open', { 列名称: '期中测验', 科目: '数学', 考核日期: '2026-09-10', 家长可见: '是', 学生可见: '是' }),
      col('c_gate', { 列名称: '期末总评', 科目: '数学', 考核日期: '2026-09-20', 家长可见: '是', 学生可见: '是', 完成日期: '2026-09-30' }),
      col('c_private', { 列名称: '内部摸底', 科目: '数学', 家长可见: '', 学生可见: '' }),
      col('c_off', { 列名称: '停用列', 家长可见: '是', 学生可见: '是', 状态: '停用' }),
    ],
    [ENTRY]: [
      entry('e1', 'c_open', 'rec_s1'),
      entry('e2', 'c_gate', 'rec_s1'),
      entry('e3', 'c_private', 'rec_s1'),
      entry('e4', 'c_off', 'rec_s1'),
      entry('e5', 'c_open', 'rec_s2'), // 别的学生，绝不能混进来
      entry('e6', 'c_open', 'rec_s1', { 家长可见: '否' }), // 逐格遮掉
    ],
  });

  it('成绩：只给放行的格子，且不含别人的', async () => {
    const rows = await gradesOf(sql, 'rec_s1', 'student', '2026-09-19');
    // 学生视角（不受闸门约束、条目看「学生可见」）：
    //   e1 c_open 放行 · e6 c_open 放行（条目上遮的是「家长可见」，对不学生生效）
    //   e2 期末总评 放行 · e3(内部摸底, 开关空) / e4(停用列) / e5(别人) 全部不出
    expect(rows.map((r) => r.id).sort()).toEqual(['e1', 'e2', 'e6']);
  });

  it('成绩：条目级「家长可见=否」只遮家长，学生照常看到', async () => {
    const stu = await gradesOf(sql, 'rec_s1', 'student', '2026-09-30');
    const par = await gradesOf(sql, 'rec_s1', 'parent', '2026-09-30');
    expect(stu.map((r) => r.id)).toContain('e6');
    expect(par.map((r) => r.id)).not.toContain('e6');
  });

  it('成绩：家长被闸门挡住（这正是「家长端少几条」的正常原因）', async () => {
    const rows = await gradesOf(sql, 'rec_s1', 'parent', '2026-09-19');
    expect(rows.map((r) => r.列名称)).toEqual(['期中测验']);
    // 过了闸门日期就一起放出来
    const later = await gradesOf(sql, 'rec_s1', 'parent', '2026-09-30');
    expect(later.map((r) => r.列名称).sort()).toEqual(['期中测验', '期末总评']);
  });

  it('成绩：别人的成绩/条目不会串进来（按学生 link 过滤）', async () => {
    const rows = await gradesOf(sql, 'rec_s2', 'parent', '2026-09-30');
    // c_open 的条目是 e1（s1）与 e5（s2），理论上都该出现；这里只断言没有 s1 专属列
    expect(rows.map((r) => r.列名称)).not.toContain('期末总评');
  });

  it('作业：草稿教案不出、没写作业的不出、未开可见的不出', async () => {
    const lessonSql = fakeSql({
      [LESSON]: [
        { id: 'l1', fields: { 课题: '函数入门', 作业布置: '习题 1-5', 教案状态: '已发布', 家长可见: '是', 学生可见: '是' } },
        { id: 'l2', fields: { 课题: '草稿教案', 作业布置: '不该看到', 教案状态: '草稿', 家长可见: '是', 学生可见: '是' } },
        { id: 'l3', fields: { 课题: '没作业', 作业布置: '', 教案状态: '已发布', 家长可见: '是', 学生可见: '是' } },
        { id: 'l4', fields: { 课题: '未开可见', 作业布置: '不该看到', 教案状态: '已发布', 家长可见: '', 学生可见: '' } },
      ],
      [TABLES.enrollment.tableId]: [],
    });
    const rows = await homeworkOf(lessonSql, 'rec_s1', 'parent', '2026-09-19');
    expect(rows.map((r) => r.课题)).toEqual(['函数入门']);
  });

  it('沟通记录：只出「家校沟通」，日常跟进与高敏感记录都不出', async () => {
    const commSql = fakeSql({
      [FOLLOW]: [
        { id: 'f1', fields: { [STUDENT_RECORD_TYPE_FIELD]: '家校沟通', 关联学生编号: ['rec_s1'], 沟通主题: '开学面谈', 沟通时间: '2026-09-12', 信息敏感级别: '内部' } },
        { id: 'f2', fields: { [STUDENT_RECORD_TYPE_FIELD]: '日常跟进', 关联学生编号: ['rec_s1'], 沟通主题: '教师内部记录', 沟通时间: '2026-09-13' } },
        { id: 'f3', fields: { [STUDENT_RECORD_TYPE_FIELD]: '家校沟通', 关联学生编号: ['rec_s1'], 沟通主题: '高度敏感', 沟通时间: '2026-09-14', 信息敏感级别: '高度敏感' } },
        { id: 'f4', fields: { [STUDENT_RECORD_TYPE_FIELD]: '家校沟通', 关联学生编号: ['rec_s2'], 沟通主题: '别人家的', 沟通时间: '2026-09-15' } },
      ],
    });
    const rows = await commsOf(commSql, 'rec_s1');
    expect(rows.map((r) => r.沟通主题)).toEqual(['开学面谈']);
  });

  it('子女摘要：按传入顺序返回（切换条次序不能随表内顺序抖动）', async () => {
    const stuSql = fakeSql({
      [TABLES.studentProfile.tableId]: [
        { id: 'rec_b', fields: { 学生姓名: '妹妹', 学生编号: '002' } },
        { id: 'rec_a', fields: { 学生姓名: '哥哥', 学生编号: '001' } },
      ],
    });
    const rows = await studentSummaries(stuSql, ['rec_a', 'rec_b']);
    expect(rows.map((r) => r.姓名)).toEqual(['哥哥', '妹妹']);
  });
});
