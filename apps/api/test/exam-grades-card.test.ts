/**
 * 「考试与成绩 · 成绩单」修两个报障的**接线守卫**（2026-09-26 峰哥报障）。
 *
 * 两个症状都属于「接口对、类型对、不报错，但页面就是这样」这一类，所以必须有断言钉住：
 *
 *  ① 「已有总评的学生是重复的」
 *     总评表的行粒度是 **`批次 × 学生 × 科目`**（幂等键 `termGradeKey`），
 *     一个学生有几科就有几行。成绩单是**学生粒度**的东西，左列表直接渲染行 ⇒ 重复。
 *     修法：服务端在同一个响应里给出 `students`（去重后的学生维度，纯函数 `studentsFromRows`），
 *     左列表用它、批量评语继续用 `rows`。**去重规则只许有一份**。
 *
 *  ② 「批量评语用科目筛选之后没数据了」
 *     科目候选来自**成绩册的列**、列表数据来自**期末总评表**，两者不同源 ⇒
 *     下拉里会有「有列但还没结转」的科目（生产实测：「生物学」1 列 / 0 条总评），
 *     选中必然是空列表，而界面上只有一句「暂无总评」，用户看不出是"没结转"还是"坏了"。
 *     修法：`subjects` 接口带 `grades` 计数（下拉标注「暂无总评」）+ 空态给人话解释。
 *
 * 断言分两层：**纯函数**在 `exam-grade.logic.test.ts` 里测（行为），
 * 这里测**接线**（源码级，防止以后重构把它拆掉 —— 拆掉不会有任何类型错误）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(path.join(here, '..', '..', ...p), 'utf8');

const svc = read('api', 'src', 'exam-grade', 'exam-grade.service.ts');
const ctrl = read('api', 'src', 'exam-grade', 'exam-grade.controller.ts');
const page = read('web', 'app', 'exam-grades', 'page.tsx');
const apiTs = read('web', 'lib', 'api.ts');

describe('① 成绩单左列表：学生维度去重', () => {
  it('服务端 term-grades 同时给出 rows（行）与 students（学生维度）', () => {
    expect(svc).toContain('studentsFromRows');
    expect(svc).toContain('students: studentsFromRows(rows)');
    expect(svc).toContain('students: StudentRef[]');
  });

  it('🔴 前端左列表用 r.students，批量评语用 r.rows（两者不许混用）', () => {
    expect(page).toContain('setCardStudents(r.students ?? [])');
    expect(page).toContain('setCommentRows(r.rows)');
    // 反例守卫：不许再出现"把 rows 直接塞进左列表"的写法
    expect(page).not.toContain('setCardStudents(r.rows)');
  });

  it('左列表按 studentId 作 key（按行 id 作 key 会随科目数变化，且同一学生多行会重复）', () => {
    const i = page.indexOf('{cardStudents.map');
    const seg = page.slice(i, i + 700);
    expect(seg).toContain('key={s.studentId}');
  });

  it('徽标显示科目数而不是名次（名次是**分科目**的，在学生这一层显示会误导）', () => {
    const i = page.indexOf('{cardStudents.map');
    const seg = page.slice(i, i + 900);
    expect(seg).toContain("t('subjectCount'");
    expect(seg).not.toMatch(/`#\$\{s\.rank\}`/);
  });

  it('类型定义里有 TermGradeStudentRef 且 term-grades 响应用它', () => {
    expect(apiTs).toContain('export interface TermGradeStudentRef');
    expect(apiTs).toContain('students: TermGradeStudentRef[]');
  });
});

describe('② 科目筛选：候选与数据同源可解释', () => {
  it('subjects 接口接受 batchId 并返回每科总评行数 grades', () => {
    expect(ctrl).toContain("@Query('batchId') batchId");
    expect(ctrl).toContain("batchId ?? ''");
    expect(svc).toContain('grades: grades.get(value) ?? 0');
    expect(svc).toContain('countGradesBySubject');
    expect(apiTs).toContain('grades: number');
  });

  it('前端把 batchId 传给科目候选接口（不传 ⇒ grades 恒 0，标注失真）', () => {
    // ⚠️ 源码里是 `void api\n  .examSubjects(...)`（链式换行），所以断言只取方法调用那一段
    expect(page).toContain('.examSubjects(cls, b?.year, b?.term, batchId)');
  });

  it('下拉标注「暂无总评」/「总评 N 条」', () => {
    expect(page).toContain("t('subjectOptionNoGrades'");
    expect(page).toContain("t('subjectOptionWithGrades'");
  });

  it('空态区分「没选科目」与「选了科目但该科没总评」，并写明下一步', () => {
    expect(page).toContain("subject ? t('noTermGradesForSubject') : t('noTermGradesForComment')");
    // 成绩单左列表空态同理（选科目后筛选掉所有人）
    expect(page).toContain("subject ? t('noTermGradesForSubject') : t('noTermGradesShort')");
  });

  it('🔴 批量评语表格必须有「科目」列（评语是按科目写的，缺列就分不清哪行哪科）', () => {
    // 按「批量评语」整段切（从它的 tab 标记到下一个 tab 标记），别用固定字符窗口 ——
    // 窗口太窄会漏掉表体里的用法，测试就变成"看起来在守、其实守不住"。
    const i = page.indexOf("{tab === 'comments'");
    const j = page.indexOf("{tab === 'anomaly'", i);
    expect(i, '找不到批量评语 tab').toBeGreaterThan(-1);
    expect(j, '找不到下一个 tab 标记').toBeGreaterThan(i);
    const seg = page.slice(i, j);
    expect(seg).toContain("t('colSubject')");            // 表头有「科目」
    expect(seg).toContain("t('subjectNone')");           // 未分科目显示成「未填科目」而不是空白
    expect(seg).toContain('setSubject');                 // 空态里有「清除科目筛选」出口
  });

  it('i18n：新文案中英都齐（缺了页面会显示成 key，且 label lint 会拦）', () => {
    const zh = JSON.parse(read('web', 'messages', 'zh.json')) as { examGrades: Record<string, string> };
    const en = JSON.parse(read('web', 'messages', 'en.json')) as { examGrades: Record<string, string> };
    for (const k of [
      'noTermGradesForSubject', 'subjectCount', 'subjectCountHint',
      'subjectOptionWithGrades', 'subjectOptionNoGrades',
    ]) {
      expect(zh.examGrades[k], `zh 缺 ${k}`).toBeTruthy();
      expect(en.examGrades[k], `en 缺 ${k}`).toBeTruthy();
    }
  });
});
