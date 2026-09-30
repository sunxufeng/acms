/**
 * 成绩册「模板导出 + 成绩导入」守卫（2026-09-30 峰哥第 4 条需求）。
 *
 * 这一块最容易出的两类事故，本文件就是为它们写的：
 *
 * ① **空 = 清空**（写错方向的默认值）。老师通常只填其中几列，
 *    若把空单元格也提交上去，后端 `saveEntries` 会按"空 = 删条目"把**其他列的分全删掉**，
 *    而且**不报错**（只是数字悄悄变少）。判据：空一定不产生变更行。
 *
 * ② **导出与解析不同源**（模板列头一处写法、解析另一处写法）⇒ 列错位，
 *    分数写到别的考核项上。判据：列头生成与解析共用 `gradeColumnHeaders`，
 *    并且有**往返断言**（导出模板 → 解析回来 → 值与原值一致）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GRADE_IMPORT_CLEAR,
  GRADE_IMPORT_ID_COL,
  GRADE_IMPORT_NAME_COL,
  buildGradeTemplateCsv,
  csvCell,
  gradeCellExportText,
  gradeColumnHeaders,
  gradeHeaderIndex,
  parseCsvRows,
  parseGradeImport,
} from '@acms/contracts';
// 🔴 往返断言的另一半：**真跑后端的值解析**（不是"照着写一遍"）——
//    导出文本必须能被它解析回同一状态，否则老师导出模板→改几个数→导入 会一片报错
import { parseScoreInput } from '../src/exam-grade/exam-grade.logic.js';

const root = new URL('../../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');

const STUDENTS = [
  { id: 'recA', name: '张三' },
  { id: 'recB', name: '李四' },
  { id: 'recC', name: '王五' },
];
const COLUMNS = [
  { id: 'col1', name: '月考一' },
  { id: 'col2', name: '月考二' },
  { id: 'col3', name: '月考一' }, // 故意重名：列头要变成「月考一(2)」
];

describe('A. CSV 解析（全站唯一一份）', () => {
  it('引号内的逗号 / 换行 / 双引号都正确', () => {
    const rows = parseCsvRows('a,b\n"x,1","y\n2"\n"he said ""hi"""');
    expect(rows[0]).toEqual(['a', 'b']);
    expect(rows[1]).toEqual(['x,1', 'y\n2']);
    expect(rows[2]).toEqual(['he said "hi"']);
  });

  it('BOM / CRLF / 尾随空行都不影响', () => {
    const rows = parseCsvRows('\uFEFFa,b\r\n1,2\r\n\r\n');
    expect(rows).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('`csvCell` 与解析互为逆（含逗号 / 引号的值）', () => {
    const line = ['张三, 小', '他说"好"'].map(csvCell).join(',');
    expect(parseCsvRows(line)[0]).toEqual(['张三, 小', '他说"好"']);
  });

  it('🔴 CrudPage 用的是**同一份**（全站只有一份解析器）', () => {
    const crud = read('apps/web/components/CrudPage.tsx');
    expect(crud).toContain('parseCsvRows');
    // 反向：组件里不许再有自己那份按行 split 的实现
    expect(crud).not.toContain('const splitLine = (line: string): string[] =>');
  });

  it('🔴 markbook 页也不许自己解析 CSV（必须走 contracts）', () => {
    const page = read('apps/web/app/markbook/page.tsx');
    expect(page).toContain('parseGradeImport');
    expect(page).not.toContain('function parseCsv');
  });
});

describe('B. 列头（模板与解析同源）', () => {
  it('重名列自动加 (2)/(3)，不能两列同名（否则导入必然错位）', () => {
    expect(gradeColumnHeaders(COLUMNS).map((h) => h.header)).toEqual(['月考一', '月考二', '月考一(2)']);
  });

  it('`gradeHeaderIndex` 按模板表头反查列 id，认不出的列名单独报出来', () => {
    const { byIndex, unknown } = gradeHeaderIndex(
      [GRADE_IMPORT_NAME_COL, GRADE_IMPORT_ID_COL, '月考一', '月考二', '上一个班主任乱加的列'],
      COLUMNS,
    );
    expect(byIndex).toEqual(['', '', 'col1', 'col2', '']);
    expect(unknown).toEqual(['上一个班主任乱加的列']);
  });
});

describe('C. 导出文本必须能往返（含免考 / 缺考）', () => {
  it('`gradeCellExportText`：免考 → 免 · 缺考 → 缺 · 数字 → 数字 · 只录等级 → 等级', () => {
    expect(gradeCellExportText({ status: '免考', score: null })).toBe('免');
    expect(gradeCellExportText({ status: '缺考', score: 0 })).toBe('缺');
    expect(gradeCellExportText({ status: '正常', score: 92 })).toBe('92');
    expect(gradeCellExportText({ status: '正常', score: null, level: 'A' })).toBe('A');
    expect(gradeCellExportText(null)).toBe('');
  });

  it('🔴 往返：导出文本喂给**后端真实的** parseScoreInput，状态与值都还原', () => {
    const cases: { cell: { status?: string; score?: number | null; level?: string }; status: string; score: number | null }[] = [
      { cell: { status: '免考', score: null }, status: '免考', score: null },
      { cell: { status: '缺考', score: 0 }, status: '缺考', score: 0 },
      { cell: { status: '正常', score: 92 }, status: '正常', score: 92 },
    ];
    for (const c of cases) {
      const text = gradeCellExportText(c.cell);
      const parsed = parseScoreInput(text, { fullMark: 100 });
      expect(parsed.ok, `导出文本「${text}」应能被解析`).toBe(true);
      expect(parsed.status, `「${text}」的状态`).toBe(c.status);
      expect(parsed.score, `「${text}」的分数`).toBe(c.score);
    }
  });

  it('🔴 导出文本是**语言无关**的：不能走界面那套 i18n 文案（英文会导 Excused/Absent）', () => {
    const page = read('apps/web/app/markbook/page.tsx');
    // 模板导出必须用 gradeCellExportText，不能用界面 cellText（它返回 t('cellExcused')）
    expect(page).toContain('gradeCellExportText(cellMap.get');
    // 反向：模板里不许出现 i18n 的免考/缺考文案 key
    const i = page.indexOf('buildGradeTemplateCsv(');
    const j = page.indexOf('downloadTextFile(', i);
    expect(page.slice(i, j > i ? j : i + 900)).not.toContain("t('cellExcused')");
  });
});

describe('D. 清空标记不能与后端的「缺考」写法和撞', () => {
  it('🔴 清空标记不是 `-`（后端把 `-` 当缺考，同符号两套语义最危险）', () => {
    expect(GRADE_IMPORT_CLEAR).toBe('clear');
    // 真跑：`-` 必须被解析成**缺考**（所以它不可能同时表示"清空"）
    const p = parseScoreInput('-', { fullMark: 100 });
    expect(p.ok).toBe(true);
    expect(p.status).toBe('缺考');
    // 清空标记本身不能是缺考/免考 token
    const c = parseScoreInput(GRADE_IMPORT_CLEAR, { fullMark: 100 });
    expect(c.ok, '`clear` 不该被当成合法分数 —— 它在导入侧被单独识别，不该流到后端').toBe(false);
  });

  it('`clear` 大小写不敏感都能识别为清空', () => {
    const text = [
      [GRADE_IMPORT_NAME_COL, GRADE_IMPORT_ID_COL, '月考一'].join(','),
      ['张三', 'recA', 'CLEAR'].join(','),
    ].join('\n');
    const r = parseGradeImport({ text, students: STUDENTS, columns: COLUMNS });
    expect(r.clears).toBe(1);
    expect(r.rows).toEqual([{ columnId: 'col1', studentId: 'recA', raw: '' }]);
  });
});

describe('E. 🔴🔴 空 = 不动（写错方向就是"一次导入删掉整班其他列的分"）', () => {
  it('模板里的空格子**不产生任何变更行**', () => {
    const text = buildGradeTemplateCsv({ students: STUDENTS, columns: COLUMNS });
    const r = parseGradeImport({ text, students: STUDENTS, columns: COLUMNS });
    expect(r.rows).toEqual([]);
    expect(r.untouched).toBe(STUDENTS.length * COLUMNS.length);
    expect(r.clears).toBe(0);
  });

  it('只填一格 ⇒ 只产生 1 条变更行（其余全是"不动"）', () => {
    const text = [
      [GRADE_IMPORT_NAME_COL, GRADE_IMPORT_ID_COL, '月考一', '月考二', '月考一(2)'].join(','),
      ['张三', 'recA', '88', '', ''].join(','),
      ['李四', 'recB', '', '', ''].join(','),
    ].join('\n');
    const r = parseGradeImport({ text, students: STUDENTS, columns: COLUMNS });
    expect(r.rows).toEqual([{ columnId: 'col1', studentId: 'recA', raw: '88' }]);
    expect(r.untouched).toBe(5);
  });

  it('说明行（`#` 开头）被忽略，不当作学生行', () => {
    const text = buildGradeTemplateCsv({ students: STUDENTS, columns: COLUMNS });
    expect(text.split('\n')[1]?.startsWith('#')).toBe(true);
    const r = parseGradeImport({ text, students: STUDENTS, columns: COLUMNS });
    expect(r.problems).toEqual([]);
  });
});

describe('F. 学生匹配（ID 优先 · 同名不猜）', () => {
  it('`学生ID` 优先于姓名（同名学生被改名也错配不了）', () => {
    const text = [
      [GRADE_IMPORT_NAME_COL, GRADE_IMPORT_ID_COL, '月考一'].join(','),
      // 姓名故意写错，但 ID 对：应当按 ID 落到 recB
      ['不是李四的名字', 'recB', '70'].join(','),
    ].join('\n');
    const r = parseGradeImport({ text, students: STUDENTS, columns: COLUMNS });
    expect(r.rows).toEqual([{ columnId: 'col1', studentId: 'recB', raw: '70' }]);
  });

  it('🔴 班里有同名两人 ⇒ 报错不猜（猜错就是把 A 的分写到 B 头上）', () => {
    const students = [
      { id: 'recA', name: '张伟' },
      { id: 'recB', name: '张伟' },
    ];
    const text = [
      [GRADE_IMPORT_NAME_COL, GRADE_IMPORT_ID_COL, '月考一'].join(','),
      ['张伟', '', '90'].join(','),
    ].join('\n');
    const r = parseGradeImport({ text, students, columns: COLUMNS });
    expect(r.rows).toEqual([]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.reason).toContain('同名');
  });

  it('学生不在班里 ⇒ 报错（不静默丢弃）', () => {
    const text = [
      [GRADE_IMPORT_NAME_COL, GRADE_IMPORT_ID_COL, '月考一'].join(','),
      ['查无此人', 'recZZZ', '90'].join(','),
    ].join('\n');
    const r = parseGradeImport({ text, students: STUDENTS, columns: COLUMNS });
    expect(r.rows).toEqual([]);
    expect(r.problems[0]?.where).toBe('查无此人');
  });

  it('没有姓名列也没有 ID 列 ⇒ 直接判"用错文件了"', () => {
    const r = parseGradeImport({ text: 'a,b\n1,2', students: STUDENTS, columns: COLUMNS });
    expect(r.rows).toEqual([]);
    expect(r.problems[0]?.reason).toContain('导出模板');
  });
});

describe('G. 往返（模板 → 改数 → 解析）', () => {
  it('🔴 导出带现有分数的模板，解析回来的值与原值一致', () => {
    const score: Record<string, string> = { 'col1__recA': '88', 'col2__recA': '免', 'col1__recB': '缺' };
    const text = buildGradeTemplateCsv({
      students: STUDENTS,
      columns: COLUMNS,
      cellText: (sid, cid) => score[`${cid}__${sid}`] ?? '',
    });
    const r = parseGradeImport({ text, students: STUDENTS, columns: COLUMNS });
    // 三格都非空 ⇒ 三行（含"免"/"缺"这种状态值，**原样**交给后端解析）
    expect(r.rows).toHaveLength(3);
    expect(r.rows).toContainEqual({ columnId: 'col1', studentId: 'recA', raw: '88' });
    expect(r.rows).toContainEqual({ columnId: 'col2', studentId: 'recA', raw: '免' });
    expect(r.rows).toContainEqual({ columnId: 'col1', studentId: 'recB', raw: '缺' });
    // 其余格子留空 ⇒ 不动
    expect(r.untouched).toBe(STUDENTS.length * COLUMNS.length - 3);
    expect(r.problems).toEqual([]);
    expect(r.unknownColumns).toEqual([]);
  });

  it('🔴 值本身不在前端解析（原样传给后端）——「85%」「A」都要原样带着', () => {
    const text = [
      [GRADE_IMPORT_NAME_COL, GRADE_IMPORT_ID_COL, '月考一'].join(','),
      ['张三', 'recA', '85%'].join(','),
      ['李四', 'recB', 'A'].join(','),
    ].join('\n');
    const r = parseGradeImport({ text, students: STUDENTS, columns: COLUMNS });
    expect(r.rows.map((x) => x.raw).sort()).toEqual(['85%', 'A']);
  });
});

describe('H. 页面接线', () => {
  const page = read('apps/web/app/markbook/page.tsx');
  const api = read('apps/web/lib/api.ts');

  it('工具栏有两个按钮，且都要求先选班级（没有班级就没有成绩册）', () => {
    expect(page).toContain("t('templateBtn')");
    expect(page).toContain("t('importBtn')");
    // ⚠️ 窗口必须**各自贴紧到自己那个按钮**：一开始我取了两个 key 之间的整段，
    //    把第三个按钮（作业同步）的 `disabled` 也算进来，断言变成假的。
    const iT = page.indexOf("t('templateBtn')");
    expect(page.slice(iT - 200, iT + 40)).toContain('disabled={!cls || !grid}');
    const iI = page.indexOf("t('importBtn')");
    expect(page.slice(iI - 300, iI + 40)).toContain('disabled={!cls || !grid}');
  });

  it('🔴 导入是"两步"：选文件先解析给老师看，确认后才写库', () => {
    expect(page).toContain('parseGradeImport');
    // 提交用后端现成的批量保存接口（不在前端造第二套写入）
    expect(page).toContain('api.markbookSaveEntries');
    expect(api).toContain("'/markbook/entries/save'");
    // 确认按钮的文案里带"要改多少格"
    expect(page).toContain("t('importConfirm'");
  });

  it('🔴 分批提交（一个请求塞几百格会超时，超时后老师不知道进了多少）', () => {
    expect(page).toContain('i += 300');
  });

  it('导出带 BOM（否则 Excel 打开中文乱码）', () => {
    expect(page).toContain("'\\ufeff' + text");
  });

  it('同一个文件连续选两次也能触发（清空 input.value）', () => {
    expect(page).toContain('e.target.value = \'\'');
  });
});
